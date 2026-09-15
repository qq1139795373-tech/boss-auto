const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    // 检查北京时间是否在12:00-12:30
    const now = new Date();
    const bjHour = (now.getUTCHours() + 8) % 24;
    const bjMin = now.getUTCMinutes();
    const inTime = (bjHour === 12 && bjMin < 30);

    console.log(`北京时间: ${bjHour}:${String(bjMin).padStart(2, '0')}`);

    if (!inTime) {
        console.log('未到开放时间(12:00-12:30)，跳过');
        return;
    }

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
            // 再次检查时间，超过12:30就停
            const now2 = new Date();
            const bjHour2 = (now2.getUTCHours() + 8) % 24;
            const bjMin2 = now2.getUTCMinutes();
            if (bjHour2 !== 12 || bjMin2 >= 30) {
                console.log('开放时间结束，停止');
                break;
            }

            const challengeBtn = page.locator('text=发起挑战').first();
            if (await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await challengeBtn.click();
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
                console.log('没有挑战次数了');
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
