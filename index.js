const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click();
        return true;
    }
    return false;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 1. 登录
        await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        await inputs[0].fill(ACCOUNT);
        await inputs[1].fill(PASSWORD);
        await page.getByText('登录').first().click();
        await sleep(3000);
        console.log('1. 登录完成');

        // 2. 选择角色，进入游戏
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('2. 进入游戏');

        // 3. 检查是否在孟买，不在就导航过去
        let pageText = await getPageText(page);
        if (!pageText.includes('当前城市：孟买')) {
            console.log('3. 不在孟买，导航中...');
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(2000);
            await clickText(page, '出航');
            await sleep(2000);

            // 印度洋区域
            await clickText(page, '印度洋');
            await sleep(1000);
            await clickText(page, '孟买');
            await sleep(2000);
            await clickText(page, '立即出发');
            await sleep(1000);
            await clickText(page, '自动航行');
            console.log('3. 航行中...');
            await sleep(15000);
        } else {
            console.log('3. 已在孟买');
        }

        // 4. 点击世界boss
        await clickText(page, '世界boss');
        await sleep(3000);
        console.log('4. 进入boss页面');

        // 5. 发起挑战（最多10次）
        for (let i = 0; i < 10; i++) {
            const challengeBtn = page.locator('text=发起挑战').first();
            if (await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await challengeBtn.click();
                await sleep(2000);

                // 检查是否有时间提示
                pageText = await getPageText(page);
                if (pageText.includes('12:00') || pageText.includes('开放时间')) {
                    console.log('未到开放时间，停止');
                    break;
                }

                console.log(`5. 第 ${i + 1} 次挑战`);
                await sleep(5000);

                const closeBtn = page.locator('text=关闭').first();
                if (await closeBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
                    await closeBtn.click();
                    console.log(`6. 第 ${i + 1} 次关闭`);
                }

                console.log(`7. 等待35秒冷却...`);
                await sleep(35000);
            } else {
                console.log('按钮不可用');
                break;
            }
        }

        console.log('世界boss完成');
    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }
}

run();
