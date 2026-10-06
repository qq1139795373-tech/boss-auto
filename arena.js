const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

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

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

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

async function closePopup(page) {
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.keyboard.press('Escape');
    await sleep(1000);
}

function parseToday(txt) {
    const m = txt.match(/今日匹配[：:]\s*(\d+)\s*[\/／]\s*10/);
    return m ? parseInt(m[1], 10) : null;
}

function atArena(txt) {
    return txt.includes('今日匹配') && txt.includes('开始匹配');
}

async function openArena(page) {
    for (let i = 0; i < 8; i++) {
        let t = await getPageText(page);
        if (atArena(t)) return true;
        let ok = await clickLeaf(page, '竞技场');
        if (!ok) ok = await clickText(page, '竞技场', 3000);
        if (!ok) {
            await page.mouse.wheel(0, 600);
            await sleep(800);
            ok = await clickLeaf(page, '竞技场');
            if (!ok) ok = await clickText(page, '竞技场', 2000);
        }
        await sleep(2000);
        t = await getPageText(page);
        if (atArena(t)) return true;
    }
    console.log('打开竞技场失败:', (await getPageText(page)).substring(0, 200));
    await page.screenshot({ path: 'arena-open-fail.png' }).catch(() => {});
    return false;
}

async function waitResult(page) {
    const start = Date.now();
    while (Date.now() - start < 45000) {
        const t = await getPageText(page);
        if (t.includes('今日匹配场次已达上限')) return { limit: true };
        if (t.includes('战斗结果') && t.includes('关闭')) {
            const win = t.includes('结果：你赢了');
            return { ok: true, win };
        }
        await sleep(500);
    }
    return { timeout: true };
}

async function closeResult(page) {
    let ok = await clickLeaf(page, '关闭');
    if (!ok) ok = await clickExact(page, '关闭', 3000);
    if (!ok) await jsClick(page, '关闭');
    const start = Date.now();
    while (Date.now() - start < 8000) {
        const t = await getPageText(page);
        if (!t.includes('战斗结果')) return true;
        await sleep(500);
    }
    return !(await getPageText(page)).includes('战斗结果');
}

async function exitArena(page) {
    for (let i = 0; i < 4; i++) {
        let t = await getPageText(page);
        if (!atArena(t) && (t.includes('当前城市') || t.includes('你看到'))) {
            return true;
        }
        await page.goBack().catch(() => {});
        await sleep(2000);
        t = await getPageText(page);
        if (!atArena(t) && (t.includes('当前城市') || t.includes('你看到'))) {
            return true;
        }
        if (t.includes('请输入账号密码')) {
            console.log('goBack退过头了，回到登录页');
            return false;
        }
    }
    return false;
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

        if (!(await openArena(page))) {
            await browser.close();
            return;
        }

        let count = parseToday(await getPageText(page));
        console.log(`进入竞技场，今日匹配: ${count}/10`);

        let matched = 0;
        let wins = 0;
        let fails = 0;

        while (count !== null && count < 10) {
            let clicked = await clickLeaf(page, '开始匹配');
            if (!clicked) clicked = await clickText(page, '开始匹配', 3000);
            if (!clicked) {
                await jsClick(page, '开始匹配');
                clicked = true;
            }
            await sleep(3000);

            const res = await waitResult(page);
            if (res.limit) {
                console.log('今日匹配场次已达上限，停止');
                break;
            }
            if (res.timeout) {
                fails++;
                console.log(`第${count + 1}次匹配未出结果，重试 (${fails}/3)`);
                await page.screenshot({ path: 'arena-timeout.png' }).catch(() => {});
                if (fails >= 3) break;
                continue;
            }
            if (res.win) wins++;
            await closeResult(page);

            const t = await getPageText(page);
            const prev = count;
            for (let w = 0; w < 6 && count === prev; w++) {
                count = parseToday(await getPageText(page));
                if (count === null || count === prev) await sleep(1000);
            }
            if (count === null || count === prev) {
                console.log('关闭后未刷新今日匹配计数，重新进入竞技场...');
                await page.goBack().catch(() => {});
                await sleep(2000);
                if (await openArena(page)) count = parseToday(await getPageText(page));
                if (count === null || count === prev) {
                    console.log('计数仍无法读取，停止');
                    break;
                }
            }
            matched++;
            console.log(`匹配完成 ${count}/10 (${res.win ? '胜' : '负'})`);
            await sleep(1500);
        }

        await page.screenshot({ path: 'arena-done.png' }).catch(() => {});

        if (count === null) count = parseToday(await getPageText(page)) ?? count;
        console.log(`竞技场完成: 本轮${matched}场, 胜${wins}负${matched - wins} | 今日匹配 ${count}/10`);

        if (count !== null && count >= 10) {
            if (await exitArena(page)) {
                console.log('已退出竞技场回到主页面');
            } else {
                console.log('退出竞技场未确认回到主页面');
                await page.screenshot({ path: 'arena-exit-fail.png' }).catch(() => {});
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'arena-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
