const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 农场固定去广州沙滩
const NAV_DEST = '广州';
const NAV_REGION = '东亚';

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

// 截取"当前城市"到"【聊天】"之间的地图区块，用于日志观察位置变化
function mapBlock(txt) {
    const a = txt.indexOf('当前城市');
    if (a < 0) return '(无当前城市)';
    const b = txt.indexOf('【聊天】', a);
    return txt.substring(a, b > a ? b : a + 120).replace(/\s+/g, ' ');
}

// JS直接向元素派发鼠标事件，绕过全屏遮罩（城内地图弹窗的遮罩会吃掉坐标点击）
async function jsClick(page, text, exclude = '') {
    return await page.evaluate(({ t, ex }) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) && (!ex || !s.includes(ex)) &&
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

// 精确匹配整段文本的按钮（避免“避战”匹配到“迎战或避战”说明文字、“自动航行”匹配到“停止自动航行”）
async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

// 出航流程：出航菜单→区域→城市→出航确认→自动航行→航行循环（海盗避战/恢复），返回是否到达
async function sailFlow(page) {
    let step = await clickText(page, '出航', 2000);
    if (!step) {
        await clickText(page, '城内地图');
        await sleep(2000);
        await clickText(page, '码头');
        await sleep(3000);
        step = await clickText(page, '出航');
    }
    await sleep(2000);
    await clickExact(page, NAV_REGION);
    await sleep(1000);

    let picked = false;
    for (let s = 0; s < 5; s++) {
        if (await clickText(page, NAV_DEST, 2000)) {
            await sleep(1500);
            if ((await getPageText(page)).includes('出航确认')) {
                picked = true;
                break;
            }
        }
        await page.mouse.wheel(0, 300);
        await sleep(1000);
    }
    if (!picked) console.log('未看到出航确认框，继续尝试...');

    await sleep(1000);
    await clickText(page, '立即出发');
    await sleep(2000);
    await clickExact(page, '自动航行', 5000);
    console.log('航行中...');

    for (let w = 0; w < 80; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`到达${NAV_DEST}`);
            return true;
        }
        if (txt.includes('遭遇海盗')) {
            console.log('遭遇海盗，选择避战...');
            await page.screenshot({ path: 'sail-pirate.png' }).catch(() => {});
            await clickExact(page, '避战', 3000);
            await sleep(2000);
            const t2 = await getPageText(page);
            if (t2.includes('成功避战')) console.log('成功避战');
            if (!t2.includes('停止自动航行')) {
                if (await clickExact(page, '自动航行', 3000)) console.log('恢复自动航行');
            }
            continue;
        }
        if (!txt.includes('停止自动航行') && await clickExact(page, '自动航行', 1500)) {
            console.log('自动航行(重新)启动');
        }
    }
    const txt = await getPageText(page);
    console.log('航行未完成（约5分钟），页面文本:', txt.substring(0, 300));
    return false;
}

// 传送兜底：出航流程失败后重新登录 → 码头点传送 → 点目标城市瞬间到达
async function teleportToDest(page) {
    console.log('传送兜底: 重新登录游戏...');
    try {
        await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        if (inputs.length >= 2) {
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
            await page.getByText('登录').first().click();
            await sleep(3000);
        } else {
            // 会话仍有效时登录页会自动跳回游戏，无需重新填账号
            console.log('传送兜底: 会话有效，页面已自动进入游戏');
        }
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('传送兜底: 重新登录完成');

        let ok = await clickText(page, '传送', 2000);
        if (!ok) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            ok = await clickText(page, '传送');
        }
        if (!ok) {
            console.log('传送兜底: 找不到传送入口');
            await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
            return false;
        }
        await sleep(2000);

        await clickExact(page, NAV_REGION);
        await sleep(1000);

        let picked = false;
        for (let s = 0; s < 5; s++) {
            if (await clickText(page, NAV_DEST, 2000)) {
                picked = true;
                break;
            }
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }
        if (!picked) console.log('传送兜底: 列表中找不到目的地');

        await sleep(3000);
        let txt = await getPageText(page);
        if (!txt.includes(`当前城市：${NAV_DEST}`)) {
            await clickText(page, '确定');
            await sleep(2000);
            await clickText(page, '确认');
            await sleep(2000);
            txt = await getPageText(page);
        }
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`传送兜底: 已到达${NAV_DEST}`);
            return true;
        }
        console.log('传送兜底: 未检测到到达，页面文本:', txt.substring(0, 300));
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    }
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
        for (let attempt = 0; attempt < 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                // 会话已生效时登录页无表单（直接停在游戏/选角页），跳过登录
                let t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    console.log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                console.log('找不到输入框，刷新页面...');
                await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
                await page.waitForTimeout(3000);
                const newInputs = await page.$$('input');
                if (newInputs.length < 2) {
                    t = await getPageText(page);
                    if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                        console.log('无表单但已在游戏流程中（会话有效），跳过登录');
                        break;
                    }
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

            // 检查是否出现"进入游戏"或已直接进入游戏主界面
            let pageText = await getPageText(page);
            if (pageText.includes('进入游戏')) {
                console.log('登录成功，进入游戏');
                break;
            }
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('登录成功，已在游戏内');
                break;
            }
            console.log('登录未成功，重试...');
            await sleep(2000);
        }

        // 点击进入游戏（带重试）
        for (let i = 0; i < 10; i++) {
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

            const arrived = await sailFlow(page);
            if (!arrived) {
                console.log('出航约5分钟未完成，改用传送兜底...');
                await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                await teleportToDest(page);
            }
            await sleep(2000);

            // 严格校验：没到广州绝不往下走（否则会在错误城市空转数小时）
            pageText = await getPageText(page);
            if (!pageText.includes('当前城市：广州')) {
                console.log('未到达广州，跳过农场');
                await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
            console.log('到达广州');
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
            let ok = await jsClick(page, '东城门');
            if (!ok || i >= 1) {
                console.log(`[nav] 打开城内地图(${i + 1}):`, await jsClick(page, '城内地图'));
                await sleep(2000);
                ok = await jsClick(page, '东城门');
            }
            console.log(`[nav] 点东城门(${i + 1}):`, ok, i >= 1 ? '(经城内地图)' : '(主页面)');
            await sleep(3000);
            await page.screenshot({ path: `nav-2-gate-${i + 1}.png` });
        }
        pageText = await getPageText(page);
        console.log('[nav] 第1步后地图:', mapBlock(pageText), '| 沙滩294=' + pageText.includes('沙滩294'));

        // 第2步：点沙滩294（只在还站在东城门方向上时点）
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (!pageText.includes('东：沙滩294') && !pageText.includes('东:沙滩294')) break;
            console.log(`[nav] 点沙滩294(${i + 1}):`, await jsClick(page, '沙滩294'));
            await sleep(3000);
            await page.screenshot({ path: `nav-3-294-${i + 1}.png` });
        }
        pageText = await getPageText(page);
        console.log('[nav] 第2步后地图:', mapBlock(pageText), '| 东向沙滩294=' + (pageText.includes('东：沙滩294') || pageText.includes('东:沙滩294')));

        // 第3步：进沙滩
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('经验妖灵')) break;
            console.log(`[nav] 点沙滩(${i + 1}):`, await jsClick(page, '沙滩', '294'));
            await sleep(3000);
            await page.screenshot({ path: `nav-4-beach-${i + 1}.png` });
        }

        pageText = await getPageText(page);
        console.log('[nav] 到达后地图:', mapBlock(pageText), '| 经验妖灵=' + pageText.includes('经验妖灵'));
        if (pageText.includes('经验妖灵') || pageText.includes('当前城市：广州')) {
            console.log('到达沙滩');
        } else {
            // 不在广州时“沙滩导航”会在错误城市空转，直接退出而不是假装到达
            console.log('不在广州，沙滩导航失败，退出农场');
            await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 循环打经验妖灵
        // 日志节流：每轮都打印会刷出几MB日志、拖垮runner，改为每60秒汇报一次进度
        let count = 0;
        const loopStart = Date.now();
        let lastLogAt = Date.now();
        console.log('进入打怪循环（进度每60秒汇报一次）');
        while (true) {
            pageText = await getPageText(page);

            if (pageText.includes('经验妖灵')) {
                await clickText(page, '经验妖灵');
                await sleep(50);

                // 一击必杀：直接点攻击，不循环
                await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
                await sleep(50);

                // 直接点关闭
                await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
                await sleep(50);

                count++;
            } else {
                if (count === 0 && !global.__shot) {
                    global.__shot = true;
                    await page.screenshot({ path: 'stuck-beach.png' });
                }
                await clickText(page, '刷新');
                await sleep(50);
            }

            const now = Date.now();
            if (now - lastLogAt >= 60000) {
                lastLogAt = now;
                const mins = Math.round((now - loopStart) / 60000);
                const tail = pageText.includes('经验妖灵')
                    ? ''
                    : ` | 未见经验妖灵，页面: ${pageText.substring(0, 80)}`;
                console.log(`打怪进行中：已完成 ${count} 次，已运行 ${mins} 分钟${tail}`);
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
    } finally {
        await browser.close();
    }
}

run();
