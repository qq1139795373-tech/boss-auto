const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

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

async function triggerFarm() {
    console.log('等待1分钟后触发Auto Farm...');
    await sleep(60000);
    console.log('正在触发Auto Farm workflow...');
    try {
        const resp = await fetch('https://api.github.com/repos/qq1139795373-tech/boss-auto/actions/workflows/farm.yml/dispatches', {
            method: 'POST',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ref: 'farm' })
        });
        console.log(`Farm触发结果: ${resp.status}`);
        if (resp.status !== 204) {
            const text = await resp.text();
            console.log(`错误详情: ${text}`);
        }
    } catch (e) {
        console.error('触发Farm失败:', e.message);
    }
}

async function fightBoss(page) {
    // 进入boss页面
    await clickText(page, '世界boss');
    await sleep(3000);
    console.log('4. 进入boss页面');

    // 读取剩余挑战次数
    let pageText = await getPageText(page);
    const timesMatch = pageText.match(/攻击次数[：:]\s*(\d+)\/10/);
    const usedTimes = timesMatch ? parseInt(timesMatch[1]) : 0;
    const remainTimes = 10 - usedTimes;
    console.log(`已用次数: ${usedTimes}, 剩余次数: ${remainTimes}`);

    if (remainTimes <= 0) {
        console.log('今日次数已用完');
        return;
    }

    for (let i = 0; i < remainTimes; i++) {
        // 检查是否还在挑战时间内
        const { hour, min } = await getBjTime();
        if (hour !== 12 || min >= 30) {
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

            // 等待挑战结果弹窗
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

            // 等待冷却结束
            console.log(`6. 等待30秒冷却...`);
            for (let s = 0; s < 35; s++) {
                await sleep(1000);
                pageText = await getPageText(page);
                if (pageText.includes('发起挑战') && !pageText.includes('后可再次挑战')) {
                    console.log('冷却结束');
                    break;
                }
                const { hour: h, min: m } = await getBjTime();
                if (h !== 12 || m >= 30) {
                    console.log('挑战时间结束');
                    break;
                }
            }
        } else {
            console.log('按钮不可用');
            break;
        }
    }
}

async function run() {
    const { hour, min } = await getBjTime();
    console.log(`北京时间: ${hour}:${String(min).padStart(2, '0')}`);

    // 不在boss时间(12:00-12:30)直接触发farm
    if (hour !== 12 || min >= 30) {
        console.log('不在挑战时间，直接触发farm');
        await triggerFarm();
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

        // 2. 进入游戏
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('2. 进入游戏');

        // 3. 导航到孟买码头
        let pageText = await getPageText(page);
        if (pageText.includes('世界boss') && pageText.includes('当前城市：孟买')) {
            console.log('3. 已在孟买码头');
        } else {
            console.log('3. 不在孟买码头，导航中...');
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

        // 4-5. 打boss
        await fightBoss(page);

        console.log('世界boss完成');

        // 退出boss页面
        console.log('退出boss页面...');
        await page.click('text=<').catch(() => {});
        await sleep(2000);

    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }

    // 触发farm
    await triggerFarm();
}

run();
