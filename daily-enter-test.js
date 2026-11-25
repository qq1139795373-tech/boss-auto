// daily.enterMain 的离线单测：进游戏的判定与重试（不需要浏览器）
// 跑法：node daily-enter-test.js
const assert = require('assert');

// daily.js 顶部只读环境变量，不发请求；这里直接取它的导出
const daily = require('./daily.js');

let pass = 0; let fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const tAsync = async (name, fn) => t(name, fn);

// 假的页面：texts 是「每次读页面依次返回的文本」，clicks 记录点击次数
function fakePage(texts, clickResult) {
    let i = 0;
    const state = { clicks: 0 };
    const opts = {
        rounds: texts.length + 3,
        pauseMs: 0,
        log: () => { },
        readText: async () => texts[Math.min(i++, texts.length - 1)],
        click: async () => { state.clicks++; return clickResult === undefined ? '坐标(1,1)' : clickResult; },
    };
    return { state, opts };
}

(async () => {
    console.log('\n[1] 已经在主界面：不点任何按钮就走');
    {
        const { state, opts } = fakePage(['你看到 一片海洋。', '当前城市：广州']);
        const ok = await daily.enterMain(null, opts);
        t('返回 true', () => assert.strictEqual(ok, true));
        t('一次都没点（不打扰已进游戏的号）', () => assert.strictEqual(state.clicks, 0));
    }

    console.log('\n[2] 登录页 → 点一次进主界面');
    {
        const { state, opts } = fakePage(['进入游戏', '你看到 一片海洋。', '你看到 一片海洋。']);
        const ok = await daily.enterMain(null, opts);
        t('返回 true', () => assert.strictEqual(ok, true));
        t('只点 1 次', () => assert.strictEqual(state.clicks, 1));
    }

    console.log('\n[3] 选角页：先选角色再进（选角页要多点一次）');
    {
        // 读序：进入游戏（点1）→ 选择角色（再点1）→ 你看到
        const { state, opts } = fakePage(['进入游戏', '选择角色 ♂笑呵呵 等级 Lv.135 进入游戏', '你看到 一片海洋。']);
        const ok = await daily.enterMain(null, opts);
        t('返回 true', () => assert.strictEqual(ok, true));
        t('点了 2 次（选角页补点）', () => assert.strictEqual(state.clicks, 2));
    }

    console.log('\n[4] 一直进不去：用完轮数返回 false');
    {
        const { opts } = fakePage(['进入游戏', '进入游戏', '进入游戏', '进入游戏', '进入游戏', '进入游戏', '进入游戏', '进入游戏']);
        const ok = await daily.enterMain(null, opts);
        t('返回 false（调用方据此跳过本任务，不再对着没进游戏的页面操作）', () => assert.strictEqual(ok, false));
    }

    console.log('\n[5] 页面上根本没有这个按钮：连续 3 轮就收手（不白等 10 轮）');
    {
        const { state, opts } = fakePage(['请输入账号密码', '请输入账号密码', '请输入账号密码', '请输入账号密码', '请输入账号密码'], null);
        const ok = await daily.enterMain(null, opts);
        t('返回 false', () => assert.strictEqual(ok, false));
        t('只尝试 3 次', () => assert.strictEqual(state.clicks, 3));
    }

    console.log('\n[6] ★ 证伪：能不能进必须由页面文本决定，不能写死 true');
    {
        const a = fakePage(['进入游戏', '你看到 一片海洋。']).opts;
        const b = fakePage(['进入游戏', '进入游戏', '进入游戏', '进入游戏', '进入游戏']).opts;
        const ra = await daily.enterMain(null, a);
        const rb = await daily.enterMain(null, b);
        t('能进 → true；进不去 → false（两种情况结果不同）', () => assert.notStrictEqual(ra, rb));
    }

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
})();
