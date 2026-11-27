// 派发兜底守卫（2026-11-26）
//
// 为什么需要它 —— 11-26 00:00 那趟整套没跑，GitHub 上连 run 记录都没有：
//   cron-job.org 的两次 POST /dispatches（00:00:30、00:00:35）都被 GitHub 返回
//   **500 Internal Server Error**（截图实证，等待 ~300ms / ~760ms 后失败）。
//   cron-job.org 对失败不做重试，于是 master 与 multi-boss 两条链同时丢失，
//   当天的副本 / 镇妖塔 / 每日任务 / 钓鱼一次没做 —— 而代码与闸门都是好的
//   （06:00 / 11:30 / 18:00 三趟当天都正常派发，证明链路本身没问题）。
//
// 办法：用 GitHub 自己的 schedule 每 30 分钟看一眼「这一波到底有没有 run」，缺了才补发。
//   · 判定只用事实（有没有 created_at 落在波次窗口内的 run），不写本地标记 → 天然幂等；
//   · 已取消的 run 也算「派发过」，不会因为手动取消而被反复补发；
//   · schedule 只对默认分支（master）生效，所以这份守卫放 master，由它同时照看两条分支；
//   · 补发窗口按「补发后 tasks.js 还能判回正确模式」为界（见 WAVES 的 windowMin），
//     过了窗口就不补 —— 补一个 mode 已经滑成 skip 的 run 只是白耗 runner。
//
// 用法：
//   GH_TOKEN=xxx GITHUB_REPOSITORY=owner/repo node dispatch-guard.js   # CI 里
//   node dispatch-guard.js --dry                                        # 只看会补什么
// 单测：node dispatch-guard-test.js

'use strict';

const { execFileSync } = require('child_process');

const WORKFLOW = 'boss.yml';
const REFS = ['master', 'multi-boss'];

// 波次表（北京时间）。windowMin = 波次之后多少分钟内补发还有意义。
//   dawn  ：resolveMode 的 dawn 窗口是 00:00-02:59，02:30 补发仍判 dawn；
//   couple：shouldRunCouple 窗口 06:00-08:59，08:30 补发仍在窗口内；
//   boss  ：11:30 这趟 tasks 本来就判 skip，只跑 Run Boss / Run Farm，晚补无副作用；
//   dusk  ：18:00-19:55 才是 dusk，19:40 之后补发就没意义了。
const WAVES = [
    { hm: '00:00', label: 'dawn（副本/镇妖塔/每日任务/钓鱼）', windowMin: 150 },
    { hm: '06:00', label: 'couple（情侣迷宫）', windowMin: 150 },
    { hm: '11:30', label: 'boss（世界 boss 前组队）', windowMin: 150 },
    { hm: '18:00', label: 'dusk（山寨/邮件）', windowMin: 100 },
];

// 波次后多少分钟还没 run 才开始怀疑「派发丢了」。
// GitHub 从 dispatch 到 run 出现在列表通常几秒，留 12 分钟是给排队与 API 延迟的余量。
const CHECK_AFTER_MIN = 12;

// 判定「这一波已经派发过」：波次前 2 分钟起、到「此刻」为止，只要出现过任何一次 run 就算。
//
// ★ 早先是「波次 ±12 分钟」的窄窗，试出来了两个错：
//   ① 守卫自己补发的 run 建在 00:12 之后，下一轮（00:42）再看就超出窄窗 → 判定仍缺失 → 反复补发；
//   ② 派发带 0~5 分钟随机错峰 + runner 排队，run 的 created_at 天然会偏后。
// 改成「波次之后到此刻的任意 run 都算已处理」：守卫只在 dueWaves 的窗口内跑，
// 那段时间里出现的 run 只可能来自本波次（cron-job.org / 守卫补发 / 人工补跑），
// 保守地把人工补跑也算进来 —— 宁可少补一次，也不要同账号被两趟同时登录顶掉。
const CREATED_AFTER_MIN = -2;

function bjParts(date) {
    const d = new Date(date.getTime() + 8 * 3600 * 1000);
    return {
        year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(),
        hour: d.getUTCHours(), min: d.getUTCMinutes(),
    };
}

function bjMinuteOfDay(date) {
    const p = bjParts(date);
    return p.hour * 60 + p.min;
}

function hmToMin(hm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
    if (!m) throw new Error(`波次时间格式不对: ${hm}`);
    return Number(m[1]) * 60 + Number(m[2]);
}

// 「今天（北京时间）这个波次」对应的绝对时间戳（毫秒）。
// 用绝对时间比较，避免「波次 00:00 的窗口 -2 分钟」跨到前一天 23:58 的 run 上。
function waveEpoch(waveMin, now) {
    const p = bjParts(now);
    const bjMidnightUtc = Date.UTC(p.year, p.month, p.day) - 8 * 3600 * 1000;
    return bjMidnightUtc + waveMin * 60000;
}

// 本刻需要检查的波次（可能 0~1 个；留数组是为了以后波次挨得近时也能同时处理）。
function dueWaves(now) {
    const nowMin = bjMinuteOfDay(now);
    return WAVES.filter((w) => {
        const t = hmToMin(w.hm);
        return nowMin >= t + CHECK_AFTER_MIN && nowMin <= t + w.windowMin;
    });
}

// createdAts: GitHub runs 列表里的 created_at（ISO 字符串数组）
// 「波次前 2 分钟之后、到此刻为止」出现过 run，就认为这一波已经处理过。
function hasRunSince(createdAts, targetEpoch, nowEpoch) {
    for (const iso of createdAts || []) {
        const t = new Date(iso).getTime();
        if (Number.isNaN(t)) continue;
        if (t >= targetEpoch + CREATED_AFTER_MIN * 60000 && t <= nowEpoch) return true;
    }
    return false;
}

let execFile = execFileSync;
// 仅单测用：注入假 gh，好让「取数口径」这一层也能被测到。
function __setExec(fn) { execFile = fn; }

function gh(args, opts) {
    return execFile('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// jq 必须写成 .workflow_runs[].created_at 这种**直接取值**，不能写 "\(.created_at)" 插值串：
// JS 单引号串会把 \( 的反斜杠吃掉，交给 gh 的表达式变成 "(.created_at)"，gh 原样输出字面量，
// new Date 全 NaN → hasRunSince 恒 false → 每个进入窗口的轮次都误补发一对，
// 同一批账号叠两趟 farm 相互顶号（2026-11-27 03:43 线上实证，与 11:30 那趟叠了 5 小时 43 分）。
const RUNS_JQ = '.workflow_runs[].created_at';

function listCreatedAts(repo, ref) {
    const out = gh(['api', `repos/${repo}/actions/runs?branch=${encodeURIComponent(ref)}&per_page=50`,
        '--jq', RUNS_JQ]);
    const rows = (out || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const valid = rows.filter((s) => !Number.isNaN(new Date(s).getTime()));
    // 读到了行却一条都解析不出时间 = 取数口径坏了。宁可抛出去让 main 打「本轮跳过」，
    // 也绝不按「没有 run」放行：漏补下一轮还能补，重复补会顶号毁掉当天收益。
    if (rows.length && !valid.length) {
        throw new Error(`返回 ${rows.length} 行但无可解析时间（取数口径异常），样例 ${JSON.stringify(rows[0])}`);
    }
    return valid;
}

function dispatch(repo, ref, workflow) {
    gh(['api', '--method', 'POST', `repos/${repo}/actions/workflows/${workflow || WORKFLOW}/dispatches`,
        '-f', `ref=${ref}`]);
}

function main(argv) {
    const dry = argv.includes('--dry');
    const repo = process.env.GITHUB_REPOSITORY;
    const now = new Date();
    const bj = bjParts(now);
    const nowText = `${String(bj.hour).padStart(2, '0')}:${String(bj.min).padStart(2, '0')}`;

    const due = dueWaves(now);
    const selftest = process.env.GUARD_SELFTEST === '1';

    // 自检：验证 GITHUB_TOKEN 真的有 actions:write，能派发 workflow。
    // 目标选 Dispatch Guard 自身（再跑一遍守卫，不在窗口就空转退出），绝不碰 boss 链：
    // 这一步是为了不给线上留一条「看起来在守、实际派不出去」的假防线。
    if (selftest) {
        if (!repo) {
            console.error('[guard] 缺 GITHUB_REPOSITORY（形如 owner/repo）');
            return 2;
        }
        dispatch(repo, 'master', 'dispatch-guard.yml');
        console.log('[guard] 自检通过：已用 GITHUB_TOKEN 派发 Dispatch Guard 自身（不碰 boss 链）');
        return 0;
    }

    if (!due.length) {
        console.log(`[guard] 北京 ${nowText} 不在任何波次的补发检查窗口内 → 退出`);
        return 0;
    }
    if (!repo) {
        console.error('[guard] 缺 GITHUB_REPOSITORY（形如 owner/repo）');
        return 2;
    }

    let dispatched = 0;
    for (const w of due) {
        const target = waveEpoch(hmToMin(w.hm), now);
        for (const ref of REFS) {
            let createdAts;
            try {
                createdAts = listCreatedAts(repo, ref);
            } catch (e) {
                console.error(`[guard] 读 ${ref} 的 runs 失败，本轮跳过该分支: ${e.message}`);
                continue;
            }
            if (hasRunSince(createdAts, target, now.getTime())) {
                console.log(`[guard] ${w.hm} ${ref}：窗口内已有 run → 跳过`);
                continue;
            }
            console.log(`[guard] ${w.hm} ${ref}：窗口内没有 run → 补发（${w.label}）`);
            if (dry) continue;
            try {
                dispatch(repo, ref);
                dispatched++;
            } catch (e) {
                console.error(`[guard] 补发 ${ref} 失败（下一轮会再试）: ${e.message}`);
            }
        }
    }
    console.log(`[guard] 完成：本次补发 ${dispatched} 条${dry ? '（dry，未真的派发）' : ''}`);
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (e) {
        console.error('[guard] 守卫自身异常:', e && e.message);
        process.exit(1);
    }
}

module.exports = {
    WAVES, REFS, CHECK_AFTER_MIN, RUNS_JQ, bjMinuteOfDay, hmToMin, waveEpoch, dueWaves, hasRunSince,
    listCreatedAts, __setExec,
};
