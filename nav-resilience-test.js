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

// 统一换行：仓库里 farm.js / team5-form.js 是 CRLF，kidd.js 是 LF。
// 正则里写 `\n\s*` 时，CRLF 的 `{\r\n` 匹配不上 —— 统一归一化，免得断言因换行风格假失败。
const rd = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const KIDD = rd('kidd.js');
const BYMJ = rd(path.join('bymj-local', 'bymj-batch.js'));
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

console.log('\n[5] farm 自愈必须先回广州（2026-11-23 coldwind8 卡威尼斯 1h40m 事故）');
const FARM = rd('farm.js');
// master 分支是单号架构、没有组队 job，也就没有 team5-form.js → 跳过 [6] 而不是报错
const TEAM5 = fs.existsSync(path.join(__dirname, 'team5-form.js')) ? rd('team5-form.js') : null;
t('存在 ensureGuangzhou（跨城：出航 → 传送兜底 → 严格校验）', () => {
    assert.ok(/async function ensureGuangzhou\(page\)/.test(FARM), '没有抽出 ensureGuangzhou');
    const body = FARM.slice(FARM.indexOf('async function ensureGuangzhou(page)'));
    assert.ok(/await sailFlow\(page\)/.test(body.slice(0, 2000)), 'ensureGuangzhou 里没有出航');
    assert.ok(/await teleportToDest\(page\)/.test(body.slice(0, 2000)), 'ensureGuangzhou 里没有传送兜底');
});
t('★ 两条路径（被顶后接管、10 分钟无击杀）都先过 ensureGuangzhou 再走沙滩', () => {
    // 掉线路径 2026-11-23 20:11 起改成「窗口外阶梯重登、重登后同样要回广州」，所以也是调 recoverToBeach
    assert.ok(/async function recoverToBeach\(\)/.test(FARM), '没有 recoverToBeach');
    assert.ok(!/if \(!pageText\.includes\('经验妖灵'\)\) await gotoBeach\(page\)\.catch\(\(\) => false\);/.test(FARM),
        '还有自愈路径直接调 gotoBeach（外地城市必然失败）');
    const calls = (FARM.match(/await recoverToBeach\(\)/g) || []).length;
    assert.strictEqual(calls, 2, `recoverToBeach 应被两条路径各调一次，实际 ${calls} 次`);
});
t('recoverToBeach 内先 ensureGuangzhou 再 gotoBeach', () => {
    const body = FARM.slice(FARM.indexOf('async function recoverToBeach()'));
    const seg = body.slice(0, 400);
    assert.ok(/await ensureGuangzhou\(page\)/.test(seg), '没先回广州');
    assert.ok(body.indexOf('ensureGuangzhou(page)') < body.indexOf('gotoBeach(page)'), '顺序反了');
});
t('连续 3 次自愈失败 → diag 报错并停手（不再空转到 job 被杀）', () => {
    assert.ok(/if \(healFails >= 3\) \{\n\s*console\.log\(`::error::farm 连续 3 次自愈失败/.test(FARM), '没有 3 次停手');
    const breaks = (FARM.match(/if \(healFails >= 3\) break;/g) || []).length;
    // 被顶接管循环：跳出 for + 跳出 while 各一处；「10 分钟无击杀」自愈一处 → 共 3 处
    assert.strictEqual(breaks, 3, `自愈停手应有 3 处（接管循环内外 + 10 分钟无击杀），实际 ${breaks} 处`);
});
t('击杀成功会清零 healFails（相隔很远的偶发失败不该累加）', () => {
    assert.ok(/count\+\+;\n\s*healFails = 0;/.test(FARM), '击杀后没有清零');
});

console.log('\n[6] 组队 4/5 不再直接红叉（2026-11-23 笑呵呵接受失败 → exit 2）');
if (!TEAM5) {
    console.log('  - 本分支没有 team5-form.js（master 单号架构无组队 job），跳过 [6]');
} else {
t('acceptInvite 轮次 ≥ 6、每轮间隔 ≥ 2 秒', () => {
    const m = TEAM5.match(/async function acceptInvite\(page\) \{[\s\S]*?\n\}/);
    assert.ok(m, '找不到 acceptInvite');
    const body = m[0];
    const loop = body.match(/for \(let i = 0; i < (\d+); i\+\+\)/);
    assert.ok(loop, '没有轮次循环');
    assert.ok(Number(loop[1]) >= 6, `只有 ${loop[1]} 轮`);
    assert.ok(/await sleep\(2000\);\n\s*continue;/.test(body), '等待不足/没有等待');
});
t('★ 不再「第 2 轮没按钮就直接 failed」', () => {
    const m = TEAM5.match(/async function acceptInvite\(page\) \{[\s\S]*?\n\}/);
    assert.ok(!/if \(i > 0\) return \{ ok: false/.test(m[0]), '还留着 i>0 就返回失败的早退');
});
t('点完要复核按钮是否真的消失（防假阳性 ok）', () => {
    assert.ok(/点击后按钮仍在（第 \$\{i \+ 1\} 轮），继续重试/.test(TEAM5), '没有「点击后复核」');
});
t('不满 5 人会补一轮邀请+接受', () => {
    assert.ok(/不满 5 人（\$\{n\}\/5）→ 补一轮邀请\+接受/.test(TEAM5), '没有补漏');
    assert.ok(/【补漏后队伍】/.test(TEAM5), '补漏后没有复核日志');
});
t('★ 仍不足 5 人只告警不红叉（return 0）', () => {
    assert.ok(/::warning::组队只到 \$\{n\}\/5/.test(TEAM5), '没有 warning');
    assert.ok(!/return n === 5 \? 0 : 2/.test(TEAM5), '还留着 4/5 就 exit 2');
});
}

console.log('\n[7] 被顶号：派发窗口内退场、窗口外等用户下线（2026-11-23 20:11 第二轮修正）');
t('★ 不再有「让位 30 分钟再重登」那套旧状态机', () => {
    assert.ok(!/RELOGIN_WAIT_MS/.test(FARM), '还留着让位常量');
    assert.ok(!/满\d+分钟再重登/.test(FARM), '还留着让位日志');
    assert.ok(!/kickedAt/.test(FARM), '还留着让位状态变量');
});
t('★ 派发窗口内被顶 → diag(…, 0) + break 退场（run 保持绿，不抢 CI 的号）', () => {
    assert.ok(/isNearDispatch\(Date\.now\(\)\)/.test(FARM), '没有调用 isNearDispatch');
    assert.ok(/判定为下一趟 CI 交接，本趟立即退场/.test(FARM), '没有 CI 交接日志');
    assert.ok(/diag\('账号被接管（派发窗口内，CI 交接），主动退场', 0\);\s*\n\s*break;/.test(FARM),
        'CI 交接退场没有 diag(…, 0) + break');
});
t('★ 窗口外被顶 → 阶梯重登接管（直接退场会让用户玩半小时就废掉整趟刷怪）', () => {
    assert.ok(/const USER_OCCUPY_WAIT_MIN = envNum\('FARM_USER_WAIT_MIN', 20\)/.test(FARM), '没有等待间隔常量');
    assert.ok(/const USER_OCCUPY_TRIES = envNum\('FARM_USER_WAIT_TRIES', 3\)/.test(FARM), '没有轮次常量');
    assert.ok(/for \(let i = 1; i <= USER_OCCUPY_TRIES; i\+\+\)/.test(FARM), '没有阶梯重登循环');
    assert.ok(/await sleep\(USER_OCCUPY_WAIT_MIN \* 60000\)/.test(FARM), '等待没有用 USER_OCCUPY_WAIT_MIN');
    assert.ok(/已接管账号，恢复刷怪/.test(FARM), '没有接管成功的日志');
});
t('★ 等待期间进入派发窗口立刻让位（不能把 CI 正在用的号顶掉）', () => {
    assert.ok(/等待第 \$\{i\} 轮期间进入派发窗口/.test(FARM), '等待循环里没有再判一次派发窗口');
    assert.ok(/exitByWindow = true;/.test(FARM), '没有 exitByWindow 标记');
});
t('★ dispatch-window.js 确实被 require 且文件在（防止漏入库导致 CI Cannot find module）', () => {
    assert.ok(/require\('\.\/dispatch-window\.js'\)/.test(FARM), '没有引入 dispatch-window');
    assert.ok(fs.existsSync(path.join(__dirname, 'dispatch-window.js')), 'dispatch-window.js 不存在');
    assert.ok(fs.existsSync(path.join(__dirname, 'dispatch-window-test.js')), 'dispatch-window-test.js 不存在');
});
t('两个 env 覆盖都做了非法值兜底（NaN / ≤0 回退默认）', () => {
    assert.ok(/Number\.isFinite\(v\) && v > 0 \? v : def/.test(FARM), 'envNum 没有兜底');
    assert.ok(/String\(raw\)\.trim\(\) === ''/.test(FARM), '没有把空串当未设置');
});
t('「10 分钟无击杀」自愈仍保留重登（这条不是被顶，不能一起删）', () => {
    assert.ok(/连续10分钟无击杀/.test(FARM), '自愈分支被误删');
    assert.ok(/await relogin\(page\)/.test(FARM), '自愈不再重登');
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
