// 附魔秘境解析口径单测（本地跑，`node fmsj-test.js`）—— 不登录、不碰账号
// 用 11-22 冷6 实探落盘的 25 间页面原文（fmsj-probe-coldwind6.jsonl）当样本，避免自己编文本。
const fs = require('fs');
const assert = require('assert');
const fmsj = require('./fmsj.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

const rows = fs.readFileSync('fmsj-probe-coldwind6.jsonl', 'utf8').trim().split('\n').map(JSON.parse);

console.log('[1] 条件行 / 剩余时间解析');
t('起点页能读到条件 破碎星灵:2', () => assert.strictEqual(fmsj.condLeft(rows[0].text), 2));
t('全角冒号也认', () => assert.strictEqual(fmsj.condLeft('副本条件 破碎星灵：0'), 0));
t('读不到时返回 null（不是 0，避免误判已达成）', () => assert.strictEqual(fmsj.condLeft('副本页加载中'), null));
t('副本剩余时间 60 → 60', () => assert.strictEqual(fmsj.leftMin(rows[0].text), 60));

console.log('[2] 「你看到：」段（本房间怪）只取到第一个出口前');
t('起点房间无怪 → 段内没有破碎星灵（11-22 冷1 空退的根因）',
    () => assert.ok(!/破碎星灵/.test(fmsj.seenSeg(rows[0].text)), '起点段里出现了破碎星灵：' + fmsj.seenSeg(rows[0].text)));
t('第 2 间（幻卡回廊）段内有 5 只破碎星灵',
    () => assert.strictEqual((fmsj.seenSeg(rows[1].text).match(/破碎星灵/g) || []).length, 5));
t('精英房间段内只出现该房精英，不含出口名',
    () => { const s = fmsj.seenSeg(rows[4].text); assert.ok(/精英·/.test(s), '段内没有精英怪：' + s); assert.ok(!/北：|南：|东：|西：/.test(s), '段内混进了出口：' + s); });

console.log('[3] 领奖明细解析（卡魂碎片箱 ×1 为到账硬证据）');
t('实得原文 → 卡魂碎片箱 1 / 藏宝图碎片 5',
    () => assert.deepStrictEqual(fmsj.toastOf('获得经验*0，铜币*10000，卡魂碎片箱*1，藏宝图碎片*5'), { '卡魂碎片箱': 1, '藏宝图碎片': 5 }));
t('× 与 x 混写都认', () => assert.deepStrictEqual(fmsj.toastOf('获得 卡魂碎片箱×2, 藏宝图碎片x3'), { '卡魂碎片箱': 2, '藏宝图碎片': 3 }));
t('空 toast 不报错', () => assert.deepStrictEqual(fmsj.toastOf(''), {}));

console.log('[4] 期望奖励表');
t('卡魂碎片箱 期望 1 个', () => assert.strictEqual(fmsj.FMSJ_REWARDS['卡魂碎片箱'], 1));
t('怪物名单覆盖 23 种、长名在前（避免 精英·艾斯 被短名截断）',
    () => assert.ok(fmsj.KNOWN.every((n, i) => i === 0 || fmsj.KNOWN[i - 1].length >= n.length)));

console.log('[5] 默认跳过名单（用户点名不打的怪）');
t('默认跳过 精英·泉州路霸', () => assert.ok(fmsj.SKIP.includes('精英·泉州路霸'), '不在 SKIP 里: ' + fmsj.SKIP.join(',')));
t('默认跳过 精英·巨型仙人掌', () => assert.ok(fmsj.SKIP.includes('精英·巨型仙人掌'), '不在 SKIP 里: ' + fmsj.SKIP.join(',')));
t('默认只跳过这两只（不许顺手扩大范围）',
    () => assert.deepStrictEqual([...fmsj.SKIP].sort(), ['精英·泉州路霸', '精英·巨型仙人掌'].sort()));
t('跳过名单里的名字必须在 KNOWN 里（拼写对得上才不会漏判）',
    () => { for (const s of fmsj.SKIP) assert.ok(fmsj.KNOWN.includes(s), 'KNOWN 里没有: ' + s); });
t('11-22 实探原文里第 10/11 间正是这两只（证明排除位置正确）',
    () => {
        const s10 = fmsj.seenSeg(rows[9].text), s11 = fmsj.seenSeg(rows[10].text);
        assert.ok(/精英·泉州路霸/.test(s10), '第10间不是泉州路霸: ' + s10);
        assert.ok(/精英·巨型仙人掌/.test(s11), '第11间不是巨型仙人掌: ' + s11);
    });

console.log('[6] 小号连脚本都不启动（tasks.js 派发前就拦）');
const tasks = require('./tasks.js');
t('coldwind8 判为小号 → 不启动附魔秘境', () => assert.strictEqual(tasks.isSubAccount('coldwind8'), true));
t('coldwind1 / coldwind2 / coldwind6 同样判为小号',
    () => { for (const a of ['coldwind1', 'coldwind2', 'coldwind6']) assert.strictEqual(tasks.isSubAccount(a), true, a); });
t('大号 coldwind 不是小号 → 才会启动', () => assert.strictEqual(tasks.isSubAccount('coldwind'), false));
t('空值 / 未设账号按大号处理（脚本内部还有一道拦截）',
    () => { assert.strictEqual(tasks.isSubAccount(''), false); assert.strictEqual(tasks.isSubAccount(undefined), false); });
t('require tasks.js 不会触发主流程（否则单测会真登录）',
    () => assert.strictEqual(typeof tasks.resolveMode, 'function'));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
