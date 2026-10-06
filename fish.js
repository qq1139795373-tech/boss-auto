const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 钓鱼：出航到地中海威尼斯，码头鱼老板买饵→出航马赛→钓鱼甩竿100次→返航→卖鱼
const NAV_DEST = '威尼斯';
const NAV_REGION = '地中海';

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

// evaluate点击文本叶子（精确或包含），绕过遮罩
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

function atDockView(txt) {
    return txt.includes('出航') && txt.includes('鱼老板');
}

// 回到码头视图：返回箭头(goBack) → 兜底刷新重进
async function backToDock(page) {
    for (let i = 0; i < 3; i++) {
        let t = await getPageText(page);
        if (atDockView(t)) return true;
        await page.goBack().catch(() => {});
        await sleep(1500);
        t = await getPageText(page);
        if (atDockView(t)) return true;
        if (t.includes('请输入账号密码')) {
            console.log('goBack退过头了，重新进游戏');
            return false;
        }
        console.log('返回码头: goBack无效，刷新重进...');
        await page.reload().catch(() => {});
        await sleep(4000);
        await page.keyboard.press('Escape');
        await sleep(1500);
    }
    return atDockView(await getPageText(page));
}

// 确保在威尼斯码头视图（你看到里有鱼老板）
async function ensureDock(page) {
    for (let i = 0; i < 6; i++) {
        let t = await getPageText(page);
        if (atDockView(t)) return true;
        if (t.includes(`当前城市：${NAV_DEST}`)) {
            await jsClick(page, '码头');
            await sleep(2000);
            t = await getPageText(page);
            if (atDockView(t)) return true;
            await jsClick(page, '城内地图');
            await sleep(2000);
            await jsClick(page, '码头');
            await sleep(2000);
        } else {
            return false;
        }
    }
    return atDockView(await getPageText(page));
}

// 关闭包裹回游戏视图（左上角返回/历史后退/Escape，逐个尝试）
async function closeBag(page) {
    for (let i = 0; i < 4; i++) {
        const t = await getPageText(page);
        if (t.includes('鱼老板') || t.includes('当前城市：')) return true;
        // 左上角返回键（按class启发式找页头左上的返回元素）
        await page.evaluate(() => {
            const cands = [...document.querySelectorAll('[class*=back],[class*=arrow],[class*=return]')];
            const el = cands.find(e => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.x < 80 && r.y < 140;
            });
            if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }).catch(() => {});
        await sleep(1200);
        let t2 = await getPageText(page);
        if (!(t2.includes('鱼老板') || t2.includes('当前城市：'))) {
            await page.evaluate(() => history.back()).catch(() => {});
            await sleep(1500);
        }
        t2 = await getPageText(page);
        if (!(t2.includes('鱼老板') || t2.includes('当前城市：'))) {
            await page.keyboard.press('Escape');
            await sleep(1000);
        }
    }
    return (await getPageText(page)).includes('鱼老板') ||
        (await getPageText(page)).includes('当前城市：');
}

// 标签行右滑（jsClick点不到“其他”时的兜底）
async function dragTabRow(page) {
    try {
        const box = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('body *')].filter(el => {
                const s = el.textContent || '';
                return s.includes('装备') && s.includes('其他') &&
                    el.children.length >= 6 && el.children.length <= 15;
            });
            if (!rows.length) return null;
            const r = rows[rows.length - 1].getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        if (!box || box.w < 50) return;
        const y = box.y + box.h / 2;
        const x0 = box.x + box.w - 40;
        await page.mouse.move(x0, y);
        await page.mouse.down();
        for (let s = 1; s <= 8; s++) {
            await page.mouse.move(x0 - s * 45, y);
            await sleep(30);
        }
        await page.mouse.up();
        await sleep(600);
    } catch (e) { /* ignore */ }
}

// 其他标签里向下滚到出现“已加载全部数据”（列表懒加载，没到底不能下结论）
async function scrollBagToBottom(page) {
    for (let i = 0; i < 25; i++) {
        const t = await getPageText(page);
        if (t.includes('已加载全部数据')) return true;
        await page.mouse.move(400, 650).catch(() => {});
        await page.mouse.wheel(0, 700).catch(() => {});
        await sleep(450);
    }
    return (await getPageText(page)).includes('已加载全部数据');
}

// 查小鱼活饵库存：包裹→其他标签→必须滚到“已加载全部数据”→读数量。
// 看到鱼饵=记数量（调用方补差额到100）；滚到底没显示=没有(0)→买100；
// 打不开包裹/切不过去/滚不到底=null（调用方按100购买，宁可买也不断钓）
async function getBaitStock(page) {
    try {
        if (!(await clickText(page, '包裹', 3000))) {
            await jsClick(page, '包裹');
        }
        await sleep(1500);
        let t = await getPageText(page);
        if (!t.includes('负重') && !t.includes('详情')) {
            console.log('未打开包裹，页面:', t.substring(0, 122));
            await closeBag(page);
            return null;
        }
        // 切到“其他”标签（必要时右滑标签行），确认切过去（出现地图/鱼饵物品）
        let switched = false;
        for (let i = 0; i < 3 && !switched; i++) {
            if (i === 1) await dragTabRow(page);
            await jsClick(page, '其他');
            await sleep(800);
            t = await getPageText(page);
            switched = /地图|小鱼活饵/.test(t);
        }
        if (!switched) {
            console.log('未切换到“其他”标签，库存判定失败');
            await closeBag(page);
            return null;
        }
        // 必须滚到“已加载全部数据”才下结论（防止鱼饵在下方看不见）
        if (!(await scrollBagToBottom(page))) {
            console.log('其他标签未滚到“已加载全部数据”，库存判定失败');
            await closeBag(page);
            return null;
        }
        t = await getPageText(page);
        const m = t.match(/小鱼活饵[\s\S]{0,160}?数量[：:]\s*(\d+)/);
        const stock = m ? parseInt(m[1], 10) : 0;
        console.log(m ? `滚动中看到鱼饵，库存: ${stock}` : '滚到底未见鱼饵 = 库存0');
        await closeBag(page);
        return stock;
    } catch (e) {
        console.log('库存检查异常:', e.message);
        await closeBag(page).catch(() => {});
        return null;
    }
}

// 打开鱼老板页
async function openBoss(page) {
    if (!(await clickText(page, '鱼老板', 3000))) {
        await jsClick(page, '鱼老板');
    }
    await sleep(2000);
    const t = await getPageText(page);
    if (!t.includes('购买鱼饵')) {
        console.log('未打开鱼老板页:', t.substring(0, 150));
        await page.screenshot({ path: 'fish-boss-open-fail.png' }).catch(() => {});
        return false;
    }
    return true;
}

// 买鱼饵，qty=补齐数量
async function buyBait(page, qty = 100) {
    const ok = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && el.textContent.trim() === '购买' &&
                r.width > 0 && r.height > 0;
        });
        if (!cands.length) return false;
        // 锁定“小鱼活饵”的购买按钮：找同时含物品名和银贝金额的最小行（小鱼活饵 50 银贝 购买），
        // 避免点到蚯蚓等其他鱼饵；锁不到就失败，绝不乱点
        let best = null;
        let bestLen = Infinity;
        for (const b of cands) {
            let p = b.parentElement;
            for (let d = 0; d < 6 && p; d++, p = p.parentElement) {
                const txt = p.textContent || '';
                if (txt.includes('小鱼活饵') && txt.includes('银贝') && txt.length < bestLen) {
                    best = b;
                    bestLen = txt.length;
                    break;
                }
            }
        }
        if (!best) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            best.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    });
    if (!ok) {
        console.log('找不到小鱼活饵的购买按钮');
        return false;
    }
    await sleep(1500);
    let t = await getPageText(page);
    if (!t.includes('确认购买')) {
        console.log('未弹出购买框:', t.substring(0, 150));
        await page.screenshot({ path: 'fish-buy-dialog-fail.png' }).catch(() => {});
        return false;
    }
    // 填购买数量（页面上唯一的输入框）
    const inputs = await page.$$('input');
    let filled = false;
    for (const inp of inputs) {
        if (await inp.isVisible().catch(() => false)) {
            await inp.fill(String(qty)).catch(() => {});
            filled = true;
        }
    }
    console.log(`购买数量填${qty}:`, filled);
    await clickExact(page, '确认购买');
    await sleep(2000);
    t = await getPageText(page);
    console.log('购买后:', t.includes('确认购买') ? '购买框仍在' : '购买框已关闭');
    return true;
}

// 出航→地中海→马赛→立即出发（不点自动航行），到达“航行中”面板
async function departForFishing(page) {
    if (!(await clickText(page, '出航', 3000))) {
        await jsClick(page, '出航');
    }
    await sleep(2000);
    await clickExact(page, '地中海', 3000);
    await sleep(1000);

    let picked = false;
    for (let s = 0; s < 5; s++) {
        if (await clickText(page, '马赛', 2000)) {
            await sleep(1500);
            if ((await getPageText(page)).includes('出航确认')) {
                picked = true;
                break;
            }
        }
        await page.mouse.wheel(0, 300);
        await sleep(1000);
    }
    if (!picked) {
        console.log('未弹出航确认(马赛)');
        await page.screenshot({ path: 'fish-depart-fail.png' }).catch(() => {});
        return false;
    }
    await clickExact(page, '立即出发', 3000);
    await sleep(2000);
    const t = await getPageText(page);
    if (!t.includes('航行中') && !t.includes('剩余距离')) {
        console.log('未进入航行中:', t.substring(0, 150));
        await page.screenshot({ path: 'fish-sailing-fail.png' }).catch(() => {});
        return false;
    }
    console.log('已出发(不点自动航行)');
    return true;
}

// 钓鱼面板里反复甩竿，直到“暂无鱼饵”或“每天钓鱼最多100次”
async function castLoop(page) {
    if (!(await clickExact(page, '钓鱼', 3000))) {
        await clickText(page, '钓鱼', 3000);
    }
    await sleep(1500);

    let casts = 0;
    let reason = '';
    for (let i = 0; i < 140; i++) {
        let t = await getPageText(page);
        if (t.includes('暂无鱼饵')) { reason = '暂无鱼饵'; break; }
        if (t.includes('每天钓鱼最多100次')) { reason = '每日100次上限'; break; }
        if (!t.includes('甩竿')) {
            // 钓鱼面板可能被关掉，重新打开
            if (t.includes('航行中') || t.includes('剩余距离')) {
                await clickExact(page, '钓鱼', 2000);
                await sleep(1000);
                continue;
            }
            console.log('钓鱼面板丢失:', t.substring(0, 120));
            await page.screenshot({ path: 'fish-cast-lost.png' }).catch(() => {});
            break;
        }
        const ok = await clickLeaf(page, '甩竿');
        if (!ok) { await sleep(500); continue; }
        casts++;
        if (casts % 20 === 0) console.log(`甩竿 ${casts} 次`);
        await sleep(700);
    }
    if (!reason) {
        const t = await getPageText(page);
        if (t.includes('暂无鱼饵')) reason = '暂无鱼饵';
        else if (t.includes('每天钓鱼最多100次')) reason = '每日100次上限';
        else reason = '循环结束';
    }
    console.log(`钓鱼结束: ${casts}次, 原因=${reason}`);
    return { casts, reason };
}

// 关钓鱼面板(×) → 航行中面板点返航 → 回威尼斯码头
async function returnToPort(page) {
    let t = await getPageText(page);
    if (t.includes('甩竿') || t.includes('暂无鱼饵') || t.includes('我的鱼饵')) {
        await clickLeaf(page, '×', false);
        await sleep(1500);
    }
    t = await getPageText(page);
    if (!t.includes('返航')) {
        console.log('航行中面板无返航:', t.substring(0, 150));
        await page.screenshot({ path: 'fish-return-fail.png' }).catch(() => {});
        return false;
    }
    await clickExact(page, '返航', 3000);
    await sleep(3000);
    for (let i = 0; i < 10; i++) {
        t = await getPageText(page);
        if (t.includes(`当前城市：${NAV_DEST}`)) {
            console.log('已返航回威尼斯');
            return true;
        }
        if (t.includes('遭遇海盗')) {
            await clickExact(page, '避战', 3000);
        }
        await sleep(2000);
    }
    console.log('返航未检测到威尼斯:', (await getPageText(page)).substring(0, 150));
    await page.screenshot({ path: 'fish-return-timeout.png' }).catch(() => {});
    return false;
}

// 卖鱼：从第一个卖到最后一个，直到出售鱼列表没有卖出按钮
async function sellAll(page) {
    let rounds = 0;
    for (let i = 0; i < 40; i++) {
        const t = await getPageText(page);
        if (t.includes('快速卖出')) {
            // 详情框开着：点框内最底部的卖出
            await page.getByText('卖出', { exact: true }).last().click({ force: true }).catch(() => {});
            await sleep(1500);
            const t2 = await getPageText(page);
            if (t2.includes('快速卖出')) {
                console.log('卖出详情框未关闭，尝试Escape');
                await page.keyboard.press('Escape');
                await sleep(1000);
            }
            rounds++;
            continue;
        }
        const has = await page.evaluate(() => {
            const all = [...document.querySelectorAll('body *')].filter(el => {
                const r = el.getBoundingClientRect();
                return el.children.length === 0 && el.textContent.trim() === '卖出' &&
                    r.width > 0 && r.height > 0;
            });
            if (!all.length) return false;
            const el = all[0];
            const opts = { bubbles: true, cancelable: true, view: window };
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                el.dispatchEvent(new MouseEvent(type, opts));
            }
            return true;
        });
        if (!has) break;
        await sleep(1500);
        rounds++;
        if (rounds % 5 === 0) console.log(`已卖 ${rounds} 轮`);
    }
    const t = await getPageText(page);
    const stillHas = t.includes('卖出') && !t.includes('快速卖出');
    console.log(`卖鱼结束: ${rounds}轮, 列表还有卖出=${stillHas}`);
    return !stillHas;
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

        // 1. 到威尼斯
        if (pageText.includes(`当前城市：${NAV_DEST}`)) {
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
                await page.screenshot({ path: 'fish-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }

        // 2. 码头买饵
        if (!(await ensureDock(page))) {
            console.log('未到威尼斯码头，退出');
            await page.screenshot({ path: 'fish-dock-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('到达威尼斯码头');
        // 先查包裹鱼饵库存：≥100直接出航钓，<100在鱼老板处补到100
        const stock = await getBaitStock(page);
        if (!(await ensureDock(page))) {
            console.log('查库存后未回码头视图，退出');
            await page.screenshot({ path: 'fish-dock-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        if (stock !== null && stock >= 100) {
            console.log(`鱼饵库存${stock}≥100，跳过购买直接出航`);
        } else {
            const qty = stock === null ? 100 : 100 - stock;
            console.log(stock === null ? '库存未知，按100购买' : `库存${stock}，补齐${qty}个`);
            if (!(await openBoss(page))) {
                await browser.close();
                return;
            }
            if (!(await buyBait(page, qty))) {
                await browser.close();
                return;
            }
            if (!(await backToDock(page))) {
                console.log('买饵后返回码头失败，退出');
                await page.screenshot({ path: 'fish-back-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
            console.log('买饵完成，回到码头');
        }

        // 3. 出航马赛开钓
        if (!(await departForFishing(page))) {
            await browser.close();
            return;
        }
        const { casts, reason } = await castLoop(page);
        await page.screenshot({ path: 'fish-after-cast.png' }).catch(() => {});

        // 4. 返航
        if (!(await returnToPort(page))) {
            await browser.close();
            return;
        }

        // 5. 卖鱼
        if (!(await ensureDock(page))) {
            console.log('返航后未见码头视图，退出');
            await page.screenshot({ path: 'fish-dock2-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        if (!(await openBoss(page))) {
            await browser.close();
            return;
        }
        const sold = await sellAll(page);
        await page.screenshot({ path: 'fish-sold.png' }).catch(() => {});
        await backToDock(page);

        console.log(`钓鱼流程完成: 甩竿${casts}次(${reason}) | 卖鱼${sold ? '全部卖完' : '仍有剩余'} | 结束于码头视图=${atDockView(await getPageText(page))}`);

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'fish-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
