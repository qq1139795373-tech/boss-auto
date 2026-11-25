// farm-gate.js 的离线单测：刷怪闸门的解析与判定
// 跑法：node farm-gate-test.js
const assert = require('assert');
const { parseSkipHours, shouldSkipFarm, bjHour } = require('./farm-gate.js');

let pass = 0; let fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\n[1] 解析：逗号分隔的北京小时');
t('正常串', () => assert.deepStrictEqual(parseSkipHours('0,1,2,5,6,7'), [0, 1, 2, 5, 6, 7]));
t('带空格', () => assert.deepStrictEqual(parseSkipHours(' 0 , 6 '), [0, 6]));
t('空串 → 空数组（= 每趟都刷怪）', () => assert.deepStrictEqual(parseSkipHours(''), []));
t('undefined / null → 空数组', () => {
    assert.deepStrictEqual(parseSkipHours(undefined), []);
    assert.deepStrictEqual(parseSkipHours(null), []);
});
t('非法项被丢掉（文字 / 小数 / 越界 / 负数）', () => {
    assert.deepStrictEqual(parseSkipHours('0,abc,6.5,24,-1,23'), [0, 23]);
});
t('重复项原样保留（判定用的是 includes，不影响结果）', () => {
    assert.deepStrictEqual(parseSkipHours('6,6'), [6, 6]);
});

console.log('\n[2] 判定：某一小时是否跳过刷怪');
t('0 点在 0,1,2,5,6,7 里 → 跳过', () => assert.strictEqual(shouldSkipFarm(0, '0,1,2,5,6,7'), true));
t('6 点在里 → 跳过', () => assert.strictEqual(shouldSkipFarm(6, '0,1,2,5,6,7'), true));
t('11 点不在里 → 照常刷怪', () => assert.strictEqual(shouldSkipFarm(11, '0,1,2,5,6,7'), false));
t('18 点不在里 → 照常刷怪', () => assert.strictEqual(shouldSkipFarm(18, '0,1,2,5,6,7'), false));
t('变量为空 → 任何小时都照常刷怪（默认行为不变）', () => {
    for (let h = 0; h < 24; h++) assert.strictEqual(shouldSkipFarm(h, ''), false);
});

console.log('\n[3] 北京小时换算');
t('UTC 16:00 → 北京 0 点', () => assert.strictEqual(bjHour(Date.UTC(2026, 10, 25, 16, 0, 0)), 0));
t('UTC 22:00 → 北京 6 点', () => assert.strictEqual(bjHour(Date.UTC(2026, 10, 25, 22, 0, 0)), 6));
t('UTC 03:30 → 北京 11 点', () => assert.strictEqual(bjHour(Date.UTC(2026, 10, 25, 3, 30, 0)), 11));
t('UTC 10:00 → 北京 18 点', () => assert.strictEqual(bjHour(Date.UTC(2026, 10, 25, 10, 0, 0)), 18));
t('跨日：UTC 17:30 → 北京次日 1 点', () => assert.strictEqual(bjHour(Date.UTC(2026, 10, 25, 17, 30, 0)), 1));

console.log('\n[4] ★ 证伪：判定必须真的随变量变化');
t('同一小时，开关不同 → 结果必须不同（防「永远 true / 永远 false」）', () => {
    assert.strictEqual(shouldSkipFarm(6, '6'), true);
    assert.strictEqual(shouldSkipFarm(6, '0'), false);
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
