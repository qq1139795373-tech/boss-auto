// 跨分支 / 跨 job 抢号审计：把「每个 job 在哪个时段登录哪些账号」建成表，自动找重叠。
//
// ★ 为什么要这个文件（用户 11-23 23:27「这些其实不应该由我来提醒，我让你实现功能，你应该自己写代码再检查」）
//   账号冲突这件事靠人眼看 YAML 是看不出来的：涉及 2 个分支 × 4 个 job × 6 个账号 × 4 趟派发，
//   还有 Setup、随机错峰、hold 让路这些偏移量。之前就是靠人指出「冷6 跨分支」「form 抢大号」才发现的。
//   这里把规则写成数据 + 纯函数，跑一次就输出全部重叠区间，改 workflow 参数后重跑即可。
//
// ★ 口径
//   时间统一用「当天 0:00 起算的分钟」（可超过 1440，表示跨到次日）。
//   所有区间取**最坏情况**（Setup 取上限、错峰取 300s、重试取满），只要最坏不重叠就算安全。
//   一个账号在同一分钟被两个不同 job 占着 = 冲突（两边会互相顶掉会话，输的那个流程作废）。
//
// ★ 隔离手段怎么体现
//   · needs 串行   → 后一个 job 的 from 直接写成前一个的 to（不是靠假设）
//   · hold 让路    → 被让路的那个号 from 取 max(自身就绪, hold 时刻)
//   · 空跑         → 判窗口退出的 job（accounts 为空）不进表
//
// 用法：node conflict-audit.js          输出审计表，有冲突则 exit 1
const TZ_OFFSET_MS = 8 * 3600e3;
const DAY_MIN = 24 * 60;

// 四趟派发的北京时间（分钟）：0:00 / 06:00 / 11:30 / 18:00
const DISPATCHES = [0, 6 * 60, 11 * 60 + 30, 18 * 60];

// 实测/推算常量（改这些等于改结论，改动前先看注释）
const SETUP_WORST = 3;            // checkout + setup-node + npm install + playwright install 上限
const MASTER_COUPLE = 25;         // 大号+冷6：Setup 3 + 清怪预算 20 + 两段领奖 2（最坏，不是实测 396s）
const MB_COUPLE = 2 * (20 + 2);   // 2 对 × (清怪预算 20 + 两段领奖 2) = 44 分钟（最坏）
const MB_COUPLE_WITH_SETUP = SETUP_WORST + MB_COUPLE;   // ≈ 26.9
const JITTER_WORST = 5;           // matrix 的随机错峰 RANDOM % 300
const FORM_BODY = 3;              // team5-form 165s；失败重试 3 轮最坏约 5 分钟，这里取 3 分钟常态
const FORM_RETRY_WORST = 5;
const JOB_CAP = 360;              // GitHub 托管 runner 单 job 硬上限 6 小时
// job-gate.js：冷6 要等 master 的 couple job **真的结束**（不猜钟点），最坏 = 06:00 + 25 分钟硬顶
const COLD6_GATE_UNTIL = 6 * 60 + 25;
// job-gate.js：master 的 boss 要等 multi-boss 的 form job 结束（实测 3m40s，3 轮重试最坏 ≈ 8 分钟）
const FORM_GATE_UNTIL = 11 * 60 + 30 + 8;
const FORM_HOLD_UNTIL = FORM_GATE_UNTIL;   // 兼容旧引用

// ★ 口径补充：farm 类 job 的 to 截到「下一次派发时刻」，不是 6 小时上限。
//   原因：下一趟派发后会有号来登，farm 检测到自己被顶（且距派发点 ≤40 分钟）就判定为 CI 交接、
//   主动退场（dispatch-window.js + farm.js），这是设计好的让位，不是抢号。
//   所以 farm 的「下一趟接管前的残余 1~3 分钟」不算结构性冲突——那 40 分钟窗口就是为它准备的。
//   结构性冲突的定义是：**两个 job 都认为自己该独占这个号，而且都不该让**。
const nextDispatchOf = (d) => {
    const i = DISPATCHES.indexOf(d);
    if (i < 0) return d + DAY_MIN;
    return i === DISPATCHES.length - 1 ? DISPATCHES[0] + DAY_MIN : DISPATCHES[i + 1];
};

// ── job 表：accs 为空 = 该趟判窗口退出、不登任何号（不进审计） ─────────────────
// from/to 是「从派发时刻起算的偏移分钟」，dispatchAt 决定它在哪几趟真跑。
const JOBS = [
    {
        id: 'master/couple',
        branch: 'master',
        desc: '情侣迷宫 大号(队长,清怪) + 冷6(队员)',
        dispatchAt: [6 * 60],                 // ★ 用户 11-23 23:39：挪到 06:00 趟（那趟没有副本在跑）
        accs: ['coldwind', 'coldwind6'],
        from: SETUP_WORST,
        to: SETUP_WORST + MASTER_COUPLE,      // ≈ 28
    },
    {
        id: 'master/boss',
        branch: 'master',
        desc: '大号 tasks(11 步) → boss → farm',
        // 06:00 趟排在 couple 之后（needs）；11:30 趟等 multi-boss 的 form 组完队
        dispatchAt: DISPATCHES,
        accs: ['coldwind'],
        from: (d) => {
            if (d === 6 * 60) return SETUP_WORST + MASTER_COUPLE + 0.2;  // couple 结束才开始
            if (d === 11 * 60 + 30) return FORM_GATE_UNTIL - d;          // ★ job-gate：等 form 真结束
            return 0.3;
        },
        to: (d) => nextDispatchOf(d) - d,     // 刷到下一趟派发，之后让位
    },
    {
        id: 'multi-boss/couple',
        branch: 'multi-boss',
        desc: '情侣迷宫 冷0+冷8、冷1+冷2（串行两对）',
        dispatchAt: [6 * 60],                 // ★ 同 master，挪到 06:00 趟
        accs: ['coldwind0', 'coldwind8', 'coldwind1', 'coldwind2'],
        from: SETUP_WORST,
        to: MB_COUPLE_WITH_SETUP,             // ≈ 47
    },
    {
        id: 'multi-boss/form',
        branch: 'multi-boss',
        desc: '组 5 人队（队长冷8，队员 大号/冷0/冷1/冷2）',
        // 窗口 11:15-11:55：只有 11:30 那趟真跑；0:00/06:00/18:00 判窗口退出
        dispatchAt: [11 * 60 + 30],
        accs: ['coldwind', 'coldwind8', 'coldwind0', 'coldwind1', 'coldwind2'],
        from: SETUP_WORST,
        to: SETUP_WORST + FORM_RETRY_WORST,   // 最坏：3 轮重试全用完
    },
    {
        id: 'multi-boss/matrix',
        branch: 'multi-boss',
        desc: '5 个号各一个 runner：tasks(10 步) → boss → farm',
        // matrix 等 couple + form 都结束（boss.needs = [prepare, form, couple]）
        dispatchAt: DISPATCHES,
        accs: ['coldwind0', 'coldwind1', 'coldwind2', 'coldwind6', 'coldwind8'],
        from: (d, acc) => {
            let wait = 0.3;
            if (d === 6 * 60) wait = MB_COUPLE_WITH_SETUP;                  // 等两对情侣跑完
            if (d === 11 * 60 + 30) wait = SETUP_WORST + FORM_RETRY_WORST;  // 等 form 组完队
            let start = wait + SETUP_WORST + JITTER_WORST;                  // 自身 Setup + 错峰
            // ★ 冷6：它是 master 那对的队员，06:00 那趟要等 master 的 couple job 真结束（job-gate）
            if (acc === 'coldwind6' && d === 6 * 60) start = Math.max(start, COLD6_GATE_UNTIL);
            return start;
        },
        to: (d) => nextDispatchOf(d) - d,     // 刷到下一趟派发，之后让位
    },
];

// 纯函数：某个 job 在某一趟派发时的绝对区间 [from, to]（分钟，从当天 0:00 起算）
function spanOf(job, dispatchMin, acc) {
    const f = typeof job.from === 'function' ? job.from(dispatchMin, acc) : job.from;
    const t = typeof job.to === 'function' ? job.to(dispatchMin, acc) : job.to;
    return [dispatchMin + f, dispatchMin + t];
}

// 纯函数：把 job 表展开成 [{acc, job, from, to}]
function expand(jobs = JOBS) {
    const rows = [];
    for (const job of jobs) {
        for (const d of job.dispatchAt) {
            for (const acc of job.accs) {
                const [from, to] = spanOf(job, d, acc);
                rows.push({ acc, job: job.id, desc: job.desc, dispatch: d, from, to });
            }
        }
    }
    return rows;
}

// 纯函数：找同一账号的重叠区间。允许 1 秒的边界容差（首尾相接不算重叠）。
function findConflicts(rows = expand()) {
    const out = [];
    const byAcc = new Map();
    for (const r of rows) {
        if (!byAcc.has(r.acc)) byAcc.set(r.acc, []);
        byAcc.get(r.acc).push(r);
    }
    for (const [acc, list] of byAcc) {
        const sorted = list.slice().sort((a, b) => a.from - b.from);
        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const a = sorted[i];
                const b = sorted[j];
                if (a.job === b.job) continue;                 // 同一个 job 的不同趟不互斥（派发间隔足够）
                const s = Math.max(a.from, b.from);
                const e = Math.min(a.to, b.to);
                if (e - s > 0.02) {                            // 超过 1 秒才算真重叠
                    out.push({ acc, a, b, overlap: [s, e], minutes: e - s });
                }
            }
        }
    }
    return out.sort((x, y) => x.overlap[0] - y.overlap[0]);
}

const fmt = (min) => {
    const total = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
    const h = Math.floor(total / 60);
    const m = Math.floor(total % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${min >= DAY_MIN ? '(次日)' : ''}`;
};
const fmtSpan = (r) => `${fmt(r.from)}~${fmt(r.to)}`;

function main() {
    const rows = expand();
    console.log('[conflict-audit] 账号占用表（最坏情况，分钟精度）\n');
    const byAcc = new Map();
    for (const r of rows) {
        if (!byAcc.has(r.acc)) byAcc.set(r.acc, []);
        byAcc.get(r.acc).push(r);
    }
    for (const acc of ['coldwind', 'coldwind6', 'coldwind0', 'coldwind1', 'coldwind2', 'coldwind8']) {
        const list = (byAcc.get(acc) || []).sort((a, b) => a.from - b.from);
        if (!list.length) continue;
        console.log(`── ${acc}`);
        for (const r of list) console.log(`   ${fmtSpan(r)}  ${r.job.padEnd(22)} ${r.desc}`);
        console.log('');
    }

    const conflicts = findConflicts(rows);
    if (!conflicts.length) {
        console.log('[conflict-audit] ✅ 无重叠：任何一分钟都不存在两个 job 同时占同一个号');
        return 0;
    }
    console.log(`[conflict-audit] ❌ 发现 ${conflicts.length} 处重叠：\n`);
    for (const c of conflicts) {
        console.log(`   ${c.acc}  ${fmt(c.overlap[0])}~${fmt(c.overlap[1])}（${c.minutes.toFixed(1)} 分钟）`);
        console.log(`      A: ${c.a.job}  ${fmtSpan(c.a)}`);
        console.log(`      B: ${c.b.job}  ${fmtSpan(c.b)}`);
    }
    return 1;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = { JOBS, DISPATCHES, spanOf, expand, findConflicts, SETUP_WORST, MASTER_COUPLE, MB_COUPLE_WITH_SETUP, COLD6_GATE_UNTIL, FORM_GATE_UNTIL, FORM_HOLD_UNTIL };
