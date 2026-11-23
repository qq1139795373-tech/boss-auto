// 跨分支抢号的闸门：等「另一个分支上正在用这个号的 job」真的结束，再放行登录。
//
// ★ 为什么不能靠时间点（用户 2026-11-23 23:35「这个你都不考虑万一卡顿塞车之类的，确定要卡这么死」）
//   上一版写的是「冷6 在 0:25 之前不登录」，25 分钟是这么来的：
//     master 的 couple job 硬超时 20 分钟（实测 396s ≈ 7 分钟，留了 2.8 倍）+ 5 分钟缓冲。
//   这个数看着有缓冲，其实有个洞：**timeout-minutes 是从 job 真正开始跑的瞬间起算的**。
//   派发到拿到 runner 之间还有排队时间，GitHub 卡起来可以几十秒到几分钟。
//   所以「0:20 一定结束」只在「job 准时启动」时成立；一旦排队延迟，硬超时也跟着往后推，
//   0:25 那道闸门就被穿过去了 —— 而穿过去的后果是两边同时登冷6：后登的把先登的顶下线，
//   情侣副本次数已经扣了、清怪和领奖全部落空（每天只有 1 次）。
//   任何写死的钟点都躲不开这类延迟，因为延迟本身没有上界。
//
// ★ 所以改成本文件的做法：不猜，去问
//   同一个 GitHub 仓库里，另一个分支的 job 状态是**可观测的**。这里直接查 Runs API：
//   找到那个分支最近一次派发中名为 couple / form 的 job，
//     · 已经 completed  → 立刻放行（对方早结束就早走，一点都不白等）
//     · 还在 queued/in_progress → 每 15 秒问一次，等到它结束为止（慢多久等多久）
//     · 查不到这个 job  → 说明对方这趟根本没跑，放行（有 3 分钟宽限期躲开 run 创建延迟）
//     · API 本身报错    → 观测失效，退回「兜底钟点」保守等待
//   于是「卡顿塞车」不再是风险：对方慢，这边就跟着慢，不存在撞号窗口。
//
// ★ 兜底钟点（fallback）和硬顶（ceiling）各自的作用
//   fallback：只在**观测失效**（没 token / 网络不通 / 401）时才用，是「看不见就只能按最坏情况等」。
//             冷6 取 0:40 = 对方 20 分钟硬超时 + 20 分钟排队余量。
//    ceiling：连兜底都等过了还在跑，就带告警放行。不能再等下去 —— 后面还有一整套 dawn 要跑。
//             冷6 取 0:50。
//   正常路径下这两个数根本用不到（对方 0:07 就结束了），它们只是故障时的止损线。
//
// ★ 只在自己的窗口内生效
//   这个脚本挂在 matrix 的「随机错峰」后面，06:00 / 11:30 / 18:00 那三趟也会执行。
//   窗口外的判断必须留在最前面：否则 18:00 那趟会去等「第二天 0:00 的 couple」，整趟卡死。
//
// 规格串（环境变量 JOB_GATE，逗号分隔多条）：
//   acc=branch/job@fallback..ceiling#windowStart-windowEnd
//   acc 写 * 表示「这个 job 里所有号都要等」（单号 job 用它，不必写死账号名）
//   例：coldwind6=master/couple@00:40..00:50#00:00-01:00
//       *=multi-boss/form@11:50..11:55#11:25-11:59
//
// 用法（boss.yml 的步骤里）：
//   GITHUB_TOKEN=... JOB_GATE='...' node job-gate.js
const POLL_MS = 15 * 1000;        // 轮询间隔
const GRACE_MS = 3 * 60 * 1000;   // objob 查不到时的宽限期（躲开 run / job 创建延迟）
const TZ_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 时间工具（北京时间按分钟计，跨天用 [0, 1440) 的分钟数）──────────────────
function minutesOfDayBJ(nowMs) {
    const ms = ((nowMs + TZ_OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS;
    return ms / 60000;
}

function hhmm(minOfDay) {
    const m = Math.round(minOfDay * 60) / 60;              // 消掉浮点毛刺
    const h = Math.floor(m / 60);
    const mi = Math.round(m % 60);
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function parseHm(s) {
    const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60)) return null;
    return h * 60 + mi;
}

// ── 规格解析 ────────────────────────────────────────────────────────────────
// 返回 Map<acc, entry>。任何一条写错就丢掉那一条（少等一个号 << 整趟卡死的代价），
// 但会把错误收集起来交给调用方打 ::warning::，不让它悄悄失效。
// 配置漂移由 job-gate-test.js 直接读 boss.yml 断言，不靠人眼核对。
function parseGateSpec(spec, errors = []) {
    const out = new Map();
    for (const raw of String(spec || '').split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const eq = item.indexOf('=');
        if (eq <= 0) { errors.push(`缺少 "="：${item}`); continue; }
        const acc = item.slice(0, eq).trim().toLowerCase();
        const rest = item.slice(eq + 1).trim();

        const at = rest.indexOf('@');
        const hash = rest.indexOf('#');
        if (at <= 0) { errors.push(`缺少 "@兜底时刻"：${item}`); continue; }
        const target = rest.slice(0, at).trim();
        const tail = hash >= 0 ? rest.slice(at + 1, hash).trim() : rest.slice(at + 1).trim();
        const win = hash >= 0 ? rest.slice(hash + 1).trim() : '';

        const slash = target.indexOf('/');
        if (slash <= 0) { errors.push(`目标要写成 分支/job：${item}`); continue; }
        const branch = target.slice(0, slash).trim();
        const job = target.slice(slash + 1).trim();
        if (!branch || !job) { errors.push(`分支或 job 名为空：${item}`); continue; }

        const dotdot = tail.indexOf('..');
        if (dotdot < 0) { errors.push(`兜底..硬顶 格式不对：${item}`); continue; }
        const fallbackMin = parseHm(tail.slice(0, dotdot));
        const ceilingMin = parseHm(tail.slice(dotdot + 2));
        if (fallbackMin === null || ceilingMin === null) { errors.push(`时刻写成 HH:MM：${item}`); continue; }
        if (ceilingMin <= fallbackMin) { errors.push(`硬顶必须晚于兜底：${item}`); continue; }

        let windowStartMin = 0;
        let windowEndMin = 24 * 60;
        if (win) {
            const dash = win.indexOf('-');
            if (dash < 0) { errors.push(`窗口写成 HH:MM-HH:MM：${item}`); continue; }
            const a = parseHm(win.slice(0, dash));
            const b = parseHm(win.slice(dash + 1));
            if (a === null || b === null || b <= a) { errors.push(`窗口时刻非法：${item}`); continue; }
            windowStartMin = a;
            windowEndMin = b;
        }
        out.set(acc, { acc, branch, job, fallbackMin, ceilingMin, windowStartMin, windowEndMin });
    }
    return out;
}

function inWindow(nowMin, entry) {
    return nowMin >= entry.windowStartMin && nowMin < entry.windowEndMin;
}

// ── 决策（纯函数，全部逻辑都在这里，方便离线测）──────────────────────────────
// ctx: { nowMin, state, absentSinceMin }
//   state: 'done' 对方 job 已 completed
//          'running' 对方 job 还在 queued / in_progress
//          'absent' 查到了对方的 run，但里面没有这个 job
//          'error' 查不到（网络 / 鉴权 / 没有 token）
// 返回 { action: 'release' | 'wait', waitMs, reason }
function decide(ctx, entry) {
    const { nowMin, state } = ctx;
    const absentSinceMin = ctx.absentSinceMin === undefined ? null : ctx.absentSinceMin;

    if (!inWindow(nowMin, entry)) {
        return { action: 'release', reason: `不在生效窗口 ${hhmm(entry.windowStartMin)}-${hhmm(entry.windowEndMin)} 内` };
    }
    if (state === 'done') {
        return { action: 'release', reason: `${entry.branch}/${entry.job} 已结束` };
    }
    if (state === 'running') {
        if (nowMin >= entry.ceilingMin) {
            return {
                action: 'release',
                reason: `${entry.branch}/${entry.job} 到 ${hhmm(entry.ceilingMin)} 仍在跑，超过硬顶，带告警放行`,
                warn: true,
            };
        }
        return { action: 'wait', waitMs: POLL_MS, reason: `${entry.branch}/${entry.job} 仍在跑，继续等` };
    }
    if (state === 'absent') {
        // 对方的 run 在，但没有这个 job：多半是 job 还没被创建（needs 里的前置还在跑）。
        // 给它 3 分钟长出来；还是没有就当成「对方这趟不跑这个 job」，放行。
        if (absentSinceMin === null) {
            return { action: 'wait', waitMs: POLL_MS, reason: `${entry.branch} 的 run 里还没有 ${entry.job}，观察 3 分钟` };
        }
        if (nowMin - absentSinceMin >= GRACE_MS / 60000) {
            return { action: 'release', reason: `${entry.branch} 的 run 里始终没有 ${entry.job}，判定对方这趟不跑`, warn: true };
        }
        return { action: 'wait', waitMs: POLL_MS, reason: `${entry.branch} 的 run 里还没有 ${entry.job}，等它长出来` };
    }
    // state === 'error'：观测失效，只能按最坏情况等兜底钟点
    if (nowMin >= entry.fallbackMin) {
        return {
            action: 'release',
            reason: `观测失效且已到兜底时刻 ${hhmm(entry.fallbackMin)}，放行`,
            warn: true,
        };
    }
    const waitMs = Math.min(POLL_MS, (entry.fallbackMin - nowMin) * 60000);
    return { action: 'wait', waitMs: Math.max(1000, waitMs), reason: `观测失效，等到兜底时刻 ${hhmm(entry.fallbackMin)}` };
}

// ── GitHub API ──────────────────────────────────────────────────────────────
const LOOKBACK_MS = 150 * 60 * 1000;   // 只看最近 2.5 小时派发的 run（一趟一个，够用）

async function github(path, token) {
    const headers = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'boss-auto-job-gate',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} GET ${path}`);
    return res.json();
}

// 找目标分支最近一次派发（只看 LOOKBACK 内，避免拿到昨天那趟）
async function findLatestRun(repo, branch, token, nowMs) {
    const data = await github(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`, token);
    const runs = (data && data.workflow_runs) || [];
    let best = null;
    for (const r of runs) {
        const t = Date.parse(r.created_at);
        if (!Number.isFinite(t)) continue;
        if (nowMs - t > LOOKBACK_MS) continue;
        if (!best || t > best.t) best = { id: r.id, t, created: r.created_at };
    }
    return best;
}

// 返回 'running' | 'done' | 'absent'
async function jobState(repo, runId, jobName, token) {
    const data = await github(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
    const jobs = (data && data.jobs) || [];
    const want = jobName.toLowerCase();
    const hit = jobs.find((j) => String(j.name || '').toLowerCase() === want);
    if (!hit) return 'absent';
    return hit.status === 'completed' ? 'done' : 'running';
}

async function main() {
    const acc = String(process.env.GAME_ACCOUNT || '').trim().toLowerCase();
    const errors = [];
    const spec = parseGateSpec(process.env.JOB_GATE || '', errors);
    for (const e of errors) console.log(`[job-gate] ::warning::规格串有一项被丢弃 —— ${e}`);

    const entry = spec.get(acc) || spec.get('*');
    if (!entry) {
        console.log(`[job-gate] ${acc || '(无 GAME_ACCOUNT)'} 不在闸门规格里 → 不等待`);
        return 0;
    }

    const now0 = Date.now();
    if (!inWindow(minutesOfDayBJ(now0), entry)) {
        console.log(`[job-gate] ${acc} 当前不在生效窗口 ${hhmm(entry.windowStartMin)}-${hhmm(entry.windowEndMin)} → 不等待`);
        return 0;
    }

    const repo = process.env.GITHUB_REPOSITORY || '';
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    console.log(`[job-gate] ${acc} 要等 ${entry.branch}/${entry.job} 结束（repo=${repo || '?'}，鉴权=${token ? '有' : '无'}）`);

    let runId = null;
    let absentSinceMin = null;
    let lastErr = '';
    let releaseReason = '';

    for (;;) {
        const nowMs = Date.now();
        const nowMin = minutesOfDayBJ(nowMs);

        let state = 'error';
        if (!repo) {
            state = 'error';
            lastErr = '没有 GITHUB_REPOSITORY';
        } else {
            try {
                if (runId === null) {
                    const run = await findLatestRun(repo, entry.branch, token, nowMs);
                    if (!run) { state = 'absent'; lastErr = `${entry.branch} 最近 2.5 小时内没有 run`; }
                    else { runId = run.id; }
                }
                if (runId !== null) state = await jobState(repo, runId, entry.job, token);
            } catch (e) {
                state = 'error';
                lastErr = e && e.message ? e.message : String(e);
            }
        }

        if (state === 'absent' && absentSinceMin === null) absentSinceMin = nowMin;
        if (state !== 'absent') absentSinceMin = null;

        const d = decide({ nowMin, state, absentSinceMin }, entry);
        const tag = `[job-gate] ${nowMin.toFixed(1)}min 状态=${state}${lastErr ? `（${lastErr}）` : ''}`;

        if (d.action === 'release') {
            const level = d.warn ? '::warning::' : '';
            console.log(`${tag} → 放行：${level}${d.reason}`);
            releaseReason = d.reason;
            break;
        }
        console.log(`${tag} → 等待 ${Math.round(d.waitMs / 1000)}s：${d.reason}`);
        await sleep(d.waitMs);
    }

    // 留一行给 CI 日志检索用
    console.log(`[job-gate] 结束：${acc} ${releaseReason}`);
    return 0;
}

if (require.main === module) {
    main().then((c) => process.exit(c)).catch((e) => {
        // 闸门自身出错不该把 matrix 变红：告警 + 放行，撞号风险由兜底钟点和 QLLM_RESERVED 一起兜
        console.error('[job-gate] ::warning::异常，跳过等待: ' + (e && e.message));
        process.exit(0);
    });
}

module.exports = {
    parseGateSpec,
    decide,
    inWindow,
    minutesOfDayBJ,
    parseHm,
    hhmm,
    POLL_MS,
    GRACE_MS,
    LOOKBACK_MS,
};
