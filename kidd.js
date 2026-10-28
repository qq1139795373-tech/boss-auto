const { chromium } = require('playwright');
// 扫荡/领奖弹窗处理 + 只读可见节点的页面文本
const drain = require('./dungeon-recover.js');
const { visibleText } = drain;

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 基德的宝藏 in 北海-阿姆斯特丹
const NAV_DEST = '阿姆斯特丹';
const NAV_REGION = '北海';
// DUNGEON_DRY=1 只导航到副本入口页，不真正进入副本（不消耗每日次数）
const DRY = process.env.DUNGEON_DRY === '1';
// DUNGEON_NO_CLAIM=1 打完不点领取奖励（留副本内供人工上号查验）
const NO_CLAIM = process.env.DUNGEON_NO_CLAIM === '1';

// 怪物（按图：仆从10500最弱、手下居中、狂兽18500最强）
const MONSTERS = ['基德仆从', '基德手下', '基德狂兽'];
// 入口链路（说明截图）：城内地图→北城门→点「基德的仆从」→点「基德的宝藏」→进入副本（每日剩余1次）
const ENTRY_NPC = '基德的仆从';
const ENTRY_LINK = '基德的宝藏';
const ENTRY_GATE = '北城门';
// 枢纽广场标志：三条支路入口同时在页面上
const HUB_MARKS = ['奴隶仓', '兽栏口', '暗仓口'];
// 从秘藏入口到枢纽的路径（防止走支路时往回拐）
const ENTRY_PATH = ['秘藏入口', '验货棚', '栈桥', '接驳厅', '枢纽广场'];
// 三条支路：西=死路弱怪，北=死路强怪，东=长廊直通宝库
const ARMS = [
    { dir: '西', label: '西线' },
    { dir: '东', label: '东线' },
    { dir: '北', label: '北线' },
];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            return;
        } catch (e) {
            console.log(`打开页面第${i}/${retries}次失败:`, (e.message || '').split('\n')[0]);
            await sleep(3000);
        }
    }
    throw new Error('打开游戏页失败(3次重试均超时)');
}

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
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

// 只拼可见节点。原实现 textContent('body') 不排除 display:none，
// 残留弹窗节点会一直留在 DOM 里 → 读出幽灵文案，把「没成」判成「成了」（2026-10-28 同源问题）。
async function getPageText(page) {
    return await visibleText(page);
}

async function remainMin(page) {
    const txt = await getPageText(page);
    const m = txt.match(/副本剩余时间[：:]\s*(\d+)\s*分钟/);
    return m ? parseInt(m[1], 10) : null;
}

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

async function closePopup(page) {
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.mouse.wheel(0, 300);
    await page.keyboard.press('Escape');
    await sleep(1000);
}

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

async function sailFlow(page) {
    let step = await clickText(page, '出航', 2000);
    if (!step) {
        await clickText(page, '城内地图');
        await sleep(2000);
        await clickText(page, '码头');
        await sleep(3000);
        step = await clickText(page, '出航');
    }
    await sleep(2000);
    await clickExact(page, NAV_REGION);
    await sleep(1000);

    let picked = false;
    for (let s = 0; s < 5; s++) {
        if (await clickText(page, NAV_DEST, 2000)) {
            await sleep(1500);
            if ((await getPageText(page)).includes('出航确认')) {
                picked = true;
                break;
            }
        }
        await page.mouse.wheel(0, 300);
        await sleep(1000);
    }
    if (!picked) console.log('未看到出航确认框，继续尝试...');

    await sleep(1000);
    await clickText(page, '立即出发');
    await sleep(2000);
    await clickExact(page, '自动航行', 5000);
    console.log('航行中...');

    for (let w = 0; w < 80; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`到达${NAV_DEST}`);
            return true;
        }
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
    console.log('航行未完成（约4分钟）');
    return false;
}

async function teleportToDest(page) {
    console.log('传送兜底: 重新登录游戏...');
    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        if (inputs.length >= 2) {
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
            await page.getByText('登录').first().click();
            await sleep(3000);
        } else {
            console.log('传送兜底: 会话有效，页面已自动进入游戏');
        }
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);

        let ok = await clickText(page, '传送', 2000);
        if (!ok) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            ok = await clickText(page, '传送');
        }
        if (!ok) {
            console.log('传送兜底: 找不到传送入口');
            return false;
        }
        await sleep(2000);

        await clickExact(page, NAV_REGION);
        await sleep(1000);

        for (let s = 0; s < 5; s++) {
            if (await clickText(page, NAV_DEST, 2000)) break;
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }

        await sleep(3000);
        let txt = await getPageText(page);
        if (!txt.includes(`当前城市：${NAV_DEST}`)) {
            await clickText(page, '确定');
            await sleep(2000);
            await clickText(page, '确认');
            await sleep(2000);
            txt = await getPageText(page);
        }
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`传送兜底: 已到达${NAV_DEST}`);
            return true;
        }
        console.log('传送兜底: 未检测到到达');
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        return false;
    }
}

// “你看到：”到“背包”之间的区块（怪物列表+地图出口都在其中）
function viewSeg(txt) {
    const i = txt.indexOf('你看到：');
    if (i < 0) return '';
    const j = txt.indexOf('背包', i);
    return txt.substring(i, j > i ? j : txt.length);
}

function monstersIn(seg) {
    const found = [];
    for (const m of MONSTERS) {
        if (seg.includes(m)) found.push(m);
    }
    return found;
}

// 点击“你看到：”里的怪物链接：只在“你看到”标签之后的叶子节点里按全等文本匹配
async function clickMonster(page, name) {
    return await page.evaluate((t) => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0;
        });
        const seenIdx = leaves.findIndex(el => (el.textContent || '').includes('你看到'));
        const from = seenIdx >= 0 ? seenIdx + 1 : 0;
        const all = leaves.slice(from).filter(el => (el.textContent || '').trim() === t);
        if (!all.length) return false;
        const el = all.find(e => e.tagName === 'A') || all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, name);
}

// 列出当前房间全部方向出口（如 {dir:'北', target:'狂兽栏'}）
async function allExits(page) {
    return await page.evaluate(() => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                /^[东西南北][：:]/.test(s) && s.length > 2;
        });
        return all.map(el => {
            const s = el.textContent.trim();
            return { dir: s[0], target: s.slice(1).replace(/[：:]/, '').trim() };
        });
    });
}

// 找指定方向出口按钮文本（null=该方向无出口）
async function exitLabel(page, dir) {
    return await page.evaluate((d) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                (s.startsWith(d + '：') || s.startsWith(d + ':')) && s.length > 1;
        });
        if (!all.length) return null;
        return all[0].textContent.trim();
    }, dir);
}

async function clickExit(page, dir) {
    return await page.evaluate((d) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                (s.startsWith(d + '：') || s.startsWith(d + ':')) && s.length > 1;
        });
        if (!all.length) return false;
        const el = all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, dir);
}

async function atHub(page) {
    const txt = await getPageText(page);
    return HUB_MARKS.every(m => txt.includes(m));
}

// 打一只怪：选怪后反复出刀直到出现结算（一刀可能杀不死），最后关结算
async function fightOne(page, name) {
    if (!(await clickMonster(page, name))) return false;
    await sleep(300);
    let blades = 0;
    for (let a = 0; a < 12; a++) {
        const txt = await getPageText(page);
        if (txt.includes('关闭')) {
            await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
            await sleep(300);
            console.log(`  [战斗] ${name}: ${blades}刀+结算`);
            return true;
        }
        if (txt.includes('攻击')) {
            await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
            blades++;
            await sleep(300);
            continue;
        }
        await sleep(300);
        const t2 = await getPageText(page);
        if (!t2.includes('攻击') && !t2.includes('关闭')) break;
    }
    await page.locator('text=关闭').first().click({ force: true, timeout: 300 }).catch(() => {});
    if (blades) console.log(`  [战斗] ${name}: ${blades}刀(未见结算)`);
    await sleep(200);
    return true;
}

// evaluate精确点击页面上的链接文本（绕过遮罩）
async function clickLeaf(page, text) {
    return await page.evaluate((t) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                (s === t || s.includes(t));
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, text);
}

// 打完一条线回枢纽：回到起点→秘藏入口→一路往北→枢纽广场
async function backToHub(page) {
    for (let i = 0; i < 8 && !(await atHub(page)); i++) {
        if (await exitLabel(page, '北')) {
            await clickExit(page, '北');
        } else if ((await getPageText(page)).includes('回到起点')) {
            await clickLeaf(page, '回到起点');
        } else {
            break;
        }
        await sleep(1500);
    }
    return await atHub(page);
}

// 从秘藏入口一路往北到枢纽广场，沿途清掉走廊每一间房的怪。
// 地图（用户确认）：秘藏入口**无怪**、枢纽广场**无怪**；验货棚/栈桥/接驳厅各 3 只基德仆从(10500) = 9 只。
// 之前只走路不清怪，等于白漏这 9 只。首次进本与续打都走这里（无怪的房间自动跳过）。
async function northToHubClearing(page) {
    let kills = 0;
    for (let i = 0; i < 8 && !(await atHub(page)); i++) {
        const seg = viewSeg(await getPageText(page));
        const mobs = monstersIn(seg);
        if (mobs.length) {
            const k = await clearRoom(page, '走廊');
            if (k) {
                kills += k;
                console.log(`[走廊] 清怪 ${k} 只（${mobs.join('/')}）`);
            }
        }
        if (await exitLabel(page, '北')) {
            await clickExit(page, '北');
        } else if ((await getPageText(page)).includes('回到起点')) {
            await clickLeaf(page, '回到起点');
        } else {
            break;
        }
        await sleep(1500);
    }
    // 枢纽广场本身没有怪，到达后再确认一次
    if (await atHub(page)) {
        const seg = viewSeg(await getPageText(page));
        if (monstersIn(seg).length) {
            const k = await clearRoom(page, '枢纽广场');
            if (k) {
                kills += k;
                console.log(`[枢纽广场] 清怪 ${k} 只`);
            }
        }
    }
    return { ok: await atHub(page), kills };
}

// 清空当前房间的怪，返回击杀数
async function clearRoom(page, tag) {
    let kills = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
        const txt = await getPageText(page);
        const seg = viewSeg(txt);
        if (!seg) {
            console.log(`[${tag}] 找不到“你看到”区块，页面:`, txt.substring(0, 120));
            await sleep(1000);
            continue;
        }
        const mobs = monstersIn(seg);
        if (!mobs.length) return kills;
        const before = seg.split(mobs[0]).length - 1;
        await fightOne(page, mobs[0]);
        const after = viewSeg(await getPageText(page));
        const nowCount = after.split(mobs[0]).length - 1;
        kills += Math.max(0, before - nowCount);
        if (before - nowCount === 0 && attempt > 10) {
            await page.screenshot({ path: `dungeon-stuck-${tag}.png` }).catch(() => {});
        }
    }
    await page.screenshot({ path: `dungeon-room-stuck-${tag}.png` }).catch(() => {});
    throw new Error(`[${tag}] 房间怪物清理失败（15次尝试）`);
}

// 扫荡：进入副本后页头「回到起点」左侧若有「扫荡」，一键扫完（按钮逻辑同炼器窟）
async function trySweep(page) {
    let t0 = await getPageText(page);
    let waited = 0;
    for (let i = 0; i < 4 && !t0.includes('扫荡'); i++) {
        await sleep(1500);
        waited += 1.5;
        t0 = await getPageText(page);
    }
    if (t0.includes('扫荡') && waited > 0) console.log(`等待${waited}秒后扫荡入口出现`);
    if (!t0.includes('扫荡')) {
        const i = t0.indexOf('副本条件');
        const seg = i >= 0 ? t0.slice(i, i + 100).replace(/\s+/g, ' ') : '(页面无副本条件行)';
        console.log(`未见扫荡入口，走手动清怪流程 | ${seg} | 回到起点=${t0.includes('回到起点')} 退出副本=${t0.includes('退出副本')} 领取奖励=${t0.includes('领取奖励')} 文本长=${t0.length}`);
        await page.screenshot({ path: 'kidd-no-sweep.png' }).catch(() => {});
        return false;
    }
    console.log('发现扫荡入口，点击扫荡...');
    let ok = await clickLeaf(page, '扫荡');
    if (!ok) ok = await jsClick(page, '扫荡');
    if (!ok) {
        console.log('扫荡入口点击失败');
        return false;
    }
    let txt = '';
    for (let w = 0; w < 8; w++) {
        await sleep(1000);
        txt = await getPageText(page);
        if (txt.includes('扫荡收获') || txt.includes('扫荡成功')) break;
    }
    if (!txt.includes('扫荡收获') && !txt.includes('扫荡成功')) {
        console.log('未出现扫荡结果，页面:', txt.substring(0, 150).replace(/\s+/g, ' '));
        return false;
    }
    // 「扫荡收获」只有一个「知道了」，点完必须回头验证它真的关了，
    // 否则它盖住「领取奖励」，领奖会废掉（炼器窟 boss(0) 就是这么废的）。
    if (!(await drain.closeSweepPopup(page, { log: console.log }))) {
        console.log('「扫荡收获」弹窗关不掉');
        await page.screenshot({ path: 'kidd-sweep-popup-stuck.png' }).catch(() => {});
        return false;
    }
    console.log('已关闭「扫荡收获」，可以领奖了');
    await sleep(1500);
    console.log('扫荡成功（剩余', await remainMin(page), '分钟），跳过手动清怪');
    return true;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);

        for (let attempt = 0; attempt < 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                let t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    console.log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                console.log('找不到输入框，刷新页面...');
                await gotoGame(page);
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
            await page.getByText('登录').first().click();
            await sleep(3000);
            console.log(`登录尝试${attempt + 1}`);

            let pageText = await getPageText(page);
            if (pageText.includes('进入游戏') || pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('登录成功');
                break;
            }
            console.log('登录未成功，重试...');
            await sleep(2000);
        }

        for (let i = 0; i < 10; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            let pageText = await getPageText(page);
            if (pageText.includes('选择角色') || pageText.includes('Lv.')) {
                console.log('在选角界面，点击进入游戏选角色...');
                await clickText(page, '进入游戏');
                await sleep(5000);
                pageText = await getPageText(page);
            }
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('进入游戏成功');
                break;
            }
            console.log('进入游戏未成功，重试...');
            await sleep(2000);
        }

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        let pageText = await getPageText(page);
        if (pageText.includes('请输入账号密码') || pageText.includes('选择角色')) {
            console.log('ERROR: 未进入游戏主界面，退出');
            console.log('::error::登录失败：未进入游戏主界面，基德宝藏已跳过');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 上次中断后续打：登录后若已身处副本，跳过出航与进入流程
        // 必须确认是基德宝藏（含基德怪名），否则可能把人困在其他副本里乱打
        const insideDungeon = pageText.includes('副本条件') && pageText.includes('回到起点');
        const inKidd = insideDungeon && MONSTERS.some(m => pageText.includes(m));
        if (insideDungeon && !inKidd) {
            console.log('当前身处其他副本（非基德宝藏），跳过不处理，页面:', pageText.substring(0, 120).replace(/\s+/g, ' '));
            await browser.close();
            return;
        }
        const inDungeon = inKidd;
        if (inDungeon) {
            console.log('已在副本内（续打），跳过出航/进入流程');
        } else if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`已在${NAV_DEST}`);
        } else {
            console.log(`不在${NAV_DEST}，导航中...`);
            const arrived = await sailFlow(page);
            if (!arrived) {
                console.log('出航未完成，改用传送兜底...');
                await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                await teleportToDest(page);
            }
            await sleep(2000);
            pageText = await getPageText(page);
            if (!pageText.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`未到达${NAV_DEST}，退出`);
                await page.screenshot({ path: 'kidd-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }

        if (!inDungeon) {
        // 入口链路：城内地图→北城门→基德的仆从→基德的宝藏（说明截图给定）
        console.log('导航到北城门...');
        let onEntryPage = false;
        for (let i = 0; i < 8; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('进入副本') && pageText.includes(ENTRY_LINK)) {
                onEntryPage = true;
                break;
            }
            if (viewSeg(pageText).includes(ENTRY_NPC)) {
                // 在北城门了，点仆从NPC
                await clickLeaf(page, ENTRY_NPC);
                await sleep(2000);
                // 出现「可进入基德的宝藏」后点链接
                pageText = await getPageText(page);
                if (pageText.includes(ENTRY_LINK)) {
                    await clickExact(page, ENTRY_LINK, 3000) || await clickLeaf(page, ENTRY_LINK);
                    await sleep(2000);
                }
                continue;
            }
            // 不在北城门：城内地图传送过去
            await jsClick(page, '城内地图');
            await sleep(2000);
            await clickLeaf(page, ENTRY_GATE) || await clickExact(page, ENTRY_GATE, 3000);
            await sleep(2500);
        }
        pageText = await getPageText(page);
        await page.screenshot({ path: 'kidd-entry.png' }).catch(() => {});

        if (!onEntryPage && !(pageText.includes('进入副本') && pageText.includes('基德'))) {
            console.log('未到达基德宝藏入口页，页面文本:', pageText.substring(0, 300));
            await browser.close();
            return;
        }

        if (pageText.includes('次数已用尽') || pageText.includes('剩余0次')) {
            console.log('今日副本次数已用尽');
            await browser.close();
            return;
        }

        if (DRY) {
            console.log('DRY 模式：已到达基德宝藏入口页，不进入副本');
            await browser.close();
            return;
        }

        // 进入副本 → 确定，轮询最多45秒等房间标志，最多3轮
        console.log('进入副本...');
        let entered = false;
        for (let round = 1; round <= 3 && !entered; round++) {
            if (round > 1) console.log(`第${round}轮重新点击进入副本...`);
            await clickText(page, '进入副本', 3000);
            await sleep(1500);
            await clickExact(page, '确定');
            for (let w = 0; w < 15; w++) {
                await sleep(1000);
                pageText = await getPageText(page);
                if (pageText.includes('副本条件') || pageText.includes('回到起点')) {
                    entered = true;
                    break;
                }
            }
        }
        if (!entered) {
            console.log('未进入副本，页面文本:', pageText.substring(0, 300));
            await page.screenshot({ path: 'kidd-enter-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('已进入副本');
        }

        let totalKills = 0;
        let corridorKills = 0;
        const armResults = [];

        // 扫荡优先：进本后页头（「回到起点」左侧）有「扫荡」就一键完成
        const swept = NO_CLAIM ? false : await trySweep(page);
        if (swept) {
            armResults.push('扫荡');
        } else {
        // 回到枢纽广场：不在枢纽就先一路往北（沿途把走廊 3 间的基德仆从清掉）
        if (!(await atHub(page))) {
            const r = await northToHubClearing(page);
            corridorKills = r.kills;
            if (!r.ok) {
                console.log('未能到达枢纽广场，退出');
                await page.screenshot({ path: 'kidd-hub-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }
        if (corridorKills) armResults.push(`走廊: ${corridorKills}杀`);
        console.log('到达枢纽广场，剩余', await remainMin(page), '分钟');

        for (const arm of ARMS) {
            if (!(await atHub(page))) {
                console.log('不在枢纽广场，中止');
                break;
            }
            const left = await remainMin(page);
            if (left !== null && left < 5) {
                console.log(`剩余${left}分钟，不足5分钟，不再开新线`);
                break;
            }
            const started = await exitLabel(page, arm.dir);
            if (!started) {
                console.log(`[${arm.label}] 枢纽处无${arm.dir}向出口，跳过`);
                armResults.push(`${arm.label}: 无入口`);
                continue;
            }
            console.log(`[${arm.label}] 进入，出口: ${started}`);
            // visited 只记已实际走过的房间；入口线5房+本线第一房预置，防止往回拐
            // （首跑教训：第一房没预置导致在囚道选中「东：奴隶仓」走回头路，漏了奴隶仓深处）
            const firstRoom = started.slice(1).replace(/[：:]/, '').trim();
            const visited = new Set([...ENTRY_PATH, firstRoom]);
            await clickExit(page, arm.dir);
            await sleep(1500);

            let armKills = 0;
            let rooms = 0;
            for (rooms = 0; rooms < 30; rooms++) {
                const seg = viewSeg(await getPageText(page));
                const present = monstersIn(seg);
                const roomKills = await clearRoom(page, arm.label);
                armKills += roomKills;
                if (present.length) {
                    console.log(`[${arm.label}] 第${rooms + 1}间: ${present.join('/')} ×${roomKills}`);
                }
                const exits = await allExits(page);
                const next = exits.find(e => !visited.has(e.target));
                if (!next) {
                    console.log(`[${arm.label}] 到达尽头（${rooms + 1}间，击杀${armKills}）`);
                    break;
                }
                visited.add(next.target);
                console.log(`[${arm.label}] 第${rooms + 1}间 → ${next.dir}：${next.target}`);
                await clickExit(page, next.dir);
                await sleep(1500);
            }
            if (rooms >= 30) console.log(`[${arm.label}] 房间数达到上限30，强制返回`);
            totalKills += armKills;
            armResults.push(`${arm.label}: ${armKills}杀/${rooms + 1}间`);

            // 回枢纽：尽头处「回到起点」→秘藏入口→一路往北
            if (await backToHub(page)) {
                console.log(`[${arm.label}] 已回到枢纽广场，累计${totalKills}杀，剩余${await remainMin(page)}分钟`);
            } else {
                console.log(`[${arm.label}] 返回枢纽失败，中止`);
                await page.screenshot({ path: `kidd-back-fail-${arm.label}.png` }).catch(() => {});
                break;
            }
        }

        console.log('各线结果:', armResults.join(' | '),
            `| 总击杀: ${corridorKills + totalKills}（走廊${corridorKills} + 三线${totalKills}）`,
            '| 剩余', await remainMin(page), '分钟');
        }

        const armsOk = armResults.filter(r => r.includes('杀/')).length;
        const allArmsDone = swept || (armsOk === 3);

        // 领取奖励（只在三线全部走完后）
        pageText = await getPageText(page);
        if (NO_CLAIM) {
            const ci = pageText.indexOf('副本条件');
            const cj = pageText.indexOf('回到起点', ci);
            console.log('NO_CLAIM 模式：不领奖、不退出，留副本内待人工查验');
            console.log('条件行:', ci >= 0 ? pageText.substring(ci, cj > ci ? cj : ci + 120) : '(未见)');
            await page.screenshot({ path: 'kidd-no-claim.png' }).catch(() => {});
        } else if (allArmsDone && pageText.includes('领取奖励')) {
            // 领奖循环：一层层关弹窗，直到「领取奖励」消失或已离开副本页。
            // 只点一次「确定」在弹窗叠层时会半途而废（炼器窟 boss(0) 实证）。
            let got = false;
            for (let round = 1; round <= 4; round++) {
                pageText = await getPageText(page);
                if (!pageText.includes('副本条件')) { got = true; break; }
                if (!pageText.includes('领取奖励')) { got = true; break; }
                console.log(`领取奖励（第 ${round} 轮）...`);
                if (!(await drain.clickByText(page, '领取奖励'))) {
                    console.log('「领取奖励」点不到');
                    break;
                }
                await sleep(1500);
                await drain.dismissPopups(page, { log: console.log });
                await sleep(1500);
            }
            pageText = await getPageText(page);
            if (got && !pageText.includes('副本条件')) {
                console.log('奖励已领取，已退出副本');
            } else if (!pageText.includes('领取奖励')) {
                console.log('奖励已领取（领取奖励入口已消失），仍在副本页');
            } else {
                console.log('领奖失败：「领取奖励」仍在，页面:', pageText.substring(0, 300).replace(/\s+/g, ' '));
                await page.screenshot({ path: 'kidd-claim-fail.png' }).catch(() => {});
            }
        } else if (!allArmsDone) {
            console.log('未完成全部3线，不领奖');
        } else {
            console.log('未看到领取奖励入口，页面:', pageText.substring(0, 300));
            await page.screenshot({ path: 'kidd-claim-fail.png' }).catch(() => {});
        }

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'kidd-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
