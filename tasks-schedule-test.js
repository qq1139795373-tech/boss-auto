// 攻城时间判定单测（离线，不登录、不联网）
//   node tasks-schedule-test.js
// 被测：tasks.js 的 gongchengPlan(nowMs) —— 纯函数，只吃一个时间戳，吐出「等 / 直接打 / 不打」。
// 为什么单独抽出来测：这段判断错一天，就等于白占一个号的 2 小时（用户 11-22 明确接受的那 2 小时），
// 所以星期几、20:00 边界、20:30 截止这三处都用固定时间戳钉死。
const assert = require('assert');
// 必须先清掉环境里的 TASKS_MODE：resolveMode 在 auto 模式下才按时间算，否则恒返回强制值
delete process.env.TASKS_MODE;
const { gongchengPlan, resolveMode, gongchengWaitEnabled } = require('./tasks.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// 北京时间 → 真实 UTC 时间戳（北京 = UTC+8）
const bj = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);
// 2026-11-22 是周日，所以 11-24 周二、11-28 周六、11-23 周一
const TUE = [2026, 11, 24], SAT = [2026, 11, 28], SUN = [2026, 11, 22], MON = [2026, 11, 23];

console.log('[1] 周二/周六 18:00 之后要等到 19:55 提前出发（不是等到 20:00 才开始）');
t('周二 18:05 → wait，等约 110 分钟', () => {
    const p = gongchengPlan(bj(...TUE, 18, 5));
    assert.strictEqual(p.action, 'wait');
    assert.strictEqual(Math.round(p.waitMs / 60000), 110);
});
t('周六 18:00:00 整 → wait，正好 6900000ms（19:55-18:00）', () => {
    const p = gongchengPlan(bj(...SAT, 18, 0));
    assert.strictEqual(p.action, 'wait');
    assert.strictEqual(p.waitMs, 6900000);
});
t('周二 19:54:30 → wait，只剩 30 秒（19:55 前不出发）', () => {
    const p = gongchengPlan(bj(...TUE, 19, 54, 30));
    assert.strictEqual(p.action, 'wait');
    assert.strictEqual(p.waitMs, 30000);
});

console.log('[2] 19:55 就出发（到城门刷新等 20:00），20:00 之后照常直接打');
t('周二 19:55:00 → run（提前出发，给登录+出航+航行留 5 分钟）', () => {
    assert.strictEqual(gongchengPlan(bj(...TUE, 19, 55)).action, 'run');
});
t('周二 19:59:30 → run（此时出发已经偏晚，但不能再等）', () => {
    assert.strictEqual(gongchengPlan(bj(...TUE, 19, 59, 30)).action, 'run');
});
t('周二 20:00:00 → run', () => {
    assert.strictEqual(gongchengPlan(bj(...TUE, 20, 0)).action, 'run');
});
t('周六 20:10 → run（窗口内）', () => {
    assert.strictEqual(gongchengPlan(bj(...SAT, 20, 10)).action, 'run');
});
t('周二 20:29 → run（截止前一分钟仍要打）', () => {
    assert.strictEqual(gongchengPlan(bj(...TUE, 20, 29)).action, 'run');
});

console.log('[3] 过了窗口就不打，别白等');
t('周二 20:31 → skip', () => {
    const p = gongchengPlan(bj(...TUE, 20, 31));
    assert.strictEqual(p.action, 'skip');
    assert.ok(/20:30/.test(p.reason), p.reason);
});
t('周二 22:00 → skip', () => {
    assert.strictEqual(gongchengPlan(bj(...TUE, 22, 0)).action, 'skip');
});

console.log('[4] 非周二/周六 一律不打（含周日、周一）');
t('周日 18:05 → skip', () => {
    assert.strictEqual(gongchengPlan(bj(...SUN, 18, 5)).action, 'skip');
});
t('周一 19:30 → skip', () => {
    assert.strictEqual(gongchengPlan(bj(...MON, 19, 30)).action, 'skip');
});
t('周三 19:30 → skip', () => {
    assert.strictEqual(gongchengPlan(bj(2026, 11, 25, 19, 30)).action, 'skip');
});

console.log('[5] 任何时刻都必须给出三选一的 action，且 waitMs 非负');
t('0:00~23:59 每隔 7 分钟扫一天，全都有确定结果', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
        const ts = bj(...TUE, 0, 0) + m * 60000;
        const p = gongchengPlan(ts);
        assert.ok(['run', 'wait', 'skip'].includes(p.action), `动作非法: ${p.action}`);
        assert.ok(p.waitMs >= 0, `waitMs 为负: ${p.waitMs}`);
        assert.ok(typeof p.reason === 'string' && p.reason.length > 0, '缺少原因说明');
    }
});
t('wait 只在 19:55 之前出现，run 只在 19:55~20:29 出现', () => {
    for (let m = 0; m < 24 * 60; m++) {
        const p = gongchengPlan(bj(...TUE, 0, 0) + m * 60000);
        const hm = m;
        if (p.action === 'wait') assert.ok(hm < 19 * 60 + 55, `19:55 之后还 wait: ${hm}`);
        if (p.action === 'run') assert.ok(hm >= 19 * 60 + 55 && hm < 20 * 60 + 30, `run 出现在 ${hm} 分`);
    }
});

console.log('[6] 派发晚到也能接上：dusk 窗口 18:00-19:55（不区分星期）');
t('18:00 / 18:05 / 18:30 / 18:59 / 19:00 / 19:55 全部判为 dusk', () => {
    const cases = [[18, 0], [18, 5], [18, 30], [18, 59], [19, 0], [19, 55]];
    for (const [h, m] of cases) {
        assert.strictEqual(resolveMode(h, m, 2), 'dusk', `${h}:${m} 不是 dusk`);
        assert.strictEqual(resolveMode(h, m, 0), 'dusk', `${h}:${m} 周日也应当 dusk（山寨每天都跑）`);
    }
});
t('19:56 之后不再当 dusk（赶不上 20:00 了）', () => {
    assert.strictEqual(resolveMode(19, 56, 2), 'skip');
    assert.strictEqual(resolveMode(19, 59, 2), 'skip');
});
t('20:00~20:30 周二/六 是 gongcheng，其他星期是 skip', () => {
    assert.strictEqual(resolveMode(20, 0, 2), 'gongcheng');
    assert.strictEqual(resolveMode(20, 30, 6), 'gongcheng');
    assert.strictEqual(resolveMode(20, 31, 2), 'skip');
    assert.strictEqual(resolveMode(20, 0, 0), 'skip');
});
t('其余时段仍是 skip，0 点档仍是 dawn', () => {
    assert.strictEqual(resolveMode(17, 59, 2), 'skip');
    assert.strictEqual(resolveMode(21, 0, 2), 'skip');
    assert.strictEqual(resolveMode(0, 30, 2), 'dawn');
});

console.log('[7] 不想等那两小时时用开关关掉，而不是去页面上取消 run');
t('未传 / 空值 / true → 照常等（默认行为不变）', () => {
    assert.strictEqual(gongchengWaitEnabled(undefined), true);
    assert.strictEqual(gongchengWaitEnabled(null), true);
    assert.strictEqual(gongchengWaitEnabled(''), true);
    assert.strictEqual(gongchengWaitEnabled('true'), true);
    assert.strictEqual(gongchengWaitEnabled('TRUE'), true);
    assert.strictEqual(gongchengWaitEnabled(' 1 '), true);
});
t('0 / false / no / off / skip（大小写、空格不限）→ 关闭等待', () => {
    for (const v of ['0', 'false', 'False', ' FALSE ', 'no', 'off', 'skip']) {
        assert.strictEqual(gongchengWaitEnabled(v), false, `${JSON.stringify(v)} 应当关闭等待`);
    }
});
t('★ workflow_dispatch 的 boolean 输入落到 env 是 "false" 字符串，必须能关掉', () => {
    // 只判 === '0' 的老写法在这里会当成「开着」，白等两小时
    assert.strictEqual(gongchengWaitEnabled(String(false)), false);
    assert.strictEqual(gongchengWaitEnabled(String(true)), true);
});

console.log('[8] dawn 窗口延长到 03:00（11-22：加入奔月/海盗王后整趟变长）');
t('0:00 / 0:30 / 1:00 / 2:00 / 2:59 全部判为 dawn', () => {
    const cases = [[0, 0], [0, 30], [0, 59], [1, 0], [2, 0], [2, 59]];
    for (const [h, m] of cases) {
        assert.strictEqual(resolveMode(h, m, 2), 'dawn', `${h}:${m} 不是 dawn`);
        // 星期不应影响 dawn（每天 0 点这趟都要跑）
        assert.strictEqual(resolveMode(h, m, 0), 'dawn', `${h}:${m} 周日也应当 dawn`);
    }
});
t('3:00 起不再是 dawn（已经赶不上这趟）', () => {
    assert.strictEqual(resolveMode(3, 0, 2), 'skip');
    assert.strictEqual(resolveMode(3, 59, 2), 'skip');
});
t('延长 dawn 没有吃掉 dusk / 中午那趟的边界', () => {
    // 中午 11:30 派发（11-22 从 11:50 提前）：tasks.js 必须跳过，boss 交给 index.js；
    // 11:50 也照样跳过 —— 无论派发时刻落在这两个中的哪个，都不能误跑 dawn/dusk 流程。
    assert.strictEqual(resolveMode(11, 30, 2), 'skip');
    assert.strictEqual(resolveMode(11, 50, 2), 'skip');
    assert.strictEqual(resolveMode(12, 0, 2), 'skip');
    assert.strictEqual(resolveMode(18, 0, 2), 'dusk');
    assert.strictEqual(resolveMode(19, 55, 2), 'dusk');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
