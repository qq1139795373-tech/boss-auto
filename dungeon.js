const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 炼器窟在北海-伦敦
const NAV_DEST = '伦敦';
const NAV_REGION = '北海';
// DUNGEON_DRY=1 只导航到炼器窑入口页，不真正进入副本（不消耗每日次数）
const DRY = process.env.DUNGEON_DRY === '1';
// DUNGEON_NO_CLAIM=1 打完4线不点领取奖励（留副本内供人工上号查验，挤号后角色仍在副本）
const NO_CLAIM = process.env.DUNGEON_NO_CLAIM === '1';

const MONSTERS = ['猫眼猎手', '翡翠采掘者', '玄铁矿工', '血晶守卫'];
// 4个方向：dir=深入方向, entrance=枢纽处的入口名
const ARMS = [
    { dir: '北', entrance: '幽猫入口', label: '北线' },
    { dir: '西', entrance: '翠晶入口', label: '西线' },
    { dir: '东', entrance: '铁盐岔路', label: '东线' },
    { dir: '南', entrance: '赤晶入口', label: '南线' },
];

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

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

// 精确提取副本剩余分钟数（正则从页面原文取，避免控制台乱码误读）
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
    console.log('航行未完成（约5分钟）');
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
//（副本条件行在你看到之前，天然排除；不能查祖先文本，因容器以“副本条件”开头会全灭）
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

// 找方向出口按钮（文本以“北：”开头的叶子节点），如返回 null 表示该方向无出口
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
    return txt.includes('铁盐岔路') && txt.includes('翠晶入口') && txt.includes('赤晶入口');
}

// 打一只怪：选怪后反复出刀直到出现结算（一刀可能杀不死，2/3/4刀都有可能），最后关结算
// 安全网：没死的怪由房间循环再选中补杀，房间以“你看到”无怪名为准
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
        // 无弹窗无结算：可能还在过渡，稍等复看一次
        await sleep(300);
        const t2 = await getPageText(page);
        if (!t2.includes('攻击') && !t2.includes('关闭')) break;
    }
    await page.locator('text=关闭').first().click({ force: true, timeout: 300 }).catch(() => {});
    if (blades) console.log(`  [战斗] ${name}: ${blades}刀(未见结算)`);
    await sleep(200);
    return true;
}

// evaluate精确点击页面上的链接文本（绕过遮罩，force click坐标会被遮罩截获）
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

// 打完一条线回枢纽：回到起点→矿洞入口→往北→枢纽广场，带回退验证
async function backToHub(page) {
    for (let i = 0; i < 3; i++) {
        const txt = await getPageText(page);
        if (txt.includes('矿洞入口')) break;
        await clickLeaf(page, '回到起点');
        await sleep(1500);
    }
    if (!(await getPageText(page)).includes('矿洞入口')) {
        console.log('回到起点未到达矿洞入口，当前:', (await getPageText(page)).substring(0, 150));
        await page.screenshot({ path: 'dungeon-backto-start-fail.png' }).catch(() => {});
        return false;
    }
    for (let i = 0; i < 5 && !(await atHub(page)); i++) {
        if (!(await exitLabel(page, '北'))) break;
        await clickExit(page, '北');
        await sleep(1500);
    }
    return await atHub(page);
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
            await browser.close();
            return;
        }

        // 上次中断后续打：登录后若已身处副本（副本条件+回到起点），跳过出航与进入流程
        const inDungeon = pageText.includes('副本条件') && pageText.includes('回到起点');
        if (inDungeon) {
            console.log('已在副本内（续打），跳过出航/进入流程');
        } else if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`已在${NAV_DEST}`);
        } else {
            console.log(`不在${NAV_DEST}，导航中...`);
            const arrived = await sailFlow(page);
            if (!arrived) {
                console.log('出航约5分钟未完成，改用传送兜底...');
                await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                await teleportToDest(page);
            }
            await sleep(2000);
            pageText = await getPageText(page);
            if (!pageText.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`未到达${NAV_DEST}，退出`);
                await page.screenshot({ path: 'dungeon-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }

        if (!inDungeon) {
        // 铁匠铺 → 炼器师 → 炼器窟（说明书里写炼器窑，实际链接是炼器窟）
        console.log('导航到炼器窟入口...');
        let onEntryPage = false;
        for (let i = 0; i < 8; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('进入副本') && pageText.includes('炼器窟')) {
                onEntryPage = true;
                break;
            }
            const seg = viewSeg(pageText);
            if (seg.includes('炼器窟')) {
                await clickExact(page, '炼器窟', 2000);
            } else if (seg.includes('炼器师')) {
                await clickExact(page, '炼器师', 2000);
            } else {
                await jsClick(page, '铁匠铺');
                await sleep(2000);
                await jsClick(page, '城内地图');
                await sleep(2000);
                await jsClick(page, '铁匠铺');
            }
            await sleep(2000);
        }
        pageText = await getPageText(page);
        await page.screenshot({ path: 'dungeon-entry.png' }).catch(() => {});

        if (!onEntryPage && !(pageText.includes('进入副本') && pageText.includes('炼器窟'))) {
            console.log('未到达炼器窑入口页，页面文本:', pageText.substring(0, 300));
            await browser.close();
            return;
        }

        if (pageText.includes('次数已用尽') || pageText.includes('剩余0次')) {
            console.log('今日副本次数已用尽');
            await browser.close();
            return;
        }

        if (DRY) {
            console.log('DRY 模式：已到达炼器窑入口页，不进入副本');
            await browser.close();
            return;
        }

        // 进入副本 → 确定
        console.log('进入副本...');
        await clickText(page, '进入副本');
        await sleep(1500);
        await clickExact(page, '确定');
        await sleep(2500);

        pageText = await getPageText(page);
        if (!pageText.includes('副本条件') && !pageText.includes('回到起点')) {
            console.log('未进入副本，页面文本:', pageText.substring(0, 300));
            await page.screenshot({ path: 'dungeon-enter-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('已进入副本');
        }

        // 回到枢纽广场：不在枢纽就先回到起点，再往北走（矿洞入口→前厅→枢纽广场）
        if (!(await atHub(page)) && !(await backToHub(page))) {
            console.log('未能到达枢纽广场，退出');
            await page.screenshot({ path: 'dungeon-hub-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('到达枢纽广场，剩余', await remainMin(page), '分钟');

        let totalKills = 0;
        const armResults = [];

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
            console.log(`[${arm.label}] 进入，入口: ${started}`);
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
                const deep = await exitLabel(page, arm.dir);
                if (!deep) {
                    console.log(`[${arm.label}] 到达尽头（${rooms + 1}间，击杀${armKills}）`);
                    break;
                }
                await clickExit(page, arm.dir);
                await sleep(1500);
            }
            if (rooms >= 30) console.log(`[${arm.label}] 房间数达到上限30，强制返回`);
            totalKills += armKills;
            armResults.push(`${arm.label}: ${armKills}杀/${rooms + 1}间`);

            // 打完回起点再往北走回枢纽广场（比原路走快）
            if (await backToHub(page)) {
                console.log(`[${arm.label}] 已回到枢纽广场，累计${totalKills}杀，剩余${await remainMin(page)}分钟`);
            } else {
                console.log(`[${arm.label}] 返回枢纽失败，中止`);
                await page.screenshot({ path: `dungeon-back-fail-${arm.label}.png` }).catch(() => {});
                break;
            }
        }

        console.log('各线结果:', armResults.join(' | '), '| 总击杀:', totalKills, '| 剩余', await remainMin(page), '分钟');

        const allArmsDone = armResults.length === 4 && !armResults.some(r => r.includes('无入口'));

        // 领取奖励（只在4线全部走完后）
        pageText = await getPageText(page);
        if (NO_CLAIM) {
            const ci = pageText.indexOf('副本条件');
            const cj = pageText.indexOf('回到起点', ci);
            console.log('NO_CLAIM 模式：不领奖、不退出，留副本内待人工查验');
            console.log('条件行:', ci >= 0 ? pageText.substring(ci, cj > ci ? cj : ci + 120) : '(未见)');
            await page.screenshot({ path: 'dungeon-no-claim.png' }).catch(() => {});
        } else if (allArmsDone && pageText.includes('领取奖励')) {
            console.log('领取奖励...');
            await clickLeaf(page, '领取奖励');
            await sleep(1500);
            await clickExact(page, '确定');
            await sleep(2500);
            pageText = await getPageText(page);
            if (!pageText.includes('副本条件')) {
                console.log('奖励已领取，已退出副本');
            } else {
                console.log('领奖后仍在副本页，页面:', pageText.substring(0, 200));
            }
        } else if (!allArmsDone) {
            console.log('未完成全部4线，不领奖');
        } else {
            console.log('未看到领取奖励入口，页面:', pageText.substring(0, 300));
            await page.screenshot({ path: 'dungeon-claim-fail.png' }).catch(() => {});
        }

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'dungeon-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
