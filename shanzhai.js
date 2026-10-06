const { chromium } = require('playwright');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

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

async function getPageText(page) {
    return await page.textContent('body').catch(() => '');
}

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

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

async function clickLeaf(page, text, exactOnly = true) {
    return await page.evaluate(({ t, ex }) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (el.children.length !== 0 || r.width <= 0 || r.height <= 0) return false;
            return ex ? s === t : s.includes(t);
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, { t: text, ex: exactOnly });
}

async function closePopup(page) {
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.keyboard.press('Escape');
    await sleep(1000);
}

async function grabToast(page, keys, timeout = 3500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const t = await getPageText(page);
        for (const k of keys) {
            const i = t.indexOf(k);
            if (i >= 0) {
                return t.substring(i, Math.min(t.length, i + 60)).replace(/\s+/g, ' ').trim();
            }
        }
        await sleep(350);
    }
    return null;
}

async function openShanzhai(page) {
    for (let i = 0; i < 8; i++) {
        let t = await getPageText(page);
        if (t.includes('一键收获')) return true;
        let ok = await clickLeaf(page, '山寨');
        if (!ok) ok = await clickText(page, '山寨', 3000);
        if (!ok) {
            await page.mouse.wheel(0, 600);
            await sleep(800);
            ok = await clickLeaf(page, '山寨');
            if (!ok) ok = await clickText(page, '山寨', 2000);
        }
        await sleep(2000);
        t = await getPageText(page);
        if (t.includes('一键收获')) return true;
    }
    console.log('打开山寨失败:', (await getPageText(page)).substring(0, 200));
    await page.screenshot({ path: 'shanzhai-open-fail.png' }).catch(() => {});
    return false;
}

async function doHarvest(page) {
    let ok = await clickLeaf(page, '一键收获');
    if (!ok) ok = await clickText(page, '一键收获', 3000);
    if (!ok) await jsClick(page, '一键收获');
    const toast = await grabToast(page, ['一键收获完成', '没有可收获的作物']);
    console.log(`[收获] ${toast || '未捕获提示'}`);
    await sleep(1500);
    return toast;
}

async function clickSowButton(page) {
    return await page.evaluate(() => {
        const cands = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s === '播种' && r.width > 0 && r.height > 0;
        });
        if (!cands.length) return 'none';
        let el = cands.find(e => {
            let p = e.parentElement;
            for (let d = 0; d < 5 && p; d++, p = p.parentElement) {
                if ((p.textContent || '').includes('空地')) return true;
            }
            return false;
        });
        if (!el) el = cands[cands.length - 1];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return 'clicked';
    });
}

async function plantDurian(page) {
    const t = await getPageText(page);
    if (!t.includes('空地')) {
        console.log('[播种] 无空地，跳过');
        return false;
    }
    const sow = await clickSowButton(page);
    if (sow !== 'clicked') {
        console.log(`[播种] 找不到播种按钮(${sow})，跳过`);
        return false;
    }

    let dialogOpen = false;
    const start = Date.now();
    while (Date.now() - start < 4000) {
        if ((await getPageText(page)).includes('选择种子')) { dialogOpen = true; break; }
        await sleep(300);
    }
    if (!dialogOpen) {
        console.log('[播种] 未弹出选择种子对话框');
        await page.screenshot({ path: 'shanzhai-seed-dialog-fail.png' }).catch(() => {});
        return false;
    }

    let found = await page.evaluate(() => {
        const el = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('榴莲种子'));
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
    });
    if (!found) {
        for (let i = 0; i < 5 && !found; i++) {
            await page.mouse.wheel(0, 300);
            await sleep(500);
            found = await page.evaluate(() => {
                const el = [...document.querySelectorAll('body *')].find(e =>
                    e.children.length === 0 && (e.textContent || '').includes('榴莲种子'));
                if (!el) return false;
                el.scrollIntoView({ block: 'center' });
                return true;
            });
        }
    }
    if (!found) {
        console.log('[播种] 对话框里没有榴莲种子');
        await page.screenshot({ path: 'shanzhai-no-durian.png' }).catch(() => {});
        await clickLeaf(page, '×', false);
        return false;
    }
    await sleep(600);

    const clicked = await page.evaluate(() => {
        const name = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('榴莲种子'));
        if (!name) return 'noseed';
        let row = name;
        for (let d = 0; d < 6 && row; d++, row = row.parentElement) {
            const leaves = [...row.querySelectorAll('*')].filter(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '一键');
            if (leaves.length) {
                const el = leaves[0];
                const opts = { bubbles: true, cancelable: true, view: window };
                for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                    el.dispatchEvent(new MouseEvent(type, opts));
                }
                return 'ok';
            }
        }
        return 'nobtn';
    });
    if (clicked !== 'ok') {
        console.log(`[播种] 点击榴莲一键失败(${clicked})`);
        await page.screenshot({ path: 'shanzhai-seed-click-fail.png' }).catch(() => {});
        return false;
    }

    const toast = await grabToast(page, ['一键种植完成', '种植成功', '播种成功'], 4000);
    console.log(`[播种] ${toast || '未捕获提示'}`);
    await sleep(1500);
    return !!toast;
}

async function doWater(page) {
    let ok = await clickLeaf(page, '一键浇水');
    if (!ok) ok = await clickText(page, '一键浇水', 3000);
    if (!ok) ok = await jsClick(page, '一键浇水');
    console.log(`[浇水] 点击=${ok}`);
    const toast = await grabToast(page, ['一键浇水完成', '浇水成功', '没有可浇水', '请先播种', '暂无可浇水']);
    console.log(`[浇水] ${toast || '未捕获提示'}`);
    if (!toast) {
        await page.screenshot({ path: 'shanzhai-water-fail.png' }).catch(() => {});
        const t = await getPageText(page);
        const i = t.indexOf('浇');
        if (i >= 0) console.log('[浇水] 页面含浇字上下文:', t.substring(Math.max(0, i - 30), i + 50).replace(/\s+/g, ' '));
    }
    await sleep(1500);
    return toast;
}

async function exitShanzhai(page) {
    for (let i = 0; i < 4; i++) {
        let t = await getPageText(page);
        if (!t.includes('一键收获') && (t.includes('当前城市') || t.includes('你看到'))) {
            return true;
        }
        await page.goBack().catch(() => {});
        await sleep(2000);
        t = await getPageText(page);
        if (!t.includes('一键收获') && (t.includes('当前城市') || t.includes('你看到'))) {
            return true;
        }
        if (t.includes('请输入账号密码')) {
            console.log('goBack退过头了，回到登录页');
            return false;
        }
        await page.evaluate(() => {
            const c = document.querySelector('.van-nav-bar__arrow, .van-icon-arrow-left, [class*="back"]');
            if (c) c.click();
        });
        await sleep(2000);
    }
    return false;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);

        for (let attempt = 0; attempt < 10; attempt++) {
            const inputs = await page.$$('input');
            if (inputs.length < 2) {
                let t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    console.log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                console.log('找不到输入框，刷新页面...');
                await gotoGame(page);
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

            let pageText = await getPageText(page);
            if (pageText.includes('进入游戏') || pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('登录成功');
                break;
            }
            console.log('登录未成功，重试...');
            await sleep(2000);
        }

        for (let i = 0; i < 10; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            let pageText = await getPageText(page);
            if (pageText.includes('选择角色') || pageText.includes('Lv.')) {
                console.log('在选角界面，点击进入游戏选角色...');
                await clickText(page, '进入游戏');
                await sleep(5000);
                pageText = await getPageText(page);
            }
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('进入游戏成功');
                break;
            }
            console.log('进入游戏未成功，重试...');
            await sleep(2000);
        }

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        let pageText = await getPageText(page);
        if (pageText.includes('请输入账号密码') || pageText.includes('选择角色')) {
            console.log('ERROR: 未进入游戏主界面，退出');
            await browser.close();
            return;
        }

        if (!(await openShanzhai(page))) {
            await browser.close();
            return;
        }
        console.log('进入山寨农场');

        const harvest = await doHarvest(page);
        const planted = await plantDurian(page);
        const water = await doWater(page);

        await page.screenshot({ path: 'shanzhai-done.png' }).catch(() => {});

        if (await exitShanzhai(page)) {
            console.log('已退出山寨回到主页面');
        } else {
            console.log('退出山寨未确认回到主页面');
            await page.screenshot({ path: 'shanzhai-exit-fail.png' }).catch(() => {});
        }

        console.log(`山寨农场完成: 收获[${harvest || '无提示'}] | 播种榴莲[${planted ? '成功' : '未完成'}] | 浇水[${water || '无提示'}]`);

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'shanzhai-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
