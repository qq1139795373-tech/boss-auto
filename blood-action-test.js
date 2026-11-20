// 血池 0 处置决策单测（不联网、不登录、不碰真号）
// 锁的是 2026-11-20 两次修正后的策略：
//   有药 → 补药再打；补不成（没药 / 背包打不开 / 没切到药水页 / 读不到）→ 一律硬打，
//   战死复活一次后领奖。不再有 'giveup'（从不提前放弃）。
// 用法：node blood-action-test.js
const { bloodAction, bloodItemGone } = require('./dungeon-recover.js');

const CASES = [
    // [说明, 入参, 期望]
    ['血池有值 → 直接打', { blood: 500 }, 'fight'],
    ['血池读不到(null) → 照常打', { blood: null }, 'fight'],
    ['血池 0 + 有药补成功 → 补药再打', { blood: 0, healOk: true }, 'heal'],
    ['血池 0 + 已在硬打 → 继续出刀', { blood: 0, hardMode: true }, 'fight'],
    ['血池 0 + 补过 1 个仍是 0 → 硬打（不放弃）', { blood: 0, healedOnce: true, healReason: 'no-item' }, 'hard'],
    ['血池 0 + 药水页真没药(no-item) → 硬打', { blood: 0, healReason: 'no-item' }, 'hard'],
    ['血池 0 + 包裹打不开(no-bag) → 硬打（用户 22:45）', { blood: 0, healReason: 'no-bag' }, 'hard'],
    ['血池 0 + 没切到药水页 → 硬打（用户 22:45）', { blood: 0, healReason: 'no-potion-tab' }, 'hard'],
    ['血池 0 + 血池读失败 → 硬打', { blood: 0, healReason: 'no-blood-read' }, 'hard'],
    ['血池 0 + 补药后点不回怪 → 硬打', { blood: 0, healReason: 'click-back-fail' }, 'hard'],
    ['血池 0 + 未知 reason → 硬打', { blood: 0, healReason: 'whatever' }, 'hard'],
    ['空入参（blood 缺失=读不到血池）→ 照常打', {}, 'fight'],
];

let pass = 0;
const fails = [];
for (const [name, input, expect] of CASES) {
    const got = bloodAction(input);
    if (got === expect) { pass++; console.log(`  ✔ ${name} → ${got}`); }
    else { fails.push(`${name}: 期望 ${expect}，实际 ${got}`); console.log(`  ✘ ${name}: 期望 ${expect}，实际 ${got}`); }
}

// 关键不变量：任何输入都不允许返回 'giveup'（提前放弃这只怪）
const NEVER = [
    { blood: 0 }, { blood: 0, healReason: 'no-bag' }, { blood: 0, healedOnce: true },
    { blood: 0, hardMode: false, healOk: false, healReason: 'no-potion-tab' },
];
for (const input of NEVER) {
    const got = bloodAction(input);
    if (got !== 'giveup') { pass++; console.log(`  ✔ 永不放弃 ${JSON.stringify(input)} → ${got}`); }
    else { fails.push(`出现 giveup: ${JSON.stringify(input)}`); console.log(`  ✘ 出现 giveup: ${JSON.stringify(input)}`); }
}

// bloodItemGone 白名单：只认「药水页确实没有体力宝」，仅影响日志措辞
const GONE = [['no-item', true], ['no-bag', false], ['no-potion-tab', false], ['no-blood-read', false], ['', false], [undefined, false]];
for (const [reason, expect] of GONE) {
    const got = bloodItemGone(reason);
    if (got === expect) { pass++; console.log(`  ✔ bloodItemGone(${JSON.stringify(reason)}) = ${got}`); }
    else { fails.push(`bloodItemGone(${JSON.stringify(reason)}): 期望 ${expect}，实际 ${got}`); console.log(`  ✘ bloodItemGone(${JSON.stringify(reason)}): 期望 ${expect}，实际 ${got}`); }
}

const total = CASES.length + NEVER.length + GONE.length;
console.log(`\n===== ${pass}/${total} 通过 =====`);
if (fails.length) { console.log('失败项:\n' + fails.map((f) => ' - ' + f).join('\n')); process.exit(1); }
