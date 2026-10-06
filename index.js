const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// BOSS_FORCE=true 时跳过所有时间闸门（测试登录+导航用）
const FORCE = process.env.BOSS_FORCE === 'true' || process.env.BOSS_FORCE === '1';
// 测试用：NAV_DEST/NAV_REGION 覆盖航行目的地（如 广州/东亚），默认孟买/印度洋
const NAV_DEST = process.env.NAV_DEST || '孟买';
const NAV_REGION = process.env.NAV_REGION || '印度洋';
// 12:00-12:30 窗口内失败重试的最大轮数
const MAX_ATTEMPTS = FORCE ? 2 : 5;

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

// 出航流程：出航菜单→区域→城市→出航确认→自动航行→航行循环（海盗避战/恢复），返回是否到达
async function sailFlow(page) {
    if (FORCE && process.env.TEST_FALLBACK === 'true') {
        console.log('测试模式: 跳过出航流程，直接走传送兜底');
        return false;
    }

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

// 导航到目的地：先出航，失败改传送，最后强校验当前城市
async function navigateToDest(page, preferTeleport) {
    let arrived;
    if (preferTeleport) {
        console.log('上轮已出航失败，本轮直接走传送兜底...');
        arrived = await teleportToDest(page);
    } else {
        arrived = await sailFlow(page);
        if (!arrived) {
            await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
            console.log('出航未完成，改用传送兜底...');
            arrived = await teleportToDest(page);
        }
    }
    await sleep(2000);
    const txt = await getPageText(page);
    if (arrived && txt.includes(`当前城市：${NAV_DEST}`)) return true;
    await page.screenshot({ path: 'nav-final-fail.png' }).catch(() => {});
    console.log(`导航失败，当前未在${NAV_DEST}。页面文本:`, txt.substring(0, 300));
    return false;
}

// 登录→进入游戏，返回是否看到游戏主界面
async function loginToGame(page) {
    try {
        await page.goto('http://yiyu.yiyutx.top/yysh/#/pages/login/login');
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        if (inputs.length >= 2) {
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
            await page.getByText('登录').first().click();
            await sleep(3000);
            console.log('1. 登录完成');
        } else {
            console.log('1. 会话有效，页面已自动进入游戏');
        }
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        console.log('2. 进入游戏');
        return (await getPageText(page)).includes('当前城市');
    } catch (e) {
        console.log('登录失败:', e.message);
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

    let remain = -1;
    let completed = 0;
    let useTeleport = false;

    try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            console.log(`===== 第 ${attempt}/${MAX_ATTEMPTS} 轮 =====`);
            let stop = false;
            let timeUp = false;

            try {
                if (!(await loginToGame(page))) {
                    console.log('登录/进入游戏失败');
                } else {
                    if ((await getPageText(page)).includes(`当前城市：${NAV_DEST}`)) {
                        console.log(`3. 已在${NAV_DEST}`);
                    } else {
                        console.log(`3. 不在${NAV_DEST}，导航中...`);
                        if (!(await navigateToDest(page, useTeleport))) useTeleport = true;
                    }

                    const t0 = await getBjTime();
                    if (!FORCE && (t0.hour < 12 || (t0.hour === 12 && t0.min === 0))) {
                        console.log('等待boss开放...');
                        while (true) {
                            const t = await getBjTime();
                            if (t.hour >= 12) break;
                            await sleep(10000);
                        }
                    }

                    await page.keyboard.press('Escape');
                    await sleep(500);
                    if (!(await clickBtn(page, '世界boss'))) await clickText(page, '世界boss');
                    await sleep(3000);
                    console.log('4. 进入boss页面');

                    let pageText = await getPageText(page);
                    const timesMatch = pageText.match(/攻击次数[：:]\s*(\d+)\/10/);
                    const usedTimes = timesMatch ? parseInt(timesMatch[1]) : 0;
                    const roundRemain = 10 - usedTimes;
                    if (remain < 0) remain = roundRemain;
                    console.log(`已用次数: ${usedTimes}, 剩余次数: ${roundRemain}`);

                    if (roundRemain <= 0) {
                        console.log('今日次数已用完');
                        remain = 0;
                        stop = true;
                    }

                    if (!stop) {
                        for (let i = 0; i < roundRemain; i++) {
                            const { hour: h, min: m } = await getBjTime();
                            if (!FORCE && (h !== 12 || m >= 30)) {
                                console.log('挑战时间结束');
                                timeUp = true;
                                break;
                            }

                            const challengeBtn = page.locator('text=发起挑战').first();
                            let visible = await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false);
                            if (!visible) {
                                await page.keyboard.press('Escape');
                                await sleep(1000);
                                visible = await challengeBtn.isVisible({ timeout: 5000 }).catch(() => false);
                            }
                            if (!visible) {
                                console.log('按钮不可用');
                                break;
                            }

                            await challengeBtn.click();
                            await sleep(1000);

                            pageText = await getPageText(page);
                            if (pageText.includes('已达上限')) {
                                console.log('今日次数已用完');
                                remain = 0;
                                break;
                            }
                            if (pageText.includes('开放时间')) {
                                console.log('boss未开放');
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
                                completed++;
                                console.log(`5. 第 ${completed} 次挑战完成`);
                            } else if (damageMatch) {
                                completed++;
                                console.log(`5. 第 ${completed} 次挑战完成(未见确定按钮)`);
                            }

                            console.log('6. 等待30秒冷却...');
                            for (let s = 0; s < 35; s++) {
                                await sleep(1000);
                                pageText = await getPageText(page);
                                if (pageText.includes('发起挑战') && !pageText.includes('后可再次挑战')) {
                                    console.log('冷却结束');
                                    break;
                                }
                                const { hour: h2, min: m2 } = await getBjTime();
                                if (!FORCE && (h2 !== 12 || m2 >= 30)) break;
                            }
                        }

                        if (remain === 0 || completed >= remain) stop = true;
                        else if (timeUp) {
                            console.log('12:30后不再重试');
                            stop = true;
                        } else if (attempt < MAX_ATTEMPTS) {
                            console.log(`本轮未打满(${completed}/${remain})，15秒后重试...`);
                        }
                    }
                }
            } catch (e) {
                console.log(`第 ${attempt} 轮异常:`, e.message);
            }

            if (stop) break;
            if (attempt < MAX_ATTEMPTS) await sleep(15000);
        }

        if (remain === 0 || completed > 0) {
            console.log(`世界boss完成，累计 ${completed} 次`);
        } else {
            console.error('::error::世界boss失败: 12:00-12:30 窗口内完成 0 次挑战');
            await page.screenshot({ path: 'boss-fail.png' }).catch(() => {});
            process.exitCode = 1;
        }
    } catch (e) {
        console.error('错误:', e.message);
        if (!(remain === 0 || completed > 0)) {
            console.error(`::error::世界boss异常终止: ${e.message}`);
            await page.screenshot({ path: 'boss-fail.png' }).catch(() => {});
            process.exitCode = 1;
        }
    } finally {
        await browser.close();
    }
}

run();
