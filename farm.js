const { chromium } = require('playwright');
// 副本内自恢复（先扫荡/领奖再退本）
const drain = require('./dungeon-recover.js');
// 被顶号时判断「占用方是另一趟 CI 还是用户手动登录」——见 dispatch-window.js 头注释
const { isNearDispatch, DISPATCH_WINDOW_MIN } = require('./dispatch-window.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 农场固定去广州沙滩打经验妖灵（11-09 起小号也走广州，不再去杭州西湖）
const NAV_DEST = '广州';
const NAV_REGION = '东亚';

// 读正整数环境变量，非法值（空/NaN/≤0）回退默认值 —— 上一次 FARM_MAX_MIN 传 NaN 就吃过大亏
function envNum(name, def) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : def;
}

// 被「用户手动登录」占号时的等待策略（2026-11-23 20:11 用户提问：
//   「我就玩一会儿，比如30分钟就下线了，如果不设定自愈，那本次工作流后面任务比如刷野怪不就不会跑了？」）
//   - 派发窗口内被顶 → 是另一趟 CI 的交接信号 → 立刻退场（不能重登抢号，否则双方互顶）
//   - 窗口外被顶   → 用户手动登录在玩 → 每 USER_OCCUPY_WAIT_MIN 分钟试一次接管，最多 USER_OCCUPY_TRIES 轮
//   为什么第一轮就等 35 分钟：farm 每次重登都会把在玩的人挤下线，等待太短会反复打断。
//   用户举的例子是「玩 30 分钟就下线」，35 分钟探第一次正好落在他下线之后，全程不打断他；
//   2 轮共 70 分钟，覆盖「玩一小时以内」。两个值都可用环境变量覆盖，想让出更多时间就调大。
const USER_OCCUPY_WAIT_MIN = envNum('FARM_USER_WAIT_MIN', 35);
const USER_OCCUPY_TRIES = envNum('FARM_USER_WAIT_TRIES', 2);

// 刷怪时长：不设。一直刷到 GitHub 托管 runner 的 job 6 小时硬上限把进程杀掉为止
//   （用户 11-23 20:00：「刷野怪不用设定多少分钟，工作流会自动达到上限6小时而停止」）。
//   之前那两套预算（「刷到下一个派发节点前 5 分钟」farm-budget.js、「job 起跑 + 355 分钟」）
//   已全部删除：job 的 6 小时硬上限总在预算之前生效，算了也用不上。

// 退出诊断：GitHub 的 job 日志偶发 404 全丢（2026-11-12 00:00 小号波 farm failure 就是这样查不下去），
// 所以进程自己把「退出原因 + 退出码 + 击杀数 + 运行时长」压成一行打在末尾。
// 规则：正常到点收尾 exit 0；登录失败/没到目的地/未捕获异常一律 exit 1，红色只留给真故障。
const EXIT_DIAG = { reason: '未设置', kills: 0, startedAt: Date.now() };
function diag(reason, code) {
    EXIT_DIAG.reason = reason;
    if (code) process.exitCode = code;
}
function exitLine() {
    return `=== farm 收尾：原因=${EXIT_DIAG.reason} 退出码=${process.exitCode || 0} 击杀=${EXIT_DIAG.kills} 次 运行=${Math.round((Date.now() - EXIT_DIAG.startedAt) / 60000)} 分钟 ===`;
}
// 崩溃路径必须同步写 stdout：CI 里 stdout 是管道，console.log 是异步的，
// process.exit() 会把还没 flush 的日志丢掉（正是 11-12 那次查不下去的原因）。
function crashExit(e, kind) {
    diag(`${kind}: ${e && e.message ? e.message : e}`, 1);
    const msg = `::error::farm ${kind}: ${e && e.stack ? e.stack : e}\n${exitLine()}\n`;
    try { require('fs').writeSync(1, msg); } catch (_) { console.error(msg); }
    process.exit(1);
}
process.on('unhandledRejection', (e) => crashExit(e, '未捕获 Promise 拒绝'));
process.on('uncaughtException', (e) => crashExit(e, '未捕获异常'));

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
    // runner到游戏服务器慢时，等load事件会30s超时；domcontentloaded不等全量资源，失败重试
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            return true;
        } catch (e) {
            console.log(`打开页面第${i}/${retries}次失败:`, (e.message || '').split('\n')[0]);
            await sleep(3000);
        }
    }
    return false;
}

async function clickText(page, text, timeout = 5000) {
    // 主路径：用isVisible检查元素是否真正可见
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
    // 兜底：先滚动到元素位置，再检查可见性
    try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(500);
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.click({ force: true }).catch(() => {});
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

// 点在「叶子文本节点」上（不点包着按钮的外层容器）
async function clickLeaf(page, text, exactOnly = true) {
    return await page.evaluate(({ t, ex }) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (el.children.length !== 0 || r.width <= 0 || r.height <= 0) return false;
            return ex ? s === t : s.includes(t);
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, { t: text, ex: exactOnly });
}

// 点「进入游戏」：getByText('进入游戏',{exact:false}).first() 会命中包着按钮的外层容器，
// 点击落在容器中心而不是按钮上 → 每轮都「点了但没反应」，冷2 18:00 波曾连试 10 轮、
// 每轮 37.5 秒全空转。改为「叶子节点真实坐标 → 合成事件 → force click」三级降级。
async function clickEnterGame(page) {
    const pos = await page.evaluate(() => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 && s === '进入游戏';
        });
        if (!all.length) return null;
        // 选角页的按钮通常后渲染，取最后一个叶子节点
        const r = all[all.length - 1].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }).catch(() => null);
    if (pos) {
        await page.mouse.click(pos.x, pos.y).catch(() => {});
        return `坐标(${pos.x},${pos.y})`;
    }
    if (await clickLeaf(page, '进入游戏', true).catch(() => false)) return '合成事件';
    try {
        await page.getByText('进入游戏', { exact: false }).first().click({ force: true, timeout: 5000 });
        return 'force';
    } catch {
        return null;
    }
}

// 点「登录」：登录页常驻的 uni-toast 遮罩会拦住 Playwright 的 actionability 检查，
// 旧写法等满 30 秒抛错 → 整个任务跳 catch 静默成功退出（2026-11-10 coldwind1 事故）。
async function clickLoginButton(page) {
    const pos = await page.evaluate(() => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 && s === '登录';
        });
        if (!all.length) return null;
        const r = all[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }).catch(() => null);
    if (pos) {
        await page.mouse.click(pos.x, pos.y).catch(() => {});
        return `坐标(${pos.x},${pos.y})`;
    }
    if (await clickLeaf(page, '登录', true).catch(() => false)) return '合成事件';
    try {
        await page.getByText('登录', { exact: false }).first().click({ force: true, timeout: 5000 });
        return 'force';
    } catch {
        return null;
    }
}

// 只拼可见节点。原实现 textContent('body') 不排除 display:none，
// 残留弹窗节点会一直留在 DOM 里 → 读出幽灵文案，把「没成」判成「成了」（2026-10-28 同源问题）。
async function getPageText(page) {
    return await drain.visibleText(page);
}

// 截取"当前城市"到"【聊天】"之间的地图区块，用于日志观察位置变化
function mapBlock(txt) {
    const a = txt.indexOf('当前城市');
    if (a < 0) return '(无当前城市)';
    const b = txt.indexOf('【聊天】', a);
    return txt.substring(a, b > a ? b : a + 120).replace(/\s+/g, ' ');
}

// JS直接向元素派发鼠标事件，绕过全屏遮罩（城内地图弹窗的遮罩会吃掉坐标点击）
async function jsClick(page, text, exclude = '') {
    return await page.evaluate(({ t, ex }) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) && (!ex || !s.includes(ex)) &&
                r.width > 0 && r.height > 0;
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all.find(e => e.textContent.trim() === t) || all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, { t: text, ex: exclude });
}

// jsClick优先（穿遮罩），失败退回文本点击
async function clickBtn(page, text, timeout = 3000) {
    if (await jsClick(page, text)) return true;
    return await clickText(page, text, timeout);
}

async function closePopup(page) {
    // 尝试点击不同位置关闭弹窗
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.mouse.click(990, 10);
    await sleep(500);
    await page.mouse.click(500, 500);
    await sleep(500);
    // 尝试按ESC
    await page.keyboard.press('Escape');
    await sleep(1000);
}

// 精确匹配整段文本的按钮（避免“避战”匹配到“迎战或避战”说明文字、“自动航行”匹配到“停止自动航行”）
async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

// 出航失败原因（nomap = 该号没有目标城市的海图，传送一样没用，别白花银币）
let SAIL_FAIL = '';

async function pickConfirm(page, region, dest) {
    SAIL_FAIL = '';
    for (let round = 1; round <= 3; round++) {
        // 先关掉可能遮挡点击的弹窗/残留面板（高峰期弹窗会吃掉坐标点击）
        await page.mouse.click(10, 10);
        await sleep(300);
        await page.keyboard.press('Escape');
        await sleep(500);
        let opened = await clickText(page, '出航', 2000);
        if (!opened) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            await clickText(page, '出航');
        }
        await sleep(2000);
        await clickExact(page, region);
        await sleep(1000);
        for (let s = 0; s < 5; s++) {
            // 第2轮起用JS叶子派发点击，绕过遮罩对坐标点击的拦截；排除聊天栏同名词（"在广州拍卖行等着"）
            const ok = round === 1
                ? await clickText(page, dest, 2000)
                : await jsClick(page, dest, '拍卖');
            if (ok) {
                // 高峰期确认框慢半拍，单次1.5秒查询会误判，改成最多9秒轮询
                for (let c = 0; c < 6; c++) {
                    await sleep(1500);
                    const t = await getPageText(page);
                    // 「暂无地图」与出航确认框会同时出现（实测），必须先判 nomap
                    if (t.includes('暂无地图')) {
                        console.log(`「暂无地图，查看失败」→ 该号没有${dest}的海图，不传送`);
                        SAIL_FAIL = 'nomap';
                        return false;
                    }
                    if (t.includes('出航确认')) return true;
                }
            }
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }
        console.log(`未看到出航确认框，重开面板重试(${round}/3)...`);
    }
    return false;
}

// 出航失败时把现场拍下来（此前失败路径无任何页面文本，无从定位）
async function failNav(page, why) {
    const t = await getPageText(page);
    console.log(`出航中止(${why})，页面文本: ${t.replace(/\s+/g, ' ').substring(0, 300)}`);
    await page.screenshot({ path: 'nav-fail-detail.png' }).catch(() => {});
    return false;
}

// 起航判定：先认硬证据（停止自动航行/剩余距离），只看到「航行中」算弱确认('soft')。
// 只认「停止自动航行」会误判——按钮渲染慢/文案被遮罩盖住时，船其实已在海上却判成出航失败，白走传送。
async function waitSailing(page, sec) {
    for (let i = 0; i < sec; i++) {
        const t = await getPageText(page);
        if (t.includes('停止自动航行') || t.includes('剩余距离')) return 'hard';
        if (t.includes('航行中')) return 'soft';
        await sleep(1000);
    }
    return '';
}

// 起航未确认时的观察窗口：宁可多盯 60 秒，也不要误判成失败去花银币传送。
// 期间任何硬证据/到港都算成功，并顺手点「自动航行」补救。
async function observeSail(page, sec = 60) {
    for (let i = 0; i < sec; i++) {
        await sleep(1000);
        const t = await getPageText(page);
        if (t.includes(`当前城市：${NAV_DEST}`)) { console.log('起航观察: 已到港'); return true; }
        if (t.includes('停止自动航行') || t.includes('剩余距离')) { console.log('起航观察: 已离港'); return true; }
        if (t.includes('遭遇海盗')) {
            await clickExact(page, '避战', 3000);
            await sleep(1500);
        } else if (i % 8 === 7 && await clickExact(page, '自动航行', 1500)) {
            console.log('起航观察: 自动航行(重新)启动');
        }
    }
    return false;
}

// 出航流程：出航菜单→区域→城市→出航确认→自动航行→航行循环（海盗避战/恢复），返回是否到达
// 已在海上时跳过出航选择、直接进入等待（跨洋续等复用同一函数，不会重新选目的地）
async function sailFlow(page, rounds = 200) {
    const pre = await getPageText(page);
    if (pre.includes(`当前城市：${NAV_DEST}`)) {
        console.log(`已在${NAV_DEST}，无需出航`);
        return true;
    }
    const atSea = pre.includes('停止自动航行') || pre.includes('剩余距离');
    if (atSea) {
        console.log('已在航行中，跳过出航选择直接等待到达...');
    } else {
        let picked = await pickConfirm(page, NAV_REGION, NAV_DEST);
        if (!picked) {
            return failNav(page, SAIL_FAIL === 'nomap' ? `目的地${NAV_DEST}无地图` : '出航确认框始终未出现');
        }

        await clickText(page, '立即出发');
        await sleep(2000);
        // 起航校验：硬证据优先，只看到「航行中」也算离港；
        // 都读不到时进 60 秒观察窗口（11-11 11:50 教训：判「未启动」后 3 秒实际已在海上，白走传送）
        let state = await waitSailing(page, 10);
        for (let a = 1; a <= 2 && !state; a++) {
            await clickExact(page, '自动航行', 5000);
            state = await waitSailing(page, 8);
            if (!state && a === 1) {
                console.log('自动航行未启动，重新开面板选目的地...');
                picked = await pickConfirm(page, NAV_REGION, NAV_DEST);
                if (!picked) break;
                await clickText(page, '立即出发');
                await sleep(2000);
            }
        }
        if (!state) {
            console.log('起航未确认，进 60 秒观察窗口...');
            if (!(await observeSail(page))) return failNav(page, '起航未确认(观察60秒仍无航行迹象)');
        }
        console.log(state === 'soft' ? '航行中...(仅见「航行中」)' : '航行中...');
    }

    // 旧上限 80 轮≈4 分钟，跨海域（大阪→广州）走不完 → 默认 200 轮≈10 分钟
    for (let w = 0; w < rounds; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`到达${NAV_DEST}`);
            return true;
        }
        if (w > 0 && w % 20 === 0) console.log(`航行中... 已等 ${Math.round(w * 3 / 60)} 分钟（${(txt.match(/当前城市：\S+/) || ['位置未知'])[0]}）`);
        if (txt.includes('遭遇海盗')) {
            console.log('遭遇海盗，选择避战...');
            await page.screenshot({ path: 'sail-pirate.png' }).catch(() => {});
            await clickExact(page, '避战', 3000);
            await sleep(2000);
            const t2 = await getPageText(page);
            if (t2.includes('成功避战')) console.log('成功避战');
            if (!t2.includes('停止自动航行')) {
                if (await clickExact(page, '自动航行', 3000)) console.log('恢复自动航行');
            }
            continue;
        }
        if (!txt.includes('停止自动航行') && await clickExact(page, '自动航行', 1500)) {
            console.log('自动航行(重新)启动');
        }
    }
    const txt = await getPageText(page);
    console.log(`航行 ${Math.round(rounds * 3 / 60)} 分钟仍未到达，页面文本:`, txt.substring(0, 300));
    await page.screenshot({ path: 'nav-timeout.png' }).catch(() => {});
    return false;
}

// 卡副本自恢复：身处副本房间先**把副本做完（扫荡/领奖）**，实在没可领的才退本回城。
// 2026-10-27 boss(0) 教训：炼器窟已扫荡、条件已达成、只差领奖，
// 老逻辑读到「副本条件」直接退本，把当天奖励扔了。现在先交给 recoverDungeon 处理。
async function exitDungeonIfInside(page) {
    const t0 = await getPageText(page);
    if (!(t0.includes('副本条件') && t0.includes('回到起点'))) return false;
    console.log('自恢复：检测到身处副本，先尝试完成副本（扫荡/领奖）...');
    try {
        const r = await drain.recoverDungeon(page, { tag: '自恢复', screenshot: 'dungeon-recover-fail.png' });
        if (r.claimed) console.log(r.swept ? '已扫荡并领取奖励，副本结束' : '已领取奖励，副本结束');
        if (r.exited) { console.log('已退出副本'); return true; }
        console.log(`副本内没能完成/退出（${r.kind}，领奖=${r.claimed}），走兜底流程`);
    } catch (e) {
        console.log('副本内处理异常:', e.message);
    }
    for (let i = 1; i <= 3; i++) {
        if (!(await clickText(page, '退出副本', 2000))) {
            await jsClick(page, '退出副本');
        }
        await sleep(1500);
        let t = await getPageText(page);
        if (t.includes('副本条件') && t.includes('确定')) {
            await clickExact(page, '确定', 2000);
            await sleep(1500);
            t = await getPageText(page);
        }
        if (!(t.includes('副本条件') && t.includes('回到起点'))) {
            console.log('已退出副本');
            return true;
        }
        console.log(`第${i}次退出副本未生效，重试...`);
    }
    const t = await getPageText(page);
    console.log('退出副本失败，仍在:', t.replace(/\s+/g, ' ').substring(0, 200));
    await page.screenshot({ path: 'dungeon-recover-fail.png' }).catch(() => {});
    return false;
}

// 重载页面（会话仍有效会自动回到游戏），用于点击无响应时刷新前端
async function reloadGame(page) {
    try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        console.log('重载页面失败:', (e.message || '').split('\n')[0]);
        return false;
    }
    await sleep(3000);
    if ((await getPageText(page)).includes('请输入账号密码')) {
        console.log('重载后回到登录页，重新登录...');
        try {
            await gotoGame(page, 3);
        } catch (e) {
            console.log('重登失败:', (e.message || '').split('\n')[0]);
            return false;
        }
        await sleep(3000);
    }
    return true;
}

// 打开传送面板（不在码头先走城内地图→码头），返回是否真打开
async function openTeleportPanel(page) {
    for (let i = 0; i < 3; i++) {
        const t = await getPageText(page);
        if (!t.includes('码头')) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
        }
        let ok = await clickText(page, '传送', 2500);
        if (!ok) ok = await jsClick(page, '传送');
        await sleep(2500);
        const pt = await getPageText(page);
        // 放宽判定：页面半渲染时只会出现部分洲名
        if (pt.includes('地中海') || pt.includes('印度洋') || pt.includes('大西洋') || pt.includes('太平洋')) return true;
        console.log(`传送面板未打开(${i + 1}/3)，关闭重试...`);
        await page.mouse.click(10, 10);
        await sleep(300);
        await page.keyboard.press('Escape');
        await sleep(500);
    }
    return false;
}

// 传送兜底：出航流程失败后重新登录 → 码头点传送 → 点目标城市瞬间到达
async function teleportToDest(page) {
    // 防白花银币：已到达 / 仍在海上（传送在航行中点不开）都别重登折腾
    const chk = await getPageText(page);
    if (chk.includes(`当前城市：${NAV_DEST}`)) {
        console.log(`传送兜底: 其实已在${NAV_DEST}，跳过传送(省银币)`);
        return true;
    }
    if (chk.includes('停止自动航行') || chk.includes('剩余距离')) {
        console.log('传送兜底: 仍在航行，海上点不了传送 → 原地再等 3 分钟');
        for (let i = 0; i < 60; i++) {
            await sleep(3000);
            const t = await getPageText(page);
            if (t.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`传送兜底: 已到达${NAV_DEST}`);
                return true;
            }
            if (t.includes('遭遇海盗')) {
                await clickExact(page, '避战', 3000);
                await sleep(2000);
                if (await clickExact(page, '自动航行', 3000)) console.log('恢复自动航行');
            }
        }
        console.log('传送兜底: 仍在海上，放弃（不重登打断航行）');
        return false;
    }
    console.log('传送兜底: 重新登录游戏...');
    try {
        if (!(await gotoGame(page))) {
            console.log('传送兜底: 打开页面失败(3次重试均超时)');
            return false;
        }
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        if (inputs.length >= 2) {
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
            console.log('传送兜底: 点登录 →', (await clickLoginButton(page)) || '未找到按钮');
            await sleep(3000);
        } else {
            // 会话仍有效时登录页会自动跳回游戏，无需重新填账号
            console.log('传送兜底: 会话有效，页面已自动进入游戏');
        }
        await closePopup(page);
        await sleep(1000);
        const how = await clickEnterGame(page);
        console.log('传送兜底: 点进入游戏 →', how || '未找到按钮');
        await sleep(3000);
        console.log('传送兜底: 重新登录完成');

        // 重登可能落回副本房间，先退出再开传送面板
        await exitDungeonIfInside(page);

        // 面板打不开多半是页面半渲染（点击无响应），重载页面再来一轮基本能救回
        let panelOpen = await openTeleportPanel(page);
        if (!panelOpen) {
            console.log('传送面板多次打不开，重载页面后再试一轮...');
            await page.screenshot({ path: 'teleport-reload.png' }).catch(() => {});
            await reloadGame(page);
            await sleep(4000);
            await exitDungeonIfInside(page);
            panelOpen = await openTeleportPanel(page);
        }
        if (!panelOpen) {
            const pt = await getPageText(page);
            console.log('传送兜底: 找不到传送入口，页面文本:', pt.replace(/\s+/g, ' ').substring(0, 300));
            await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
            return false;
        }

        await clickExact(page, NAV_REGION);
        await sleep(1000);

        for (let s = 0; s < 5; s++) {
            if (await clickText(page, NAV_DEST, 2000)) break;
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }

        // 传送即时生效：轮询到达，其间按需点确定/确认
        let txt = '';
        for (let i = 0; i < 8; i++) {
            await sleep(1500);
            txt = await getPageText(page);
            if (txt.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`传送兜底: 已到达${NAV_DEST}`);
                return true;
            }
            if (txt.includes('确定')) {
                await clickText(page, '确定');
                await sleep(1000);
            } else if (txt.includes('确认')) {
                await clickText(page, '确认');
                await sleep(1000);
            }
        }
        console.log('传送兜底: 未检测到到达，页面文本:', txt.replace(/\s+/g, ' ').substring(0, 300));
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    }
}

// 掉线自救：重新打开游戏并登录（会话失效时自动填账号），返回是否完成
async function relogin(page) {
    if (!(await gotoGame(page))) {
        console.log('自救: 打开页面失败(3次重试均超时)');
        return false;
    }
    await page.waitForTimeout(3000);
    const inputs = await page.$$('input');
    if (inputs.length >= 2) {
        await inputs[0].fill(ACCOUNT).catch(() => {});
        await inputs[1].fill(PASSWORD).catch(() => {});
        console.log('自救: 点登录 →', (await clickLoginButton(page)) || '未找到按钮');
        await sleep(3000);
    } else {
        console.log('自救: 会话有效，页面已自动进入游戏');
    }
    await closePopup(page);
    await sleep(1000);
    const howEnter = await clickEnterGame(page);
    console.log('自救: 点进入游戏 →', howEnter || '未找到按钮');
    await sleep(3000);
    await closePopup(page);
    console.log('自救: 重新登录完成');
    return true;
}

// 确保站在广州（跨城）：不在广州就走「出航 → 传送兜底 → 严格校验」，两轮都不行才返回 false。
//
// ★ 为什么必须抽成函数（2026-11-23 coldwind8 事故）：
//   打怪循环里有两条自愈路径 —— ①掉回登录页重登后 ②连续 10 分钟无击杀重登后 ——
//   原来两条都直接调 gotoBeach()。而 gotoBeach 只是**广州城内**走位（东城门→沙滩294→沙滩）：
//   号一旦落在别的城市（这次是威尼斯，钓鱼城市，城内只有「海滩4」没有「沙滩」），
//   三次点沙滩全部 false，于是每 10.5 分钟重复一轮「重登→点不到沙滩」，整趟 5 小时只刷了 8432 次
//   （同批其他号 4 万+），而且日志里没有任何 error，从 CI 状态完全看不出来。
//   所以自愈必须先回广州，再走城内沙滩。
async function ensureGuangzhou(page) {
    let pageText = await getPageText(page);
    if (pageText.includes(`当前城市：${NAV_DEST}`)) {
        console.log(`已在${NAV_DEST}`);
        return true;
    }
    for (let round = 1; round <= 2; round++) {
        console.log(`不在${NAV_DEST}，导航中...(第${round}/2轮)`);

        if (round > 1) {
            await reloadGame(page);
            await sleep(4000);
            await exitDungeonIfInside(page);
        }

        const arrived = await sailFlow(page);
        if (!arrived && SAIL_FAIL === 'nomap') {
            console.log(`⚠ ${NAV_DEST} 暂无地图（该号没有这张海图），不传送`);
            await page.screenshot({ path: 'nav-nomap.png' }).catch(() => {});
        } else if (!arrived) {
            await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
            // 船还在海上（跨洋没走完）→ 续等一轮，别重登（重登会打断航行）
            const now = await getPageText(page);
            if (now.includes('停止自动航行') || now.includes('剩余距离')) {
                console.log('首轮航行未到港但船仍在海上 → 续等 5 分钟...');
                if (!(await sailFlow(page, 100))) await teleportToDest(page);
            } else {
                console.log('出航未完成（没起航/已回港），改用传送兜底...');
                await teleportToDest(page);
            }
        }
        await sleep(2000);

        pageText = await getPageText(page);
        if (pageText.includes(`当前城市：${NAV_DEST}`)) return true;
    }
    return false;
}

// 走到沙滩（广州城内：东城门 -> 沙滩294 -> 沙滩），失败返回 false
async function gotoBeach(page) {
    // 导航到沙滩：东城门 -> 沙滩294 -> 沙滩（手机手动验证过的路径）
    // 到达东城门的标志：主页面出现"东：沙滩294"
    console.log('导航到沙滩...');
    await page.keyboard.press('Escape');
    await sleep(1000);

    let pageText;

    // 第1步：走到东城门
    for (let i = 0; i < 4; i++) {
        pageText = await getPageText(page);
        if (pageText.includes('沙滩294')) {
            console.log('[nav] 已在东城门附近（看到沙滩294）');
            break;
        }
        let ok = await jsClick(page, '东城门');
        if (!ok || i >= 1) {
            console.log(`[nav] 打开城内地图(${i + 1}):`, await jsClick(page, '城内地图'));
            await sleep(2000);
            ok = await jsClick(page, '东城门');
        }
        console.log(`[nav] 点东城门(${i + 1}):`, ok, i >= 1 ? '(经城内地图)' : '(主页面)');
        await sleep(3000);
        await page.screenshot({ path: `nav-2-gate-${i + 1}.png` }).catch(() => {});
    }
    pageText = await getPageText(page);
    console.log('[nav] 第1步后地图:', mapBlock(pageText), '| 沙滩294=' + pageText.includes('沙滩294'));

    // 第2步：点沙滩294（只在还站在东城门方向上时点）
    for (let i = 0; i < 3; i++) {
        pageText = await getPageText(page);
        if (!pageText.includes('东：沙滩294') && !pageText.includes('东:沙滩294')) break;
        console.log(`[nav] 点沙滩294(${i + 1}):`, await jsClick(page, '沙滩294'));
        await sleep(3000);
        await page.screenshot({ path: `nav-3-294-${i + 1}.png` }).catch(() => {});
    }
    pageText = await getPageText(page);
    console.log('[nav] 第2步后地图:', mapBlock(pageText), '| 东向沙滩294=' + (pageText.includes('东：沙滩294') || pageText.includes('东:沙滩294')));

    // 第3步：进沙滩
    for (let i = 0; i < 3; i++) {
        pageText = await getPageText(page);
        if (pageText.includes('经验妖灵')) break;
        console.log(`[nav] 点沙滩(${i + 1}):`, await jsClick(page, '沙滩', '294'));
        await sleep(3000);
        await page.screenshot({ path: `nav-4-beach-${i + 1}.png` }).catch(() => {});
    }

    pageText = await getPageText(page);
    console.log('[nav] 到达后地图:', mapBlock(pageText), '| 经验妖灵=' + pageText.includes('经验妖灵'));
    if (pageText.includes('经验妖灵') || pageText.includes('当前城市：广州')) {
        console.log('到达沙滩');
        return true;
    }
    return false;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 登录
        if (!(await gotoGame(page))) throw new Error('打开游戏页失败(3次重试均超时)');
        await page.waitForTimeout(3000);

        // 登录（带重试）
        for (let attempt = 0; attempt < 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                // 会话已生效时登录页无表单（直接停在游戏/选角页），跳过登录
                let t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    console.log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                console.log('找不到输入框，刷新页面...');
                if (!(await gotoGame(page))) {
                    await sleep(2000);
                    continue;
                }
                await page.waitForTimeout(3000);
                const newInputs = await page.$$('input');
                if (newInputs.length < 2) {
                    t = await getPageText(page);
                    if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                        console.log('无表单但已在游戏流程中（会话有效），跳过登录');
                        break;
                    }
                    console.log('刷新后仍找不到输入框，重试...');
                    await sleep(2000);
                    continue;
                }
                await newInputs[0].fill(ACCOUNT);
                await newInputs[1].fill(PASSWORD);
            } else {
                await inputs[0].fill(ACCOUNT);
                await inputs[1].fill(PASSWORD);
            }
            console.log(`点登录 → ${(await clickLoginButton(page)) || '未找到按钮'}`);
            await sleep(3000);
            console.log(`登录尝试${attempt + 1}`);

            // 检查是否出现"进入游戏"或已直接进入游戏主界面
            let pageText = await getPageText(page);
            if (pageText.includes('进入游戏')) {
                console.log('登录成功，进入游戏');
                break;
            }
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('登录成功，已在游戏内');
                break;
            }
            console.log('登录未成功，重试...');
            await sleep(2000);
        }

        // 点击进入游戏（带重试）
        for (let i = 0; i < 10; i++) {
            const how = await clickEnterGame(page);
            console.log(`进入游戏第${i + 1}轮 → ${how || '未找到按钮'}`);
            await sleep(5000);
            let pageText = await getPageText(page);
            // 如果是选角界面（有"选择角色"或Lv.），需要再点一次进入游戏
            if (pageText.includes('选择角色') || pageText.includes('Lv.')) {
                console.log('在选角界面，点击进入游戏选角色...');
                await clickEnterGame(page);
                await sleep(5000);
                pageText = await getPageText(page);
            }
            // 如果页面包含游戏内容（有"你看到"或"当前城市"），说明成功
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('进入游戏成功');
                break;
            }
            console.log('进入游戏未成功，重试...');
            await sleep(2000);
        }

        // 等待页面加载完成
        await sleep(5000);

        // 最终验证：确认已进入游戏（不是登录页或选角界面）
        let pageText = await getPageText(page);
        if (pageText.includes('请输入账号密码') || pageText.includes('登录注册') || pageText.includes('选择角色')) {
            console.log('ERROR: 未进入游戏主界面，退出');
            console.log('::error::登录失败：未进入游戏主界面，刷怪已退出');
            diag('登录失败：未进入游戏主界面', 1);
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 检查是否有弹窗并关闭
        console.log('页面文本前200字:', pageText.substring(0, 200));

        // 尝试关闭弹窗（只按ESC，不点屏幕避免误操作）
        await page.keyboard.press('Escape');
        await sleep(2000);

        // 再次检查
        pageText = await getPageText(page);
        console.log('关闭弹窗后前200字:', pageText.substring(0, 200));

        // 卡副本自恢复（dungeon误进/未退出会把号留在房间里，后续全部步骤都会撞死）
        await exitDungeonIfInside(page);

        // 检查是否在广州（失败不直接放弃：重载页面再试一轮，点击无响应多半能救回）
        if (!(await ensureGuangzhou(page))) {
            // 严格校验：没到广州绝不往下走（否则会在错误城市空转数小时）
            console.log('未到达广州，跳过农场');
            console.log('::error::farm 出航失败：未到达广州，刷怪未开始');
            diag(`未到达广州（出航/传送均失败，SAIL_FAIL=${SAIL_FAIL || 'none'}）`, 1);
            await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        if (!(await gotoBeach(page))) {
            // 不在广州时“沙滩导航”会在错误城市空转，直接退出而不是假装到达
            console.log('不在广州，沙滩导航失败，退出农场');
            console.log('::error::farm 沙滩导航失败：未到打怪点，刷怪未开始');
            diag('沙滩导航失败（未到打怪点）', 1);
            await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 循环打经验妖灵（选怪→50→攻击→50→关闭→50，一刀一个）
        // 日志节流：每轮都打印会刷出几十MB日志、拖垮runner，改为每60秒汇报一次进度
        let count = 0;
        const loopStart = Date.now();
        // 不设时长：一直刷，直到 job 被 6 小时硬上限杀掉（用户 11-23 20:00 定）。
        console.log('刷怪不限时长：一直刷到 job 6 小时硬上限被杀为止');

        // 自愈计数：连续几次「重登后仍回不到广州/走不到沙滩」就停手。
        // 不留这个计数的话，号只要落在外地城市就会以 10 分钟一轮无限空转到 job 被杀，
        // 而日志里一片正常（2026-11-23 coldwind8 就这样白跑 1 小时 40 分）。
        let healFails = 0;
        async function recoverToBeach() {
            if (await ensureGuangzhou(page)) {
                if (await gotoBeach(page)) { healFails = 0; return true; }
            }
            healFails++;
            console.log(`自愈失败（连续第 ${healFails} 次：不在${NAV_DEST}或走不到打怪点）`);
            if (healFails >= 3) {
                console.log(`::error::farm 连续 3 次自愈失败：号一直回不到${NAV_DEST}打怪点，本趟停止（不再空转到 job 被杀）`);
                diag(`连续 3 次自愈失败（回不到${NAV_DEST}/沙滩）`, 1);
            }
            return false;
        }
        let lastLogAt = Date.now();
        let lastCountAt = Date.now();
        console.log('进入打怪循环（进度每60秒汇报一次）');
        while (true) {
            pageText = await getPageText(page);
            EXIT_DIAG.kills = count;

            // 不再有「到点主动收尾」：刷怪不限时长，由 job 6 小时硬上限终止进程。

            // 账号被接管（退回登录页）→ 先判断是谁占的号，两类必须走相反动作。
            //   a) 被顶时刻距最近派发点 ≤ DISPATCH_WINDOW_MIN → 另一趟 CI 刚起跑并登录了同一个号
            //      （如 06:00 趟刷到 11:30 被 11:30 趟的组队顶掉）→ 立刻退场，把号完整交给对方。
            //      为什么不能重登：对方在持续占号，本趟一登就把它顶掉，它也重登，双方来回抢，
            //      两趟 run 的有效时间都被切碎。
            //   b) 窗口外 → 用户手动登录在玩 → 阶梯重登等他下线，不能直接退场。
            //      用户 11-23 20:11：「我就玩一会儿，比如30分钟就下线了，那刷野怪不就不会跑了？」
            //      直接退场会把整趟 5~6 小时的刷怪废掉，只因为用户玩了半小时。
            if (pageText.includes('请输入账号密码') || (pageText.includes('已保存账号') && pageText.includes('请输入密码'))) {
                const mins = Math.round((Date.now() - loopStart) / 60000);
                await page.screenshot({ path: 'farm-offline.png' }).catch(() => {});

                if (isNearDispatch(Date.now())) {
                    console.log(`账号被接管(退回登录页)：已打 ${count} 次、运行 ${mins} 分钟。距派发点 ≤ ${DISPATCH_WINDOW_MIN} 分钟 → 判定为下一趟 CI 交接，本趟立即退场`);
                    diag('账号被接管（派发窗口内，CI 交接），主动退场', 0);
                    break;
                }

                console.log(`账号被接管(退回登录页)：已打 ${count} 次、运行 ${mins} 分钟。不在派发窗口内 → 判定为手动登录占用，每 ${USER_OCCUPY_WAIT_MIN} 分钟尝试接管一次（最多 ${USER_OCCUPY_TRIES} 轮）`);
                let resumed = false;
                let exitByWindow = false;
                for (let i = 1; i <= USER_OCCUPY_TRIES; i++) {
                    await sleep(USER_OCCUPY_WAIT_MIN * 60000);
                    // 等待期间可能已经进入下一趟派发窗口：这时必须让位，不能把 CI 的号顶掉
                    if (isNearDispatch(Date.now())) {
                        console.log(`等待第 ${i} 轮期间进入派发窗口（距派发点 ≤ ${DISPATCH_WINDOW_MIN} 分钟），放弃接管、让位退场`);
                        exitByWindow = true;
                        break;
                    }
                    console.log(`手动占用等待第 ${i}/${USER_OCCUPY_TRIES} 轮：尝试重新登录...`);
                    if (!(await relogin(page))) {
                        console.log(`第 ${i} 轮重登失败（页面打不开），继续等`);
                        continue;
                    }
                    pageText = await getPageText(page);
                    if (pageText.includes('请输入账号密码')) {
                        console.log(`第 ${i} 轮仍被占用（对方还在线），继续等`);
                        continue;
                    }
                    // 登进去了：先确保回到广州打怪点（重登可能落在别的城市，见 coldwind8 事故）
                    if (!(await recoverToBeach())) {
                        console.log(`第 ${i} 轮已登录但回不到打怪点，继续等`);
                        if (healFails >= 3) break;      // recoverToBeach 里已 ::error:: + diag(…, 1)
                        continue;
                    }
                    resumed = true;
                    break;
                }
                if (resumed) {
                    lastCountAt = Date.now();
                    console.log(`已接管账号，恢复刷怪（累计已打 ${count} 次）`);
                    continue;
                }
                if (healFails >= 3) break;
                diag(exitByWindow
                    ? '等待手动占用期间进入派发窗口，让位退场'
                    : `手动占用超过 ${USER_OCCUPY_TRIES} 轮（约 ${USER_OCCUPY_TRIES * USER_OCCUPY_WAIT_MIN} 分钟），主动退场`, 0);
                break;
            }

            if (pageText.includes('经验妖灵')) {
                await clickText(page, '经验妖灵');
                await sleep(50);

                // 这里不做血池判断（用户 2026-11-15）：农场一刀一怪，怪打不到人、也不消耗血池，
                // 有没有药都不影响刷怪、也不会死。血池只对「一刀砍不死的怪」才有意义（如攻城、
                // 副本里的怪），那些地方才需要补药。
                // 顺带记一笔：要看血池只需点开怪的战斗面板（「体力：x/y -0 血池：0」），不用开背包。

                // 一击必杀：直接点攻击，不循环
                await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
                await sleep(50);

                // 直接点关闭
                await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
                await sleep(50);

                count++;
                healFails = 0;   // 打到了就说明位置正常，自愈计数清零（避免几次相隔很远的偶发失败累加到 3）
                lastCountAt = Date.now();
            } else {
                if (count === 0 && !global.__shot) {
                    global.__shot = true;
                    await page.screenshot({ path: 'stuck-beach.png' });
                }
                await clickText(page, '刷新');
                await sleep(50);
            }

            // 10分钟没击杀=卡死（页面空白/人物异常），重登并走回沙滩自愈
            if (Date.now() - lastCountAt >= 600000) {
                console.log(`连续10分钟无击杀(已打${count}次)，尝试自愈：重登+走回沙滩...`);
                await page.screenshot({ path: 'farm-stuck.png' }).catch(() => {});
                await relogin(page);
                pageText = await getPageText(page);
                // 同掉线自救：先确保回到广州，否则 gotoBeach 在外地城市必然失败（2026-11-23 coldwind8）
                if (!pageText.includes('经验妖灵')) await recoverToBeach();
                lastCountAt = Date.now();
                if (healFails >= 3) break;
                continue;
            }

            const now = Date.now();
            if (now - lastLogAt >= 60000) {
                lastLogAt = now;
                const mins = Math.round((now - loopStart) / 60000);
                const tail = pageText.includes('经验妖灵')
                    ? ''
                    : ` | 未见经验妖灵，页面: ${pageText.substring(0, 80)}`;
                console.log(`打怪进行中：已完成 ${count} 次，已运行 ${mins} 分钟${tail}`);
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
        console.error('::error::farm 运行异常:', e.stack || e.message);
        diag(`运行异常: ${e.message}`, 1);
    } finally {
        await browser.close().catch(() => {});
        console.log(exitLine());
    }
}

run();
