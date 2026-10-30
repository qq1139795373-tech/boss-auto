const { chromium } = require('playwright');
// 副本内自恢复（先扫荡/领奖再退本）
const drain = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 农场固定去杭州西湖打水怪
const NAV_DEST = '杭州';
const NAV_REGION = '东亚';
// 刷怪时长上限（分钟）：job 的 6 小时上限会把「跑到上限」判成 failure，
// 到点自己收尾 exit 0，红色只留给真故障。FARM_MAX_MIN=0 表示不限（旧行为）。
// 300 而不是 330：farm 是在 Run Tasks 之后启动的，00:00 那一波任务段要跑 0:04→0:32（约 28 分钟），
// 330+28=358 分钟再叠加启动与 index.js 就压线超过 360（10-30 实证 master 与 boss0/3/4 全被砍）。
// 300 留 60 分钟余量，任务段再怎么拖也不会撞上限。
const FARM_MAX_MIN = Number(process.env.FARM_MAX_MIN || 300);

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

// 只拼可见节点。原实现 textContent('body') 不排除 display:none，
// 残留弹窗节点会一直留在 DOM 里 → 读出幽灵文案，把「没成」判成「成了」（2026-10-28 同源问题）。
async function getPageText(page) {
    return await drain.visibleText(page);
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

async function pickConfirm(page, region, dest) {
    for (let round = 1; round <= 3; round++) {
        // 先关掉可能遮挡点击的弹窗/残留面板（高峰期弹窗会吃掉坐标点击）
        await page.mouse.click(10, 10);
        await sleep(300);
        await page.keyboard.press('Escape');
        await sleep(500);
        let opened = await clickText(page, '出航', 2000);
        if (!opened) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            await clickText(page, '出航');
        }
        await sleep(2000);
        await clickExact(page, region);
        await sleep(1000);
        for (let s = 0; s < 5; s++) {
            // 第2轮起用JS叶子派发点击，绕过遮罩对坐标点击的拦截
            const ok = round === 1
                ? await clickText(page, dest, 2000)
                : await jsClick(page, dest);
            if (ok) {
                // 高峰期确认框慢半拍，单次1.5秒查询会误判，改成最多9秒轮询
                for (let c = 0; c < 6; c++) {
                    await sleep(1500);
                    if ((await getPageText(page)).includes('出航确认')) return true;
                }
            }
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }
        console.log(`未看到出航确认框，重开面板重试(${round}/3)...`);
    }
    return false;
}

// 出航失败时把现场拍下来（此前失败路径无任何页面文本，无从定位）
async function failNav(page, why) {
    const t = await getPageText(page);
    console.log(`出航中止(${why})，页面文本: ${t.replace(/\s+/g, ' ').substring(0, 300)}`);
    await page.screenshot({ path: 'nav-fail-detail.png' }).catch(() => {});
    return false;
}

// 出航流程：出航菜单→区域→城市→出航确认→自动航行→航行循环（海盗避战/恢复），返回是否到达
async function sailFlow(page) {
    let picked = await pickConfirm(page, NAV_REGION, NAV_DEST);
    if (!picked) return failNav(page, '出航确认框始终未出现');

    await clickText(page, '立即出发');
    await sleep(2000);
    // 验证真进入航行状态（出现「停止自动航行」），未启动则整轮重来，最多2次
    let sailing = false;
    for (let a = 1; a <= 2 && !sailing; a++) {
        await clickExact(page, '自动航行', 5000);
        for (let c = 0; c < 5; c++) {
            await sleep(1000);
            if ((await getPageText(page)).includes('停止自动航行')) {
                sailing = true;
                break;
            }
        }
        if (!sailing && a === 1) {
            console.log('自动航行未启动，重新开面板选目的地...');
            picked = await pickConfirm(page, NAV_REGION, NAV_DEST);
            if (!picked) break;
            await clickText(page, '立即出发');
            await sleep(2000);
        }
    }
    if (!sailing) return failNav(page, '自动航行未启动');
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

// 卡副本自恢复：身处副本房间先**把副本做完（扫荡/领奖）**，实在没可领的才退本回城。
// 2026-10-27 boss(0) 教训：炼器窟已扫荡、条件已达成、只差领奖，
// 老逻辑读到「副本条件」直接退本，把当天奖励扔了。现在先交给 recoverDungeon 处理。
async function exitDungeonIfInside(page) {
    const t0 = await getPageText(page);
    if (!(t0.includes('副本条件') && t0.includes('回到起点'))) return false;
    console.log('自恢复：检测到身处副本，先尝试完成副本（扫荡/领奖）...');
    try {
        const r = await drain.recoverDungeon(page, { tag: '自恢复', screenshot: 'dungeon-recover-fail.png' });
        if (r.claimed) console.log(r.swept ? '已扫荡并领取奖励，副本结束' : '已领取奖励，副本结束');
        if (r.exited) { console.log('已退出副本'); return true; }
        console.log(`副本内没能完成/退出（${r.kind}，领奖=${r.claimed}），走兜底流程`);
    } catch (e) {
        console.log('副本内处理异常:', e.message);
    }
    for (let i = 1; i <= 3; i++) {
        if (!(await clickText(page, '退出副本', 2000))) {
            await jsClick(page, '退出副本');
        }
        await sleep(1500);
        let t = await getPageText(page);
        if (t.includes('副本条件') && t.includes('确定')) {
            await clickExact(page, '确定', 2000);
            await sleep(1500);
            t = await getPageText(page);
        }
        if (!(t.includes('副本条件') && t.includes('回到起点'))) {
            console.log('已退出副本');
            return true;
        }
        console.log(`第${i}次退出副本未生效，重试...`);
    }
    const t = await getPageText(page);
    console.log('退出副本失败，仍在:', t.replace(/\s+/g, ' ').substring(0, 200));
    await page.screenshot({ path: 'dungeon-recover-fail.png' }).catch(() => {});
    return false;
}

// 重载页面（会话仍有效会自动回到游戏），用于点击无响应时刷新前端
async function reloadGame(page) {
    try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        console.log('重载页面失败:', (e.message || '').split('\n')[0]);
        return false;
    }
    await sleep(3000);
    if ((await getPageText(page)).includes('请输入账号密码')) {
        console.log('重载后回到登录页，重新登录...');
        try {
            await gotoGame(page, 3);
        } catch (e) {
            console.log('重登失败:', (e.message || '').split('\n')[0]);
            return false;
        }
        await sleep(3000);
    }
    return true;
}

// 打开传送面板（不在码头先走城内地图→码头），返回是否真打开
async function openTeleportPanel(page) {
    for (let i = 0; i < 3; i++) {
        const t = await getPageText(page);
        if (!t.includes('码头')) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
        }
        let ok = await clickText(page, '传送', 2500);
        if (!ok) ok = await jsClick(page, '传送');
        await sleep(2500);
        const pt = await getPageText(page);
        // 放宽判定：页面半渲染时只会出现部分洲名
        if (pt.includes('地中海') || pt.includes('印度洋') || pt.includes('大西洋') || pt.includes('太平洋')) return true;
        console.log(`传送面板未打开(${i + 1}/3)，关闭重试...`);
        await page.mouse.click(10, 10);
        await sleep(300);
        await page.keyboard.press('Escape');
        await sleep(500);
    }
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

        // 重登可能落回副本房间，先退出再开传送面板
        await exitDungeonIfInside(page);

        // 面板打不开多半是页面半渲染（点击无响应），重载页面再来一轮基本能救回
        let panelOpen = await openTeleportPanel(page);
        if (!panelOpen) {
            console.log('传送面板多次打不开，重载页面后再试一轮...');
            await page.screenshot({ path: 'teleport-reload.png' }).catch(() => {});
            await reloadGame(page);
            await sleep(4000);
            await exitDungeonIfInside(page);
            panelOpen = await openTeleportPanel(page);
        }
        if (!panelOpen) {
            const pt = await getPageText(page);
            console.log('传送兜底: 找不到传送入口，页面文本:', pt.replace(/\s+/g, ' ').substring(0, 300));
            await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
            return false;
        }

        await clickExact(page, NAV_REGION);
        await sleep(1000);

        for (let s = 0; s < 5; s++) {
            if (await clickText(page, NAV_DEST, 2000)) break;
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }

        // 传送即时生效：轮询到达，其间按需点确定/确认
        let txt = '';
        for (let i = 0; i < 8; i++) {
            await sleep(1500);
            txt = await getPageText(page);
            if (txt.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`传送兜底: 已到达${NAV_DEST}`);
                return true;
            }
            if (txt.includes('确定')) {
                await clickText(page, '确定');
                await sleep(1000);
            } else if (txt.includes('确认')) {
                await clickText(page, '确认');
                await sleep(1000);
            }
        }
        console.log('传送兜底: 未检测到到达，页面文本:', txt.replace(/\s+/g, ' ').substring(0, 300));
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    }
}

// 掉线自救：重新打开游戏并登录（会话失效时自动填账号），返回是否完成
async function relogin(page) {
    if (!(await gotoGame(page))) {
        console.log('自救: 打开页面失败(3次重试均超时)');
        return false;
    }
    await page.waitForTimeout(3000);
    const inputs = await page.$$('input');
    if (inputs.length >= 2) {
        await inputs[0].fill(ACCOUNT).catch(() => {});
        await inputs[1].fill(PASSWORD).catch(() => {});
        await page.getByText('登录').first().click().catch(() => {});
        await sleep(3000);
    } else {
        console.log('自救: 会话有效，页面已自动进入游戏');
    }
    await closePopup(page);
    await sleep(1000);
    await clickText(page, '进入游戏');
    await sleep(3000);
    await closePopup(page);
    console.log('自救: 重新登录完成');
    return true;
}

// 走到西湖（杭州城内：西城门 -> 龙井村 -> 西湖），失败返回 false
async function gotoXihu(page) {
    // 导航到西湖：西城门 -> 龙井村 -> 西湖（手机手动验证过的路径）
    // 到达西城门的标志：状态行出现"西：龙井村"
    console.log('导航到西湖...');
    await page.keyboard.press('Escape');
    await sleep(1000);

    let pageText;

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
        await page.screenshot({ path: `nav-2-gate-${i + 1}.png` }).catch(() => {});
    }
    pageText = await getPageText(page);
    console.log('[nav] 第1步后地图:', mapBlock(pageText), '| 西向龙井村=' + (pageText.includes('西：龙井村') || pageText.includes('西:龙井村')));

    // 第2步：点龙井村（只在还站在西城门方向上时点）
    for (let i = 0; i < 3; i++) {
        pageText = await getPageText(page);
        if (!pageText.includes('西：龙井村') && !pageText.includes('西:龙井村')) break;
        console.log(`[nav] 点龙井村(${i + 1}):`, await jsClick(page, '龙井村'));
        await sleep(3000);
        await page.screenshot({ path: `nav-3-ljc-${i + 1}.png` }).catch(() => {});
    }
    pageText = await getPageText(page);
    console.log('[nav] 第2步后地图:', mapBlock(pageText), '| 北向西湖=' + (pageText.includes('北：西湖') || pageText.includes('北:西湖')));

    // 第3步：进西湖
    for (let i = 0; i < 3; i++) {
        pageText = await getPageText(page);
        if (pageText.includes('水怪')) break;
        console.log(`[nav] 点西湖(${i + 1}):`, await jsClick(page, '西湖'));
        await sleep(3000);
        await page.screenshot({ path: `nav-4-xihu-${i + 1}.png` }).catch(() => {});
    }

    pageText = await getPageText(page);
    console.log('[nav] 到达后地图:', mapBlock(pageText), '| 水怪=' + pageText.includes('水怪'));
    if (pageText.includes('水怪') || pageText.includes('当前城市：杭州')) {
        console.log('到达西湖');
        return true;
    }
    return false;
}

// 掉线/被顶号的等待重登时间：期间可能是用户在手动操作，不能抢号
const RELOGIN_WAIT_MS = 30 * 60 * 1000;

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
            console.log('::error::登录失败：未进入游戏主界面，刷怪已退出');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
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

        // 卡副本自恢复（dungeon误进/未退出会把号留在房间里，后续全部步骤都会撞死）
        await exitDungeonIfInside(page);

        // 检查是否在杭州（失败不直接放弃：重载页面再试一轮，点击无响应多半能救回）
        pageText = await getPageText(page);
        if (pageText.includes('当前城市：杭州')) {
            console.log('已在杭州');
        } else {
            for (let round = 1; round <= 2; round++) {
                console.log(`不在杭州，导航中...(第${round}/2轮)`);

                if (round > 1) {
                    await reloadGame(page);
                    await sleep(4000);
                    await exitDungeonIfInside(page);
                }

                const arrived = await sailFlow(page);
                if (!arrived) {
                    console.log('出航未完成（中止或约5分钟超时），改用传送兜底...');
                    await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                    await teleportToDest(page);
                }
                await sleep(2000);

                pageText = await getPageText(page);
                if (pageText.includes('当前城市：杭州')) break;
            }

            // 严格校验：没到杭州绝不往下走（否则会在错误城市空转数小时）
            if (!pageText.includes('当前城市：杭州')) {
                console.log('未到达杭州，跳过农场');
                await page.screenshot({ path: 'farm-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
            console.log('到达杭州');
        }

        if (!(await gotoXihu(page))) {
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
        let lastCountAt = Date.now();
        let kickedAt = 0;
        let kickLogAt = 0;
        console.log('进入打怪循环（进度每60秒汇报一次）');
        while (true) {
            pageText = await getPageText(page);

            // 到点主动收尾：job 的 timeout-minutes 是 360，被它砍掉时整个 run 标 failure，
            // 于是「跑到上限」和「真故障」混成一片红（2026-10-29 00:00 波 4 个 job 全是这样）。
            // 刷到这里就正常退出，red 只留给真问题。FARM_MAX_MIN=0 可关闭该限制。
            if (FARM_MAX_MIN > 0 && Date.now() - loopStart >= FARM_MAX_MIN * 60000) {
                console.log(`已刷满 ${FARM_MAX_MIN} 分钟（击杀 ${count} 次），主动收尾退出，避免撞 job 6 小时上限被判 failure`);
                break;
            }

            // 掉线自救：会话失效会退回登录页，原逻辑只点刷新，能空转几小时
            // 但掉线也可能是用户手动登录/新一波顶号，先让位 30 分钟，期间不自作主张重登抢号
            if (pageText.includes('请输入账号密码') || (pageText.includes('已保存账号') && pageText.includes('请输入密码'))) {
                const now = Date.now();
                if (!kickedAt) {
                    kickedAt = now;
                    console.log(`检测到掉回登录页(已打${count}次)，可能被顶号或在水手操，先让位30分钟再尝试重登`);
                    await page.screenshot({ path: 'farm-offline.png' }).catch(() => {});
                }
                if (now - kickedAt < RELOGIN_WAIT_MS) {
                    if (now - kickLogAt >= 300000) {
                        kickLogAt = now;
                        console.log(`让位等待中：已等 ${Math.round((now - kickedAt) / 60000)} 分钟（满30分钟再重登）`);
                    }
                    await sleep(10000);
                    continue;
                }
                console.log(`已让位 ${Math.round((now - kickedAt) / 60000)} 分钟，尝试重新登录...`);
                if (await relogin(page)) {
                    pageText = await getPageText(page);
                    if (!pageText.includes('水怪')) await gotoXihu(page).catch(() => false);
                    lastCountAt = Date.now();
                }
                kickedAt = 0;
                kickLogAt = 0;
                continue;
            }
            kickedAt = 0;

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
                lastCountAt = Date.now();
            } else {
                if (count === 0 && !global.__shot) {
                    global.__shot = true;
                    await page.screenshot({ path: 'stuck-beach.png' });
                }
                await clickText(page, '刷新');
                await sleep(50);
            }

            // 10分钟没击杀=卡死（页面空白/人物异常），重登并走回西湖自愈
            if (Date.now() - lastCountAt >= 600000) {
                console.log(`连续10分钟无击杀(已打${count}次)，尝试自愈：重登+走回西湖...`);
                await page.screenshot({ path: 'farm-stuck.png' }).catch(() => {});
                await relogin(page);
                pageText = await getPageText(page);
                if (!pageText.includes('水怪')) await gotoXihu(page).catch(() => false);
                lastCountAt = Date.now();
                continue;
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
