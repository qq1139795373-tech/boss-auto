const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        const enterBtn = page.locator('text=进入游戏').first();
        if (await enterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await enterBtn.click();
            await sleep(3000);
        }
        console.log('2. 进入游戏');

        // 3. 点击世界boss
        const worldBoss = page.locator('text=世界boss').first();
        if (await worldBoss.isVisible({ timeout: 5000 }).catch(() => false)) {
            await worldBoss.click();
            await sleep(3000);
        }
        console.log('3. 进入boss页面');

        // 4. 发起挑战（最多10次）
        for (let i = 0; i < 10; i++) {
            const challengeBtn = page.locator('text=发起挑战').first();
            if (await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await challengeBtn.click();
                await sleep(2000);

                // 检查是否有时间提示
                const bodyText = await getPageText(page);
                if (bodyText.includes('12:00') || bodyText.includes('开放时间')) {
                    console.log('未到开放时间，停止');
                    break;
                }

                console.log(`4. 第 ${i + 1} 次挑战`);
                await sleep(5000);

                const closeBtn = page.locator('text=关闭').first();
                if (await closeBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
                    await closeBtn.click();
                    console.log(`5. 第 ${i + 1} 次关闭`);
                }

                console.log(`6. 等待35秒冷却...`);
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
