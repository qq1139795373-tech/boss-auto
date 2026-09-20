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
    // 尝试点击不同位置关闭弹窗
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.mouse.click(990, 10);
    await sleep(500);
    await page.mouse.click(500, 500);
    await sleep(500);
    // 尝试按ESC
    await page.keyboard.press('Escape');
    await sleep(1000);
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
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(5000);
        console.log('进入游戏');

        // 等待页面加载完成
        await sleep(3000);

        // 检查是否有弹窗并关闭
        let pageText = await getPageText(page);
        console.log('页面文本前200字:', pageText.substring(0, 200));

        // 尝试关闭弹窗
        await closePopup(page);
        await sleep(2000);

        // 再次检查
        pageText = await getPageText(page);
        console.log('关闭弹窗后前200字:', pageText.substring(0, 200));

        // 检查是否在广州
        pageText = await getPageText(page);
        if (pageText.includes('当前城市：广州')) {
            console.log('已在广州');
        } else {
            console.log('不在广州，导航中...');
            await closePopup(page);

            // 如果不在码头，先去码头
            if (!pageText.includes('出航')) {
                await clickText(page, '城内地图');
                await sleep(2000);
                await clickText(page, '码头');
                await sleep(2000);
            }

            // 出航到广州
            let step = await clickText(page, '出航');
            console.log(`出航: ${step}`);
            await sleep(2000);
            step = await clickText(page, '东亚');
            console.log(`东亚: ${step}`);
            await sleep(1000);

            // 找广州
            for (let s = 0; s < 5; s++) {
                step = await clickText(page, '广州', 2000);
                console.log(`广州尝试${s + 1}: ${step}`);
                if (step) break;
                await page.mouse.wheel(0, 300);
                await sleep(1000);
            }

            await sleep(2000);
            step = await clickText(page, '立即出发');
            console.log(`立即出发: ${step}`);
            await sleep(1000);
            step = await clickText(page, '自动航行');
            console.log(`自动航行: ${step}`);
            console.log('航行中...');
            // 等待到达广州
            for (let w = 0; w < 30; w++) {
                await sleep(3000);
                pageText = await getPageText(page);
                if (pageText.includes('当前城市：广州')) {
                    console.log('到达广州');
                    break;
                }
            }
            await sleep(2000);
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
            pageText = await getPageText(page);

            if (pageText.includes('经验妖灵')) {
                console.log(`找到经验妖灵`);
                await clickText(page, '经验妖灵');
                await sleep(300);

                // 高速攻击：直接用locator点击，缩短超时
                const attackBtn = page.locator('text=攻击').first();
                for (let i = 0; i < 20; i++) {
                    if (await attackBtn.isVisible({ timeout: 200 }).catch(() => false)) {
                        await attackBtn.click({ force: true }).catch(() => {});
                        await sleep(50);
                    } else {
                        break;
                    }
                }

                // 快速关闭
                const closeBtn = page.locator('text=关闭').first();
                if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await closeBtn.click({ force: true }).catch(() => {});
                }
                await sleep(100);

                count++;
                console.log(`第 ${count} 次完成`);
            } else {
                console.log('没找到经验妖灵，刷新...');
                await clickText(page, '刷新');
                await sleep(300);
            }
        }

        console.log(`打怪结束，共 ${count} 次`);

    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }
}

run();
