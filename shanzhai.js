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

async function countEmptyPlots(page) {
    if (!(await getPageText(page)).includes('一键收获')) return -1;
    return await page.evaluate(() => {
        const cands = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s === '播种' && r.width > 0 && r.height > 0;
        });
        let n = 0;
        for (const el of cands) {
            let p = el.parentElement;
            for (let d = 0; d < 5 && p; d++, p = p.parentElement) {
                if ((p.textContent || '').includes('空地')) { n++; break; }
            }
        }
        return n;
    });
}

async function openSeedDialog(page) {
    const sow = await clickSowButton(page);
    if (sow !== 'clicked') {
        console.log(`[播种] 找不到播种按钮(${sow})`);
        return false;
    }
    const start = Date.now();
    while (Date.now() - start < 4000) {
        if ((await getPageText(page)).includes('选择种子')) return true;
        await sleep(300);
    }
    console.log('[播种] 未弹出选择种子对话框');
    await page.screenshot({ path: 'shanzhai-seed-dialog-fail.png' }).catch(() => {});
    return false;
}

async function closeSeedDialog(page) {
    for (let i = 0; i < 3; i++) {
        if (!(await getPageText(page)).includes('选择种子')) return true;
        await clickLeaf(page, '×', false);
        await sleep(400);
        if (!(await getPageText(page)).includes('选择种子')) return true;
        await jsClick(page, '×');
        await sleep(400);
        if (!(await getPageText(page)).includes('选择种子')) return true;
        await page.keyboard.press('Escape');
        await sleep(600);
    }
    return !(await getPageText(page)).includes('选择种子');
}

async function findDurianRow(page) {
    const probe = async () => await page.evaluate(() => {
        const el = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('榴莲种子'));
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
    });
    let found = await probe();
    for (let i = 0; i < 5 && !found; i++) {
        await page.mouse.move(640, 360).catch(() => {});
        await page.mouse.wheel(0, 300);
        await sleep(500);
        found = await probe();
    }
    if (!found) return null;
    await sleep(400);
    return await page.evaluate(() => {
        const name = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('榴莲种子'));
        if (!name) return null;
        let row = name;
        for (let d = 0; d < 6 && row; d++, row = row.parentElement) {
            const hasKey = [...row.querySelectorAll('*')].some(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '一键');
            if (hasKey) return (row.textContent || '');
        }
        return null;
    });
}

async function clickDurianOneKey(page) {
    const clicked = await page.evaluate(() => {
        const name = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('榴莲种子'));
        if (!name) return 'noseed';
        let row = name;
        for (let d = 0; d < 6 && row; d++, row = row.parentElement) {
            const leaves = [...row.querySelectorAll('*')].filter(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '一键');
            if (leaves.length && (row.textContent || '').includes('榴莲种子')) {
                const el = leaves[0];
                for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
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
    return true;
}

async function plantAll(page) {
    let empties = await countEmptyPlots(page);
    if (empties < 0) {
        console.log('[播种] 不在山寨农场页，跳过');
        return false;
    }
    if (empties === 0) {
        console.log('[播种] 无空地，跳过');
        return true;
    }
    let stalls = 0;
    for (let round = 1; round <= 12 && empties > 0; round++) {
        const prev = empties;
        if (!(await openSeedDialog(page))) break;
        const rowText = await findDurianRow(page);
        if (!rowText) {
            console.log(`[播种] 第${round}轮: 无榴莲种子(空地${empties})，开顶级种子箱×${empties}`);
            await closeSeedDialog(page);
            if (!(await useTopSeedBoxes(page, empties))) break;
            if (!(await openSeedDialog(page))) break;
        } else {
            const m = rowText.match(/×\s*(\d+)/);
            const count = m ? parseInt(m[1], 10) : null;
            const need = count === null ? 0 : Math.max(0, empties - count);
            if (need > 0) {
                console.log(`[播种] 第${round}轮: 空地${empties} 榴莲×${count}，开顶级种子箱×${need}`);
                await closeSeedDialog(page);
                if (!(await useTopSeedBoxes(page, need))) break;
                if (!(await openSeedDialog(page))) break;
            }
        }
        const ok = await clickDurianOneKey(page);
        await closeSeedDialog(page);
        await sleep(1500);
        let after = await countEmptyPlots(page);
        if (after < 0) {
            if (!(await openShanzhai(page))) break;
            after = await countEmptyPlots(page);
        }
        console.log(`[播种] 第${round}轮 一键=${ok}，空地 ${prev}→${after}`);
        empties = after < 0 ? prev : after;
        if (empties > 0) {
            if (empties < prev) {
                stalls = 0;
            } else {
                stalls++;
                if (stalls >= 2) {
                    console.log('[播种] 连续2轮无进展，停止');
                    break;
                }
            }
        }
    }
    if (empties > 0) {
        console.log(`::error::山寨农场: 播种后仍有${empties}块空地未种上榴莲`);
        await page.screenshot({ path: 'shanzhai-not-full.png' }).catch(() => {});
        return false;
    }
    console.log('[播种] 全部空地已种上榴莲');
    return true;
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

function extractOrderState(t) {
    const today = (t.match(/今日\s*\d+\s*\/\s*\d+\s*单/) || [''])[0];
    const times = (t.match(/订单时间[:：]\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}/g) || []).join('|');
    return `${today}#${times}`;
}

async function scanOrders(page) {
    return await page.evaluate(() => {
        const badges = [...document.querySelectorAll('body *')].filter(e =>
            e.children.length === 0 && /^(可提交|已满足|满足)$/.test((e.textContent || '').trim()));
        const cards = [];
        for (const b of badges) {
            let card = b;
            for (let d = 0; d < 8 && card; d++, card = card.parentElement) {
                const txt = card.textContent || '';
                if (txt.includes('提交订单') && !txt.includes('未满足')) { cards.push(card); break; }
            }
        }
        if (!cards.length) return badges.length ? 'blocked' : 'none';
        const subs = [...cards[0].querySelectorAll('*')].filter(e =>
            e.children.length === 0 && (e.textContent || '').trim() === '提交订单');
        if (!subs.length) return 'blocked';
        const el = subs[subs.length - 1];
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return 'clicked';
    });
}

async function refreshAllOrders(page) {
    const before = extractOrderState(await getPageText(page));
    const c = await page.evaluate(() => {
        const els = [...document.querySelectorAll('body *')].filter(e =>
            e.children.length === 0 && (e.textContent || '').trim() === '刷新全部');
        if (!els.length) return 'nobtn';
        const el = els[els.length - 1];
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return 'ok';
    });
    if (c !== 'ok') {
        console.log('[订单] 无刷新全部按钮(可能今日已用过)');
        return false;
    }
    let triedConfirm = false;
    const start = Date.now();
    while (Date.now() - start < 5000) {
        const t = await getPageText(page);
        if (t.includes('刷新成功') || extractOrderState(t) !== before) {
            console.log('[订单] 刷新全部成功');
            await sleep(800);
            return true;
        }
        if (!triedConfirm && t.includes('确定') && t.includes('取消')) {
            triedConfirm = true;
            await jsClick(page, '确定');
        }
        await sleep(300);
    }
    console.log('[订单] 刷新全部未见成功提示');
    await page.screenshot({ path: 'shanzhai-order-refresh-fail.png' }).catch(() => {});
    return false;
}

async function doOrders(page) {
    try {
        await jsClick(page, '订单');
        await sleep(1200);
        let t = await getPageText(page);
        if (!t.includes('果实订单') && !t.includes('提交订单')) {
            await clickExact(page, '订单', 2000);
            await sleep(1200);
            t = await getPageText(page);
        }
        if (!t.includes('果实订单') && !t.includes('提交订单')) {
            console.log('[订单] 打开订单页失败');
            await page.screenshot({ path: 'shanzhai-order-open-fail.png' }).catch(() => {});
            return '打开失败';
        }
        await sleep(800);
        let submitted = 0;
        let refreshed = false;
        let refreshFail = false;
        let stuck = false;
        let capEnd = false;
        let strikes = 0;
        for (let round = 0; round < 12; round++) {
            const beforeT = await getPageText(page);
            const before = extractOrderState(beforeT);
            const scan = await scanOrders(page);
            if (scan === 'clicked') {
                let changed = false;
                let triedConfirm = false;
                const start = Date.now();
                while (Date.now() - start < 4500) {
                    const ct = await getPageText(page);
                    if ((ct.includes('提交成功') && !beforeT.includes('提交成功')) ||
                        extractOrderState(ct) !== before) { changed = true; break; }
                    if (!triedConfirm && ct.includes('确定') && ct.includes('取消')) {
                        triedConfirm = true;
                        await jsClick(page, '确定');
                    }
                    await sleep(400);
                }
                if (changed) {
                    submitted++;
                    strikes = 0;
                    console.log(`[订单] 提交成功(今日第${submitted}单)`);
                    continue;
                }
                strikes++;
                console.log(`[订单] 提交后状态未变(${strikes}/2)`);
                if (strikes >= 2) {
                    const cm = (await getPageText(page)).match(/今日\s*(\d+)\s*\/\s*(\d+)\s*单/);
                    if (cm && parseInt(cm[1], 10) >= parseInt(cm[2], 10) && parseInt(cm[2], 10) > 0) {
                        console.log(`[订单] 已达今日${cm[2]}单上限`);
                        capEnd = true;
                    } else {
                        console.log('[订单] 提交卡住');
                        await page.screenshot({ path: 'shanzhai-order-stuck.png' }).catch(() => {});
                        stuck = true;
                    }
                    break;
                }
                continue;
            }
            if (scan === 'blocked') {
                strikes++;
                console.log(`[订单] 有满足但点不到提交(${strikes}/2)`);
                if (strikes >= 2) {
                    await page.screenshot({ path: 'shanzhai-order-stuck.png' }).catch(() => {});
                    stuck = true;
                    break;
                }
                continue;
            }
            if (refreshed) break;
            if (await refreshAllOrders(page)) {
                refreshed = true;
                continue;
            }
            refreshFail = true;
            break;
        }
        await jsClick(page, '种植');
        await sleep(1000);
        if (!(await getPageText(page)).includes('一键收获')) {
            await clickExact(page, '种植', 2000);
            await sleep(1000);
            if (!(await getPageText(page)).includes('一键收获')) console.log('[订单] 返回种植页失败(退出时兜底)');
        }
        let summary = submitted > 0 ? `提交${submitted}单` : (refreshed ? '刷新后无可提交' : '无可提交');
        if (capEnd) summary += '(上限)';
        if (refreshFail) summary += '(刷新失败)';
        if (stuck) summary = '卡住(见截图)';
        console.log(`[订单] 完成: ${summary}`);
        return summary;
    } catch (e) {
        console.log('[订单] 异常:', e.message);
        await page.screenshot({ path: 'shanzhai-order-error.png' }).catch(() => {});
        return '异常';
    }
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

async function bagOrHome(page) {
    const t = await getPageText(page);
    if (t.includes('负重') || t.includes('种子箱')) return true;
    return 'home';
}

async function closeRewardPopup(page) {
    let seen = false;
    const start = Date.now();
    while (Date.now() - start < 4000) {
        if ((await getPageText(page)).includes('奖励获取')) { seen = true; break; }
        await sleep(300);
    }
    if (!seen) return true;
    for (let i = 0; i < 6; i++) {
        if (!(await getPageText(page)).includes('奖励获取')) return bagOrHome(page);
        const pos = await page.evaluate(() => {
            const leaf = [...document.querySelectorAll('body *')].find(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '奖励获取');
            if (leaf) {
                let box = leaf;
                for (let d = 0; d < 5 && box; d++, box = box.parentElement) {
                    const r = box.getBoundingClientRect();
                    if (r.width > 200 && r.height > 150 && r.width <= window.innerWidth) {
                        const cx = Math.round(r.left + r.width / 2);
                        if (r.top > 80) return { x: cx, y: Math.round(r.top / 2) };
                        if (r.bottom < window.innerHeight - 60) return { x: cx, y: Math.round((r.bottom + window.innerHeight) / 2) };
                        break;
                    }
                }
            }
            return { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight * 0.9) };
        });
        await page.mouse.click(pos.x, pos.y);
        await sleep(800);
    }
    if (!(await getPageText(page)).includes('奖励获取')) return bagOrHome(page);
    await page.evaluate(() => {
        const c = document.querySelector('.van-nav-bar__arrow, .van-icon-arrow-left, [class*="back"]');
        if (c) c.click();
    });
    await sleep(1500);
    if ((await getPageText(page)).includes('奖励获取')) {
        await page.goBack().catch(() => {});
        await sleep(2000);
    }
    if ((await getPageText(page)).includes('奖励获取')) {
        console.log('[开箱] 奖励弹窗点不掉');
        await page.screenshot({ path: 'shanzhai-box-reward-stuck.png' }).catch(() => {});
        return false;
    }
    console.log('[开箱] 弹窗遮罩点不掉，已用返回箭头回首页兜底');
    return 'home';
}

async function clickBoxUse(page) {
    const clicked = await page.evaluate(() => {
        const name = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('顶级种子箱'));
        if (!name) return 'nobox';
        let row = name;
        for (let d = 0; d < 6 && row; d++, row = row.parentElement) {
            const leaves = [...row.querySelectorAll('*')].filter(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '使用');
            if (leaves.length && (row.textContent || '').includes('顶级种子箱')) {
                const el = leaves[0];
                for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                }
                return 'ok';
            }
        }
        return 'nouse';
    });
    if (clicked !== 'ok') {
        console.log(`[开箱] 点击顶级种子箱「使用」失败(${clicked})`);
        await page.screenshot({ path: 'shanzhai-box-useclick-fail.png' }).catch(() => {});
        return null;
    }
    const start = Date.now();
    while (Date.now() - start < 6000) {
        const t = await getPageText(page);
        if (t.includes('自定义数量')) return 'qty';
        if (t.includes('奖励获取') || t.includes('使用成功')) return 'instant';
        await sleep(300);
    }
    console.log('[开箱] 点使用后未见数量框或奖励弹窗');
    await page.screenshot({ path: 'shanzhai-box-dialog-fail.png' }).catch(() => {});
    return null;
}

async function fillBoxQty(page, m) {
    let fillOk = false;
    const inputs = await page.$$('input');
    for (const inp of inputs) {
        try {
            if (!(await inp.isVisible().catch(() => false))) continue;
            const v = await inp.inputValue().catch(() => '');
            if (v !== '' && !/^\d{1,4}$/.test(v)) continue;
            await inp.fill(String(m)).catch(() => {});
            fillOk = (await inp.inputValue().catch(() => '')) === String(m);
            if (!fillOk) {
                await inp.click({ force: true }).catch(() => {});
                await page.keyboard.press('Control+a');
                await page.keyboard.type(String(m));
                fillOk = (await inp.inputValue().catch(() => '')) === String(m);
            }
            break;
        } catch { /* ignore */ }
    }
    if (!fillOk) {
        console.log(`[开箱] 自定义数量未填成${m}`);
        await page.screenshot({ path: 'shanzhai-box-fill-fail.png' }).catch(() => {});
        return false;
    }
    const useOk = await page.evaluate(() => {
        const marker = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('自定义数量'));
        if (!marker) return 'nomarker';
        let box = marker;
        for (let d = 0; d < 5 && box; d++, box = box.parentElement) {
            const leaves = [...box.querySelectorAll('*')].filter(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '使用');
            if (leaves.length) {
                const el = leaves[leaves.length - 1];
                for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                }
                return 'ok';
            }
        }
        return 'nouse';
    });
    if (useOk !== 'ok') {
        console.log(`[开箱] 点击数量框「使用」失败(${useOk})`);
        await page.screenshot({ path: 'shanzhai-box-confirm-fail.png' }).catch(() => {});
        return false;
    }
    const start = Date.now();
    while (Date.now() - start < 5000) {
        if (!(await getPageText(page)).includes('自定义数量')) return true;
        await sleep(400);
    }
    console.log('[开箱] 确认后数量框未关闭');
    await page.screenshot({ path: 'shanzhai-box-stuck.png' }).catch(() => {});
    await page.keyboard.press('Escape');
    await sleep(800);
    return !(await getPageText(page)).includes('自定义数量');
}

async function openBoxBag(page) {
    if (!(await exitShanzhai(page))) {
        console.log('[开箱] 离开山寨失败');
        await page.screenshot({ path: 'shanzhai-box-exit-fail.png' }).catch(() => {});
        return false;
    }
    let ok = await clickText(page, '包裹', 3000);
    if (!ok) await jsClick(page, '包裹');
    await sleep(1500);
    let t = await getPageText(page);
    if (!t.includes('负重') && !t.includes('详情')) {
        console.log('[开箱] 未打开包裹:', t.substring(0, 100));
        await page.screenshot({ path: 'shanzhai-box-bag-fail.png' }).catch(() => {});
        return false;
    }
    await jsClick(page, '宝箱');
    await sleep(800);
    t = await getPageText(page);
    if (!t.includes('种子箱') && !t.includes('龙泉水') && !t.includes('强化材料')) {
        await clickText(page, '宝箱', 2000);
        await sleep(800);
    }
    let loadedAll = false;
    for (let i = 0; i < 25; i++) {
        t = await getPageText(page);
        if (t.includes('顶级种子箱')) return true;
        if (t.includes('已加载全部数据')) { loadedAll = true; break; }
        await page.mouse.move(400, 500).catch(() => {});
        await page.mouse.wheel(0, 700).catch(() => {});
        await sleep(400);
    }
    console.log(`[开箱] 宝箱里没有顶级种子箱(${loadedAll ? '已滚到底' : '未滚到底'})`);
    await page.screenshot({ path: 'shanzhai-box-missing.png' }).catch(() => {});
    await exitShanzhai(page).catch(() => {});
    return false;
}

async function useTopSeedBoxes(page, n) {
    if (!(await openBoxBag(page))) return false;
    const rowText = await page.evaluate(() => {
        const name = [...document.querySelectorAll('body *')].find(e =>
            e.children.length === 0 && (e.textContent || '').includes('顶级种子箱'));
        if (!name) return '';
        let row = name;
        for (let d = 0; d < 6 && row; d++, row = row.parentElement) {
            if ([...row.querySelectorAll('*')].some(e =>
                e.children.length === 0 && (e.textContent || '').trim() === '使用')) return (row.textContent || '');
        }
        return '';
    });
    const om = rowText.match(/数量[:：]\s*(\d+)/);
    const owned = om ? parseInt(om[1], 10) : null;
    if (owned !== null && owned < n) {
        console.log(`[开箱] 顶级种子箱只有${owned}个(需${n})，先开${owned}个`);
        n = owned;
    }
    if (n <= 0) {
        console.log('[开箱] 顶级种子箱数量为0');
        await page.screenshot({ path: 'shanzhai-box-missing.png' }).catch(() => {});
        await exitShanzhai(page).catch(() => {});
        return false;
    }
    let mode = await clickBoxUse(page);
    if (!mode) {
        await exitShanzhai(page).catch(() => {});
        return false;
    }
    let remain = n;
    if (mode === 'qty') {
        if (!(await fillBoxQty(page, remain))) {
            await exitShanzhai(page).catch(() => {});
            return false;
        }
        remain = 0;
    } else {
        remain = n - 1;
    }
    while (remain > 0) {
        const closed = await closeRewardPopup(page);
        if (closed === false) {
            await exitShanzhai(page).catch(() => {});
            return false;
        }
        if (closed === 'home' && !(await openBoxBag(page))) {
            return false;
        }
        mode = await clickBoxUse(page);
        if (!mode) {
            await exitShanzhai(page).catch(() => {});
            return false;
        }
        if (mode === 'qty') {
            if (!(await fillBoxQty(page, remain))) {
                await exitShanzhai(page).catch(() => {});
                return false;
            }
            remain = 0;
        } else {
            remain--;
        }
    }
    let openedOk = false;
    const oStart = Date.now();
    while (Date.now() - oStart < 4000) {
        if ((await getPageText(page)).includes('奖励获取')) { openedOk = true; break; }
        await sleep(300);
    }
    console.log(`[开箱] 顶级种子箱×${n}已使用${openedOk ? '(奖励弹窗已出现)' : '(未见奖励提示)'}`);
    await sleep(500);
    if (!(await exitShanzhai(page))) {
        console.log('[开箱] 退回首页失败');
        await page.screenshot({ path: 'shanzhai-box-close-fail.png' }).catch(() => {});
        return false;
    }
    if (!(await openShanzhai(page))) {
        console.log('[开箱] 重新打开山寨失败');
        await page.screenshot({ path: 'shanzhai-box-reopen-fail.png' }).catch(() => {});
        return false;
    }
    console.log('[开箱] 已回到山寨农场');
    return true;
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
            console.log('::error::登录失败：未进入游戏主界面，山寨农场已跳过');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        if (!(await openShanzhai(page))) {
            await browser.close();
            return;
        }
        console.log('进入山寨农场');

        const harvest = await doHarvest(page);
        const planted = await plantAll(page);
        if (!(await getPageText(page)).includes('一键收获')) {
            if (!(await openShanzhai(page))) console.log('[浇水] 未能回到山寨农场页');
        }
        const water = await doWater(page);
        const orders = await doOrders(page);

        await page.screenshot({ path: 'shanzhai-done.png' }).catch(() => {});

        if (await exitShanzhai(page)) {
            console.log('已退出山寨回到主页面');
        } else {
            console.log('退出山寨未确认回到主页面');
            await page.screenshot({ path: 'shanzhai-exit-fail.png' }).catch(() => {});
        }

        console.log(`山寨农场完成: 收获[${harvest || '无提示'}] | 播种[${planted ? '全部种满' : '未完成(见error)'}] | 浇水[${water || '无提示'}] | 订单[${orders}]`);

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'shanzhai-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
