const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 每日签到：主菜单→福利→向下滚到签到按钮→点今日签到→按钮变「今日已签到」即完成；
// 页面已是「今日已签到」则直接跳过（幂等）

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

// 精确点按钮（先滚进视口再点，避免force点击点空）
async function tapExact(page, text) {
    const el = page.getByText(text, { exact: true }).first();
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
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

        // 1. 登录（10次重试+文本验证，防登录失败假成功）
        let loggedIn = false;
        for (let attempt = 1; attempt <= 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length >= 2) {
                await inputs[0].fill(ACCOUNT);
                await inputs[1].fill(PASSWORD);
                await page.getByText('登录').first().click();
            } else {
                const loginEl = page.getByText('登录', { exact: true }).first();
                await loginEl.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                await loginEl.click({ force: true }).catch(() => {});
            }
            await sleep(3000);
            const t = await getPageText(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                console.log(`登录成功 (第${attempt}次)`);
                loggedIn = true;
                break;
            }
            console.log(`登录未成功，重试 (${attempt}/10)`);
            await sleep(2000);
        }
        if (!loggedIn) {
            console.log('ERROR: 登录失败，跳过签到');
            console.log('::error::签到：登录失败(10次重试)');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            return;
        }

        // 2. 进入游戏（含选角处理）+ 验证
        for (let i = 0; i < 10; i++) {
            const ge = page.getByText('进入游戏', { exact: true }).first();
            await ge.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await ge.click({ force: true }).catch(() => {});
            await sleep(5000);
            let t = await getPageText(page);
            if (t.includes('选择角色') || t.includes('Lv.')) {
                console.log('在选角界面，点击进入游戏选角色...');
                await ge.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                await ge.click({ force: true }).catch(() => {});
                await sleep(5000);
                t = await getPageText(page);
            }
            if (t.includes('你看到') || t.includes('当前城市')) break;
            console.log('进入游戏未成功，重试...');
            await sleep(2000);
        }
        await sleep(3000);
        await page.keyboard.press('Escape');
        await sleep(1500);

        let pageText = await getPageText(page);
        if (pageText.includes('请输入账号密码') || pageText.includes('选择角色') ||
            !(pageText.includes('你看到') || pageText.includes('当前城市'))) {
            console.log('ERROR: 未进入游戏主界面，跳过签到');
            console.log('::error::签到：未进入游戏主界面');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            return;
        }

        // 3. 主菜单点「福利」
        let onWelfare = false;
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('累计签到') || pageText.includes('今日已签到')) {
                onWelfare = true;
                break;
            }
            const el = page.getByText('福利', { exact: true }).first();
            await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await sleep(300);
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                await el.click({ force: true }).catch(() => {});
            }
            await sleep(2500);
        }
        pageText = await getPageText(page);
        if (!pageText.includes('累计签到') && !pageText.includes('今日签到') &&
            !pageText.includes('今日已签到')) {
            console.log('ERROR: 打开福利页失败:', pageText.substring(0, 120).replace(/\s+/g, ' '));
            console.log('::error::签到：福利页未打开');
            await page.screenshot({ path: 'signin-welfare-fail.png' }).catch(() => {});
            return;
        }
        console.log('已进入福利页');
        onWelfare = true;

        // 4. 向下滚到签到按钮出现
        let t = await getPageText(page);
        for (let i = 0; i < 15; i++) {
            if (t.includes('今日签到') || t.includes('今日已签到')) break;
            await page.mouse.move(400, 650).catch(() => {});
            await page.mouse.wheel(0, 700).catch(() => {});
            await sleep(500);
            t = await getPageText(page);
        }

        // 5. 已签直接完成
        if (t.includes('今日已签到')) {
            console.log('今日已签到，跳过');
            return;
        }

        // 6. 点「今日签到」→ 验证变为「今日已签到」
        let signed = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (!(await tapExact(page, '今日签到'))) {
                console.log(`第${attempt}次未找到今日签到按钮`);
                await page.mouse.wheel(0, 500).catch(() => {});
                await sleep(800);
                continue;
            }
            await sleep(2500);
            t = await getPageText(page);
            if (t.includes('今日已签到')) {
                console.log(`签到成功 (第${attempt}次)`);
                signed = true;
                break;
            }
            console.log(`第${attempt}次点击后未变为已签到，重试`);
        }
        if (!signed) {
            console.log('ERROR: 签到失败，按钮未变为今日已签到');
            console.log('::error::签到：点击后未变为今日已签到');
            await page.screenshot({ path: 'signin-fail.png' }).catch(() => {});
            return;
        }
        console.log('签到完成: 按钮已变为今日已签到');
    } catch (e) {
        console.error('ERROR: 签到流程异常:', e.message);
        console.log(`::error::签到异常: ${e.message}`);
        await page.screenshot({ path: 'signin-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
