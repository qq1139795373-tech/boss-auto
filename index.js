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

async function getBjTime() {
    const now = new Date();
    return { hour: (now.getUTCHours() + 8) % 24, min: now.getUTCMinutes() };
}

async function run() {
    const { hour, min } = await getBjTime();
    console.log(`BJ Time: ${hour}:${String(min).padStart(2, '0')}`);

    if (hour > 12 || (hour === 12 && min >= 30)) {
        console.log('Past boss time, skip boss');
        return;
    }

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
        console.log('1. Login done');

        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('2. Entered game');

        let pageText = await getPageText(page);
        if (pageText.includes('世界boss') && pageText.includes('当前城市：孟买')) {
            console.log('3. Already at Mumbai');
        } else {
            console.log('3. Navigating to Mumbai...');
            await closePopup(page);

            if (!pageText.includes('出航')) {
                await clickText(page, '城内地图');
                await sleep(2000);
                await clickText(page, '码头');
                await sleep(2000);
            }

            await clickText(page, '出航');
            await sleep(2000);
            await clickText(page, '印度洋');
            await sleep(1000);

            for (let s = 0; s < 5; s++) {
                if (await clickText(page, '孟买', 2000)) break;
                await page.mouse.wheel(0, 300);
                await sleep(1000);
            }

            await sleep(2000);
            await clickText(page, '立即出发');
            await sleep(1000);
            await clickText(page, '自动航行');
            console.log('3. Sailing...');
            for (let w = 0; w < 30; w++) {
                await sleep(3000);
                const txt = await getPageText(page);
                if (txt.includes('当前城市：孟买')) {
                    console.log('Arrived Mumbai');
                    break;
                }
            }
            await sleep(2000);
        }

        if (hour < 12 || (hour === 12 && min === 0)) {
            console.log('Waiting for boss...');
            while (true) {
                const { hour: h, min: m } = await getBjTime();
                if (h === 12 && m >= 0) break;
                await sleep(10000);
            }
        }

        await clickText(page, '世界boss');
        await sleep(3000);
        console.log('4. Boss page');

        pageText = await getPageText(page);
        const timesMatch = pageText.match(/攻击次数[：:]\s*(\d+)\/10/);
        const usedTimes = timesMatch ? parseInt(timesMatch[1]) : 0;
        const remainTimes = 10 - usedTimes;
        console.log(`Used: ${usedTimes}, Remaining: ${remainTimes}`);

        if (remainTimes <= 0) {
            console.log('All challenges used');
        }

        for (let i = 0; i < remainTimes; i++) {
            const { hour: h, min: m } = await getBjTime();
            if (h !== 12 || m >= 30) {
                console.log('Boss time ended');
                break;
            }

            const challengeBtn = page.locator('text=发起挑战').first();
            if (await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await challengeBtn.click();
                await sleep(1000);

                pageText = await getPageText(page);
                if (pageText.includes('已达上限') || pageText.includes('开放时间')) {
                    console.log('Limit reached or not open');
                    break;
                }

                await sleep(2000);
                pageText = await getPageText(page);

                const damageMatch = pageText.match(/本次造成伤害[：:]\s*(\d+)/);
                const rewardMatch = pageText.match(/挑战奖励[\s\S]*?(?=回合数|$)/);
                if (damageMatch) console.log(`   Damage: ${damageMatch[1]}`);
                if (rewardMatch) {
                    const items = rewardMatch[0].replace('挑战奖励', '').trim();
                    console.log(`   Reward: ${items}`);
                }

                const confirmBtn = page.locator('text=确定').first();
                if (await confirmBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
                    await confirmBtn.click();
                    console.log(`5. Challenge ${i + 1} done`);
                }

                console.log(`6. Waiting 30s cooldown...`);
                for (let s = 0; s < 35; s++) {
                    await sleep(1000);
                    pageText = await getPageText(page);
                    if (pageText.includes('发起挑战') && !pageText.includes('后可再次挑战')) {
                        console.log('Cooldown done');
                        break;
                    }
                    const { hour: h2, min: m2 } = await getBjTime();
                    if (h2 !== 12 || m2 >= 30) {
                        console.log('Boss time ended');
                        break;
                    }
                }
            } else {
                console.log('Button not available');
                break;
            }
        }

        console.log('Boss finished');

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
}

run();
