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
    // 主路径：用isVisible检查元素是否真正可见
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
    // 兜底：先滚动到元素位置，再检查可见性
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
    console.log(`北京时间: ${hour}:${String(min).padStart(2, '0')}`);

    // 只有11:50-12:30才打boss，其他时间跳过
    if (hour > 12 || (hour === 12 && min >= 30) || hour < 11 || (hour === 11 && min < 50)) {
        console.log('非boss时间，跳过boss');
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
        console.log('1. 登录完成');

        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('2. 进入游戏');

        let pageText = await getPageText(page);
        if (pageText.includes('世界boss') && pageText.includes('当前城市：孟买')) {
            console.log('3. 已在孟买码头');
        } else {
            console.log('3. 不在孟买码头，导航中...');

            let step = await clickText(page, '出航', 2000);
            if (!step) {
                await clickText(page, '城内地图');
                await sleep(2000);
                await clickText(page, '码头');
                await sleep(3000);
                step = await clickText(page, '出航');
            }
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
            console.log('3. 航行中...');
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

        if (hour < 12 || (hour === 12 && min === 0)) {
            console.log('等待boss开放...');
            while (true) {
                const { hour: h, min: m } = await getBjTime();
                if (h === 12 && m >= 0) break;
                await sleep(10000);
            }
        }

        await clickText(page, '世界boss');
        await sleep(3000);
        console.log('4. 进入boss页面');

        pageText = await getPageText(page);
        const timesMatch = pageText.match(/攻击次数[：:]\s*(\d+)\/10/);
        const usedTimes = timesMatch ? parseInt(timesMatch[1]) : 0;
        const remainTimes = 10 - usedTimes;
        console.log(`已用次数: ${usedTimes}, 剩余次数: ${remainTimes}`);

        if (remainTimes <= 0) {
            console.log('今日次数已用完');
        }

        for (let i = 0; i < remainTimes; i++) {
            const { hour: h, min: m } = await getBjTime();
            if (h !== 12 || m >= 30) {
                console.log('挑战时间结束');
                break;
            }

            const challengeBtn = page.locator('text=发起挑战').first();
            if (await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await challengeBtn.click();
                await sleep(1000);

                pageText = await getPageText(page);
                if (pageText.includes('已达上限') || pageText.includes('开放时间')) {
                    console.log('次数已用完或未开放');
                    break;
                }

                await sleep(2000);
                pageText = await getPageText(page);

                const damageMatch = pageText.match(/本次造成伤害[：:]\s*(\d+)/);
                const rewardMatch = pageText.match(/挑战奖励[\s\S]*?(?=回合数|$)/);
                if (damageMatch) console.log(`   伤害: ${damageMatch[1]}`);
                if (rewardMatch) {
                    const items = rewardMatch[0].replace('挑战奖励', '').trim();
                    console.log(`   奖励: ${items}`);
                }

                const confirmBtn = page.locator('text=确定').first();
                if (await confirmBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
                    await confirmBtn.click();
                    console.log(`5. 第 ${i + 1} 次挑战完成`);
                }

                console.log(`6. 等待30秒冷却...`);
                for (let s = 0; s < 35; s++) {
                    await sleep(1000);
                    pageText = await getPageText(page);
                    if (pageText.includes('发起挑战') && !pageText.includes('后可再次挑战')) {
                        console.log('冷却结束');
                        break;
                    }
                    const { hour: h2, min: m2 } = await getBjTime();
                    if (h2 !== 12 || m2 >= 30) {
                        console.log('挑战时间结束');
                        break;
                    }
                }
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
