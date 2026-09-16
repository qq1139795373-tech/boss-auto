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
        await el.click({ force: true }).catch(() => {});
        return true;
    }
    return false;
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
        // 检查北京时间是否在12:00-12:30之间
        const now = new Date();
        const bjHour = (now.getUTCHours() + 8) % 24;
        const bjMin = now.getUTCMinutes();
        console.log(`北京时间: ${bjHour}:${String(bjMin).padStart(2, '0')}`);

        if (bjHour < 12 || (bjHour === 12 && bjMin >= 30) || bjHour >= 13) {
            console.log('未到开放时间，等待...');
            // 等到12:00再开始打boss
            while (true) {
                const now2 = new Date();
                const h = (now2.getUTCHours() + 8) % 24;
                const m = now2.getUTCMinutes();
                if (h === 12 && m === 0) break;
                if (h >= 12 && m > 0) break;
                await sleep(30000);
            }
        }

        // 1. 登录
        await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        await inputs[0].fill(ACCOUNT);
        await inputs[1].fill(PASSWORD);
        await page.getByText('登录').first().click();
        await sleep(3000);
        console.log('1. 登录完成');

        // 2. 进入游戏
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('2. 进入游戏');

        // 3. 检查是否在孟买码头（"你看到"里有"世界boss"就说明到了）
        let pageText = await getPageText(page);
        if (pageText.includes('世界boss') && pageText.includes('当前城市：孟买')) {
            console.log('3. 已在孟买码头');
        } else {
            console.log('3. 不在孟买码头，导航中...');

            // 先关闭可能存在的弹窗
            await closePopup(page);

            // 如果不在码头，先去码头
            if (!pageText.includes('出航')) {
                await clickText(page, '城内地图');
                await sleep(2000);
                await clickText(page, '码头');
                await sleep(2000);
            }

            // 出航
            await clickText(page, '出航');
            await sleep(2000);

            // 印度洋区域
            await clickText(page, '印度洋');
            await sleep(1000);

            // 找孟买
            for (let s = 0; s < 5; s++) {
                if (await clickText(page, '孟买', 2000)) break;
                await page.mouse.wheel(0, 300);
                await sleep(1000);
            }

            await sleep(2000);
            await clickText(page, '立即出发');
            await sleep(1000);
            await clickText(page, '自动航行');
            console.log('3. 航行中...');
            // 等待到达孟买
            for (let w = 0; w < 30; w++) {
                await sleep(3000);
                const txt = await getPageText(page);
                if (txt.includes('当前城市：孟买')) {
                    console.log('到达孟买');
                    break;
                }
            }
            await sleep(2000);
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

        // 触发Auto Farm
        console.log('等待5分钟后触发Auto Farm...');
        await sleep(300000); // 等5分钟
        console.log('正在触发Auto Farm workflow...');
        try {
            const resp = await fetch('https://api.github.com/repos/qq1139795373-tech/boss-auto/actions/workflows/farm.yml/dispatches', {
                method: 'POST',
                headers: {
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ref: 'farm' })
            });
            console.log(`Farm触发结果: ${resp.status}`);
        } catch (e) {
            console.error('触发Farm失败:', e.message);
        }
    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }
}

run();
