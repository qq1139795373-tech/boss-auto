const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

// JS直接向元素派发鼠标事件，绕过全屏遮罩（城内地图弹窗的遮罩会吃掉坐标点击）
async function jsClick(page, text, exclude = '') {
    return await page.evaluate(({ t, ex }) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) && !s.includes(ex) &&
                r.width > 0 && r.height > 0;
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all.find(e => e.textContent.trim() === t) || all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, { t: text, ex: exclude });
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

        // 登录（带重试）
        for (let attempt = 0; attempt < 3; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                console.log('找不到输入框，刷新页面...');
                await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
                await page.waitForTimeout(3000);
                const newInputs = await page.$$('input');
                if (newInputs.length < 2) {
                    console.log('刷新后仍找不到输入框，重试...');
                    await sleep(2000);
                    continue;
                }
                await newInputs[0].fill(ACCOUNT);
                await newInputs[1].fill(PASSWORD);
            } else {
                await inputs[0].fill(ACCOUNT);
                await inputs[1].fill(PASSWORD);
            }
            await page.getByText('登录').first().click();
            await sleep(3000);
            console.log(`登录尝试${attempt + 1}`);

            // 检查是否出现"进入游戏"
            let pageText = await getPageText(page);
            if (pageText.includes('进入游戏')) {
                console.log('登录成功，进入游戏');
                break;
            }
            console.log('登录未成功，重试...');
            await sleep(2000);
        }

        // 点击进入游戏（带重试）
        for (let i = 0; i < 3; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            let pageText = await getPageText(page);
            // 如果是选角界面（有"选择角色"或Lv.），需要再点一次进入游戏
            if (pageText.includes('选择角色') || pageText.includes('Lv.')) {
                console.log('在选角界面，点击进入游戏选角色...');
                await clickText(page, '进入游戏');
                await sleep(5000);
                pageText = await getPageText(page);
            }
            // 如果页面包含游戏内容（有"你看到"或"当前城市"），说明成功
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('进入游戏成功');
                break;
            }
            console.log('进入游戏未成功，重试...');
            await sleep(2000);
        }

        // 等待页面加载完成
        await sleep(5000);

        // 最终验证：确认已进入游戏（不是登录页或选角界面）
        let pageText = await getPageText(page);
        if (pageText.includes('请输入账号密码') || pageText.includes('登录注册') || pageText.includes('选择角色')) {
            console.log('ERROR: 未进入游戏主界面，退出');
            await browser.close();
            return;
        }

        // 检查是否有弹窗并关闭
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

        // 导航到沙滩：东城门 -> 沙滩294 -> 沙滩（手机手动验证过的路径）
        // 到达东城门的标志：主页面出现"东：沙滩294"
        console.log('导航到沙滩...');
        await page.keyboard.press('Escape');
        await sleep(1000);

        // 第1步：走到东城门
        for (let i = 0; i < 4; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('沙滩294')) {
                console.log('[nav] 已在东城门附近（看到沙滩294）');
                break;
            }
            if (!pageText.includes('东城门')) {
                console.log('[nav] 打开城内地图:', await jsClick(page, '城内地图'));
                await sleep(2000);
            }
            console.log(`[nav] 点东城门(${i + 1}):`, await jsClick(page, '东城门'));
            await sleep(3000);
            await page.screenshot({ path: `nav-2-gate-${i + 1}.png` });
        }
        pageText = await getPageText(page);
        console.log('[nav] 第1步后前150字:', pageText.substring(0, 150));

        // 第2步：点沙滩294（只在还站在东城门方向上时点）
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (!pageText.includes('东：沙滩294') && !pageText.includes('东:沙滩294')) break;
            console.log(`[nav] 点沙滩294(${i + 1}):`, await jsClick(page, '沙滩294'));
            await sleep(3000);
            await page.screenshot({ path: `nav-3-294-${i + 1}.png` });
        }
        pageText = await getPageText(page);
        console.log('[nav] 第2步后前150字:', pageText.substring(0, 150));

        // 第3步：进沙滩
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('经验妖灵')) break;
            console.log(`[nav] 点沙滩(${i + 1}):`, await jsClick(page, '沙滩', '294'));
            await sleep(3000);
            await page.screenshot({ path: `nav-4-beach-${i + 1}.png` });
        }

        pageText = await getPageText(page);
        console.log('[nav] 到达后页面前150字:', pageText.substring(0, 150));
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
                if (count === 0 && !global.__shot) {
                    global.__shot = true;
                    await page.screenshot({ path: 'stuck-beach.png' });
                }
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
