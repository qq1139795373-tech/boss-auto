// farm-budget.js 的离线单测：刷怪预算 = 到下一个派发节点前 5 分钟
// 跑法：node farm-budget-test.js
const assert = require('assert');
const { farmBudgetMin, bjMinuteOf, NODE_MINUTES, FORWARD_GAP_MIN } = require('./farm-budget.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
// 北京 2026-11-22 h:m → 对应 UTC 时间戳
const bj = (h, m) => Date.UTC(2026, 10, 22, h - 8, m, 0);

console.log('[1] 实际派发趟次的预算（按 11-22 定稿的时刻表）');
// 11:30 这趟：farm 是 boss 打完立刻起跑（Run Farm 紧接 Run Boss）。10 次挑战每次 30 秒冷却，
// 最早 11:36 开打 → 约 11:42 结束；最晚 11:44 开打 → 约 11:50 结束。所以起跑区间是 11:42~11:50。
t('11:30 派发、11:42 打完立刻起跑 → 刷到 17:55，共 373 分钟', () => assert.strictEqual(farmBudgetMin(bj(11, 42)), 373));
t('11:30 派发、11:50 最晚打完起跑 → 刷到 17:55，共 365 分钟', () => assert.strictEqual(farmBudgetMin(bj(11, 50)), 365));
t('对照：万一真拖到 12:29 才起跑 → 只剩 326 分钟（仍不为负）', () => assert.strictEqual(farmBudgetMin(bj(12, 29)), 326));
t('18:00 派发、18:35 起跑 → 刷到 23:55，共 320 分钟', () => assert.strictEqual(farmBudgetMin(bj(18, 35)), 320));
t('18:00 派发 + 周二六攻城到 20:30、20:35 起跑 → 200 分钟', () => assert.strictEqual(farmBudgetMin(bj(20, 35)), 200));
t('00:00 派发、01:15 起跑（dawn 任务跑完）→ 刷到 05:55，共 280 分钟', () => assert.strictEqual(farmBudgetMin(bj(1, 15)), 280));
t('06:00 派发、06:15 起跑 → 刷到 11:25，共 310 分钟', () => assert.strictEqual(farmBudgetMin(bj(6, 15)), 310));

console.log('\n[1b] 同一趟派发：起跑越早预算越长（收尾点恒为 17:55）');
t('11:36→11:59 逐分扫描：预算严格递减 1 分钟，收尾恒在 17:55', () => {
    for (let m = 11 * 60 + 36; m <= 11 * 60 + 59; m++) {
        const v = farmBudgetMin(bj(Math.floor(m / 60), m % 60));
        assert.strictEqual(v, 18 * 60 - 5 - m, `${Math.floor(m / 60)}:${m % 60} 应为 ${18 * 60 - 5 - m}，实得 ${v}`);
        assert.strictEqual(m + v, 18 * 60 - 5, '收尾点必须恒为 17:55');
    }
});

console.log('\n[2] 「前 5 分钟」这条边界的精确位置');
t('17:55 起跑 → 0 分钟（正好卡在 5 分钟间隔上）', () => assert.strictEqual(farmBudgetMin(bj(17, 55)), 0));
t('17:54 起跑 → 只剩 1 分钟', () => assert.strictEqual(farmBudgetMin(bj(17, 54)), 1));
t('11:29 起跑 → 0（1 分钟后就是节点，别开新循环）', () => assert.strictEqual(farmBudgetMin(bj(11, 29)), 0));
t('11:31 起跑 → 跳到 18:00，384 分钟', () => assert.strictEqual(farmBudgetMin(bj(11, 31)), 384));

console.log('\n[3] 跨天与深夜');
t('23:58 起跑 → 0（次日 00:00 就在眼前）', () => assert.strictEqual(farmBudgetMin(bj(23, 58)), 0));
t('00:05 起跑 → 下一个节点 06:00，350 分钟', () => assert.strictEqual(farmBudgetMin(bj(0, 5)), 350));
t('23:00 起跑 → 60-5=55 分钟（跨到次日 00:00）', () => assert.strictEqual(farmBudgetMin(bj(23, 0)), 55));

console.log('\n[4] 不变量：任何时刻都不为负、不超 job 余量');
t('全天 1440 分钟逐分扫描：结果恒在 0~385 且等于 (下一节点-当前-5)', () => {
    for (let m = 0; m < 1440; m++) {
        const v = farmBudgetMin(bj(Math.floor(m / 60), m % 60));
        assert.ok(v >= 0, `${m} 分算出负数 ${v}`);
        assert.ok(v <= 385, `${m} 分算出 ${v}，超过最大值 385`);
        const nextNode = NODE_MINUTES.find((n) => n > m);
        const expect = Math.max(0, (nextNode === undefined ? 1440 : nextNode) - m - FORWARD_GAP_MIN);
        assert.strictEqual(v, expect, `${m} 分期望 ${expect} 实得 ${v}`);
    }
});
t('每个节点前 5 分钟都恰好归零（4 个节点各验一次，00:00 取前一天的 23:55）', () => {
    for (const n of NODE_MINUTES) {
        const prev = (n - 5 + 1440) % 1440;
        const h = Math.floor(prev / 60), mm = prev % 60;
        assert.strictEqual(farmBudgetMin(bj(h, mm)), 0, `${h}:${mm} 应为 0`);
    }
});

console.log('\n[5] bjMinuteOf 时区换算');
t('UTC 04:15 → 北京 12:15 → 第 735 分钟', () => assert.strictEqual(bjMinuteOf(Date.UTC(2026, 10, 22, 4, 15)), 735));
t('UTC 16:00 → 北京次日 00:00 → 第 0 分钟', () => assert.strictEqual(bjMinuteOf(Date.UTC(2026, 10, 22, 16, 0)), 0));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
