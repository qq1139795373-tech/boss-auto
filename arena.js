const { LOGIN_URL } = require('./game-url.js');
const { chromium } = require('playwright');
// 只读可见节点的页面文本（避免 display:none 残留节点造成的幽灵文案）
const { visibleText } = require('./dungeon-recover.js');
// 进游戏的强点击 + 进主界面判定（2026-11-25 统一到 daily.js，五个脚本共用一份）
const daily = require('./daily.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
    // runner到游戏服务器慢时，等load事件会30s超时；domcontentloaded不等全量资源，失败重试
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto(LOGIN_URL, {
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

// 开场提示「竞技场耳环已失效，请重新配置阵容 + 确定」会盖在「开始匹配」上。
// 10-30 大号实证：这层弹窗没关，点开始匹配完全没反应 → 每次 45 秒等不到战斗结果、
// 整轮 0 场。进竞技场先把它点掉。
async function settleArenaTip(page) {
    const t = await getPageText(page);
    if (!t.includes('请重新配置阵容')) return false;
    console.log('竞技场提示「耳环已失效，请重新配置阵容」→ 点确定关掉');
    await clickExact(page, '确定', 2500);
    await sleep(1500);
    const after = await getPageText(page);
    console.log(`  关闭后：仍在竞技场=${atArena(after)} 提示还在=${after.includes('请重新配置阵容')}`);
    return true;
}

async function openArena(page) {
    for (let i = 0; i < 8; i++) {
        let t = await getPageText(page);
        if (atArena(t)) { await settleArenaTip(page); return true; }
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
        if (atArena(t)) { await settleArenaTip(page); return true; }
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
    // 超时时把页面文本打出来：不打印就只能看到「未出结果」，分不清是没人匹配还是页面卡住
    const t = await getPageText(page);
    console.log(`匹配 ${Math.round((Date.now() - start) / 1000)} 秒无结果，页面: ${t.replace(/\s+/g, ' ').substring(0, 220)}`);
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

        // 进游戏统一走 daily.enterMain：强点击（坐标→合成事件→force）+ 判定只认「你看到/当前城市」。
        // 原来这 10 轮都是 clickText('进入游戏')，点了没反应也算点过，卡在选角页时判不出来，
        // 后面所有步骤都对着一个没进游戏的页面操作，整趟白跑还被记成「跑过了」。
        const entered = await daily.enterMain(page, { rounds: 10, pauseMs: 5000 });
        if (entered) console.log('进入游戏成功');
        else console.log('进入游戏失败：10 轮强点击仍未到主界面');

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        let pageText = await getPageText(page);
        if (!entered || pageText.includes('请输入账号密码') || pageText.includes('选择角色')) {
            console.log('ERROR: 未进入游戏主界面，退出');
            console.log('::error::登录失败：未进入游戏主界面，竞技场已跳过');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
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
        let reentered = false;   // 连续超时后「退出重进竞技场」只做一次，避免死循环

        // ★ 场次配额（2026-11-16）：旧版拿「页面上的今日匹配 N/10」当循环开关，
        //   coldwind0 打 2 场、coldwind1 打 3 场后，关掉结算弹窗那一刻计数没刷新 →
        //   脚本判「计数读不到」直接 stop，把「读不到」当成「打满了」，白丢 7~8 场。
        //   现在：配额在进场时算一次，循环按「本轮已打场数」推进；计数只做展示，
        //   读不到就按 +1 估计并打 ::warning::，绝不因此中断。
        const quota = (count === null) ? 10 : Math.max(0, 10 - count);
        console.log(`本轮计划 ${quota} 场（今日已 ${count === null ? '未知' : count + '/10'}）`);

        while (matched < quota) {
            let clicked = await clickLeaf(page, '开始匹配');
            if (!clicked) clicked = await clickText(page, '开始匹配', 3000);
            if (!clicked && (await getPageText(page)).includes('开始匹配')) {
                await jsClick(page, '开始匹配');
                clicked = true;
            }
            if (!clicked) {
                console.log('未找到开始匹配按钮，等2秒重试...');
                await sleep(2000);
                clicked = await clickLeaf(page, '开始匹配');
                if (!clicked) clicked = await clickText(page, '开始匹配', 2000);
                if (!clicked) {
                    console.log('仍无开始匹配按钮，重新进入竞技场...');
                    await page.goBack().catch(() => {});
                    await sleep(2000);
                    if (await openArena(page)) {
                        clicked = await clickLeaf(page, '开始匹配');
                        if (!clicked) clicked = await clickText(page, '开始匹配', 2000);
                    }
                }
                if (!clicked) {
                    console.log('竞技场页面异常(始终无开始匹配按钮)，停止');
                    await page.screenshot({ path: 'arena-broken.png' }).catch(() => {});
                    break;
                }
            }
            await sleep(3000);

            const res = await waitResult(page);
            if (res.limit) {
                console.log('今日匹配场次已达上限，停止');
                break;
            }
            if (res.timeout) {
                fails++;
                console.log(`第${matched + 1}次匹配未出结果，重试 (${fails}/3)`);
                await page.screenshot({ path: 'arena-timeout.png' }).catch(() => {});
                if (fails >= 3) {
                    // 旧版在这里直接 break，整轮 0 场、exit=0 静默失败（10-30 大号实证：
                    // 45 秒 × 3 次都等不到「战斗结果」→ 本轮0场 胜0负0，白跑 168 秒）。
                    // 竞技场卡住时退出重进一次能恢复，重进后仍不出结果才收工。
                    if (reentered) { console.log('重进竞技场后仍匹配不出结果，停止'); break; }
                    console.log('连续3次匹配无结果 → 退出重进竞技场再试');
                    await page.goBack().catch(() => {});
                    await sleep(2000);
                    if (!(await openArena(page))) {
                        console.log('重进竞技场失败，停止');
                        await page.screenshot({ path: 'arena-reenter-fail.png' }).catch(() => {});
                        break;
                    }
                    reentered = true;
                    fails = 0;
                    await sleep(2000);
                }
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
            matched++;
            // 计数只是展示值：读不到/没刷新 → 按上一值 +1 估计，继续打，不中断本轮
            if (count === null || count === prev) {
                count = (prev === null || prev === undefined) ? matched : prev + 1;
                console.log(`::warning::结算后读不到今日匹配计数 → 按场次推进，记为 ${count}/10（继续）`);
            }
            fails = 0;   // 有进展就清零：旧版 fails 只累计不复位，10 场里偶发 3 次超时也会断整轮
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
