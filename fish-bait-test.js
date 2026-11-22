// 钓鱼买饵 / 银贝读数回归测试（2026-11-23）
//
// 背景：11-22 无头日志出现两行连着的问题 ——
//   478 滚到底未见鱼饵 = 库存0
//   479 库存0，补齐100个
//   480 鱼老板页未读到银贝，跳过资金检查      ← 余额行还没渲染就只读了一次
//   481 第1轮未找到小鱼活饵的购买按钮          ← 饵料列表还没渲染
//   482 购买数量填100: true                    ← 第 2 轮就好了
// 同一个根因：openBoss 的「打开成功」判据只看面板静态标签，没等动态内容。
// 这个测试钉三件事：①解析器认得真实页面格式 ②openBoss 把「银贝可读」算进就绪 ③读不到会重试并告警。
//
// fish.js 一加载就跑主流程，不能 require，所以从源码里取出纯函数本体做真值测试。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, 'fish.js'), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✔ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// 取出源码里的 parseBossSilver 本体（纯函数，无外部依赖）
function loadParseBossSilver() {
    const m = SRC.match(/function parseBossSilver\(t\) \{[\s\S]*?\n\}/);
    assert.ok(m, '源码里找不到 parseBossSilver');
    // eslint-disable-next-line no-eval
    return eval(`(${m[0]})`);
}

console.log('[1] parseBossSilver：按真实页面文本解析');
const parse = loadParseBossSilver();
const REAL = '鱼老板 账户： 金贝：16.06银贝：20692铜贝：158【鱼老';
t('真实日志格式「金贝：16.06银贝：20692铜贝：158」→ 20692', () => {
    assert.strictEqual(parse(REAL), 20692);
});
t('带空格的「银贝: 4801 铜贝:493」→ 4801', () => {
    assert.strictEqual(parse('账户：金贝：0 银贝: 4801 铜贝:493'), 4801);
});
t('千分位「银贝：54,733」→ 54733', () => {
    assert.strictEqual(parse('账户：银贝：54,733 铜贝：1'), 54733);
});
t('饵料行的「50银贝」不会被误当成余额（必须带冒号）', () => {
    assert.strictEqual(parse('小鱼活饵 50银贝 购买'), null);
});
t('页面上没有银贝 → null', () => {
    assert.strictEqual(parse('钓鱼 码头 出航'), null);
});
t('空输入 → null', () => {
    assert.strictEqual(parse(''), null);
    assert.strictEqual(parse(undefined), null);
});

console.log('\n[2] openBoss 的就绪判据：等动态内容，不只看面板外壳');
t('判据里包含「银贝+数字」的正则（余额行到账才算就绪）', () => {
    assert.ok(/silverReady = true/.test(SRC), '没有 silverReady 标记');
    assert.ok(/if \(panelOpen && silverReady\) return true;/.test(SRC), '没有「面板+余额都就绪」的双条件');
});
t('只开了面板、余额没到时不再当成功，会打印等待原因', () => {
    assert.ok(/账户余额行等 \$\{8\}s 仍未渲染/.test(SRC), '缺少「余额没渲染」的说明日志');
});

console.log('\n[3] 银贝读取：带重试 + 读不到不静默');
t('存在 readBossSilver，默认重试 3 次', () => {
    const m = SRC.match(/async function readBossSilver\(page, tries = (\d+)\)/);
    assert.ok(m, '没有 readBossSilver');
    assert.ok(Number(m[1]) >= 2, `只重试 ${m[1]} 次，偏少`);
});
t('重试之间会等待（不是死循環）', () => {
    assert.ok(/async function readBossSilver[\s\S]{0,600}?await sleep\(1200\)/.test(SRC), '重试没有等待');
});
t('主流程买饵前用的是 readBossSilver（不再单次读）', () => {
    assert.ok(/const silver = await readBossSilver\(page\);/.test(SRC), '主流程仍用单次 parseBossSilver');
});
t('补钱后复读也用重试版', () => {
    assert.ok(/const s2 = await readBossSilver\(page, 2\);/.test(SRC), '补钱后仍是单次读');
});
t('读不到时是 ::warning:: 且截图，不再静默', () => {
    assert.ok(/::warning::鱼老板页未读到银贝/.test(SRC), '读不到仍静默或级别不对');
    assert.ok(/fish-silver-unread\.png/.test(SRC), '读不到时没有截图');
});

console.log('\n[4] 买饵轮次：第 1 轮找不到按钮要说清是「等渲染」');
t('日志措辞表明是渲染未就绪，而不是失败', () => {
    assert.ok(/饵料列表还没渲染出小鱼活饵的「购买」按钮/.test(SRC), '日志措辞没改');
});
t('轮与轮之间仍有等待（给渲染留时间）', () => {
    assert.ok(/if \(round > 1\) await sleep\(2000\)/.test(SRC), '轮间等待被删了');
});
t('买饵仍锁定「小鱼活饵 + 银贝」那一行，不乱点别的饵', () => {
    assert.ok(/txt\.includes\('小鱼活饵'\) && txt\.includes\('银贝'\)/.test(SRC), '锁定条件被改动了');
});

console.log('\n[5] 鱼老板页被浮层吞点击时要有 DOM 直发兜底（11-23 冷6 卖鱼连开 3 次失败）');
t('开面板前会关「更新公告 / 活动公告」浮层', () => {
    assert.ok(/t0\.includes\('更新公告'\) \|\| t0\.includes\('活动公告'\)/.test(SRC), '没有公告浮层清理');
});
t('面板 2 秒没出现会补一次 jsClick（DOM 直发）', () => {
    assert.ok(/w === 1 && !panelOpen/.test(SRC), '没有「2 秒未出现」的补救点');
    assert.ok(/补一次 DOM 直发点击/.test(SRC), '缺少 DOM 直发兜底的日志');
});
t('jsClick 兜底不再被 clickText 的恒 true 短路', () => {
    // clickText 只要元素可见就 return true，所以「if (!clickText) jsClick」这条老路走不到；
    // 现在轮询里有独立的 w===1 触发点，不依赖 clickText 的返回值。
    assert.ok(/if \(w === 1 && !panelOpen\) \{\n\s*console\.log\('鱼老板页 2 秒未出现/.test(SRC), 'DOM 直发仍是 clickText 的从属分支');
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
