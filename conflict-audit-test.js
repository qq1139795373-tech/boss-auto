// conflict-audit.js 的离线单测。
//
// 除了「当前模型无重叠」，还必须证明**审计器真的能抓到问题**——
// 一个永远返回「无冲突」的检查器等于没检查（假阴性比假阳性更危险）。
// 所以下面有一组「证伪」用例：把 job-gate 的等待拿掉，必须报出冲突。
//
// 用法：node conflict-audit-test.js
const assert = require('assert');
const audit = require('./conflict-audit.js');

let n = 0;
let bad = 0;
function t(name, fn) {
    n++;
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (e) { bad++; console.log(`  ✗ ${name}\n      ${e && e.message}`); }
}

const clone = () => JSON.parse(JSON.stringify(audit.JOBS, (k, v) => (typeof v === 'function' ? { __fn: v.toString() } : v)));
// 上面的 JSON 克隆会把函数变成对象，这里改用结构化重建：只改数字字段，函数用原样引用
function withPatched(patches) {
    return audit.JOBS.map((j) => {
        const p = patches[j.id];
        if (!p) return j;
        return { ...j, ...p };
    });
}

console.log('[conflict-audit] 当前真实配置');

t('★ 当前配置零重叠（任何一分钟都不存在两个 job 同占一个号）', () => {
    const c = audit.findConflicts(audit.expand());
    if (c.length) {
        throw new Error(c.map((x) => `${x.acc} ${x.a.job} vs ${x.b.job} @${x.overlap[0].toFixed(0)}`).join('；'));
    }
});
t('冷6 的 06:00 那趟：master/couple 与 multi-boss/matrix 之间有足够间隔', () => {
    // 情侣副本 11-23 23:39 已从 0:00 挪到 06:00。冷6 走 job-gate（等 master 的 couple job 真结束），
    // 所以这里断言的是「最坏情况下仍有间隔」——闸门兜住的是 master 超时到 25 分钟的那种故障。
    const rows = audit.expand().filter((r) => r.acc === 'coldwind6' && r.from < 1440);
    const couple = rows.find((r) => r.job === 'master/couple');
    const matrix = rows.find((r) => r.job === 'multi-boss/matrix' && r.dispatch === 6 * 60);
    assert.ok(couple && matrix, '06:00 那趟没找到冷6 的 couple / matrix 区间');
    assert.ok(matrix.from - couple.to >= 10, `间隔只有 ${(matrix.from - couple.to).toFixed(1)} 分钟`);
});
t('大号在 11:30 那趟：form 结束到 boss 登录之间有空隙', () => {
    const rows = audit.expand().filter((r) => r.acc === 'coldwind');
    const form = rows.find((r) => r.job === 'multi-boss/form');
    const boss = rows.find((r) => r.job === 'master/boss' && r.dispatch === 11 * 60 + 30);
    assert.ok(form && boss);
    assert.ok(boss.from >= form.to, `boss 在 ${boss.from} 登录，form 还在 ${form.to} 才结束`);
});
t('每个号每天都被用到（没有漏配的号）', () => {
    const accs = new Set(audit.expand().map((r) => r.acc));
    for (const a of ['coldwind', 'coldwind0', 'coldwind1', 'coldwind2', 'coldwind6', 'coldwind8']) {
        assert.ok(accs.has(a), `${a} 不在任何 job 里`);
    }
});

console.log('[conflict-audit] ★ 证伪：把隔离手段拿掉，审计器必须报出冲突');

t('★ 去掉 job-gate（大号 11:30 立刻登）→ 必须报 form 与大号的冲突', () => {
    const jobs = withPatched({
        'master/boss': {
            from: (d) => {
                if (d === 0) return audit.SETUP_WORST + audit.MASTER_COUPLE + 0.2;
                return 0.3;      // ← 去掉 job-gate
            },
        },
    });
    const c = audit.findConflicts(audit.expand(jobs));
    assert.ok(c.some((x) => x.acc === 'coldwind'), '审计器没发现「大号被 form 和 boss 同时登录」');
});

t('★ 去掉冷6 闸门 → 必须报冷6 的冲突（两边同时出故障的最坏组合）', () => {
    // 冷6 真正危险的不是「两边都正常」（正常时 matrix 要 34.9 分钟才登，master 早完了），
    // 而是下面这个组合，两道故障叠在一起：
    //   · master 那对卡住跑满 25 分钟硬超时（06:03~06:28）
    //   · multi-boss 的两对在第 4 分钟就失败退出 → matrix 提前到 06:12 启动
    // 这时 matrix 06:12 登冷6，master 还在用 → 撞。job-gate 把冷6 压到 06:25 之后就是为这个场景准备的。
    const faulty = (withHold) => withPatched({
        'master/couple': { to: 25 },                        // ← 模拟 master 那对跑满 25 分钟硬超时
        'multi-boss/couple': { to: 4 },                     // ← 模拟两对快速失败退出（06:04 就结束）
        'multi-boss/matrix': {
            from: (d, acc) => {
                if (d === 6 * 60) {
                    const base = 4 + audit.SETUP_WORST + 5;            // 06:12，matrix 提前起来了
                    return withHold && acc === 'coldwind6' ? Math.max(base, audit.COLD6_GATE_UNTIL) : base;
                }
                return 0.3 + audit.SETUP_WORST + 5;
            },
        },
    });

    const bad1 = audit.findConflicts(audit.expand(faulty(false)));
    assert.ok(bad1.some((x) => x.acc === 'coldwind6'), '审计器没发现「冷6 被超时的 couple 和提前启动的 matrix 同时登录」');

    const ok1 = audit.findConflicts(audit.expand(faulty(true)));
    assert.ok(!ok1.some((x) => x.acc === 'coldwind6'), '加了 gate 之后冷6 仍报冲突 → COLD6_GATE_UNTIL(06:25) 小于 master 的最晚释放(06:28)? 需要重算');
});

t('★ 证伪可控：故意让两个 job 完全重合 → 必须报出来（防止检查器被改成永远放行）', () => {
    const jobs = withPatched({
        'master/couple': { to: 100 },     // 情侣跑到 00:43
    });
    const c = audit.findConflicts(audit.expand(jobs));
    assert.ok(c.length > 0, '审计器连「明显全重合」都报不出来，说明检查逻辑失效');
});

console.log(`\n[conflict-audit-test] ${n - bad}/${n} 通过${bad ? `，${bad} 项失败` : ''}`);
process.exit(bad ? 1 : 0);
