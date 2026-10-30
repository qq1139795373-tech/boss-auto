const { chromium } = require('playwright');
// 副本内自恢复（先扫荡/领奖再退本）
const drain = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
const NAV_DEST = '威尼斯';
const NAV_REGION = '地中海';
// 秘宝抽奖限时活动：城内地图→福利院→神秘机器→银贝秘藏有「免费」或今日剩余100/100才开箱
//   →确认弹窗必须带「免费」且不含银贝价格才点确认（防误花银贝）→收下奖励→验证免费消失或剩余次数减少→左上角返回
// 非活动页(无银贝秘藏)与今日免费已用 → 正常跳过不算失败；登录/导航/弹窗/奖励/验证异常 → ::error:: + mibao-*.png（进程仍退出0）

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

// 只拼可见节点。原实现 textContent('body') 不排除 display:none，
// 残留弹窗节点会一直留在 DOM 里 → 读出幽灵文案，把「没成」判成「成了」（2026-10-28 同源问题）。
async function getPageText(page) {
    return await drain.visibleText(page);
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

// 出航到威尼斯（小号会被农场开到杭州；活动NPC只在威尼斯福利院）
// 开出航面板→选区域→点目的地→轮询出航确认；失败关面板整轮重试（最多3轮）
// 卡副本自恢复：身处副本房间先**把副本做完（扫荡/领奖）**，实在没可领的才退本回城。
// 2026-10-27 boss(0) 教训：炼器窟已扫荡、条件已达成、只差领奖，
// 老逻辑读到「副本条件」直接退本，把当天奖励扔了。现在先交给 recoverDungeon 处理。
async function exitDungeonIfInside(page) {
    const t0 = await getPageText(page);
    if (!(t0.includes('副本条件') && t0.includes('回到起点'))) return false;
    log('自恢复：检测到身处副本，先尝试完成副本（扫荡/领奖）...');
    try {
        const r = await drain.recoverDungeon(page, { tag: '自恢复', screenshot: 'mibao-dungeon-recover-fail.png', log });
        if (r.claimed) log(r.swept ? '已扫荡并领取奖励，副本结束' : '已领取奖励，副本结束');
        if (r.exited) { log('已退出副本'); return true; }
        log(`副本内没能完成/退出（${r.kind}，领奖=${r.claimed}），走兜底流程`);
    } catch (e) {
        log(`副本内处理异常: ${e.message}`);
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
            log('已退出副本');
            return true;
        }
        log(`第${i}次退出副本未生效，重试...`);
    }
    const t = await getPageText(page);
    log(`退出副本失败，仍在: ${t.replace(/\s+/g, ' ').substring(0, 200)}`);
    await page.screenshot({ path: 'mibao-dungeon-recover-fail.png' }).catch(() => {});
    return false;
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
            log(`「暂无地图，查看失败」→ 该号没有${region}海域的海图，${dest}到不了，不传送`);
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
                        log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                        SAIL_FAIL = 'nomap';
                        return false;
                    }
                    if (t.includes('出航确认')) {
                        await sleep(800); // 确认框先渲染、toast 后弹：复检一次
                        t = await getPageText(page);
                        if (t.includes('暂无地图')) {
                            log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
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
        log(`未看到出航确认框，重开面板重试(${round}/3)...`);
    }
    return false;
}

// 出航失败时把现场拍下来（此前失败路径无任何页面文本，无从定位）
async function failNav(page, why) {
    const t = await getPageText(page);
    log(`出航中止(${why})，页面文本: ${t.replace(/\s+/g, ' ').substring(0, 300)}`);
    await page.screenshot({ path: 'mibao-nav-fail-detail.png' }).catch(() => {});
    return false;
}

// 起航判定：航行中/剩余距离/停止自动航行 任一出现即算离港（同 fish.js，见注释）
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
    // 已在海上 → 直接等到达；重开出航面板在海上必然失败，会误判成出航失败去传送
    const pre = await getPageText(page);
    const already = pre.includes('停止自动航行') || pre.includes('剩余距离');
    // 已在目标城市：出航列表不列当前城市，硬选必然失败 → 直接算到达（"威尼斯出航老失败→传送"的元凶之一）
    if (!already && pre.includes(`当前城市：${dest}`)) {
        log(`已在${dest}，无需出航`);
        return true;
    }
    if (already) log('已在航行中，跳过出航选择直接等待到达...');
    const picked = already ? true : await pickConfirm(page, region, dest);
    if (!picked) {
        if (SAIL_FAIL === 'nomap') return failNav(page, `目的地${dest}无地图(暂无地图，查看失败)`);
        return failNav(page, '出航确认框始终未出现');
    }

    if (!already) {
        await clickText(page, '立即出发');
        let sailing = await waitSailing(page, 25);
        if (!sailing) {
            log('未见起航，重点「立即出发」再等...');
            await clickText(page, '立即出发');
            sailing = await waitSailing(page, 20);
        }
        if (!sailing) {
            log('仍未起航，重开出航面板选目的地...');
            const again = await pickConfirm(page, region, dest);
            if (again) {
                await clickText(page, '立即出发');
                sailing = await waitSailing(page, 25);
            }
        }
        if (!sailing) return failNav(page, '起航未确认(航行中/剩余距离都没出现)');
    }
    log('航行中...');

    for (let w = 0; w < 80; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (txt.includes(`当前城市：${dest}`)) {
            log(`到达${dest}`);
            return true;
        }
        if (txt.includes('遭遇海盗')) {
            log('遭遇海盗，选择避战...');
            await page.screenshot({ path: 'mibao-sail-pirate.png' }).catch(() => {});
            await clickExact(page, '避战', 3000);
            await sleep(2000);
            const t2 = await getPageText(page);
            if (t2.includes('成功避战')) log('成功避战');
            if (!t2.includes('停止自动航行')) {
                if (await clickExact(page, '自动航行', 3000)) log('恢复自动航行');
            }
            continue;
        }
        if (!txt.includes('停止自动航行') && await clickExact(page, '自动航行', 1500)) {
            log('自动航行(重新)启动');
        }
    }
    log('航行未完成（约5分钟）');
    return false;
}

// 传送兜底：出航失败后重登 → 码头点传送 → 秒到威尼斯
async function teleportToDest(page) {
    // 防白花银币：已到达 / 仍在航行（误判）时绝不传送
    const chk = await getPageText(page);
    if (chk.includes(`当前城市：${NAV_DEST}`)) {
        log(`传送兜底: 其实已在${NAV_DEST}，跳过传送(省银币)`);
        return true;
    }
    if (chk.includes('停止自动航行') || chk.includes('剩余距离')) {
        log('传送兜底: 检测到仍在航行，等它走完，不花银币');
        for (let i = 0; i < 60; i++) {
            await sleep(3000);
            const t = await getPageText(page);
            if (t.includes(`当前城市：${NAV_DEST}`)) { log(`传送兜底: 已到达${NAV_DEST}`); return true; }
            if (t.includes('遭遇海盗')) { await clickExact(page, '避战', 3000); await sleep(2000); }
        }
        return false;
    }
    log('传送兜底: 重新登录游戏...');
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
            log('传送兜底: 会话有效，页面已自动进入游戏');
        }
        await page.mouse.click(10, 10);
        await sleep(500);
        await page.keyboard.press('Escape');
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);

        // 重登可能落回副本房间，先退出再开传送面板
        await exitDungeonIfInside(page);

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
                log(`传送面板未打开(${i + 1}/3)，关闭重试...`);
                await page.mouse.click(10, 10);
                await sleep(300);
                await page.keyboard.press('Escape');
                await sleep(500);
            }
        }
        if (!panelOpen) {
            const pt = await getPageText(page);
            log(`传送兜底: 找不到传送入口，页面文本: ${pt.replace(/\s+/g, ' ').substring(0, 300)}`);
            await page.screenshot({ path: 'mibao-teleport-fail.png' }).catch(() => {});
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
                log(`传送兜底: 已到达${NAV_DEST}`);
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
            log(`传送兜底: 已到达${NAV_DEST}`);
            return true;
        }
        log(`传送兜底: 未检测到到达，页面文本: ${txt.replace(/\s+/g, ' ').substring(0, 300)}`);
        await page.screenshot({ path: 'mibao-teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        log('传送兜底错误:', e.message);
        return false;
    }
}

function log(msg) {
    console.log(`[mibao] ${msg}`);
}

function snippet(t) {
    return t.substring(0, 100).replace(/\s+/g, ' ');
}

// evaluate点击文本叶子（包含匹配），绕过弹窗遮罩（坐标点击会被遮罩吃掉）
async function jsClick(page, text) {
    return await page.evaluate(t => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) &&
                r.width > 0 && r.height > 0;
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, text);
}

async function fail(page, msg, shot) {
    console.log(`ERROR: ${msg}`);
    console.log(`::error::秘宝抽奖：${msg}`);
    await page.screenshot({ path: shot }).catch(() => {});
}

// 银贝秘藏区块解析：位于「银贝秘藏」与「金贝秘藏」之间
function parseSilverBlock(t) {
    const i1 = t.indexOf('银贝秘藏');
    if (i1 < 0) return { present: false };
    let i2 = t.indexOf('金贝秘藏', i1 + 1);
    const i3 = t.indexOf('金元神藏', i1 + 1);
    if (i3 > i1 && (i2 < i1 || i3 < i2)) i2 = i3;
    const block = t.slice(i1, i2 > i1 ? i2 : i1 + 600);
    const m = block.match(/今日剩余[:：]?\s*(\d+)\s*[\/／]\s*(\d+)/);
    return { present: true, free: block.includes('免费'), remain: m ? parseInt(m[1], 10) : null };
}

// 点银贝秘藏的开启箱箱：从按钮向上找「含银贝秘藏且不含金贝/金元」的容器
async function clickSilverOpen(page) {
    return await page.evaluate(() => {
        const vis = el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        const btns = [...document.querySelectorAll('body *')].filter(el =>
            el.children.length === 0 && (el.textContent || '').includes('开启箱子') && vis(el));
        for (const b of btns) {
            let p = b.parentElement;
            while (p && p !== document.body) {
                const t = p.textContent || '';
                if (t.includes('金贝秘藏') || t.includes('金元神藏')) break;
                if (t.includes('银贝秘藏')) {
                    const opts = { bubbles: true, cancelable: true, view: window };
                    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                        b.dispatchEvent(new MouseEvent(type, opts));
                    }
                    return true;
                }
                p = p.parentElement;
            }
        }
        return false;
    });
}

// 确认弹窗：弹窗文本带「免费」且不含「数字+银贝」价格才点确认；否则 guarded（取消，防花银贝）
async function confirmDialog(page) {
    return await page.evaluate(() => {
        const vis = el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        const cands = [...document.querySelectorAll('body *')].filter(el =>
            (el.textContent || '').includes('确认开启') && vis(el));
        cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        for (const c of cands) {
            const leaves = [...c.querySelectorAll('*')].filter(el =>
                el.children.length === 0 && vis(el) &&
                ['开启箱子', '免费开启'].includes((el.textContent || '').trim()));
            if (!leaves.length) continue;
            const dlg = c.textContent || '';
            const hasFree = dlg.includes('免费');
            const hasSilverPrice = /\d+\s*银贝/.test(dlg);
            if (!hasFree || hasSilverPrice) return 'guarded';
            const btn = leaves.find(el => (el.textContent || '').trim() === '开启箱子') || leaves[0];
            const opts = { bubbles: true, cancelable: true, view: window };
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
                btn.dispatchEvent(new MouseEvent(type, opts));
            }
            return 'confirmed';
        }
        return 'none';
    });
}

// 左上角返回箭头（< ‹ 返回），兜底 goBack
async function navBack(page) {
    const ok = await page.evaluate(() => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && ['<', '‹', '返回'].includes(s) &&
                r.width > 0 && r.height > 0;
        });
        const el = leaves.find(e => {
            const r = e.getBoundingClientRect();
            return r.top < 130 && r.left < 130;
        }) || leaves[0];
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    });
    if (!ok) {
        await page.goBack().catch(() => {});
    }
    await sleep(1500);
    return ok;
}

// 秘宝抽奖活动闸门。10-29 公告：「福利院及天魔残魂将在 11 月 1 号下线」，
// 而秘宝抽奖的入口就是 城内地图→福利院→神秘机器→银贝秘藏，福利院没了入口也就没了。
// 因此 11/1 起默认不跑：**不登录、不出航、不花铜贝、不打 ::error::**，直接说明跳过。
// 代码完整保留 —— 这是不定期活动，官方会重新上线，届时不改逻辑只开口子：
//   MIBAO_FORCE=1 强制跑（重开时用）／ MIBAO_FORCE=0 临时压住
//   / 或把下面的 MIBAO_OFFLINE_AT 改成新日期。
const MIBAO_OFFLINE_AT = Date.parse('2026-11-01T00:00:00+08:00');
function mibaoActive() {
    const force = String(process.env.MIBAO_FORCE || '').trim();
    if (force === '1') return true;
    if (force === '0') return false;
    return Date.now() < MIBAO_OFFLINE_AT;
}

async function run() {
    if (!mibaoActive()) {
        log('活动已下线（10-29 公告：福利院 11/1 下线），本次跳过：不登录、不出航、不花铜贝');
        log('代码保留；活动重开时给 MIBAO_FORCE=1 即可恢复，逻辑无需改动');
        return;
    }

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
            await fail(page, '登录失败/未进入游戏主界面', 'mibao-login-fail.png');
            return;
        }
        log('已进入游戏主界面');

        // 卡副本自恢复（dungeon误进/未退出会把号留在房间里，后续全部步骤都会撞死）
        await exitDungeonIfInside(page);
        t = await getPageText(page);

        // 2.5 不在威尼斯先出航（农场会把号开走；活动NPC在威尼斯福利院）
        if (!t.includes(`当前城市：${NAV_DEST}`)) {
            log('不在威尼斯，出航中...');
            const arrived = await sailFlow(page);
            if (!arrived) {
                if (sailFailReason() === 'nomap') {
                    log(`⚠ ${NAV_DEST} 暂无地图（该号没有这张图），跳过抽奖；不传送（传送点城市同样提示暂无地图）`);
                    await fail(page, '暂无地图', 'mibao-nomap.png');
                    return;
                }
                log('出航未完成，走传送兜底...');
                await teleportToDest(page);
            }
            await sleep(2000);
            t = await getPageText(page);
            if (!t.includes(`当前城市：${NAV_DEST}`)) {
                await fail(page, '未到达威尼斯', 'mibao-nav-fail.png');
                return;
            }
            await page.keyboard.press('Escape');
            await sleep(1500);
            t = await getPageText(page);
        } else {
            log(`已在${NAV_DEST}`);
        }

        // 3. 导航：城内地图 → 福利院 → 神秘机器
        if (!(t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子'))) {
            const city = (t.match(/当前城市[:：]\s*(\S+)/) || [])[1] || '?';
            log(`当前城市=${city}`);
            if (!(await clickText(page, '城内地图', 4000))) {
                await fail(page, '主界面未见「城内地图」入口', 'mibao-nav-fail.png');
                return;
            }
            await sleep(2000);
            // 点福利院：jsClick 优先（绕遮罩），clickText 兜底；直到出现福利院场景特征
            let atFuli = false;
            for (let s = 0; s < 3 && !atFuli; s++) {
                const j = await jsClick(page, '福利院');
                log(`第${s + 1}次点福利院(jsClick=${j})`);
                await sleep(2500);
                t = await getPageText(page);
                if (t.includes('神秘机器') || t.includes('福利官')) {
                    atFuli = true;
                    break;
                }
                log(`未见福利院场景，改 clickText 再试: ${snippet(t)}`);
                await clickText(page, '福利院', 3000);
                await sleep(2500);
                t = await getPageText(page);
                if (t.includes('神秘机器') || t.includes('福利官')) atFuli = true;
            }
            if (!atFuli) {
                log(`3次点福利院均未进入场景: ${snippet(t)}`);
                await fail(page, '城内地图点「福利院」未进入福利院场景', 'mibao-nav-fail.png');
                return;
            }
            log('已进入福利院场景');
            // 点神秘机器 → 进抽奖页
            let onLottery = false;
            for (let s = 0; s < 3 && !onLottery; s++) {
                const j = await jsClick(page, '神秘机器');
                log(`第${s + 1}次点神秘机器(jsClick=${j})`);
                await sleep(3000);
                t = await getPageText(page);
                if (t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子')) {
                    onLottery = true;
                    break;
                }
                log(`未进抽奖页，改 clickText 再试: ${snippet(t)}`);
                await clickText(page, '神秘机器', 3000);
                await sleep(3000);
                t = await getPageText(page);
                if (t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子')) onLottery = true;
            }
            if (!onLottery) {
                log(`3次点神秘机器均未进抽奖页: ${snippet(t)}`);
                await fail(page, '福利院点「神秘机器」未进入抽奖页', 'mibao-nav-fail.png');
                return;
            }
            log('已进入抽奖页');
        }

        // 4. 抽奖页判定
        if (!(t.includes('抽奖记录') || t.includes('银贝秘藏') || t.includes('开启箱子'))) {
            await fail(page, '未进入秘宝抽奖页: ' + t.substring(0, 80).replace(/\s+/g, ' '), 'mibao-nav-fail.png');
            return;
        }
        if (!t.includes('银贝秘藏')) {
            await sleep(2500);
            t = await getPageText(page);
        }
        const block = parseSilverBlock(t);
        if (!block.present) {
            log('非活动时间或银贝秘藏未开放，正常跳过');
            await page.screenshot({ path: 'mibao-noact.png' }).catch(() => {});
            return;
        }
        log(`银贝秘藏: 免费=${block.free} 今日剩余=${block.remain === null ? '?' : block.remain}`);
        if (!(block.free || block.remain === 100)) {
            log('今日免费次数已用完，正常跳过');
            await page.screenshot({ path: 'mibao-skip.png' }).catch(() => {});
            return;
        }

        // 5. 点银贝秘藏的开启箱箱
        let opened = await clickSilverOpen(page);
        if (!opened) {
            log('区块内锁不到开启箱箱，退回整页第一个');
            opened = await clickText(page, '开启箱子', 3000);
        }
        if (!opened) {
            await fail(page, '未找到「开启箱子」按钮', 'mibao-nav-fail.png');
            return;
        }
        await sleep(2000);
        t = await getPageText(page);
        if (!t.includes('确认开启')) {
            await fail(page, '点开启箱子后未见确认弹窗', 'mibao-nodialog.png');
            return;
        }

        // 6. 确认弹窗：无免费字样或出现银贝价格 → 取消并报错（绝不花银贝）
        const res = await confirmDialog(page);
        if (res === 'guarded') {
            await clickText(page, '再想想', 1500);
            await page.keyboard.press('Escape');
            await sleep(800);
            await fail(page, '确认弹窗非免费(带价格或无免费字样)，已取消', 'mibao-nofree.png');
            return;
        }
        if (res !== 'confirmed') {
            await page.keyboard.press('Escape');
            await sleep(800);
            await fail(page, '确认弹窗内未找到确认按钮', 'mibao-nofree.png');
            return;
        }
        log('已点确认开启（免费）');

        // 7. 等奖励弹窗 → 收下奖励
        let gotReward = false;
        for (let i = 0; i < 6; i++) {
            await sleep(2000);
            t = await getPageText(page);
            if (t.includes('收下奖励')) {
                gotReward = true;
                break;
            }
        }
        if (!gotReward) {
            await fail(page, '确认后未见奖励弹窗「收下奖励」', 'mibao-reward-fail.png');
            return;
        }
        await clickText(page, '收下奖励', 3000);
        await sleep(2000);
        log('已点收下奖励');

        // 8. 验证：免费消失 或 今日剩余减少
        let verified = false;
        for (let i = 0; i < 3; i++) {
            const b = parseSilverBlock(await getPageText(page));
            if (b.present) {
                const freeGone = block.free && !b.free;
                const remainDown = b.remain !== null && block.remain !== null && b.remain < block.remain;
                if (freeGone || remainDown) {
                    verified = true;
                    log(`抽奖成功: 免费${b.free ? '仍在' : '已消失'} 今日剩余=${b.remain === null ? '?' : b.remain}`);
                    break;
                }
            }
            await sleep(2000);
        }
        if (!verified) {
            await fail(page, '抽完后免费未消失且今日剩余未减少', 'mibao-verify-fail.png');
            return;
        }
        await page.screenshot({ path: 'mibao-done.png' }).catch(() => {});

        // 9. 左上角返回
        const backOk = await navBack(page);
        log(`返回 ${backOk ? '(点返回箭头)' : '(goBack兜底)'}`);
    } catch (e) {
        console.error('ERROR: 秘宝抽奖流程异常:', e.message);
        console.log(`::error::秘宝抽奖异常: ${e.message}`);
        await page.screenshot({ path: 'mibao-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

// tasks.js 以 node mibao.js 独立进程启动(仍执行run)；probe 测试脚本 require 本模块时只取函数不跑流程
if (require.main === module) run();

module.exports = { sleep, getPageText, clickText, clickExact, jsClick, pickConfirm, sailFlow, mibaoActive, MIBAO_OFFLINE_AT, run };
