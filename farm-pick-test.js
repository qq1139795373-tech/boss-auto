// 农场出航逻辑行为测试（不联网、不登录、不碰真号）
// 用源码切片 + stub 环境跑 pickConfirm / sailFlow，验证 11-08 两波失败的真实坑：
//   聊天栏同名词（"在广州拍卖行等着"）导致城市没选上 → 旧代码照样点「立即出发」白等 5 分钟。
// 用法: node farm-pick-test.js [文件路径，默认同目录 farm.js]
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, 'farm.js');
const src = fs.readFileSync(target, 'utf8');
const candidates = [
    src.indexOf('// 出航失败原因（nomap'),
    src.indexOf('async function pickConfirm'),
].filter(i => i > 0);
const start = candidates.length ? Math.min(...candidates) : -1;
let end = src.indexOf('// 重载页面（会话仍有效会自动回到游戏）');
if (end < 0) end = src.indexOf('// 卡副本自恢复');
if (start < 0 || end < 0) throw new Error(`切片标记没命中（${target}），文件结构变了`);
const body = src.slice(start, end) +
    '\nreturn { pickConfirm, sailFlow, fail: () => SAIL_FAIL, setFail: v => { SAIL_FAIL = v; }, hasSailFail: typeof SAIL_FAIL !== "undefined" };';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// texts: 依次返回的页面文本（耗尽后重复最后一条）
function build(opts) {
    const logs = [];
    const clicks = [];
    const fails = [];
    let textIdx = 0;
    const texts = opts.texts;
    const env = {
        sleep: async () => { },
        getPageText: async () => {
            const t = texts[Math.min(textIdx, texts.length - 1)];
            if (textIdx < texts.length - 1) textIdx++;
            return t;
        },
        clickText: async (p, t) => { clicks.push(t); return opts.pickText ? opts.pickText(t) : true; },
        clickExact: async (p, t) => { clicks.push(t); return true; },
        jsClick: async (p, t) => { clicks.push(t); return opts.pickJs ? opts.pickJs(t) : true; },
        mapBlock: () => '[测试地图]',
        __failNav: async (p, why) => { fails.push(why); return false; },
        page: {
            mouse: { click: async () => { }, wheel: async () => { } },
            keyboard: { press: async () => { } },
            screenshot: async () => { },
        },
        NAV_DEST: '广州',
        NAV_REGION: '东亚',
        console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    };
    const api = new Function(
        'sleep', 'clickText', 'clickExact', 'jsClick', 'getPageText', 'mapBlock', 'page',
        'NAV_DEST', 'NAV_REGION', 'console', body
    )(env.sleep, env.clickText, env.clickExact, env.jsClick, env.getPageText, env.mapBlock, env.page,
        env.NAV_DEST, env.NAV_REGION, env.console);
    return { api, logs, clicks, fails, page: env.page };
}

const IN_CITY = '传送 出航 当前城市：大阪  【城内地图】 北：西城门 [公共] 中华 ： 在广州拍卖行等着';
const CONFIRM = IN_CITY + ' 出航确认 广州 立即出发';
const SAILING = '停止自动航行 剩余距离 2.5/4.5';
const ARRIVED = '传送 出航 当前城市：广州 【城内地图】';

(async () => {
    console.log(`\n被测文件: ${target}`);

    console.log('\n场景1：聊天栏有「广州」但城市没选中（旧代码在这里白等 5 分钟）');
    {
        const { api, logs, clicks, page } = build({ texts: [IN_CITY] });
        const r = await api.pickConfirm(page);
        ok('pickConfirm 返回 false', r === false);
        ok('没有点「立即出发」', !clicks.includes('立即出发'), `实际点击: ${clicks.join(',')}`);
        ok('打印了重试日志', logs.some(l => l.includes('未看到出航确认框')));
    }

    console.log('\n场景2：正常选中 → 起航 → 到达');
    {
        const { api, logs, page } = build({ texts: [IN_CITY, CONFIRM, CONFIRM, SAILING, ARRIVED] });
        const r = await api.sailFlow(page, 10);
        ok('sailFlow 返回 true', r === true, `logs=${logs.join(' | ')}`);
        ok('打印「航行中...」', logs.some(l => l.includes('航行中...')));
    }

    console.log('\n场景3：选不中城市时 sailFlow 必须失败且不假装航行');
    {
        const { api, logs, clicks, fails, page } = build({ texts: [IN_CITY] });
        const r = await api.sailFlow(page, 5);
        ok('sailFlow 返回 false', r === false);
        ok('没有打印「航行中...」', !logs.some(l => l.includes('航行中...')), logs.join(' | '));
        ok('没有点「立即出发」', !clicks.includes('立即出发'), `实际点击: ${clicks.join(',')}`);
        ok('走到 failNav（日志含「出航中止」）', logs.some(l => l.includes('出航中止')), logs.join(' | '));
    }

    console.log('\n场景4：已在海上 → 跳过出航选择，只等到达');
    {
        const { api, logs, clicks, page } = build({ texts: [SAILING, SAILING, ARRIVED] });
        const r = await api.sailFlow(page, 10);
        ok('sailFlow 返回 true', r === true);
        ok('没有重新点「出航」', !clicks.includes('出航'), `实际点击: ${clicks.join(',')}`);
        ok('打印「已在航行中」', logs.some(l => l.includes('已在航行中')));
    }

    console.log('\n场景5：跨洋 rounds 用尽 → 明确失败（不再自称「约5分钟」）');
    {
        const { api, logs, page } = build({ texts: [SAILING] });
        const r = await api.sailFlow(page, 3);
        ok('sailFlow 返回 false', r === false);
        ok('日志说明轮次用尽', logs.some(l => l.includes('分钟仍未到达')) || logs.some(l => l.includes('航行未完成')), logs.join(' | '));
    }

    console.log('\n场景6：目的地无海图 → nomap，且不重试不出发');
    {
        const { api, clicks, page } = build({ texts: [IN_CITY, IN_CITY + ' 暂无地图，查看失败'] });
        const r = await api.pickConfirm(page);
        ok('pickConfirm 返回 false', r === false);
        ok('SAIL_FAIL 标记为 nomap', api.hasSailFail && api.fail() === 'nomap', `sailFail=${api.hasSailFail ? api.fail() : '(无此变量)'}`);
        ok('没有点「立即出发」', !clicks.includes('立即出发'));
    }

    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})();
