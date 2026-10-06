const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 农场固定去杭州西湖打水怪
const NAV_DEST = '杭州';
const NAV_REGION = '东亚';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
    // runner到游戏服务器慢时，等load事件会30s超时；domcontentloaded不等全量资源，失败重试
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            return true;
        } catch (e) {
            console.log(`打开页面第${i}/${retries}次失败:`, (e.message || '').split('\n')[0]);
            await sleep(3000);
        }
    }
    return false;
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

// jsClick优先（穿遮罩），失败退回文本点击
async function clickBtn(page, text, timeout = 3000) {
    if (await jsClick(page, text)) return true;
    return await clickText(page, text, timeout);
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
    // Escape清掉残留弹窗/遮罩，再进出航（遮罩会吃掉坐标点击，改用jsClick穿遮罩）
    await page.keyboard.press('Escape');
    await sleep(500);

    let step = await clickBtn(page, '出航', 2000);
    if (!step) {
        await clickBtn(page, '城内地图');
        await sleep(2000);
        await clickBtn(page, '码头');
        await sleep(3000);
        step = await clickBtn(page, '出航');
    }
    if (!step) {
        console.log('找不到出航入口，页面文本:', (await getPageText(page)).substring(0, 300));
        return false;
    }
    await sleep(2000);
    await clickBtn(page, NAV_REGION);
    await sleep(1000);

    let picked = false;
    for (let s = 0; s < 5; s++) {
        if (await clickBtn(page, NAV_DEST, 2000)) {
            await sleep(1500);
            if ((await getPageText(page)).includes('出航确认')) {
                picked = true;
                break;
            }
        }
        await page.mouse.wheel(0, 300);
        await sleep(1000);
    }
    if (!picked) {
        console.log('未看到出航确认框，中止出航。页面文本:', (await getPageText(page)).substring(0, 300));
        return false;
    }

    await sleep(1000);
    await clickBtn(page, '立即出发');
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
        if (!(await gotoGame(page))) {
            console.log('传送兜底: 打开页面失败(3次重试均超时)');
            return false;
        }
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

        await page.keyboard.press('Escape');
        await sleep(500);

        let ok = await clickBtn(page, '传送', 2000);
        if (!ok) {
            await clickBtn(page, '城内地图');
            await sleep(2000);
            await clickBtn(page, '码头');
            await sleep(3000);
            ok = await clickBtn(page, '传送');
        }
        if (!ok) {
            console.log('传送兜底: 找不到传送入口');
            await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
            return false;
        }
        await sleep(2000);

        await clickBtn(page, NAV_REGION);
        await sleep(1000);

        let picked = false;
        for (let s = 0; s < 5; s++) {
            if (await clickBtn(page, NAV_DEST, 2000)) {
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
            await clickBtn(page, '确定');
            await sleep(2000);
            await clickBtn(page, '确认');
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
        if (!(await gotoGame(page))) throw new Error('打开游戏页失败(3次重试均超时)');
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
                if (!(await gotoGame(page))) {
                    await sleep(2000);
                    continue;
                }
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

        // 检查是否在杭州
        pageText = await getPageText(page);
        if (pageText.includes('当前城市：杭州')) {
            console.log('已在杭州');
        } else {
            console.log('不在杭州，导航中...');

            const arrived = await sailFlow(page);
            if (!arrived) {
                console.log('出航未完成（中止或约5分钟超时），改用传送兜底...');
                await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                await teleportToDest(page);
            }
            await sleep(2000);

            // 严格校验：没到杭州绝不往下走（否则会在错误城市空转数小时）
            pageText = await getPageText(page);
            if (!pageText.includes('当前城市：杭州')) {
                console.log('未到达杭州，跳过农场');
                await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
            console.log('到达杭州');
        }

        // 导航到西湖：西城门 -> 龙井村 -> 西湖（手机手动验证过的路径）
        // 到达西城门的标志：状态行出现"西：龙井村"
        console.log('导航到西湖...');
        await page.keyboard.press('Escape');
        await sleep(1000);

        // 第1步：走到西城门
        for (let i = 0; i < 4; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('西：龙井村') || pageText.includes('西:龙井村')) {
                console.log('[nav] 已在西城门（看到龙井村）');
                break;
            }
            let ok = await jsClick(page, '西城门');
            if (!ok || i >= 1) {
                console.log(`[nav] 打开城内地图(${i + 1}):`, await jsClick(page, '城内地图'));
                await sleep(2000);
                ok = await jsClick(page, '西城门');
            }
            console.log(`[nav] 点西城门(${i + 1}):`, ok, i >= 1 ? '(经城内地图)' : '(主页面)');
            await sleep(3000);
            await page.screenshot({ path: `nav-2-gate-${i + 1}.png` });
        }
        pageText = await getPageText(page);
        console.log('[nav] 第1步后地图:', mapBlock(pageText), '| 西向龙井村=' + (pageText.includes('西：龙井村') || pageText.includes('西:龙井村')));

        // 第2步：点龙井村（只在还站在西城门方向上时点）
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (!pageText.includes('西：龙井村') && !pageText.includes('西:龙井村')) break;
            console.log(`[nav] 点龙井村(${i + 1}):`, await jsClick(page, '龙井村'));
            await sleep(3000);
            await page.screenshot({ path: `nav-3-ljc-${i + 1}.png` });
        }
        pageText = await getPageText(page);
        console.log('[nav] 第2步后地图:', mapBlock(pageText), '| 北向西湖=' + (pageText.includes('北：西湖') || pageText.includes('北:西湖')));

        // 第3步：进西湖
        for (let i = 0; i < 3; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('水怪')) break;
            console.log(`[nav] 点西湖(${i + 1}):`, await jsClick(page, '西湖'));
            await sleep(3000);
            await page.screenshot({ path: `nav-4-xihu-${i + 1}.png` });
        }

        pageText = await getPageText(page);
        console.log('[nav] 到达后地图:', mapBlock(pageText), '| 水怪=' + pageText.includes('水怪'));
        if (pageText.includes('水怪') || pageText.includes('当前城市：杭州')) {
            console.log('到达西湖');
        } else {
            // 不在杭州时“西湖导航”会在错误城市空转，直接退出而不是假装到达
            console.log('不在杭州，西湖导航失败，退出农场');
            await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 循环打水怪（选怪→50→攻击→50→关闭→50，一刀一个）
        // 日志节流：每轮都打印会刷出几十MB日志、拖垮runner，改为每60秒汇报一次进度
        let count = 0;
        const loopStart = Date.now();
        let lastLogAt = Date.now();
        console.log('进入打怪循环（进度每60秒汇报一次）');
        while (true) {
            pageText = await getPageText(page);

            if (pageText.includes('水怪')) {
                await clickText(page, '水怪');
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
                const tail = pageText.includes('水怪')
                    ? ''
                    : ` | 未见水怪，页面: ${pageText.substring(0, 80)}`;
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
