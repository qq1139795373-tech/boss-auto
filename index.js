const { chromium } = require('playwright');
// 只读可见节点的页面文本（避免 display:none 残留节点造成的幽灵文案）
const { visibleText } = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// BOSS_FORCE=true 时跳过所有时间闸门（测试登录+导航用）
const FORCE = process.env.BOSS_FORCE === 'true' || process.env.BOSS_FORCE === '1';
// 测试用：NAV_DEST/NAV_REGION 覆盖航行目的地（如 广州/东亚），默认孟买/印度洋
const NAV_DEST = process.env.NAV_DEST || '孟买';
const NAV_REGION = process.env.NAV_REGION || '印度洋';

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
            return;
        } catch (e) {
            console.log(`打开页面第${i}/${retries}次失败:`, (e.message || '').split('\n')[0]);
            await sleep(3000);
        }
    }
    throw new Error('打开游戏页失败(3次重试均超时)');
}

// 只拼可见节点。原实现 textContent('body') 不排除 display:none，
// 残留弹窗节点会一直留在 DOM 里 → 读出幽灵文案，把「没成」判成「成了」（2026-10-28 同源问题）。
async function getPageText(page) {
    return await visibleText(page);
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

// JS直接向元素派发鼠标事件，绕过全屏遮罩（城内地图弹窗的遮罩会吃掉坐标点击）
async function jsClick(page, text) {
    return await page.evaluate(t => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) && r.width > 0 && r.height > 0;
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all.find(e => e.textContent.trim() === t) || all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, text);
}

async function clickBtn(page, text, timeout = 3000) {
    if (await jsClick(page, text)) return true;
    return await clickText(page, text, timeout);
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

// 无地图提示：没这张图的号点城市只会弹「暂无地图，查看失败」，不会出现出航确认框
let SAIL_FAIL = '';
function sailFailReason() { return SAIL_FAIL; }

// 选海域标签：.region-bar 横向滚动，目标不在可视区就先滚进来再点（否则点空/点到隔壁）
// 返回 true=已切到 / 'nomap'=该号没这个海域的海图（点标签即弹「暂无地图，查看失败」）/ false=点不到
async function selectRegion(page, region) {
    const noMap = async () => (await getPageText(page)).includes('暂无地图');
    const read = () => page.evaluate((r) => {
        const bar = document.querySelector('.region-bar');
        if (!bar) return null;
        const wrapEl = bar.querySelector('.scroll-view_H') || bar;
        const wb = wrapEl.getBoundingClientRect();
        for (const chip of bar.querySelectorAll('.region-chip')) {
            if ((chip.textContent || '').trim() !== r) continue;
            const b = chip.getBoundingClientRect();
            if (!b.width || !b.height) return null;
            const cx = b.x + b.width / 2;
            return {
                x: Math.round(cx), y: Math.round(b.y + b.height / 2),
                active: chip.classList.contains('active-region'),
                inView: cx > wb.left + 8 && cx < wb.right - 8,
                scrollLeft: cx < wb.left + 8 ? 'right' : (cx > wb.right - 8 ? 'left' : null),
                barX: Math.round(wb.x + wb.width * 0.6), barY: Math.round(wb.y + wb.height / 2),
            };
        }
        return null;
    }, region).catch(() => null);

    for (let i = 0; i < 5; i++) {
        const p = await read();
        if (!p) {
            const bar = await page.evaluate(() => {
                const b = document.querySelector('.region-bar');
                if (!b) return null;
                const r = b.getBoundingClientRect();
                return { x: Math.round(r.x + r.width * 0.75), y: Math.round(r.y + r.height / 2) };
            }).catch(() => null);
            if (bar) { await page.mouse.move(bar.x, bar.y); await page.mouse.wheel(300, 0); }
            await sleep(700);
            continue;
        }
        if (p.active) return true;
        if (!p.inView) {
            await page.mouse.move(p.barX, p.barY);
            await page.mouse.wheel(p.scrollLeft === 'right' ? -200 : 200, 0);
            await sleep(800);
            continue;
        }
        await page.mouse.click(p.x, p.y);
        await sleep(1200);
        if (await noMap()) return 'nomap';
        const after = await read();
        if (after && after.active) return true;
    }
    return false;
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
        const rp = await selectRegion(page, region);
        if (rp === 'nomap') {
            console.log(`「暂无地图，查看失败」→ 该号没有${region}海域的海图，${dest}到不了，不传送`);
            SAIL_FAIL = 'nomap';
            return false;
        }
        await sleep(1000);
        for (let s = 0; s < 5; s++) {
            // 第2轮起用JS叶子派发点击，绕过遮罩对坐标点击的拦截
            const ok = round === 1
                ? await clickText(page, dest, 2000)
                : await jsClick(page, dest);
            if (ok) {
                // 高峰期确认框慢半拍，单次1.5秒查询会误判，改成最多8秒轮询
                for (let c = 0; c < 8; c++) {
                    await sleep(1000);
                    let t = await getPageText(page);
                    // 「暂无地图」与出航确认框会同时出现（实测），必须先判 nomap
                    if (t.includes('暂无地图')) {
                        console.log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                        SAIL_FAIL = 'nomap';
                        return false;
                    }
                    if (t.includes('出航确认')) {
                        await sleep(800); // 确认框先渲染、toast 后弹：复检一次
                        t = await getPageText(page);
                        if (t.includes('暂无地图')) {
                            console.log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                            SAIL_FAIL = 'nomap';
                            return false;
                        }
                        return true;
                    }
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
// 起航判定：航行中/剩余距离/停止自动航行 任一出现即算离港（同 fish.js，见注释）
async function waitSailing(page, sec) {
    for (let i = 0; i < sec; i++) {
        const t = await getPageText(page);
        if (t.includes('航行中') || t.includes('剩余距离') || t.includes('停止自动航行')) return true;
        await sleep(1000);
    }
    return false;
}

async function sailFlow(page) {
    SAIL_FAIL = '';
    if (FORCE && process.env.TEST_FALLBACK === 'true') {
        console.log('测试模式: 跳过出航流程，直接走传送兜底');
        return false;
    }

    // 已在海上 → 直接等到达；重开出航面板在海上必然失败，会误判成出航失败去传送
    const pre = await getPageText(page);
    const already = pre.includes('停止自动航行') || pre.includes('剩余距离');
    // 已在目标城市：出航列表不列当前城市，硬选必然失败 → 直接算到达
    if (!already && pre.includes(`当前城市：${NAV_DEST}`)) {
        console.log(`已在${NAV_DEST}，无需出航`);
        return true;
    }
    if (already) console.log('已在航行中，跳过出航选择直接等待到达...');
    const picked = already ? true : await pickConfirm(page, NAV_REGION, NAV_DEST);
    if (!picked) {
        if (SAIL_FAIL === 'nomap') return failNav(page, `目的地${NAV_DEST}无地图(暂无地图，查看失败)`);
        return failNav(page, '出航确认框始终未出现');
    }

    if (!already) {
        await clickText(page, '立即出发');
        let sailing = await waitSailing(page, 25);
        if (!sailing) {
            console.log('未见起航，重点「立即出发」再等...');
            await clickText(page, '立即出发');
            sailing = await waitSailing(page, 20);
        }
        if (!sailing) {
            console.log('仍未起航，重开出航面板选目的地...');
            const again = await pickConfirm(page, NAV_REGION, NAV_DEST);
            if (again) {
                await clickText(page, '立即出发');
                sailing = await waitSailing(page, 25);
            }
        }
        if (!sailing) return failNav(page, '起航未确认(航行中/剩余距离都没出现)');
    }
    console.log('3. 航行中...');

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
    // 防白花银币：已在目标城市就别传送（误判/重试命中时常见）
    const chk = await getPageText(page);
    if (chk.includes(`当前城市：${NAV_DEST}`)) {
        console.log(`传送兜底: 其实已在${NAV_DEST}，跳过传送(省银币)`);
        return true;
    }
    console.log('传送兜底: 重新登录游戏...');
    try {
        await gotoGame(page);
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

        // 打开传送面板并验证：区域标签出现才算真打开（坐标点击被遮罩吃掉会假成功）
        let panelOpen = false;
        for (let i = 0; i < 3 && !panelOpen; i++) {
            let ok = await clickText(page, '传送', 2000);
            if (!ok) {
                await clickText(page, '城内地图');
                await sleep(2000);
                await clickText(page, '码头');
                await sleep(3000);
                ok = await clickText(page, '传送');
            }
            await sleep(1500);
            const pt = await getPageText(page);
            panelOpen = pt.includes('地中海') && pt.includes('印度洋');
            if (!panelOpen) {
                console.log(`传送面板未打开(${i + 1}/3)，关闭重试...`);
                await page.mouse.click(10, 10);
                await sleep(300);
                await page.keyboard.press('Escape');
                await sleep(500);
            }
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

    // 只有11:50-12:30才打boss，其他时间跳过（11:50出门，12:00开打，兼容3:50 UTC的cron触发）
    if (!FORCE && (hour > 12 || (hour === 12 && min >= 30) || hour < 11 || (hour === 11 && min < 50))) {
        console.log('非boss时间，跳过boss');
        return;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);

        let loggedIn = false;
        for (let attempt = 1; attempt <= 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length >= 2) {
                await inputs[0].fill(ACCOUNT);
                await inputs[1].fill(PASSWORD);
                await page.getByText('登录').first().click();
            } else {
                await clickText(page, '登录');
            }
            await sleep(3000);
            const t = await getPageText(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                console.log(`1. 登录成功 (第${attempt}次)`);
                loggedIn = true;
                break;
            }
            console.log(`登录未成功，重试 (${attempt}/10)`);
            await sleep(2000);
        }
        if (!loggedIn) {
            console.log('ERROR: 登录失败，跳过本次boss');
            console.log('::error::Run Boss 登录失败(10次重试)，本次boss已跳过');
            await page.screenshot({ path: 'boss-login-fail.png' }).catch(() => {});
            return;
        }

        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);

        let pageText = await getPageText(page);
        if (pageText.includes('选择角色') || pageText.includes('Lv.')) {
            console.log('在选角界面，再次点击进入游戏...');
            await clickText(page, '进入游戏');
            await sleep(3000);
            pageText = await getPageText(page);
        }
        if (!(pageText.includes('你看到') || pageText.includes('当前城市'))) {
            console.log('ERROR: 未进入游戏主界面，跳过本次boss');
            console.log('::error::Run Boss 未进入游戏主界面，本次boss已跳过');
            await page.screenshot({ path: 'boss-login-fail.png' }).catch(() => {});
            return;
        }
        console.log('2. 进入游戏成功');

        if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`3. 已在${NAV_DEST}`);
        } else {
            console.log(`3. 不在${NAV_DEST}，导航中...`);

            const arrived = await sailFlow(page);
            if (!arrived) {
                if (sailFailReason() === 'nomap') {
                    console.log(`⚠ ${NAV_DEST} 暂无地图（该号没有这张图），跳过；不传送（传送点城市同样提示暂无地图）`);
                    await page.screenshot({ path: 'nav-nomap.png' }).catch(() => {});
                } else {
                    await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                    console.log('出航约5分钟未完成，改用传送兜底...');
                    await teleportToDest(page);
                }
            }
            await sleep(2000);
        }

        if (!FORCE && (hour < 12 || (hour === 12 && min === 0))) {
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
            if (!FORCE && (h !== 12 || m >= 30)) {
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
                    if (!FORCE && (h2 !== 12 || m2 >= 30)) {
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
        console.error('ERROR: boss流程异常:', e.message);
        console.log(`::error::Run Boss 异常: ${e.message}`);
        await page.screenshot({ path: 'boss-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
