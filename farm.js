const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click();
        return true;
    }
    return false;
}

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 登录
        await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        await inputs[0].fill(ACCOUNT);
        await inputs[1].fill(PASSWORD);
        await page.getByText('登录').first().click();
        await sleep(3000);
        console.log('登录完成');

        // 进入游戏
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('进入游戏');

        // 检查是否在广州，不在就导航过去
        let pageText = await getPageText(page);
        if (!pageText.includes('当前城市：广州')) {
            console.log('不在广州，导航中...');
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(2000);
            await clickText(page, '出航');
            await sleep(2000);
            await clickText(page, '东亚');
            await sleep(1000);
            await clickText(page, '广州');
            await sleep(2000);
            await clickText(page, '立即出发');
            await sleep(1000);
            await clickText(page, '自动航行');
            console.log('航行中...');
            await sleep(10000);
        } else {
            console.log('已在广州');
        }

        // 导航到沙滩
        console.log('导航到沙滩...');
        await clickText(page, '城内地图');
        await sleep(2000);
        await clickText(page, '东城门');
        await sleep(2000);
        await clickText(page, '沙滩294');
        await sleep(2000);
        await clickText(page, '沙滩');
        await sleep(2000);
        console.log('到达沙滩');

        // 循环打经验妖灵
        let count = 0;
        while (true) {
            // 检查时间，11:50-12:30跳过
            const now = new Date();
            const bjHour = (now.getUTCHours() + 8) % 24;
            const bjMin = now.getUTCMinutes();
            if (bjHour === 11 && bjMin >= 50 || (bjHour === 12 && bjMin < 30)) {
                console.log(`北京时间 ${bjHour}:${String(bjMin).padStart(2, '0')}，boss时间段，等待...`);
                await sleep(60000);
                continue;
            }

            pageText = await getPageText(page);

            if (pageText.includes('经验妖灵')) {
                console.log(`找到经验妖灵`);
                await clickText(page, '经验妖灵');
                await sleep(2000);

                // 重复点攻击
                for (let i = 0; i < 20; i++) {
                    const attacked = await clickText(page, '攻击', 2000);
                    if (!attacked) break;
                    await sleep(500);
                }

                await sleep(2000);

                // 点关闭
                await clickText(page, '关闭');
                await sleep(2000);

                count++;
                console.log(`第 ${count} 次完成`);
            } else {
                console.log('没找到经验妖灵，刷新...');
                await clickText(page, '刷新');
                await sleep(3000);
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }
}

run();
