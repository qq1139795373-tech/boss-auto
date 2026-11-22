// 基德出刀上限回归测试（2026-11-23）
//
// 为什么要这个测试：11-22 小号日志出现「[战斗] 基德狂兽: 18刀(未见结算)」，用户问「可以一直打啊，为什么要跳过」。
// 根因是 fightOne 硬编码 18 刀，而 clearRoom 用「连续 3 次」计数跳过这只怪 —— 每次 18 刀、中途还关面板重开，
// 等于三段从头打，厚血怪永远打不完。这里把「不再回到 18 刀 / 3 次」这件事钉成断言，防止改回去。
//
// 只读源码做静态断言（kidd.js 一加载就会 run() 起浏览器，不能 require）。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, 'kidd.js'), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✔ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('[1] 出刀上限：不再硬编码 18 刀');
t('fightOne 的循环用的是 MAX_BLADES 常量', () => {
    assert.ok(/for \(let a = 0; a < MAX_BLADES; a\+\+\)/.test(SRC), '出刀循环没改成 MAX_BLADES');
});
t('源码里不再存在 a < 18 这类硬编码刀数循环', () => {
    assert.ok(!/for \(let a = 0; a < 18;/.test(SRC), '还残留 a < 18 的循环');
});
t('MAX_BLADES 默认值 ≥ 90（与海盗王 110 / 奔月 90 同量级，够厚血怪打完）', () => {
    const m = SRC.match(/const MAX_BLADES = Number\(process\.env\.KIDD_MAX_BLADES \|\| (\d+)\)/);
    assert.ok(m, '没找到 MAX_BLADES 默认值');
    assert.ok(Number(m[1]) >= 90, `默认只有 ${m[1]} 刀，还是偏小`);
});
t('MAX_BLADES 可用环境变量覆盖（不打补丁也能临时调）', () => {
    assert.ok(/KIDD_MAX_BLADES/.test(SRC), '没有 KIDD_MAX_BLADES 覆盖口');
});

console.log('\n[2] 跳过判据：按累计刀数/时间，不再按「连续 3 次」');
t('clearRoom 里没有 stuckHits（旧的次数计数）', () => {
    assert.ok(!/stuckHits/.test(SRC), '还残留 stuckHits 计数');
});
t('有累计容器 mobSpent', () => {
    assert.ok(/const mobSpent = new Map\(\)/.test(SRC), '没有 mobSpent 累计表');
});
t('跳过判据用 STUCK_BLADES / STUCK_MS', () => {
    assert.ok(/s\.blades >= STUCK_BLADES \|\| s\.ms >= STUCK_MS/.test(SRC), '跳过判据没接累计值');
});
t('STUCK_BLADES 至少是一轮的 3 倍（给厚血怪多轮机会）', () => {
    const mb = SRC.match(/KIDD_MAX_BLADES \|\| (\d+)/);
    const sb = SRC.match(/KIDD_STUCK_BLADES \|\| (\d+)/);
    assert.ok(mb && sb, '常量缺失');
    assert.ok(Number(sb[1]) >= Number(mb[1]) * 3, `STUCK_BLADES=${sb[1]} 不足 MAX_BLADES×3`);
});
t('没到阈值时打印「继续打」而不是跳过', () => {
    assert.ok(/还没倒下（累计 \$\{s\.blades\} 刀/.test(SRC), '缺少「继续打」分支的日志');
});

console.log('\n[3] 返回值契约：fightOne 每个分支都带 res');
t('win 分支返回对象且带 blades/ms', () => {
    assert.ok(/return \{ res: 'win', blades, ms: Date\.now\(\) - t0 \}/.test(SRC), 'win 分支契约不对');
});
t('dead 分支返回对象', () => {
    assert.ok(/return \{ res: 'dead', blades, ms: Date\.now\(\) - t0 \}/.test(SRC), 'dead 分支契约不对');
});
t('打不完分支返回 alive（交给上层接着打）', () => {
    assert.ok(/return \{ res: 'alive', blades, ms: spent \}/.test(SRC), 'alive 分支契约不对');
});
t('点不到怪分支返回 nomonster，且不计入跳过', () => {
    assert.ok(/return \{ res: 'nomonster'/.test(SRC), '没有 nomonster 分支');
    assert.ok(/fr\.res === 'nomonster'/.test(SRC), 'clearRoom 没处理 nomonster');
});
t('clearRoom 的 dead 判定已改成 fr.res（不是旧的 fr ===）', () => {
    assert.ok(!/fr === 'dead'/.test(SRC), '还残留旧的真值/字符串比较');
});

console.log('\n[4] 房间兜底：尝试次数与墙上时钟');
t('房间尝试上限 ≥ 30（厚血怪要多轮）', () => {
    const m = SRC.match(/for \(let attempt = 0; attempt < (\d+); attempt\+\+\)/);
    assert.ok(m, '没找到房间尝试循环');
    assert.ok(Number(m[1]) >= 30, `尝试上限只有 ${m[1]}`);
});
t('房间有 ROOM_MAX_MS 墙上时钟兜底', () => {
    assert.ok(/KIDD_ROOM_MAX_MS/.test(SRC) && /ROOM_MAX_MS/.test(SRC), '房间缺少时间兜底');
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
