// 导航 / 走图健壮性回归测试（2026-11-23）
//
// 两个都来自 11-23 00:00 那一趟 CI 日志的真实损失：
//   ① 冷6 基德整趟没跑：出海航行了 4 分钟没到阿姆斯特丹 → 传送兜底「未检测到到达」→ 整趟退出。
//      同一个 run 里紧跟着的炼器窟用另一种导航一次就到了伦敦，说明游戏是好的，是判据太紧。
//   ② 冷0 奔月只走了 44 间 / 94 杀（其它号 57 间 / 119 杀）：连续回退失败 4 次就整趟收工，
//      而那个计数只加不清、阈值又低，当时还剩 51 分钟。
//
// 这两个脚本一加载就跑主流程，不能 require，所以按源码静态断言（与 kidd-blades-test 同套路）。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const KIDD = fs.readFileSync(path.join(__dirname, 'kidd.js'), 'utf8');
const BYMJ = fs.readFileSync(path.join(__dirname, 'bymj-local', 'bymj-batch.js'), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✔ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('[1] 基德航行：长航线给够时间');
t('航行轮次上限 ≥ 120 轮（×3 秒 = 6 分钟以上，跨海域长航线够用）', () => {
    const m = KIDD.match(/for \(let w = 0; w < (\d+); w\+\+\) \{\n\s*await sleep\(3000\);/);
    assert.ok(m, '找不到航行等待循环');
    assert.ok(Number(m[1]) >= 120, `只有 ${m[1]} 轮（${Math.round(Number(m[1]) * 3 / 60)} 分钟）`);
});
t('「航行未完成」的日志是按轮次算出来的，不再写死 4 分钟', () => {
    assert.ok(/航行未完成（约 \$\{Math\.round\(\(120 \* 3\) \/ 60\)\} 分钟）/.test(KIDD), '日志仍是写死值');
});

console.log('\n[2] 基德传送兜底：到达判据改成轮询 + 给两次机会');
t('点完目的地后最多再等 20 秒轮询「当前城市：目标」', () => {
    assert.ok(/for \(let w = 0; w < 20; w\+\+\) \{\n\s*await sleep\(1000\);/.test(KIDD), '没有到达轮询');
    assert.ok(/传送兜底: 已到达\$\{NAV_DEST\}（等 \$\{w \+ 1\}s）/.test(KIDD), '轮询成功后没有耗时日志');
});
t('传送兜底失败后会再试一次（不再一次定生死）', () => {
    assert.ok(/if \(!\(await teleportToDest\(page\)\)\) \{\n\s*console\.log\('传送兜底第 1 次未成，再试一次\.\.\.'\);\n\s*await teleportToDest\(page\);/.test(KIDD), '没有二次兜底');
});

console.log('\n[3] 奔月回退失败：连续语义 + 只放弃单条分支');
t('进入子房间成功后清零 backFail', () => {
    assert.ok(/if \(!\(await move\(page, dir\)\)\) \{ log\(`  ⚠ 点不动 \$\{dir\}`\); continue; \}\n\s*st\.backFail = 0;/.test(BYMJ), '进入成功没有清零');
});
t('回退成功后清零 backFail', () => {
    assert.ok(/\} else \{\n\s*st\.backFail = 0;\n\s*\}/.test(BYMJ), '回退成功没有清零');
});
t('阈值从 4 提到 8', () => {
    assert.ok(/if \(st\.backFail >= 8\)/.test(BYMJ), '阈值没改');
    assert.ok(!/st\.backFail >= 4/.test(BYMJ), '还留着旧的阈值 4');
});
t('触发时只放弃当前分支（return），不立刻 stopAll', () => {
    assert.ok(/放弃这条分支，保留其它出口/.test(BYMJ), '没有「只放弃这条分支」');
    assert.ok(/if \(st\.drift >= 3\) \{ log\('  ⚠ 3 条分支都漂移，收工'\); st\.reason = 'stuck'; stopAll = true; \}/.test(BYMJ), '缺少「3 条分支才整趟收工」');
});

console.log('\n[4] 奔月基线背包读数：失败要重试');
t('基线读数最多重试 3 次', () => {
    assert.ok(/for \(let r = 1; r <= 3; r\+\+\) \{\n\s*st\.boxBefore = await readBymjBox\(page\);/.test(BYMJ), '没有重试循环');
});
t('重试之间会等页面就绪（不是死循环）', () => {
    assert.ok(/背包读取失败（第\$\{r\}\/3次），等页面就绪后重试/.test(BYMJ), '重试没有等待/日志');
});
t('最终仍失败时日志写明「重试 3 次仍失败」', () => {
    assert.ok(/读取失败（重试 3 次仍失败）/.test(BYMJ), '失败日志没写清重试情况');
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
