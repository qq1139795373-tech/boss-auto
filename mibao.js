const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
const NAV_DEST = '威尼斯';
const NAV_REGION = '地中海';
// 秘宝抽奖限时活动：城内地图→福利院→神秘机器→银贝秘藏有「免费」或今日剩余100/100才开箱
//   →确认弹窗必须带「免费」且不含银贝价格才点确认（防误花银贝）→收下奖励→验证免费消失或剩余次数减少→左上角返回
// 非活动页(无银贝秘藏)与今日免费已用 → 正常跳过不算失败；登录/导航/弹窗/奖励/验证异常 → ::error:: + mibao-*.png（进程仍退出0）

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

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
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

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

// 出航到威尼斯（小号会被农场开到杭州；活动NPC只在威尼斯福利院）
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
    if (!picked) log('未看到出航确认框，继续尝试...');

    await sleep(1000);
    await clickText(page, '立即出发');
    await sleep(2000);
    await clickExact(page, '自动航行', 5000);
    log('航行中...');

    for (let w = 0; w < 80; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            log(`到达${NAV_DEST}`);
            return true;
        }
        if (txt.includes('遭遇海盗')) {
            log('遭遇海盗，选择避战...');
            await page.screenshot({ path: 'mibao-sail-pirate.png' }).catch(() => {});
            await clickExact(page, '避战', 3000);
            await sleep(2000);
            const t2 = await getPageText(page);
            if (t2.includes('成功避战')) log('成功避战');
            if (!t2.includes('停止自动航行')) {
                if (await clickExact(page, '自动航行', 3000)) log('恢复自动航行');
            }
            continue;
        }
        if (!txt.includes('停止自动航行') && await clickExact(page, '自动航行', 1500)) {
            log('自动航行(重新)启动');
        }
    }
    log('航行未完成（约5分钟）');
    return false;
}

// 传送兜底：出航失败后重登 → 码头点传送 → 秒到威尼斯
async function teleportToDest(page) {
    log('传送兜底: 重新登录游戏...');
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
            log('传送兜底: 会话有效，页面已自动进入游戏');
        }
        await page.mouse.click(10, 10);
        await sleep(500);
        await page.keyboard.press('Escape');
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
            log('传送兜底: 找不到传送入口');
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
            log(`传送兜底: 已到达${NAV_DEST}`);
            return true;
        }
        log('传送兜底: 未检测到到达');
        await page.screenshot({ path: 'mibao-teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        log('传送兜底错误:', e.message);
        return false;
    }
}

function log(msg) {
    console.log(`[mibao] ${msg}`);
}

function snippet(t) {
    return t.substring(0, 100).replace(/\s+/g, ' ');
}

// evaluate点击文本叶子（包含匹配），绕过弹窗遮罩（坐标点击会被遮罩吃掉）
async function jsClick(page, text) {
    return await page.evaluate(t => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) &&
                r.width > 0 && r.height > 0;
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

async function fail(page, msg, shot) {
    console.log(`ERROR: ${msg}`);
    console.log(`::error::秘宝抽奖：${msg}`);
    await page.screenshot({ path: shot }).catch(() => {});
}

// 银贝秘藏区块解析：位于「银贝秘藏」与「金贝秘藏」之间
function parseSilverBlock(t) {
    const i1 = t.indexOf('银贝秘藏');
    if (i1 < 0) return { present: false };
    let i2 = t.indexOf('金贝秘藏', i1 + 1);
    const i3 = t.indexOf('金元神藏', i1 + 1);
    if (i3 > i1 && (i2 < i1 || i3 < i2)) i2 = i3;
    const block = t.slice(i1, i2 > i1 ? i2 : i1 + 600);
    const m = block.match(/今日剩余[:：]?\s*(\d+)\s*[\/／]\s*(\d+)/);
    return { present: true, free: block.includes('免费'), remain: m ? parseInt(m[1], 10) : null };
}

// 点银贝秘藏的开启箱箱：从按钮向上找「含银贝秘藏且不含金贝/金元」的容器
async function clickSilverOpen(page) {
    return await page.evaluate(() => {
        const vis = el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        const btns = [...document.querySelectorAll('body *')].filter(el =>
            el.children.length === 0 && (el.textContent || '').includes('开启箱子') && vis(el));
        for (const b of btns) {
            let p = b.parentElement;
            while (p && p !== document.body) {
                const t = p.textContent || '';
                if (t.includes('金贝秘藏') || t.includes('金元神藏')) break;
                if (t.includes('银贝秘藏')) {
                    const opts = { bubbles: true, cancelable: true, view: window };
                    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                        b.dispatchEvent(new MouseEvent(type, opts));
                    }
                    return true;
                }
                p = p.parentElement;
            }
        }
        return false;
    });
}

// 确认弹窗：弹窗文本带「免费」且不含「数字+银贝」价格才点确认；否则 guarded（取消，防花银贝）
async function confirmDialog(page) {
    return await page.evaluate(() => {
        const vis = el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        const cands = [...document.querySelectorAll('body *')].filter(el =>
            (el.textContent || '').includes('确认开启') && vis(el));
        cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        for (const c of cands) {
            const leaves = [...c.querySelectorAll('*')].filter(el =>
                el.children.length === 0 && vis(el) &&
                ['开启箱子', '免费开启'].includes((el.textContent || '').trim()));
            if (!leaves.length) continue;
            const dlg = c.textContent || '';
            const hasFree = dlg.includes('免费');
            const hasSilverPrice = /\d+\s*银贝/.test(dlg);
            if (!hasFree || hasSilverPrice) return 'guarded';
            const btn = leaves.find(el => (el.textContent || '').trim() === '开启箱子') || leaves[0];
            const opts = { bubbles: true, cancelable: true, view: window };
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                btn.dispatchEvent(new MouseEvent(type, opts));
            }
            return 'confirmed';
        }
        return 'none';
    });
}

// 左上角返回箭头（< ‹ 返回），兜底 goBack
async function navBack(page) {
    const ok = await page.evaluate(() => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && ['<', '‹', '返回'].includes(s) &&
                r.width > 0 && r.height > 0;
        });
        const el = leaves.find(e => {
            const r = e.getBoundingClientRect();
            return r.top < 130 && r.left < 130;
        }) || leaves[0];
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    });
    if (!ok) {
        await page.goBack().catch(() => {});
    }
    await sleep(1500);
    return ok;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);

        // 1. 登录（10次重试 + 会话有效跳过）
        for (let attempt = 0; attempt < 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                let t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                log('找不到输入框，刷新页面...');
                await gotoGame(page);
                await page.waitForTimeout(3000);
                const newInputs = await page.$$('input');
                if (newInputs.length < 2) {
                    t = await getPageText(page);
                    if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                        log('无表单但已在游戏流程中（会话有效），跳过登录');
                        break;
                    }
                    log('刷新后仍找不到输入框，重试...');
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
            const t = await getPageText(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                log(`登录成功 (第${attempt + 1}次)`);
                break;
            }
            log(`登录未成功，重试 (${attempt + 1}/10)`);
            await sleep(2000);
        }

        // 2. 进入游戏（含选角处理）
        for (let i = 0; i < 10; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            let t = await getPageText(page);
            if (t.includes('选择角色') || t.includes('Lv.')) {
                log('在选角界面，点击进入游戏选角色...');
                await clickText(page, '进入游戏');
                await sleep(5000);
                t = await getPageText(page);
            }
            if (t.includes('你看到') || t.includes('当前城市')) {
                log('进入游戏成功');
                break;
            }
            log('进入游戏未成功，重试...');
            await sleep(2000);
        }
        await sleep(3000);
        await page.keyboard.press('Escape');
        await sleep(1500);

        let t = await getPageText(page);
        if (t.includes('请输入账号密码') || t.includes('选择角色') ||
            !(t.includes('你看到') || t.includes('当前城市'))) {
            await fail(page, '登录失败/未进入游戏主界面', 'mibao-login-fail.png');
            return;
        }
        log('已进入游戏主界面');

        // 2.5 不在威尼斯先出航（农场会把号开走；活动NPC在威尼斯福利院）
        if (!t.includes(`当前城市：${NAV_DEST}`)) {
            log('不在威尼斯，出航中...');
            const arrived = await sailFlow(page);
            if (!arrived) {
                log('出航未完成，走传送兜底...');
                await teleportToDest(page);
            }
            await sleep(2000);
            t = await getPageText(page);
            if (!t.includes(`当前城市：${NAV_DEST}`)) {
                await fail(page, '未到达威尼斯', 'mibao-nav-fail.png');
                return;
            }
            await page.keyboard.press('Escape');
            await sleep(1500);
            t = await getPageText(page);
        } else {
            log(`已在${NAV_DEST}`);
        }

        // 3. 导航：城内地图 → 福利院 → 神秘机器
        if (!(t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子'))) {
            const city = (t.match(/当前城市[:：]\s*(\S+)/) || [])[1] || '?';
            log(`当前城市=${city}`);
            if (!(await clickText(page, '城内地图', 4000))) {
                await fail(page, '主界面未见「城内地图」入口', 'mibao-nav-fail.png');
                return;
            }
            await sleep(2000);
            // 点福利院：jsClick 优先（绕遮罩），clickText 兜底；直到出现福利院场景特征
            let atFuli = false;
            for (let s = 0; s < 3 && !atFuli; s++) {
                const j = await jsClick(page, '福利院');
                log(`第${s + 1}次点福利院(jsClick=${j})`);
                await sleep(2500);
                t = await getPageText(page);
                if (t.includes('神秘机器') || t.includes('福利官')) {
                    atFuli = true;
                    break;
                }
                log(`未见福利院场景，改 clickText 再试: ${snippet(t)}`);
                await clickText(page, '福利院', 3000);
                await sleep(2500);
                t = await getPageText(page);
                if (t.includes('神秘机器') || t.includes('福利官')) atFuli = true;
            }
            if (!atFuli) {
                log(`3次点福利院均未进入场景: ${snippet(t)}`);
                await fail(page, '城内地图点「福利院」未进入福利院场景', 'mibao-nav-fail.png');
                return;
            }
            log('已进入福利院场景');
            // 点神秘机器 → 进抽奖页
            let onLottery = false;
            for (let s = 0; s < 3 && !onLottery; s++) {
                const j = await jsClick(page, '神秘机器');
                log(`第${s + 1}次点神秘机器(jsClick=${j})`);
                await sleep(3000);
                t = await getPageText(page);
                if (t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子')) {
                    onLottery = true;
                    break;
                }
                log(`未进抽奖页，改 clickText 再试: ${snippet(t)}`);
                await clickText(page, '神秘机器', 3000);
                await sleep(3000);
                t = await getPageText(page);
                if (t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子')) onLottery = true;
            }
            if (!onLottery) {
                log(`3次点神秘机器均未进抽奖页: ${snippet(t)}`);
                await fail(page, '福利院点「神秘机器」未进入抽奖页', 'mibao-nav-fail.png');
                return;
            }
            log('已进入抽奖页');
        }

        // 4. 抽奖页判定
        if (!(t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子'))) {
            await fail(page, '未进入秘宝抽奖页: ' + t.substring(0, 80).replace(/\s+/g, ' '), 'mibao-nav-fail.png');
            return;
        }
        if (!t.includes('银贝秘藏')) {
            await sleep(2500);
            t = await getPageText(page);
        }
        const block = parseSilverBlock(t);
        if (!block.present) {
            log('非活动时间或银贝秘藏未开放，正常跳过');
            await page.screenshot({ path: 'mibao-noact.png' }).catch(() => {});
            return;
        }
        log(`银贝秘藏: 免费=${block.free} 今日剩余=${block.remain === null ? '?' : block.remain}`);
        if (!(block.free || block.remain === 100)) {
            log('今日免费次数已用完，正常跳过');
            await page.screenshot({ path: 'mibao-skip.png' }).catch(() => {});
            return;
        }

        // 5. 点银贝秘藏的开启箱箱
        let opened = await clickSilverOpen(page);
        if (!opened) {
            log('区块内锁不到开启箱箱，退回整页第一个');
            opened = await clickText(page, '开启箱子', 3000);
        }
        if (!opened) {
            await fail(page, '未找到「开启箱子」按钮', 'mibao-nav-fail.png');
            return;
        }
        await sleep(2000);
        t = await getPageText(page);
        if (!t.includes('确认开启')) {
            await fail(page, '点开启箱子后未见确认弹窗', 'mibao-nodialog.png');
            return;
        }

        // 6. 确认弹窗：无免费字样或出现银贝价格 → 取消并报错（绝不花银贝）
        const res = await confirmDialog(page);
        if (res === 'guarded') {
            await clickText(page, '再想想', 1500);
            await page.keyboard.press('Escape');
            await sleep(800);
            await fail(page, '确认弹窗非免费(带价格或无免费字样)，已取消', 'mibao-nofree.png');
            return;
        }
        if (res !== 'confirmed') {
            await page.keyboard.press('Escape');
            await sleep(800);
            await fail(page, '确认弹窗内未找到确认按钮', 'mibao-nofree.png');
            return;
        }
        log('已点确认开启（免费）');

        // 7. 等奖励弹窗 → 收下奖励
        let gotReward = false;
        for (let i = 0; i < 6; i++) {
            await sleep(2000);
            t = await getPageText(page);
            if (t.includes('收下奖励')) {
                gotReward = true;
                break;
            }
        }
        if (!gotReward) {
            await fail(page, '确认后未见奖励弹窗「收下奖励」', 'mibao-reward-fail.png');
            return;
        }
        await clickText(page, '收下奖励', 3000);
        await sleep(2000);
        log('已点收下奖励');

        // 8. 验证：免费消失 或 今日剩余减少
        let verified = false;
        for (let i = 0; i < 3; i++) {
            const b = parseSilverBlock(await getPageText(page));
            if (b.present) {
                const freeGone = block.free && !b.free;
                const remainDown = b.remain !== null && block.remain !== null && b.remain < block.remain;
                if (freeGone || remainDown) {
                    verified = true;
                    log(`抽奖成功: 免费${b.free ? '仍在' : '已消失'} 今日剩余=${b.remain === null ? '?' : b.remain}`);
                    break;
                }
            }
            await sleep(2000);
        }
        if (!verified) {
            await fail(page, '抽完后免费未消失且今日剩余未减少', 'mibao-verify-fail.png');
            return;
        }
        await page.screenshot({ path: 'mibao-done.png' }).catch(() => {});

        // 9. 左上角返回
        const backOk = await navBack(page);
        log(`返回 ${backOk ? '(点返回箭头)' : '(goBack兜底)'}`);
    } catch (e) {
        console.error('ERROR: 秘宝抽奖流程异常:', e.message);
        console.log(`::error::秘宝抽奖异常: ${e.message}`);
        await page.screenshot({ path: 'mibao-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
