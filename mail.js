const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 邮件领取（用户 coldwind8 手测流程）：主界面「邮件」→ 列表滚到底（出现「已加载全部数据」才下结论）
//   全为「已读已领/未读」→ 不点领取直接返回；有「未读未领」→ 领取所有 → 确定（确认框必弹）
//   → toast「领取成功/暂无可领取的奖励」都正常 → 再滚到底核对（仍有未读未领就补领，最多3次核对）
//   未读=无奖励邮件，忽略。挂 tasks.js dusk 链（18:00 山寨农场之后）
//   异常 → ::error:: + mail-*.png（进程仍退出0）

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
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

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
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

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

function log(msg) {
    console.log(`[mail] ${msg}`);
}

function snippet(t) {
    return t.substring(0, 100).replace(/\s+/g, ' ');
}

async function fail(page, msg, shot) {
    console.log(`ERROR: ${msg}`);
    console.log(`::error::邮件领取：${msg}`);
    await page.screenshot({ path: shot }).catch(() => {});
}

// 左上角返回：文本箭头 → 左上角坐标真实点击（箭头是图标时文本匹配不到）→ goBack 兜底
async function navBack(page) {
    const found = await page.evaluate(() => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && ['<', '‹', '返回'].includes(s) &&
                r.width > 0 && r.height > 0;
        });
        const el = leaves.find(e => {
            const r = e.getBoundingClientRect();
            return r.top < 160 && r.left < 130;
        }) || leaves[0];
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    });
    if (found) await sleep(1500);
    let t = await getPageText(page);
    if (t.includes('领取所有')) {
        log('文本箭头未离开邮件页，坐标点击左上角箭头...');
        await page.mouse.click(18, 30);
        await sleep(1500);
        t = await getPageText(page);
    }
    if (t.includes('领取所有')) {
        log('仍在邮件页，goBack兜底...');
        await page.goBack().catch(() => {});
        await sleep(1500);
        return false;
    }
    return true;
}

// 列表滚到底：出现「已加载全部数据」才下结论（懒加载，对齐 fish.js 包裹滚动写法）
async function scrollMailToBottom(page) {
    for (let i = 0; i < 25; i++) {
        const t = await getPageText(page);
        if (t.includes('已加载全部数据')) return true;
        await page.mouse.move(400, 650).catch(() => {});
        await page.mouse.wheel(0, 700).catch(() => {});
        await sleep(450);
    }
    return (await getPageText(page)).includes('已加载全部数据');
}

// 领取所有：点按钮 → 等确认弹窗(必弹) → 精确点「确定」→ 等弹窗关闭，返回 {ok, why?, t}
async function claimAll(page) {
    if (!(await clickText(page, '领取所有', 4000))) return { ok: false, why: '邮件页未见「领取所有」按钮' };
    let t = '';
    for (let i = 0; i < 5; i++) {
        await sleep(1500);
        t = await getPageText(page);
        if (t.includes('确定要领取所有未领邮件奖励')) break;
    }
    if (!t.includes('确定要领取所有未领邮件奖励')) return { ok: false, why: '点「领取所有」后未见确认弹窗', t };
    // 精确匹配按钮「确定」（弹窗正文也含“确定”二字，非精确会点到正文）
    if (!(await clickExact(page, '确定', 4000))) return { ok: false, why: '确认弹窗内未找到「确定」按钮', t };
    for (let i = 0; i < 6; i++) {
        await sleep(1500);
        t = await getPageText(page);
        if (!t.includes('确定要领取所有未领邮件奖励')) return { ok: true, t };
    }
    return { ok: false, why: '点确定后确认弹窗未关闭', t };
}

function logToast(t) {
    if (t.includes('领取成功')) log('领取成功（奖励提示已出现）');
    else if (t.includes('暂无可领取的奖励')) log('暂无可领取的奖励');
    else log('确认弹窗已关闭');
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);

        // 1. 登录（10次重试 + 会话有效跳过）
        for (let attempt = 0; attempt < 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                let t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                log('找不到输入框，刷新页面...');
                await gotoGame(page);
                await page.waitForTimeout(3000);
                const newInputs = await page.$$('input');
                if (newInputs.length < 2) {
                    t = await getPageText(page);
                    if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                        log('无表单但已在游戏流程中（会话有效），跳过登录');
                        break;
                    }
                    log('刷新后仍找不到输入框，重试...');
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
            const t = await getPageText(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                log(`登录成功 (第${attempt + 1}次)`);
                break;
            }
            log(`登录未成功，重试 (${attempt + 1}/10)`);
            await sleep(2000);
        }

        // 2. 进入游戏（含选角处理）
        for (let i = 0; i < 10; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            let t = await getPageText(page);
            if (t.includes('选择角色') || t.includes('Lv.')) {
                log('在选角界面，点击进入游戏选角色...');
                await clickText(page, '进入游戏');
                await sleep(5000);
                t = await getPageText(page);
            }
            if (t.includes('你看到') || t.includes('当前城市')) {
                log('进入游戏成功');
                break;
            }
            log('进入游戏未成功，重试...');
            await sleep(2000);
        }
        await sleep(3000);
        await page.keyboard.press('Escape');
        await sleep(1500);

        let t = await getPageText(page);
        if (t.includes('请输入账号密码') || t.includes('选择角色') ||
            !(t.includes('你看到') || t.includes('当前城市'))) {
            await fail(page, '登录失败/未进入游戏主界面', 'mail-login-fail.png');
            return;
        }
        log('已进入游戏主界面');

        // 3. 主界面点「邮件」
        if (!(await clickText(page, '邮件', 5000))) {
            await fail(page, '主界面未见「邮件」入口', 'mail-nav-fail.png');
            return;
        }
        let onMail = false;
        for (let i = 0; i < 5; i++) {
            await sleep(2000);
            t = await getPageText(page);
            if (t.includes('领取所有') && t.includes('一键已读')) {
                onMail = true;
                break;
            }
        }
        if (!onMail) {
            await fail(page, '未进入邮件页: ' + snippet(t), 'mail-nav-fail.png');
            return;
        }
        log('已进入邮件页');

        // 4. 列表滚到底（懒加载，确保未读未领不因折叠而遗漏）
        const allLoaded = await scrollMailToBottom(page);
        if (!allLoaded) log('未见「已加载全部数据」标记（邮件可能已删空或已到底）');
        t = await getPageText(page);

        if (!t.includes('未读未领')) {
            log('无「未读未领」（已读已领/未读/已删空），无需领取，直接返回');
        } else {
            // 5. 有未读未领 → 领取所有 → 确定（确认框必弹）
            let r = await claimAll(page);
            if (!r.ok) {
                const shot = r.why.includes('未见确认弹窗') ? 'mail-nodialog.png'
                    : r.why.includes('领取所有') ? 'mail-nav-fail.png' : 'mail-claim-fail.png';
                await fail(page, r.why, shot);
                await navBack(page);
                return;
            }
            logToast(r.t);

            // 6. 滚到底核对：仍有未读未领就补领（最多3次核对），确保不遗漏
            let verified = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                await scrollMailToBottom(page);
                t = await getPageText(page);
                if (!t.includes('未读未领')) {
                    verified = true;
                    break;
                }
                if (attempt === 2) break;
                log(`核对仍有「未读未领」，补领(${attempt + 2}/3)...`);
                r = await claimAll(page);
                if (!r.ok) {
                    log('补领失败: ' + r.why);
                    break;
                }
                logToast(r.t);
            }
            if (verified) {
                log('核对完成：无「未读未领」（已读已领/未读正常，未读=无奖励邮件忽略）');
            } else {
                await fail(page, '领取后核对仍有「未读未领」邮件', 'mail-verify-fail.png');
            }
        }
        await page.screenshot({ path: 'mail-done.png' }).catch(() => {});

        // 6. 左上角返回主界面
        const backOk = await navBack(page);
        await sleep(1500);
        t = await getPageText(page);
        if (!(t.includes('当前城市') || t.includes('你看到'))) {
            await fail(page, '返回后未见主界面: ' + snippet(t), 'mail-back-fail.png');
            return;
        }
        log(`领取流程完成（返回${backOk ? '点返回箭头' : 'goBack兜底'}）`);
    } catch (e) {
        console.error('ERROR: 邮件领取流程异常:', e.message);
        console.log(`::error::邮件领取异常: ${e.message}`);
        await page.screenshot({ path: 'mail-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
