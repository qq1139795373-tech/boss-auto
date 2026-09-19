const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
    return false;
}

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

async function closePopup(page) {
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.mouse.click(990, 10);
    await sleep(500);
    await page.mouse.click(500, 500);
    await sleep(500);
    await page.keyboard.press('Escape');
    await sleep(1000);
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        await inputs[0].fill(ACCOUNT);
        await inputs[1].fill(PASSWORD);
        await page.getByText('登录').first().click();
        await sleep(3000);
        console.log('Login done');

        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(5000);
        console.log('Entered game');

        await sleep(3000);
        let pageText = await getPageText(page);
        console.log('Page text:', pageText.substring(0, 200));

        await closePopup(page);
        await sleep(2000);

        pageText = await getPageText(page);
        console.log('After popup:', pageText.substring(0, 200));

        pageText = await getPageText(page);
        if (pageText.includes('当前城市：广州')) {
            console.log('Already in Guangzhou');
        } else {
            console.log('Not in Guangzhou, navigating...');
            await closePopup(page);

            if (!pageText.includes('出航')) {
                await clickText(page, '城内地图');
                await sleep(2000);
                await clickText(page, '码头');
                await sleep(2000);
            }

            await clickText(page, '出航');
            await sleep(2000);

            await clickText(page, '东亚');
            await sleep(1000);

            for (let s = 0; s < 5; s++) {
                if (await clickText(page, '广州', 2000)) break;
                await page.mouse.wheel(0, 300);
                await sleep(1000);
            }

            await sleep(2000);
            await clickText(page, '立即出发');
            await sleep(1000);
            await clickText(page, '自动航行');
            console.log('Sailing...');
            for (let w = 0; w < 30; w++) {
                await sleep(3000);
                pageText = await getPageText(page);
                if (pageText.includes('当前城市：广州')) {
                    console.log('Arrived Guangzhou');
                    break;
                }
            }
            await sleep(2000);
        }

        console.log('Navigating to beach...');
        await clickText(page, '城内地图');
        await sleep(2000);
        await clickText(page, '东城门');
        await sleep(2000);
        await clickText(page, '沙滩294');
        await sleep(2000);
        await clickText(page, '沙滩');
        await sleep(2000);
        console.log('At beach');

        let count = 0;
        const MAX_FIGHTS = 2000;
        const startTime = Date.now();
        const MAX_TIME = 5.5 * 60 * 60 * 1000;
        while (count < MAX_FIGHTS && (Date.now() - startTime) < MAX_TIME) {
            const now = new Date();
            const bjHour = (now.getUTCHours() + 8) % 24;
            const bjMin = now.getUTCMinutes();
            if (bjHour === 11 && bjMin >= 50 || (bjHour === 12 && bjMin < 30)) {
                console.log(`BJ ${bjHour}:${String(bjMin).padStart(2, '0')}, boss time, waiting...`);
                await sleep(60000);
                continue;
            }

            pageText = await getPageText(page);

            if (pageText.includes('经验妖灵')) {
                console.log('Found monster');
                await clickText(page, '经验妖灵');
                await sleep(500);

                for (let i = 0; i < 20; i++) {
                    const attacked = await clickText(page, '攻击', 500);
                    if (!attacked) break;
                    await sleep(100);
                }

                await clickText(page, '关闭');
                await sleep(200);

                count++;
                console.log(`#${count} done`);
            } else {
                console.log('No monster, refreshing...');
                await clickText(page, '刷新');
                await sleep(500);
            }
        }

        console.log(`Farm finished, total: ${count}`);

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
}

run();