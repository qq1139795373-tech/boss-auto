const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickText(page, text, timeout = 5000) {
    try {
        const el = page.getByText(text, { exact: false }).first();
        await el.waitFor({ state: 'attached', timeout });
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true, timeout: 3000 });
        return true;
    } catch (e1) {
        console.log(`getByText"${text}"失败: ${e1.message.substring(0, 100)}`);
        try {
            const pos = await page.evaluate((t) => {
                const all = document.querySelectorAll('*');
                let best = null;
                let bestLen = Infinity;
                for (const el of all) {
                    const rect = el.getBoundingClientRect();
                    if (el.textContent.includes(t) && rect.width > 0 && rect.height > 0) {
                        if (el.textContent.length < bestLen) {
                            best = el;
                            bestLen = el.textContent.length;
                        }
                    }
                }
                if (best) {
                    best.scrollIntoView({ block: 'center', inline: 'center' });
                    const rect = best.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
                return null;
            }, text);
            if (pos && pos.x > 0 && pos.y > 0) {
                await page.mouse.click(pos.x, pos.y);
                return true;
            }
        } catch {
            // ignore
        }
        return false;
    }
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
        await sleep(8000);
        console.log('进入游戏');

        // 等待页面加载完成
        await sleep(5000);

        // 检查是否有弹窗并关闭
        let pageText = await getPageText(page);
        console.log('页面文本前200字:', pageText.substring(0, 200));

        // 尝试关闭弹窗（只按ESC，不点屏幕避免误操作）
        await page.keyboard.press('Escape');
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

            // 先尝试点出航（如果已在码头）
            let step = await clickText(page, '出航', 2000);
            console.log(`第一次出航尝试: ${step}`);
            
            if (!step) {
                // 不在码头，需要导航到码头
                console.log('不在码头，尝试导航到码头...');
                step = await clickText(page, '城内地图');
                console.log(`城内地图: ${step}`);
                await sleep(2000);
                
                step = await clickText(page, '码头');
                console.log(`码头: ${step}`);
                await sleep(3000);
                
                // 到码头后再点出航
                step = await clickText(page, '出航');
                console.log(`第二次出航尝试: ${step}`);
            }
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
                console.log('找到经验妖灵');
                await clickText(page, '经验妖灵');
                await sleep(50);

                // 一击必杀：直接点攻击，不循环
                await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
                await sleep(50);

                // 直接点关闭
                await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
                await sleep(50);

                count++;
                console.log(`第 ${count} 次完成`);
            } else {
                console.log('页面内容:', pageText.substring(0, 100));
                await clickText(page, '刷新');
                await sleep(50);
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }
}

run();
