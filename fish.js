const { chromium } = require('playwright');
// 副本内自恢复（先扫荡/领奖再退本）
const drain = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 钓鱼：出航到地中海威尼斯，码头鱼老板页读银贝(<5000先去山寨仓库卖榴莲200补钱)→买饵→出航马赛→钓鱼甩竿100次→返航→卖鱼
const NAV_DEST = '威尼斯';
const NAV_REGION = '地中海';

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

// 只拼可见节点。原实现 textContent('body') 不排除 display:none，
// 残留弹窗节点会一直留在 DOM 里 → 读出幽灵文案，把「没成」判成「成了」（2026-10-28 同源问题）。
async function getPageText(page) {
    return await drain.visibleText(page);
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

async function closePopup(page) {
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.keyboard.press('Escape');
    await sleep(1000);
}

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

// evaluate点击文本叶子（精确或包含），绕过遮罩
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

// 开出航面板→选区域→点目的地→轮询出航确认；失败关面板整轮重试（最多3轮）
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

// ===== 出航面板：按网页源码的 class 定位（文本仅作兜底）=====
// 实测结构：.popup-card > .popup-title「出航选择 / 出航确认」
//   城市行 .city-row > .city-name(精确城市名) + .city-cost(海里)
//   区域栏 .region-bar 内 .region-chip（当前项带 .active-region，横向滚动）
//   出发按钮 .btn-confirm「立即出发」
async function popupTitleVisible(page, keyword) {
    return await page.evaluate((k) => {
        for (const c of document.querySelectorAll('.popup-card')) {
            const t = c.querySelector('.popup-title');
            const b = c.getBoundingClientRect();
            if (t && b.width > 0 && (t.textContent || '').includes(k)) return true;
        }
        return false;
    }, keyword).catch(() => false);
}

// 选中海域标签；区域栏是横向滚动，找不到就横滚再找
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
            // 中心点在可视区外：点会打偏，先滚进来
            await page.mouse.move(p.barX, p.barY);
            await page.mouse.wheel(p.scrollLeft === 'right' ? -200 : 200, 0);
            await sleep(800);
            continue;
        }
        await page.mouse.click(p.x, p.y);
        await sleep(1200);
        // 点标签就弹「暂无地图，查看失败」= 该号没这个海域的海图（实测 607ms 出现，区域不切换）
        if (await noMap()) return 'nomap';
        const after = await read();
        if (after && after.active) return true;
    }
    return false;
}

// 点城市行（.city-row 里 .city-name 精确等于目标）；被列表裁掉就滚动
async function selectCity(page, dest) {
    for (let s = 0; s < 7; s++) {
        const pos = await page.evaluate((d) => {
            for (const row of document.querySelectorAll('.city-row')) {
                const n = row.querySelector('.city-name');
                if (!n || (n.textContent || '').trim() !== d) continue;
                const b = row.getBoundingClientRect();
                if (!b.width || !b.height) return null;
                return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
            }
            return null;
        }, dest).catch(() => null);
        if (pos) { await page.mouse.click(pos.x, pos.y); return true; }
        const wrap = await page.evaluate(() => {
            const w = document.querySelector('.city-scroll-wrap');
            if (!w) return null;
            const b = w.getBoundingClientRect();
            return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
        }).catch(() => null);
        if (wrap) { await page.mouse.move(wrap.x, wrap.y); await page.mouse.wheel(0, 240); }
        await sleep(700);
    }
    return false;
}

// 点出航确认框的「立即出发」（.btn-confirm）
async function clickDepartNow(page) {
    const pos = await page.evaluate(() => {
        for (const b of document.querySelectorAll('.btn-confirm')) {
            if (!(b.textContent || '').includes('立即出发')) continue;
            const r = b.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
    }).catch(() => null);
    if (pos) { await page.mouse.click(pos.x, pos.y); return true; }
    return false;
}

async function depart(page) {
    if (!(await clickDepartNow(page))) await clickText(page, '立即出发');
}

// 从出航面板读「出发 XX★码头」= 当前所在城市（面板内部信息，比页面文本可靠）
async function readDepartFrom(page) {
    return await page.evaluate(() => {
        for (const c of document.querySelectorAll('.popup-card')) {
            const t = c.querySelector('.popup-title');
            if (!t || !(t.textContent || '').includes('出航选择')) continue;
            const v = c.querySelector('.info-value');
            if (!v) continue;
            return (v.textContent || '').trim().replace(/[★☆]/g, '').replace(/码头|港口/g, '').trim();
        }
        return null;
    }).catch(() => null);
}

// 关掉出航面板（.close-btn）
async function closeSailPanel(page) {
    const pos = await page.evaluate(() => {
        for (const b of document.querySelectorAll('.close-btn')) {
            const r = b.getBoundingClientRect();
            if (r.width && r.height) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
    }).catch(() => null);
    if (pos) await page.mouse.click(pos.x, pos.y);
    else await page.keyboard.press('Escape');
    await sleep(500);
}

// 无地图提示：没这张图的号点城市只会弹「暂无地图，查看失败」，不会出现出航确认框
let SAIL_FAIL = '';
function sailFailReason() { return SAIL_FAIL; }
async function noMapToast(page) {
    return (await getPageText(page)).includes('暂无地图');
}

async function pickConfirm(page, region, dest) {
    for (let round = 1; round <= 3; round++) {
        // 先关掉可能遮挡点击的弹窗/残留面板（高峰期弹窗会吃掉坐标点击）
        await page.mouse.click(10, 10);
        await sleep(300);
        await page.keyboard.press('Escape');
        await sleep(500);
        if (!(await clickText(page, '出航', 2000))) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            await clickText(page, '出航');
        }
        // 等面板真打开（class 判定），避免面板没开就空点一串
        let opened = false;
        for (let i = 0; i < 8; i++) {
            await sleep(500);
            if (await popupTitleVisible(page, '出航选择')) { opened = true; break; }
        }
        if (!opened) { console.log(`出航面板未打开(${round}/3)，重试...`); continue; }
        // 面板里的「出发 XX★码头」= 当前所在城市；等于目的地就直接收工（列表不列当前城市，硬选必失败）
        const from = await readDepartFrom(page);
        if (from) {
            console.log(`出航面板出发地: ${from}`);
            if (from === dest) {
                console.log(`出发地就是${dest}，已在目标城市，关面板收工`);
                await closeSailPanel(page);
                return true;
            }
        }
        if (region) {
            const rp = await selectRegion(page, region);
            if (rp === 'nomap') {
                console.log(`「暂无地图，查看失败」→ 该号没有${region}海域的海图，${dest}到不了，不传送`);
                SAIL_FAIL = 'nomap';
                await closeSailPanel(page);
                return false;
            }
        }
        if (await selectCity(page, dest)) {
            for (let c = 0; c < 8; c++) {
                await sleep(1000);   // 高峰期确认框慢半拍，最多8秒
                // 「暂无地图」和出航确认框会同时出现（实测），必须先判 nomap
                if (await noMapToast(page)) {
                    console.log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                    SAIL_FAIL = 'nomap';
                    await closeSailPanel(page);
                    return false;
                }
                if (await popupTitleVisible(page, '出航确认')) {
                    await sleep(800); // 确认框先渲染、toast 后弹：复检一次
                    if (await noMapToast(page)) {
                        console.log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                        SAIL_FAIL = 'nomap';
                        await closeSailPanel(page);
                        return false;
                    }
                    return true;
                }
            }
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

// 起航判定：航行中/剩余距离/停止自动航行 任一出现即算离港。
// 只认「停止自动航行」会误判——自动航行按钮要 7 秒以上才渲染，CI 慢时判成出航失败，白花银币走传送。
async function waitSailing(page, sec) {
    for (let i = 0; i < sec; i++) {
        const t = await getPageText(page);
        if (t.includes('航行中') || t.includes('剩余距离') || t.includes('停止自动航行')) return true;
        await sleep(1000);
    }
    return false;
}

async function sailFlow(page, dest = NAV_DEST, region = NAV_REGION) {
    SAIL_FAIL = '';
    // 已在海上（上次起了航但没等到「停止自动航行」）→ 直接等到达；海上没有「出航」按钮，重开面板必然失败
    const pre = await getPageText(page);
    const already = pre.includes('停止自动航行') || pre.includes('剩余距离');
    // 已在目标城市：出航列表不列当前城市，硬选必然失败 → 直接算到达（"威尼斯出航老失败→传送"的元凶之一）
    if (!already && pre.includes(`当前城市：${dest}`)) {
        console.log(`已在${dest}，无需出航`);
        return true;
    }
    if (already) console.log('已在航行中，跳过出航选择直接等待到达...');
    const picked = already ? true : await pickConfirm(page, region, dest);
    if (!picked) {
        if (SAIL_FAIL === 'nomap') return failNav(page, `目的地${dest}无地图(暂无地图，查看失败)`);
        return failNav(page, '出航确认框始终未出现');
    }

    if (!already) {
        await depart(page);
        let sailing = await waitSailing(page, 25);
        if (!sailing) {
            // 确认框可能还在（点到遮罩/面板重渲染），重点一次再等
            console.log('未见起航，重点「立即出发」再等...');
            await depart(page);
            sailing = await waitSailing(page, 20);
        }
        if (!sailing) {
            console.log('仍未起航，重开出航面板选目的地...');
            const again = await pickConfirm(page, region, dest);
            if (again) {
                await depart(page);
                sailing = await waitSailing(page, 25);
            }
        }
        if (!sailing) return failNav(page, '起航未确认(航行中/剩余距离都没出现)');
    }
    console.log('航行中...');

    for (let w = 0; w < 80; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (txt.includes(`当前城市：${dest}`)) {
            console.log(`到达${dest}`);
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
    console.log('航行未完成（约5分钟）');
    return false;
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

async function teleportToDest(page) {
    // 防白花银币：已到达 / 仍在航行（误判）时绝不传送
    const chk = await getPageText(page);
    if (chk.includes(`当前城市：${NAV_DEST}`)) {
        console.log(`传送兜底: 其实已在${NAV_DEST}，跳过传送(省银币)`);
        return true;
    }
    if (chk.includes('停止自动航行') || chk.includes('剩余距离')) {
        console.log('传送兜底: 检测到仍在航行，等它走完，不花银币');
        for (let i = 0; i < 60; i++) {
            await sleep(3000);
            const t = await getPageText(page);
            if (t.includes(`当前城市：${NAV_DEST}`)) { console.log(`传送兜底: 已到达${NAV_DEST}`); return true; }
            if (t.includes('遭遇海盗')) { await clickExact(page, '避战', 3000); await sleep(2000); }
        }
        return false;
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
            console.log('传送兜底: 会话有效，页面已自动进入游戏');
        }
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);

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
        if (txt.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`传送兜底: 已到达${NAV_DEST}`);
            return true;
        }
        console.log('传送兜底: 未检测到到达，页面文本:', txt.replace(/\s+/g, ' ').substring(0, 300));
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        return false;
    }
}

function atDockView(txt) {
    return txt.includes('出航') && txt.includes('鱼老板');
}

// 回到码头视图：返回箭头(goBack) → 兜底刷新重进
async function backToDock(page) {
    for (let i = 0; i < 3; i++) {
        let t = await getPageText(page);
        if (atDockView(t)) return true;
        await page.goBack().catch(() => {});
        await sleep(1500);
        t = await getPageText(page);
        if (atDockView(t)) return true;
        if (t.includes('请输入账号密码')) {
            console.log('goBack退过头了，重新进游戏');
            return false;
        }
        console.log('返回码头: goBack无效，刷新重进...');
        await page.reload().catch(() => {});
        await sleep(4000);
        await page.keyboard.press('Escape');
        await sleep(1500);
    }
    return atDockView(await getPageText(page));
}

// 确保在威尼斯码头视图（你看到里有鱼老板）
async function ensureDock(page) {
    for (let i = 0; i < 6; i++) {
        let t = await getPageText(page);
        if (atDockView(t)) return true;
        if (t.includes(`当前城市：${NAV_DEST}`)) {
            await jsClick(page, '码头');
            await sleep(2000);
            t = await getPageText(page);
            if (atDockView(t)) return true;
            await jsClick(page, '城内地图');
            await sleep(2000);
            await jsClick(page, '码头');
            await sleep(2000);
        } else {
            return false;
        }
    }
    return atDockView(await getPageText(page));
}

// 关闭包裹回游戏视图（左上角返回/历史后退/Escape，逐个尝试）
async function closeBag(page) {
    for (let i = 0; i < 4; i++) {
        const t = await getPageText(page);
        if (t.includes('鱼老板') || t.includes('当前城市：')) return true;
        // 左上角返回键（按class启发式找页头左上的返回元素）
        await page.evaluate(() => {
            const cands = [...document.querySelectorAll('[class*=back],[class*=arrow],[class*=return]')];
            const el = cands.find(e => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.x < 80 && r.y < 140;
            });
            if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }).catch(() => {});
        await sleep(1200);
        let t2 = await getPageText(page);
        if (!(t2.includes('鱼老板') || t2.includes('当前城市：'))) {
            await page.evaluate(() => history.back()).catch(() => {});
            await sleep(1500);
        }
        t2 = await getPageText(page);
        if (!(t2.includes('鱼老板') || t2.includes('当前城市：'))) {
            await page.keyboard.press('Escape');
            await sleep(1000);
        }
    }
    return (await getPageText(page)).includes('鱼老板') ||
        (await getPageText(page)).includes('当前城市：');
}

// 标签行右滑（jsClick点不到“其他”时的兜底）
async function dragTabRow(page) {
    try {
        const box = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('body *')].filter(el => {
                const s = el.textContent || '';
                return s.includes('装备') && s.includes('其他') &&
                    el.children.length >= 6 && el.children.length <= 15;
            });
            if (!rows.length) return null;
            const r = rows[rows.length - 1].getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        if (!box || box.w < 50) return;
        const y = box.y + box.h / 2;
        const x0 = box.x + box.w - 40;
        await page.mouse.move(x0, y);
        await page.mouse.down();
        for (let s = 1; s <= 8; s++) {
            await page.mouse.move(x0 - s * 45, y);
            await sleep(30);
        }
        await page.mouse.up();
        await sleep(600);
    } catch (e) { /* ignore */ }
}

// 其他标签里向下滚到出现“已加载全部数据”（列表懒加载，没到底不能下结论）
async function scrollBagToBottom(page) {
    for (let i = 0; i < 25; i++) {
        const t = await getPageText(page);
        if (t.includes('已加载全部数据')) return true;
        await page.mouse.move(400, 650).catch(() => {});
        await page.mouse.wheel(0, 700).catch(() => {});
        await sleep(450);
    }
    return (await getPageText(page)).includes('已加载全部数据');
}

// 查小鱼活饵库存：包裹→其他标签→必须滚到“已加载全部数据”→读数量。
// 看到鱼饵=记数量（调用方补差额到100）；滚到底没显示=没有(0)→买100；
// 打不开包裹/切不过去/滚不到底=null（调用方按100购买，宁可买也不断钓）
async function getBaitStock(page) {
    try {
        if (!(await clickText(page, '包裹', 3000))) {
            await jsClick(page, '包裹');
        }
        await sleep(1500);
        let t = await getPageText(page);
        if (!t.includes('负重') && !t.includes('详情')) {
            console.log('未打开包裹，页面:', t.substring(0, 122));
            await closeBag(page);
            return null;
        }
        // 切到“其他”标签（必要时右滑标签行），确认切过去（出现地图/鱼饵物品）
        let switched = false;
        for (let i = 0; i < 3 && !switched; i++) {
            if (i === 1) await dragTabRow(page);
            await jsClick(page, '其他');
            await sleep(800);
            t = await getPageText(page);
            switched = /地图|小鱼活饵/.test(t);
        }
        if (!switched) {
            console.log('未切换到“其他”标签，库存判定失败');
            await closeBag(page);
            return null;
        }
        // 必须滚到“已加载全部数据”才下结论（防止鱼饵在下方看不见）
        if (!(await scrollBagToBottom(page))) {
            console.log('其他标签未滚到“已加载全部数据”，库存判定失败');
            await closeBag(page);
            return null;
        }
        t = await getPageText(page);
        const m = t.match(/小鱼活饵[\s\S]{0,160}?数量[：:]\s*(\d+)/);
        const stock = m ? parseInt(m[1], 10) : 0;
        console.log(m ? `滚动中看到鱼饵，库存: ${stock}` : '滚到底未见鱼饵 = 库存0');
        await closeBag(page);
        return stock;
    } catch (e) {
        console.log('库存检查异常:', e.message);
        await closeBag(page).catch(() => {});
        return null;
    }
}

// 打开鱼老板页（点不开多半是包裹/弹层挡着，ESC关掉回码头再试，最多3次）
async function openBoss(page) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
            await page.keyboard.press('Escape');
            await sleep(1000);
            await ensureDock(page);
        }
        // 查包裹的滚动可能把页面停在中间，鱼老板在视口外时force点击会点空：先归位再点
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        const el = page.getByText('鱼老板', { exact: false }).first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(400);
        if (!(await clickText(page, '鱼老板', 3000))) {
            await jsClick(page, '鱼老板');
        }
        // 高峰期服务器响应慢，固定等2秒不够：轮询最多6秒等购买鱼饵出现
        for (let w = 0; w < 6; w++) {
            await sleep(1000);
            if ((await getPageText(page)).includes('购买鱼饵')) return true;
        }
        const t = await getPageText(page);
        console.log(`第${attempt}次未打开鱼老板页:`, t.substring(0, 100));
    }
    console.log('ERROR: 鱼老板页3次未打开');
    console.log('::error::钓鱼：鱼老板页3次未打开');
    await page.screenshot({ path: 'fish-boss-open-fail.png' }).catch(() => {});
    return false;
}

// 买鱼饵，qty=补齐数量。高峰期鱼饵列表渲染慢，按钮/确认框会晚到：
// 多轮轮询找按钮+等确认框，都就绪才下手（实测单发一次点不到就整轮放弃导致钓鱼跳过）
async function buyBait(page, qty = 100) {
    for (let round = 1; round <= 5; round++) {
        if (round > 1) await sleep(2000);
        const ok = await page.evaluate(() => {
            const cands = [...document.querySelectorAll('body *')].filter(el => {
                const r = el.getBoundingClientRect();
                return el.children.length === 0 && el.textContent.trim() === '购买' &&
                    r.width > 0 && r.height > 0;
            });
            if (!cands.length) return false;
            // 锁定“小鱼活饵”的购买按钮：找同时含物品名和银贝金额的最小行（小鱼活饵 50 银贝 购买），
            // 避免点到蚯蚓等其他鱼饵；锁不到就失败，绝不乱点
            let best = null;
            let bestLen = Infinity;
            for (const b of cands) {
                let p = b.parentElement;
                for (let d = 0; d < 6 && p; d++, p = p.parentElement) {
                    const txt = p.textContent || '';
                    if (txt.includes('小鱼活饵') && txt.includes('银贝') && txt.length < bestLen) {
                        best = b;
                        bestLen = txt.length;
                        break;
                    }
                }
            }
            if (!best) return false;
            const opts = { bubbles: true, cancelable: true, view: window };
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                best.dispatchEvent(new MouseEvent(type, opts));
            }
            return true;
        });
        if (!ok) {
            console.log(`第${round}轮未找到小鱼活饵的购买按钮`);
            continue;
        }
        // 点了购买按钮后轮询最多6秒等确认框弹出
        let t = '';
        for (let w = 0; w < 6; w++) {
            await sleep(1000);
            t = await getPageText(page);
            if (t.includes('确认购买')) break;
        }
        if (!t.includes('确认购买')) {
            console.log(`第${round}轮未弹出购买框:`, t.substring(0, 150));
            await page.screenshot({ path: 'fish-buy-dialog-fail.png' }).catch(() => {});
            continue;
        }
        // 填购买数量（页面上唯一的输入框）
        const inputs = await page.$$('input');
        let filled = false;
        for (const inp of inputs) {
            if (await inp.isVisible().catch(() => false)) {
                await inp.fill(String(qty)).catch(() => {});
                filled = true;
            }
        }
        console.log(`购买数量填${qty}:`, filled);
        await clickExact(page, '确认购买');
        await sleep(2000);
        t = await getPageText(page);
        console.log('购买后:', t.includes('确认购买') ? '购买框仍在' : '购买框已关闭');
        return true;
    }
    console.log('多轮重试后仍买不了鱼饵（按钮或确认框未就绪）');
    await page.screenshot({ path: 'fish-buy-fail.png' }).catch(() => {});
    return false;
}

// 读鱼老板页账户银贝（顶部「账户：金贝… 银贝:4801 铜贝:493」；饵料行「50银贝」没冒号不会误匹配）
function parseBossSilver(t) {
    const m = (t || '').match(/银贝[:：]\s*([\d,.]+)/);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
}

// 退出山寨页回主视图（关详情框 → 类名返回箭头(shanzhai.js同款) → 坐标(18,30) → goBack 逐级兜底）
// 「练功房」是山寨页顶标签，切到仓库子标签也不消失，作为在/不在山寨页的信号
async function exitShanzhai(page) {
    for (let i = 0; i < 3; i++) {
        let t = await getPageText(page);
        if (t.includes('物品详情')) {
            await page.keyboard.press('Escape');
            await sleep(800);
            t = await getPageText(page);
        }
        if (!t.includes('练功房')) return !t.includes('请输入账号密码');
        await page.evaluate(() => {
            const c = document.querySelector('.van-nav-bar__arrow, .van-icon-arrow-left, [class*="back"]');
            if (c) c.click();
        }).catch(() => {});
        await sleep(1500);
        t = await getPageText(page);
        if (!t.includes('练功房')) return !t.includes('请输入账号密码');
        await page.mouse.click(18, 30).catch(() => {});
        await sleep(1500);
        t = await getPageText(page);
        if (!t.includes('练功房')) return !t.includes('请输入账号密码');
        await page.goBack().catch(() => {});
        await sleep(2000);
    }
    const t = await getPageText(page);
    return !t.includes('练功房') && !t.includes('请输入账号密码');
}

// 银贝<5000的资金保障（买饵前）：点底部导航「山寨」→子标签「仓库」→上下滚到「榴莲」→
// 点开物品详情→出售数量填200（持有不足200游戏自动修正为实际值）→确认出售→左上角箭头返回。
// 进山寨后任何一步失败都先退出山寨页再返回false，绝不把人留在山寨页里
async function sellDurian(page) {
    let ok = await clickLeaf(page, '山寨');
    if (!ok) ok = await clickText(page, '山寨', 3000);
    if (!ok) {
        await page.mouse.wheel(0, 600);
        await sleep(800);
        ok = await clickLeaf(page, '山寨');
        if (!ok) ok = await clickText(page, '山寨', 2000);
    }
    await sleep(2500);
    let t = await getPageText(page);
    if (!t.includes('练功房') || !t.includes('仓库')) {
        console.log('未进入山寨页:', t.substring(0, 120));
        await page.screenshot({ path: 'fish-shanzhai-fail.png' }).catch(() => {});
        return false;
    }
    // 切「仓库」子标签
    if (!(await clickLeaf(page, '仓库'))) await jsClick(page, '仓库');
    await sleep(1500);
    // 仓库列表可上下滚动，向下滚到出现榴莲（最多25次）
    let hasFruit = false;
    for (let i = 0; i < 25; i++) {
        if ((await getPageText(page)).includes('榴莲')) { hasFruit = true; break; }
        await page.mouse.move(400, 650).catch(() => {});
        await page.mouse.wheel(0, 700).catch(() => {});
        await sleep(450);
    }
    if (!hasFruit) {
        console.log('仓库无榴莲，跳过卖榴莲，直接返回买饵');
        await page.screenshot({ path: 'fish-durian-missing.png' }).catch(() => {});
        await exitShanzhai(page);
        return true;
    }
    // 点榴莲打开物品详情
    if (!(await clickLeaf(page, '榴莲', false))) await clickText(page, '榴莲', 3000);
    await sleep(1500);
    t = await getPageText(page);
    if (!t.includes('物品详情') || !t.includes('确认出售')) {
        console.log('未弹出物品详情框:', t.substring(0, 120));
        await page.screenshot({ path: 'fish-durian-dialog-fail.png' }).catch(() => {});
        await exitShanzhai(page);
        return false;
    }
    console.log('出售数量填200（不校验持有，游戏按实际值卖）');
    // 出售数量填200（页面唯一可见输入框；fill被吞就点框全选重输再读一次）
    const inputs = await page.$$('input');
    const readQty = async () => {
        for (const inp of inputs) {
            if (await inp.isVisible().catch(() => false)) {
                const v = await inp.inputValue().catch(() => '');
                if (v) return v;
            }
        }
        return '';
    };
    for (const inp of inputs) {
        if (await inp.isVisible().catch(() => false)) await inp.fill('200').catch(() => {});
    }
    await sleep(500);
    let qty = await readQty();
    if (qty !== '200') {
        for (const inp of inputs) {
            if (await inp.isVisible().catch(() => false)) {
                await inp.click({ force: true }).catch(() => {});
                await page.keyboard.press('Control+a');
                await page.keyboard.type('200');
                break;
            }
        }
        await sleep(500);
        qty = await readQty();
    }
    // 不管持有剩多少，直接按填入的200确认出售（游戏自动按实际持有修正）
    // 确认出售 → 等详情框关闭
    if (!(await clickExact(page, '确认出售'))) await clickText(page, '确认出售', 3000);
    let closed = false;
    for (let i = 0; i < 8; i++) {
        await sleep(800);
        t = await getPageText(page);
        if (!t.includes('物品详情') || !t.includes('确认出售')) { closed = true; break; }
    }
    if (!closed) {
        console.log('确认出售后详情框未关闭');
        await page.screenshot({ path: 'fish-sell-stuck.png' }).catch(() => {});
        await exitShanzhai(page);
        return false;
    }
    console.log('榴莲出售完成(200或游戏按实际持有修正)');
    await page.screenshot({ path: 'fish-sold-durian.png' }).catch(() => {});
    if (!(await exitShanzhai(page))) {
        console.log('退出山寨页失败');
        await page.screenshot({ path: 'fish-exit-shanzhai-fail.png' }).catch(() => {});
        return false;
    }
    console.log('已退出山寨页');
    return true;
}

// 出航→地中海→马赛→立即出发（不点自动航行），到达“航行中”面板
async function departForFishing(page) {
    if (!(await clickText(page, '出航', 3000))) {
        await jsClick(page, '出航');
    }
    await sleep(2000);
    await clickExact(page, '地中海', 3000);
    await sleep(1000);

    let picked = false;
    for (let s = 0; s < 5; s++) {
        if (await clickText(page, '马赛', 2000)) {
            await sleep(1500);
            const pt = await getPageText(page);
            if (pt.includes('暂无地图')) {
                console.log('「暂无地图，查看失败」→ 该号没有马赛的地图/海图，本次不钓鱼');
                SAIL_FAIL = 'nomap';
                await page.screenshot({ path: 'fish-nomap.png' }).catch(() => {});
                return false;
            }
            if (pt.includes('出航确认')) {
                picked = true;
                break;
            }
        }
        await page.mouse.wheel(0, 300);
        await sleep(1000);
    }
    if (!picked) {
        console.log('未弹出航确认(马赛)');
        await page.screenshot({ path: 'fish-depart-fail.png' }).catch(() => {});
        return false;
    }
    await clickExact(page, '立即出发', 3000);
    await sleep(2000);
    const t = await getPageText(page);
    if (!t.includes('航行中') && !t.includes('剩余距离')) {
        console.log('未进入航行中:', t.substring(0, 150));
        await page.screenshot({ path: 'fish-sailing-fail.png' }).catch(() => {});
        return false;
    }
    console.log('已出发(不点自动航行)');
    return true;
}

// 页面卡死自救：重载页面（会话有效会自动回到游戏），必要时重新登录
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

// 钓鱼面板里反复甩竿，直到“暂无鱼饵”或“每天钓鱼最多100次”
async function castLoop(page) {
    if (!(await clickExact(page, '钓鱼', 3000))) {
        await clickText(page, '钓鱼', 3000);
    }
    await sleep(1500);

    let casts = 0;
    let reason = '';
    let stuck = 0;
    for (let i = 0; i < 140; i++) {
        let t = await getPageText(page);
        if (t.includes('暂无鱼饵')) { reason = '暂无鱼饵'; break; }
        if (t.includes('每天钓鱼最多100次')) { reason = '每日100次上限'; break; }
        if (!t.includes('甩竿')) {
            // 钓鱼面板可能被关掉，重新打开
            if (t.includes('航行中') || t.includes('剩余距离')) {
                await clickExact(page, '钓鱼', 2000);
                await sleep(1000);
                stuck++;
                // 页面渲染异常时点不开面板，会静默空转到循环上限（0竿），强制重载页面自救
                if (stuck >= 5) {
                    console.log(`连续${stuck}次打不开钓鱼面板，重载页面自救...`);
                    await page.screenshot({ path: 'fish-panel-stuck.png' }).catch(() => {});
                    await reloadGame(page);
                    stuck = 0;
                }
                continue;
            }
            console.log('钓鱼面板丢失:', t.substring(0, 120));
            await page.screenshot({ path: 'fish-cast-lost.png' }).catch(() => {});
            break;
        }
        const ok = await clickLeaf(page, '甩竿');
        if (!ok) { await sleep(500); continue; }
        casts++;
        if (casts % 20 === 0) console.log(`甩竿 ${casts} 次`);
        await sleep(700);
    }
    if (!reason) {
        const t = await getPageText(page);
        if (t.includes('暂无鱼饵')) reason = '暂无鱼饵';
        else if (t.includes('每天钓鱼最多100次')) reason = '每日100次上限';
        else reason = '循环结束';
    }
    console.log(`钓鱼结束: ${casts}次, 原因=${reason}`);
    return { casts, reason };
}

// 关钓鱼面板(×) → 航行中面板点返航 → 回威尼斯码头
async function returnToPort(page) {
    let t = await getPageText(page);
    if (t.includes('甩竿') || t.includes('暂无鱼饵') || t.includes('我的鱼饵')) {
        await clickLeaf(page, '×', false);
        await sleep(1500);
    }
    t = await getPageText(page);
    if (!t.includes('返航')) {
        console.log('航行中面板无返航:', t.substring(0, 150));
        await page.screenshot({ path: 'fish-return-fail.png' }).catch(() => {});
        return false;
    }
    await clickExact(page, '返航', 3000);
    await sleep(3000);
    for (let i = 0; i < 10; i++) {
        t = await getPageText(page);
        if (t.includes(`当前城市：${NAV_DEST}`)) {
            console.log('已返航回威尼斯');
            return true;
        }
        if (t.includes('遭遇海盗')) {
            await clickExact(page, '避战', 3000);
        }
        await sleep(2000);
    }
    console.log('返航未检测到威尼斯:', (await getPageText(page)).substring(0, 150));
    await page.screenshot({ path: 'fish-return-timeout.png' }).catch(() => {});
    return false;
}

// 卖鱼：从第一个卖到最后一个，直到出售鱼列表没有卖出按钮。
// 找不到按钮≠卖完：可能是列表刷新慢/页面被弹层挤走——连续3次仍无且页面还在鱼老板页才算卖完；
// 页面漂离鱼老板页则自动重开再卖，避免误判"全部卖完"留下剩鱼
async function sellAll(page) {
    let rounds = 0;
    let miss = 0;
    for (let i = 0; i < 60; i++) {
        const t = await getPageText(page);
        console.log(`[sell#${rounds}] 页面: ${t.substring(0, 90).replace(/\s+/g, ' ')}`);
        if (!t.includes('鱼老板') || t.includes('请输入账号密码')) {
            console.log(`[sell#${rounds}] 页面已不在鱼老板页，重开...`);
            if (!(await openBoss(page))) {
                await page.screenshot({ path: 'sell-stuck.png' }).catch(() => {});
                return false;
            }
            miss = 0;
            continue;
        }
        if (t.includes('快速卖出')) {
            // 详情框开着：点框内最底部的卖出
            await page.getByText('卖出', { exact: true }).last().click({ force: true }).catch(() => {});
            await sleep(1500);
            const t2 = await getPageText(page);
            if (t2.includes('快速卖出')) {
                console.log('卖出详情框未关闭，尝试Escape');
                await page.keyboard.press('Escape');
                await sleep(1000);
            }
            rounds++;
            miss = 0;
            continue;
        }
        const has = await page.evaluate(() => {
            const all = [...document.querySelectorAll('body *')].filter(el => {
                const r = el.getBoundingClientRect();
                return el.children.length === 0 && el.textContent.trim() === '卖出' &&
                    r.width > 0 && r.height > 0;
            });
            if (!all.length) return false;
            const el = all[0];
            const opts = { bubbles: true, cancelable: true, view: window };
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                el.dispatchEvent(new MouseEvent(type, opts));
            }
            return true;
        });
        if (has) {
            miss = 0;
            await sleep(1500);
            rounds++;
            if (rounds % 5 === 0) console.log(`已卖 ${rounds} 轮`);
            continue;
        }
        // 暂无卖出按钮：等列表刷新，连续3次都没有且页面在鱼老板页→真卖完
        miss++;
        if (miss < 3) {
            console.log(`[sell#${rounds}] 暂无卖出按钮(${miss}/3)，等待列表刷新...`);
            await sleep(1500);
            continue;
        }
        if (t.includes('出售鱼')) {
            console.log(`[sell#${rounds}] 3次无卖出按钮，页面仍在鱼老板页 → 判定卖完`);
            break;
        }
        console.log(`[sell#${rounds}] 页面异常：无出售鱼区，停止`);
        console.log('::error::钓鱼：卖鱼页面异常，可能仍有剩鱼');
        await page.screenshot({ path: 'sell-stuck.png' }).catch(() => {});
        break;
    }
    const t = await getPageText(page);
    const atBoss = t.includes('鱼老板') && t.includes('出售鱼');
    const stillHas = t.includes('卖出') && !t.includes('快速卖出');
    console.log(`卖鱼结束: ${rounds}轮, 在鱼老板页=${atBoss}, 列表还有卖出=${stillHas}`);
    return atBoss && !stillHas;
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
            console.log('::error::登录失败：未进入游戏主界面，钓鱼已跳过');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 卡副本自恢复（dungeon误进/未退出会把号留在房间里，后续全部步骤都会撞死）
        await exitDungeonIfInside(page);
        pageText = await getPageText(page);

        // 1. 到威尼斯（失败不直接放弃：重载页面再试一轮，点击无响应多半能救回）
        if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`已在${NAV_DEST}`);
        } else {
            for (let round = 1; round <= 2; round++) {
                console.log(`不在${NAV_DEST}，导航中...(第${round}/2轮)`);
                if (round > 1) {
                    await reloadGame(page);
                    await sleep(4000);
                    await exitDungeonIfInside(page);
                }
                const arrived = await sailFlow(page);
                if (!arrived) {
                    if (sailFailReason() === 'nomap') {
                        console.log(`⚠ ${NAV_DEST} 暂无地图（该号没有这张图），跳过钓鱼；不传送（传送点城市同样提示暂无地图）`);
                        await page.screenshot({ path: 'fish-nomap.png' }).catch(() => {});
                        await browser.close();
                        return;
                    }
                    console.log('出航约5分钟未完成，改用传送兜底...');
                    await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                    await teleportToDest(page);
                }
                await sleep(2000);
                pageText = await getPageText(page);
                if (pageText.includes(`当前城市：${NAV_DEST}`)) break;
            }
            if (!pageText.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`未到达${NAV_DEST}，退出`);
                await page.screenshot({ path: 'fish-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }

        // 2. 码头买饵
        if (!(await ensureDock(page))) {
            console.log('未到威尼斯码头，退出');
            await page.screenshot({ path: 'fish-dock-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('到达威尼斯码头');
        // 先查包裹鱼饵库存：≥100直接出航钓，<100在鱼老板处补到100
        const stock = await getBaitStock(page);
        if (!(await ensureDock(page))) {
            console.log('查库存后未回码头视图，退出');
            await page.screenshot({ path: 'fish-dock-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        if (stock !== null && stock >= 100) {
            console.log(`鱼饵库存${stock}≥100，跳过购买直接出航`);
        } else {
            const qty = stock === null ? 100 : 100 - stock;
            console.log(stock === null ? '库存未知，按100购买' : `库存${stock}，补齐${qty}个`);
            if (!(await openBoss(page))) {
                console.log('ERROR: 打开鱼老板失败，退出');
                console.log('::error::钓鱼：无法打开鱼老板买饵，本次钓鱼已跳过');
                await browser.close();
                return;
            }
            // 银贝保障：鱼老板页直接读银贝，<5000先去山寨仓库卖榴莲200补钱，回来再买饵
            const silver = parseBossSilver(await getPageText(page));
            if (silver !== null && silver < 5000) {
                console.log(`银贝${silver} < 5000，先去山寨卖榴莲补钱`);
                await page.screenshot({ path: 'fish-low-silver.png' }).catch(() => {});
                if (!(await backToDock(page))) {
                    console.log('离开鱼老板页失败，无法去山寨');
                    console.log('::error::钓鱼：银贝不足且无法前往山寨，资金保障失败');
                } else {
                    const soldOk = await sellDurian(page);
                    if (!soldOk) console.log('::error::钓鱼：银贝不足且卖榴莲未完成，买饵可能失败');
                    if (!(await ensureDock(page)) || !(await openBoss(page))) {
                        console.log('卖榴莲后返回鱼老板页失败，退出');
                        console.log('::error::钓鱼：卖榴莲后无法返回鱼老板页');
                        await page.screenshot({ path: 'fish-reopen-fail.png' }).catch(() => {});
                        await browser.close();
                        return;
                    }
                    const s2 = parseBossSilver(await getPageText(page));
                    console.log(`补钱后银贝=${s2 === null ? '未知' : s2}，继续买饵`);
                    if (s2 !== null && s2 < 5000) console.log('::error::钓鱼：补钱后银贝仍<5000，买饵可能失败');
                }
            } else if (silver === null) {
                console.log('鱼老板页未读到银贝，跳过资金检查');
            } else {
                console.log(`银贝${silver} ≥ 5000，资金充足`);
            }
            if (!(await buyBait(page, qty))) {
                console.log('ERROR: 购买鱼饵失败，退出');
                console.log('::error::钓鱼：购买鱼饵失败，本次钓鱼已跳过');
                await browser.close();
                return;
            }
            if (!(await backToDock(page))) {
                console.log('买饵后返回码头失败，退出');
                await page.screenshot({ path: 'fish-back-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
            console.log('买饵完成，回到码头');
        }

        // 3. 出航马赛开钓
        if (!(await departForFishing(page))) {
            await browser.close();
            return;
        }
        const { casts, reason } = await castLoop(page);
        await page.screenshot({ path: 'fish-after-cast.png' }).catch(() => {});
        if (casts === 0) console.log('::error::钓鱼：0竿(钓鱼面板打不开/页面异常)');

        // 4. 返航
        if (!(await returnToPort(page))) {
            await browser.close();
            return;
        }

        // 5. 卖鱼
        if (!(await ensureDock(page))) {
            console.log('返航后未见码头视图，退出');
            await page.screenshot({ path: 'fish-dock2-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        if (!(await openBoss(page))) {
            await browser.close();
            return;
        }
        const sold = await sellAll(page);
        await page.screenshot({ path: 'fish-sold.png' }).catch(() => {});
        await backToDock(page);

        if (!sold) console.log('::error::钓鱼：卖鱼未完成，包裹可能仍有剩鱼');
        console.log(`钓鱼流程完成: 甩竿${casts}次(${reason}) | 卖鱼${sold ? '全部卖完' : '仍有剩余'} | 结束于码头视图=${atDockView(await getPageText(page))}`);

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'fish-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

// tasks.js 以 node fish.js 独立进程启动(仍执行run)；probe 测试脚本 require 本模块时只取函数不跑流程
if (require.main === module) run();

module.exports = {
    sleep, gotoGame, getPageText, clickText, clickLeaf, clickExact, jsClick,
    pickConfirm, sailFlow, sailFailReason, atDockView, backToDock, ensureDock, getBaitStock, openBoss,
    parseBossSilver, exitShanzhai, sellDurian,
};
