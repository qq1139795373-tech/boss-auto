const { chromium } = require('playwright');
// 扫荡/领奖弹窗处理 + 只读可见节点的页面文本
const drain = require('./dungeon-recover.js');
const { visibleText } = drain;

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 基德的宝藏 in 北海-阿姆斯特丹
const NAV_DEST = '阿姆斯特丹';
const NAV_REGION = '北海';
// DUNGEON_DRY=1 只导航到副本入口页，不真正进入副本（不消耗每日次数）
const DRY = process.env.DUNGEON_DRY === '1';
// DUNGEON_NO_CLAIM=1 打完不点领取奖励（留副本内供人工上号查验）
const NO_CLAIM = process.env.DUNGEON_NO_CLAIM === '1';

// 怪物（按图：仆从10500最弱、手下居中、狂兽18500最强）
const MONSTERS = ['基德仆从', '基德手下', '基德狂兽'];
// 入口链路（说明截图）：城内地图→北城门→点「基德的仆从」→点「基德的宝藏」→进入副本（每日剩余1次）
const ENTRY_NPC = '基德的仆从';
const ENTRY_LINK = '基德的宝藏';
const ENTRY_GATE = '北城门';
// 枢纽广场标志：三条支路入口同时在页面上
const HUB_MARKS = ['奴隶仓', '兽栏口', '暗仓口'];
// 从秘藏入口到枢纽的路径（防止走支路时往回拐）
const ENTRY_PATH = ['秘藏入口', '验货棚', '栈桥', '接驳厅', '枢纽广场'];
// 三条支路：西=死路弱怪，北=死路强怪，东=长廊直通宝库
const ARMS = [
    { dir: '西', label: '西线' },
    { dir: '东', label: '东线' },
    { dir: '北', label: '北线' },
];
// 全清基准：17 间 × 3 只 = 51（走廊9 + 西9 + 东27 + 北6，用户地图逐间核对过）。
// 只用于「数量对账」诊断与补扫判断，**绝不作为领奖门槛**（2026-11-15 用户明确要求：
// 副本限时 60 分钟，领奖是大头，宁可少杀也必须领到）。
const KIDD_EXPECT = 51;
// 剩余多少分钟才允许回扫补怪（跑一遍三线约 3~4 分钟 + 留给领奖）
const RESCAN_MIN_LEFT = 8;

// ★ 领奖到账判据（2026-11-19 用户明确：比「增量」，不是比固定数量）
//   基德不掉宝箱，只给藏宝图碎片 15 个（11-19 22:44 领奖 toast 原文：
//   `获得经验*1333332，铜币*50000，藏宝图碎片*15`，与副本详情页「通关奖励」一致）。
//   ① 主判据 = 领奖明细 toast 里 `藏宝图碎片×N`，N ≥ 15 即到账（一次给 15/16/20 都认，
//      **绝不写死「0→1」**）；
//   ② 补充 = 进本前读背包基线、领奖后读一次比增量（≥ 期望值即到账）；
//      但 11-19 23:00 实测：包裹九个页签里都没有「藏宝图碎片」（只有普通/高级藏宝图），
//      碎片不进包裹 → 这条对基德基本用不上，只在别处给同名道具时才有意义。
//   ③ 经验/铜贝读不到数量，只作 toast 文本证据，不参与数值对账。
const KIDD_REWARDS = { '藏宝图碎片': 15 };

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
    return await visibleText(page);
}

async function remainMin(page) {
    const txt = await getPageText(page);
    const m = txt.match(/副本剩余时间[：:]\s*(\d+)\s*分钟/);
    return m ? parseInt(m[1], 10) : null;
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
    await page.mouse.wheel(0, 300);
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
    console.log('航行未完成（约4分钟）');
    return false;
}

async function teleportToDest(page) {
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
            return false;
        }
        await sleep(2000);

        await clickExact(page, NAV_REGION);
        await sleep(1000);

        for (let s = 0; s < 5; s++) {
            if (await clickText(page, NAV_DEST, 2000)) break;
            await page.mouse.wheel(0, 300);
            await sleep(1000);
        }

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
        console.log('传送兜底: 未检测到到达');
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        return false;
    }
}

// “你看到：”到“背包”之间的区块（怪物列表+地图出口都在其中）
function viewSeg(txt) {
    const i = txt.indexOf('你看到：');
    if (i < 0) return '';
    const j = txt.indexOf('背包', i);
    return txt.substring(i, j > i ? j : txt.length);
}

function monstersIn(seg) {
    const found = [];
    for (const m of MONSTERS) {
        if (seg.includes(m)) found.push(m);
    }
    return found;
}

// 点击“你看到：”里的怪物链接：只在“你看到”标签之后的叶子节点里按全等文本匹配
async function clickMonster(page, name) {
    return await page.evaluate((t) => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0;
        });
        const seenIdx = leaves.findIndex(el => (el.textContent || '').includes('你看到'));
        const from = seenIdx >= 0 ? seenIdx + 1 : 0;
        const all = leaves.slice(from).filter(el => (el.textContent || '').trim() === t);
        if (!all.length) return false;
        const el = all.find(e => e.tagName === 'A') || all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, name);
}

// 列出当前房间全部方向出口（如 {dir:'北', target:'狂兽栏'}）
async function allExits(page) {
    return await page.evaluate(() => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                /^[东西南北][：:]/.test(s) && s.length > 2;
        });
        return all.map(el => {
            const s = el.textContent.trim();
            return { dir: s[0], target: s.slice(1).replace(/[：:]/, '').trim() };
        });
    });
}

// 找指定方向出口按钮文本（null=该方向无出口）
async function exitLabel(page, dir) {
    return await page.evaluate((d) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                (s.startsWith(d + '：') || s.startsWith(d + ':')) && s.length > 1;
        });
        if (!all.length) return null;
        return all[0].textContent.trim();
    }, dir);
}

async function clickExit(page, dir) {
    return await page.evaluate((d) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                (s.startsWith(d + '：') || s.startsWith(d + ':')) && s.length > 1;
        });
        if (!all.length) return false;
        const el = all[0];
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, dir);
}

async function atHub(page) {
    const txt = await getPageText(page);
    return HUB_MARKS.every(m => txt.includes(m));
}

// 打一只怪：选怪后反复出刀直到出现结算（一刀可能杀不死），最后关结算
// 血池为 0（用户 2026-11-15）：面板「体力：x/y -0 血池：0」时点攻击无效，会白点 12 刀后
// 记「未见结算」，怪留房间里 → 三线永远少怪。处理：撤退 → 背包 → 药水 → 体力宝（优先小的）→ 接着打。
let BLOOD_DEAD = false;   // 体力宝用光/补药失败后不再反复开背包

async function fightOne(page, name) {
    if (!(await clickMonster(page, name))) return false;
    await sleep(300);
    let blades = 0;
    let heals = 0;
    for (let a = 0; a < 12; a++) {
        const txt = await getPageText(page);
        if (txt.includes('关闭')) {
            await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
            await sleep(300);
            console.log(`  [战斗] ${name}: ${blades}刀+结算`);
            return true;
        }
        if (txt.includes('攻击')) {
            // 血池 0 立刻补药，不许先试几刀（2026-11-15 用户纠正）：有些怪攻击力很高，
            // 等打满 3 刀人已经被砍死、副本判失败。只补 1 个（体力宝覆盖不叠加）。
            if (drain.readBlood(txt) === 0) {
                if (BLOOD_DEAD || heals >= 1) {
                    console.log(`  [血池] ${name}: 血池 0${BLOOD_DEAD ? '（药已用光）' : '（补过 1 个仍为 0）'}，放弃这只`);
                    // 补过 1 个还是 0 → 不是药不够，别再逐只怪开背包吃第二次药
                    BLOOD_DEAD = true;
                    break;
                }
                const h = await drain.healBlood(page, { tag: `补血池·${name}`, inDungeon: true, log: console.log });
                if (!h.ok) {
                    BLOOD_DEAD = true;
                    console.log(`::warning::${name} 血池 0 且补药失败（${h.reason}）→ 本波不再尝试补药`);
                    break;
                }
                heals++;
                blades = 0;
                if (!(await clickMonster(page, name))) { console.log(`  [血池] ${name}: 补药后点不回这只怪`); break; }
                await sleep(500);
                continue;
            }
            await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
            blades++;
            await sleep(300);
            continue;
        }
        await sleep(300);
        const t2 = await getPageText(page);
        if (!t2.includes('攻击') && !t2.includes('关闭')) break;
    }
    await page.locator('text=关闭').first().click({ force: true, timeout: 300 }).catch(() => {});
    if (blades) console.log(`  [战斗] ${name}: ${blades}刀(未见结算)`);
    await sleep(200);
    return true;
}

// evaluate精确点击页面上的链接文本（绕过遮罩）
async function clickLeaf(page, text) {
    return await page.evaluate((t) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 &&
                (s === t || s.includes(t));
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

// ==================== 背包读数（领奖对账用） ====================
// 只在城里可用：首页底部「包裹」→ 页签 → 找物品数量。
// 返回 { 物品名: 数量 }；**读不到就是 null**（数量 0 时背包里没有这一条，null 按 0 算）。
// 2026-11-19 踩过的三个坑都在这里堵掉：
//   ① 点完页签立刻读 → 读到的是上一个页签的内容（0→0 假读数）→ 必须等页面文本真的变了；
//   ② ★ 滚轮发在 page 上根本不滚这个列表（读到的永远是第一屏 748 字）→ 必须找到真正的
//      滚动容器改 scrollTop，容器不吃就鼠标移到容器中央再 wheel；
//   ③ ★ 目标物品在材料页**最下方**（23:07 用户截图：藏宝图碎片 243 / 浴火之蝶 123 都在底部）
//      → 用「网格」视图（一屏 12~16 格）代替列表，滚动次数少一半以上。
const evTo = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate-timeout')), ms));

// 让包裹列表真的滚动。
// ★ 2026-11-19 23:10 冷8 实测（四种方式逐一试过，文本长度 327 字是否变化为判据）：
//   · page.mouse.wheel（body 上 / 容器中央）→ 不动，一直 327 字；
//   · 鼠标按下拖动（down→move→up）→ 不动；
//   · PageDown / End → 不动；
//   · **CDP 触摸滑动（touchStart → touchMove×12 → touchEnd）→ 一次到底**：
//     327 → 457 字，页尾出现「已加载全部数据」，藏宝图碎片 / 浴火之蝶 都读到了。
//   游戏是移动端 H5，列表吃 touch 事件不吃 wheel，所以这里必须走 CDP。
async function scrollBagList(page, cdp) {
    const vp = page.viewportSize() || { width: 1080, height: 608 };
    const x = Math.round(vp.width / 2);
    const yFrom = Math.round(vp.height * 0.82);
    const yTo = Math.round(vp.height * 0.28);
    if (cdp) {
        try {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yFrom }] });
            for (let i = 1; i <= 12; i++) {
                const y = Math.round(yFrom + (yTo - yFrom) * i / 12);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
                await sleep(25);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await sleep(1200);
            return;
        } catch (e) {
            console.log(`触摸滑动失败（${e.message}）→ 退回 wheel`);
        }
    }
    await page.mouse.move(x, yFrom).catch(() => { });
    await page.mouse.wheel(0, 520).catch(() => { });
    await sleep(1000);
}

async function readBagItems(page, names) {
    const out = {};
    for (const n of names) out[n] = null;
    let opened = false;
    const flat = (s) => (s || '').replace(/\s+/g, '');
    const rectOf = (n) => Promise.race([page.evaluate((nm) => {
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length) continue;
            if ((el.textContent || '').trim() !== nm) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
    }, n), evTo(8000)]).catch(() => null);

    try {
        let t = await getPageText(page);
        if (!t.includes('当前城市')) return out;           // 只在城里能开包裹
        let cdp = null;
        try { cdp = await page.context().newCDPSession(page); } catch (e) { console.log('CDP 会话建不起来，滚动只剩 wheel 兜底'); }
        await page.mouse.wheel(0, 600).catch(() => { });
        await sleep(900);
        let bag = await rectOf('包裹');
        if (!bag) { await page.mouse.wheel(0, 420).catch(() => { }); await sleep(1200); bag = await rectOf('包裹'); }   // 底部导航常在视口外
        if (!bag) return out;
        await Promise.race([page.mouse.click(bag.x, bag.y), evTo(8000)]).catch(() => { });
        await sleep(2500);
        t = await getPageText(page);
        if (!t.includes('包裹')) return out;
        opened = true;

        // ① 先切「网格」视图（23:07 用户指引）：一屏 12~16 格，比列表少滚一半以上
        const gridBtn = await rectOf('网格');
        if (gridBtn) { await Promise.race([page.mouse.click(gridBtn.x, gridBtn.y), evTo(8000)]).catch(() => { }); await sleep(1200); }

        const pending = new Set(names);
        // 材料页优先：藏宝图碎片/浴火之蝶都在「材料」页签（23:07 用户截图实证，位置在页尾）
        for (const tab of ['材料', '道具', '宝箱', '其他']) {
            if (!pending.size) break;
            const p = await rectOf(tab);
            if (!p) continue;
            const before = flat(t);
            await Promise.race([page.mouse.click(p.x, p.y), evTo(8000)]).catch(() => { });
            for (let i = 0; i < 12; i++) { await sleep(400); t = await getPageText(page); if (flat(t) !== before) break; }
            for (let screen = 0; screen < 14 && pending.size; screen++) {
                if (screen) await scrollBagList(page, cdp);
                const found = await Promise.race([page.evaluate((nms) => {
                    const res = {};
                    for (const nm of nms) {
                        res[nm] = -1;
                        const hits = [...document.querySelectorAll('body *')].filter((el) => {
                            if (el.children.length) return false;
                            const s = (el.textContent || '').trim();
                            return s.includes(nm) && s.length <= 30 && !/^(材料|道具|宝箱|其他|装备|药水|宝石|附魔卡|宠物)$/.test(s);
                        });
                        for (const h of hits) {
                            let node = h;
                            for (let up = 0; up < 7 && node; up++) {
                                // 列表视图是「数量：243」；网格视图是单独的数字角标 → 两种都认
                                const m = (node.textContent || '').match(/数量\s*[:：]\s*(\d+)/);
                                if (m) { res[nm] = Number(m[1]); break; }
                                const numLeaf = [...node.querySelectorAll('*')].find((e) => !e.children.length && /^\d{1,6}$/.test((e.textContent || '').trim()));
                                if (numLeaf && up >= 1) { res[nm] = Number(numLeaf.textContent.trim()); break; }
                                node = node.parentElement;
                            }
                            if (res[nm] >= 0) break;
                        }
                    }
                    return res;
                }, [...pending]), evTo(8000)]).catch(() => ({}));
                for (const nm of Object.keys(found || {})) {
                    if (found[nm] >= 0 && pending.has(nm)) { out[nm] = found[nm]; pending.delete(nm); }
                }
                // 到底了就提前收工（省时间，也避免在底部空滚）
                if (screen > 0 && /已加载全部数据/.test(await getPageText(page))) break;
            }
        }
    } catch (e) {
        console.log(`背包读数异常（${e.message}）→ 该项按未读到处理`);
    } finally {
        if (opened) {
            try { await drain.closeBagPanel(page, { log: () => { } }); } catch (e) { }
            await sleep(800);
            // 关不掉就 Escape 兜底，绝不让包裹挡着后面的出航/进入副本
            if ((await getPageText(page)).includes('使用')) await page.keyboard.press('Escape').catch(() => { });
            await sleep(600);
        }
    }
    return out;
}

// 打完一条线回枢纽：回到起点→秘藏入口→一路往北→枢纽广场
async function backToHub(page) {
    for (let i = 0; i < 8 && !(await atHub(page)); i++) {
        if (await exitLabel(page, '北')) {
            await clickExit(page, '北');
        } else if ((await getPageText(page)).includes('回到起点')) {
            await clickLeaf(page, '回到起点');
        } else {
            break;
        }
        await sleep(1500);
    }
    return await atHub(page);
}

// 从秘藏入口一路往北到枢纽广场，沿途清掉走廊每一间房的怪。
// 地图（用户确认）：秘藏入口**无怪**、枢纽广场**无怪**；验货棚/栈桥/接驳厅各 3 只基德仆从(10500) = 9 只。
// 之前只走路不清怪，等于白漏这 9 只。首次进本与续打都走这里（无怪的房间自动跳过）。
async function northToHubClearing(page) {
    let kills = 0;
    for (let i = 0; i < 8 && !(await atHub(page)); i++) {
        const seg = viewSeg(await getPageText(page));
        const mobs = monstersIn(seg);
        if (mobs.length) {
            const k = await clearRoom(page, '走廊');
            if (k) {
                kills += k;
                console.log(`[走廊] 清怪 ${k} 只（${mobs.join('/')}）`);
            }
        }
        if (await exitLabel(page, '北')) {
            await clickExit(page, '北');
        } else if ((await getPageText(page)).includes('回到起点')) {
            await clickLeaf(page, '回到起点');
        } else {
            break;
        }
        await sleep(1500);
    }
    // 枢纽广场本身没有怪，到达后再确认一次
    if (await atHub(page)) {
        const seg = viewSeg(await getPageText(page));
        if (monstersIn(seg).length) {
            const k = await clearRoom(page, '枢纽广场');
            if (k) {
                kills += k;
                console.log(`[枢纽广场] 清怪 ${k} 只`);
            }
        }
    }
    return { ok: await atHub(page), kills };
}

// 清空当前房间的怪，返回击杀数
// ★ 不抛异常（2026-11-16 教训）：11-16 00:00 北线兽栏口一只「基德狂兽」连打 15 轮 ×12 刀都读不到结算，
//   旧代码在这里 `throw` → 一路冒泡出 run() → 后面的「对账 / 领取奖励」整段被跳过，
//   36 杀早已满足条件（基德手下:20）却没领奖，剩 58 分钟白白浪费。领奖是大头，绝对不能因为
//   「某一只怪打不死」就把整个副本的奖励丢掉。改为：同一只怪连续打 3 次不死 → 本轮跳过它，
//   继续清同房间其它怪；15 次仍清不完 → 告警并带着缺口返回，由上层照常对账 + 领奖。
async function clearRoom(page, tag) {
    let kills = 0;
    let emptyReads = 0;
    const stuckHits = new Map();     // 怪名 → 连续打不死的次数
    const skip = new Set();          // 本轮直接跳过的怪名
    for (let attempt = 0; attempt < 15; attempt++) {
        const txt = await getPageText(page);
        const seg = viewSeg(txt);
        if (!seg) {
            console.log(`[${tag}] 找不到“你看到”区块，页面:`, txt.substring(0, 120));
            await sleep(1000);
            continue;
        }
        const mobs = monstersIn(seg).filter((m) => !skip.has(m));
        if (!mobs.length) {
            // 「真空房间」和「怪还没渲染出来」必须分开。
            // 2026-10-29 实证：东线「西库尽头」进房后第一次读就是 0 只怪，旧代码 `return kills`
            // 立刻当空房 → 东线只记 8 间 / 24 杀（总 48/51）；同代码 10-28 同一间读到 3 只。
            // 现在连续 3 次都读不到才认定空房（真空房多花约 4.5 秒，可接受）。
            emptyReads++;
            if (emptyReads >= 3) return kills;
            console.log(`[${tag}] 房间没读到怪，等渲染（第${emptyReads}/3次）...`);
            await sleep(1500);
            continue;
        }
        emptyReads = 0;
        const before = seg.split(mobs[0]).length - 1;
        await fightOne(page, mobs[0]);
        const after = viewSeg(await getPageText(page));
        const nowCount = after.split(mobs[0]).length - 1;
        const got = Math.max(0, before - nowCount);
        kills += got;
        if (got === 0) {
            const n = (stuckHits.get(mobs[0]) || 0) + 1;
            stuckHits.set(mobs[0], n);
            if (n >= 3) {
                skip.add(mobs[0]);
                console.log(`::warning::[${tag}] 「${mobs[0]}」连续 ${n} 次打不死（每轮 12 刀无结算）→ 本轮跳过它，继续清其它怪`);
                await page.screenshot({ path: `dungeon-stuck-${tag}.png` }).catch(() => {});
            }
        } else {
            stuckHits.delete(mobs[0]);
        }
    }
    await page.screenshot({ path: `dungeon-room-stuck-${tag}.png` }).catch(() => {});
    console.log(`::warning::[${tag}] 房间 15 次未清完（跳过 ${skip.size ? [...skip].join('/') : '无'}）→ 带回缺口继续，不中断副本`);
    return kills;
}

// 跑一条支路：从枢纽进本线，沿途清怪直到走到尽头（没有未访问的出口），再回枢纽。
// 返回 { code, kills, rooms, back }
//   code: 'ok' | 'notHub'(不在枢纽) | 'noTime'(剩余不足5分钟) | 'noExit'(枢纽无该方向出口)
// 抽成函数是为了「数量对账」时能原地把三线再跑一遍补怪（2026-11-15）。
async function runArm(page, arm, tagPrefix = '') {
    const tag = `${tagPrefix}${arm.label}`;
    if (!(await atHub(page))) return { code: 'notHub', kills: 0, rooms: 0, back: false };
    const left = await remainMin(page);
    if (left !== null && left < 5) return { code: 'noTime', kills: 0, rooms: 0, back: false, left };
    const started = await exitLabel(page, arm.dir);
    if (!started) return { code: 'noExit', kills: 0, rooms: 0, back: false };
    console.log(`[${tag}] 进入，出口: ${started}`);

    // visited 只记已实际走过的房间；入口线5房+本线第一房预置，防止往回拐
    // （首跑教训：第一房没预置导致在囚道选中「东：奴隶仓」走回头路，漏了奴隶仓深处）
    const firstRoom = started.slice(1).replace(/[：:]/, '').trim();
    const visited = new Set([...ENTRY_PATH, firstRoom]);
    await clickExit(page, arm.dir);
    await sleep(1500);

    let armKills = 0;
    let rooms = 0;
    for (rooms = 0; rooms < 30; rooms++) {
        const seg = viewSeg(await getPageText(page));
        const present = monstersIn(seg);
        const roomKills = await clearRoom(page, tag);
        armKills += roomKills;
        if (present.length) {
            console.log(`[${tag}] 第${rooms + 1}间: ${present.join('/')} ×${roomKills}`);
        }
        const exits = await allExits(page);
        const next = exits.find(e => !visited.has(e.target));
        if (!next) {
            console.log(`[${tag}] 到达尽头（${rooms + 1}间，击杀${armKills}）`);
            break;
        }
        visited.add(next.target);
        console.log(`[${tag}] 第${rooms + 1}间 → ${next.dir}：${next.target}`);
        await clickExit(page, next.dir);
        await sleep(1500);
    }
    if (rooms >= 30) console.log(`[${tag}] 房间数达到上限30，强制返回`);

    // 回枢纽：尽头处「回到起点」→秘藏入口→一路往北
    const back = await backToHub(page);
    if (back) {
        console.log(`[${tag}] 已回到枢纽广场，本线${armKills}杀，剩余${await remainMin(page)}分钟`);
    } else {
        console.log(`[${tag}] 返回枢纽失败`);
        await page.screenshot({ path: `kidd-back-fail-${tag}.png` }).catch(() => {});
    }
    return { code: 'ok', kills: armKills, rooms: rooms + 1, back };
}

// 扫荡：进入副本后页头「回到起点」左侧若有「扫荡」，一键扫完（按钮逻辑同炼器窟）
async function trySweep(page) {
    let t0 = await getPageText(page);
    let waited = 0;
    for (let i = 0; i < 4 && !t0.includes('扫荡'); i++) {
        await sleep(1500);
        waited += 1.5;
        t0 = await getPageText(page);
    }
    if (t0.includes('扫荡') && waited > 0) console.log(`等待${waited}秒后扫荡入口出现`);
    if (!t0.includes('扫荡')) {
        const i = t0.indexOf('副本条件');
        const seg = i >= 0 ? t0.slice(i, i + 100).replace(/\s+/g, ' ') : '(页面无副本条件行)';
        console.log(`未见扫荡入口，走手动清怪流程 | ${seg} | 回到起点=${t0.includes('回到起点')} 退出副本=${t0.includes('退出副本')} 领取奖励=${t0.includes('领取奖励')} 文本长=${t0.length}`);
        await page.screenshot({ path: 'kidd-no-sweep.png' }).catch(() => {});
        return false;
    }
    console.log('发现扫荡入口，点击扫荡...');
    let ok = await clickLeaf(page, '扫荡');
    if (!ok) ok = await jsClick(page, '扫荡');
    if (!ok) {
        console.log('扫荡入口点击失败');
        return false;
    }
    let txt = '';
    for (let w = 0; w < 8; w++) {
        await sleep(1000);
        txt = await getPageText(page);
        if (txt.includes('扫荡收获') || txt.includes('扫荡成功')) break;
    }
    if (!txt.includes('扫荡收获') && !txt.includes('扫荡成功')) {
        console.log('未出现扫荡结果，页面:', txt.substring(0, 150).replace(/\s+/g, ' '));
        return false;
    }
    // 「扫荡收获」只有一个「知道了」，点完必须回头验证它真的关了，
    // 否则它盖住「领取奖励」，领奖会废掉（炼器窟 boss(0) 就是这么废的）。
    if (!(await drain.closeSweepPopup(page, { log: console.log }))) {
        console.log('「扫荡收获」弹窗关不掉');
        await page.screenshot({ path: 'kidd-sweep-popup-stuck.png' }).catch(() => {});
        return false;
    }
    console.log('已关闭「扫荡收获」，可以领奖了');
    await sleep(1500);
    console.log('扫荡成功（剩余', await remainMin(page), '分钟），跳过手动清怪');
    return true;
}

async function run() {
    let bagBefore = null;          // 领奖对账基线（进本前背包数量），null = 没读到
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
            console.log('::error::登录失败：未进入游戏主界面，基德宝藏已跳过');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 上次中断后续打：登录后若已身处副本，跳过出航与进入流程
        // 必须确认是基德宝藏（含基德怪名），否则可能把人困在其他副本里乱打
        const insideDungeon = pageText.includes('副本条件') && pageText.includes('回到起点');
        const inKidd = insideDungeon && MONSTERS.some(m => pageText.includes(m));
        if (insideDungeon && !inKidd) {
            console.log('当前身处其他副本（非基德宝藏），跳过不处理，页面:', pageText.substring(0, 120).replace(/\s+/g, ' '));
            await browser.close();
            return;
        }
        const inDungeon = inKidd;
        if (inDungeon) {
            console.log('已在副本内（续打），跳过出航/进入流程');
        } else if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`已在${NAV_DEST}`);
        } else {
            console.log(`不在${NAV_DEST}，导航中...`);
            const arrived = await sailFlow(page);
            if (!arrived) {
                console.log('出航未完成，改用传送兜底...');
                await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                await teleportToDest(page);
            }
            await sleep(2000);
            pageText = await getPageText(page);
            if (!pageText.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`未到达${NAV_DEST}，退出`);
                await page.screenshot({ path: 'kidd-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }

        // ★ 领奖基线（11-19）：进本前在城里读一次背包，领奖后比**增量**。
        //   续打（登录时已在副本里）读不到基线 → 只打印一行说明，降级用 toast 判据，不会误判。
        if (!inDungeon && !NO_CLAIM) {
            bagBefore = await readBagItems(page, Object.keys(KIDD_REWARDS));
            const names0 = Object.keys(KIDD_REWARDS);
            console.log('[基线] ' + names0.map((n) => `${n}=${bagBefore[n] === null ? '缺失(0)' : bagBefore[n]}`).join(' / '));
            if (names0.every((n) => bagBefore[n] === null)) {
                console.log('[基线] 包裹里没有该条目（基德碎片实测不进包裹，属正常）→ 以领奖明细原文为准');
            }
        } else if (inDungeon) {
            console.log('[基线] 续打（已在副本内），读不到背包基线 → 本次只用领奖明细/次数判据');
        }

        if (!inDungeon) {
        // 入口链路：城内地图→北城门→基德的仆从→基德的宝藏（说明截图给定）
        console.log('导航到北城门...');
        let onEntryPage = false;
        for (let i = 0; i < 8; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('进入副本') && pageText.includes(ENTRY_LINK)) {
                onEntryPage = true;
                break;
            }
            if (viewSeg(pageText).includes(ENTRY_NPC)) {
                // 在北城门了，点仆从NPC
                await clickLeaf(page, ENTRY_NPC);
                await sleep(2000);
                // 出现「可进入基德的宝藏」后点链接
                pageText = await getPageText(page);
                if (pageText.includes(ENTRY_LINK)) {
                    await clickExact(page, ENTRY_LINK, 3000) || await clickLeaf(page, ENTRY_LINK);
                    await sleep(2000);
                }
                continue;
            }
            // 不在北城门：城内地图传送过去
            await jsClick(page, '城内地图');
            await sleep(2000);
            await clickLeaf(page, ENTRY_GATE) || await clickExact(page, ENTRY_GATE, 3000);
            await sleep(2500);
        }
        pageText = await getPageText(page);
        await page.screenshot({ path: 'kidd-entry.png' }).catch(() => {});

        if (!onEntryPage && !(pageText.includes('进入副本') && pageText.includes('基德'))) {
            console.log('未到达基德宝藏入口页，页面文本:', pageText.substring(0, 300));
            await browser.close();
            return;
        }

        // 每天自动刷新 1 次机会：入口页「剩余1次」= 今天还能打，「次数为 0」= 已经用掉
        const remain = drain.remainTimes(pageText);
        console.log(`入口页次数：${remain === null ? '未显示剩余次数' : remain}`);
        if (remain === 0) {
            console.log('今日副本次数已用尽');
            await browser.close();
            return;
        }

        if (DRY) {
            console.log('DRY 模式：已到达基德宝藏入口页，不进入副本');
            await browser.close();
            return;
        }

        // 进入副本 → 确定，轮询最多45秒等房间标志，最多3轮
        console.log('进入副本...');
        let entered = false;
        for (let round = 1; round <= 3 && !entered; round++) {
            if (round > 1) console.log(`第${round}轮重新点击进入副本...`);
            await clickText(page, '进入副本', 3000);
            await sleep(1500);
            await clickExact(page, '确定');
            for (let w = 0; w < 15; w++) {
                await sleep(1000);
                pageText = await getPageText(page);
                if (pageText.includes('副本条件') || pageText.includes('回到起点')) {
                    entered = true;
                    break;
                }
            }
        }
        if (!entered) {
            console.log('未进入副本，页面文本:', pageText.substring(0, 300));
            await page.screenshot({ path: 'kidd-enter-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('已进入副本');
        }

        let totalKills = 0;
        let corridorKills = 0;
        const armResults = [];

        // 扫荡优先：进本后页头（「回到起点」左侧）有「扫荡」就一键完成
        const swept = NO_CLAIM ? false : await trySweep(page);
        if (swept) {
            armResults.push('扫荡');
        } else {
        // 回到枢纽广场：不在枢纽就先一路往北（沿途把走廊 3 间的基德仆从清掉）
        if (!(await atHub(page))) {
            const r = await northToHubClearing(page);
            corridorKills = r.kills;
            if (!r.ok) {
                console.log('未能到达枢纽广场，退出');
                await page.screenshot({ path: 'kidd-hub-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }
        if (corridorKills) armResults.push(`走廊: ${corridorKills}杀`);
        console.log('到达枢纽广场，剩余', await remainMin(page), '分钟');

        // 三线遍历全程兜住异常（2026-11-16）：任何一线出问题都只告警，不中断后续对账与领奖。
        try {
            for (const arm of ARMS) {
                const r = await runArm(page, arm);
                if (r.code === 'notHub') {
                    console.log('不在枢纽广场，中止');
                    break;
                }
                if (r.code === 'noTime') {
                    console.log(`剩余${r.left}分钟，不足5分钟，不再开新线`);
                    break;
                }
                if (r.code === 'noExit') {
                    console.log(`[${arm.label}] 枢纽处无${arm.dir}向出口，跳过`);
                    armResults.push(`${arm.label}: 无入口`);
                    continue;
                }
                totalKills += r.kills;
                armResults.push(`${arm.label}: ${r.kills}杀/${r.rooms}间`);
                console.log(`[${arm.label}] 已回到枢纽广场，累计${totalKills}杀，剩余${await remainMin(page)}分钟`);
                if (!r.back) {
                    console.log(`[${arm.label}] 返回枢纽失败，中止`);
                    break;
                }
            }
        } catch (e) {
            console.log(`::warning::三线遍历异常（${e.message}）→ 不中断，继续对账与领奖`);
            armResults.push(`异常: ${e.message}`);
            await page.screenshot({ path: 'kidd-arm-error.png' }).catch(() => {});
        }

        // ---- 数量对账（★ 只做诊断与补怪，绝不阻断领奖）----
        // 用户要求（2026-11-15）：副本限时 60 分钟，领奖是大头，宁可少杀也必须领到。
        // 所以这里的策略是：时间够就回扫一遍补怪；时间不够就带着缺口直接领奖，只打 ::warning::。
        let totalAll = corridorKills + totalKills;
        if (!swept && !NO_CLAIM && totalAll < KIDD_EXPECT) {
            const left = await remainMin(page);
            const gap = KIDD_EXPECT - totalAll;
            const canRescan = left === null || left >= RESCAN_MIN_LEFT;
            if (canRescan) {
                console.log(`⚠ 对账 ${totalAll}/${KIDD_EXPECT}，差 ${gap} 只 → 回扫一遍补怪（剩余${left}分钟）`);
                let recov = 0;
                try {
                    for (const arm of ARMS) {
                        const r = await runArm(page, arm, '补扫·');
                        if (r.code !== 'ok') { console.log(`[补扫] 中止（${r.code}）`); break; }
                        recov += r.kills;
                        if (!r.back) break;
                    }
                } catch (e) {
                    console.log(`::warning::回扫异常（${e.message}）→ 不阻断领奖，带着已有击杀数去领奖`);
                }
                if (recov) {
                    totalKills += recov;
                    armResults.push(`补扫: ${recov}杀`);
                    console.log(`回扫补回 ${recov} 只，累计 ${corridorKills + totalKills}/${KIDD_EXPECT}`);
                } else {
                    console.log('回扫一圈没补到怪（怪可能确实没刷出来）');
                }
                totalAll = corridorKills + totalKills;
            } else {
                console.log(`⚠ 对账 ${totalAll}/${KIDD_EXPECT}，差 ${gap} 只，剩余仅${left}分钟（<${RESCAN_MIN_LEFT}）→ 不回扫，直接领奖`);
            }
        }
        if (swept) console.log('已扫荡，跳过数量对账');
        else if (totalAll >= KIDD_EXPECT) console.log(`✔ 对账 ${totalAll}/${KIDD_EXPECT} 全清`);
        else console.log(`::warning::基德对账 ${totalAll}/${KIDD_EXPECT}，缺 ${KIDD_EXPECT - totalAll} 只（不阻断，照常领奖）`);

        console.log('各线结果:', armResults.join(' | '),
            `| 总击杀: ${corridorKills + totalKills}（走廊${corridorKills} + 三线${totalKills}）`,
            '| 剩余', await remainMin(page), '分钟');
        }

        const armsOk = armResults.filter(r => r.includes('杀/')).length;
        const allArmsDone = swept || (armsOk === 3);

        // 领取奖励（★ 领奖优先：不设「三线全走完」门槛）
        // 2026-11-16 用户追问「领奖优先，就算没有全部杀完也该领奖，为什么没领」——
        // 这里原来写的是 `allArmsDone && 页面有领取奖励`，等于「少杀一条线就不领」，
        // 跟用户的要求正好相反。现在只认一件事：页面上有没有「领取奖励」这个入口。
        // 杀多少只、走完几条线，只作为日志证据，绝不作为领奖条件。
        pageText = await getPageText(page);
        if (!allArmsDone && !NO_CLAIM) console.log(`::warning::三线只完成 ${armsOk}/3 → 按「领奖优先」照常领奖`);
        let toastConfirmed = false;      // 领奖明细里已看到本副本奖励项（硬证据）
        if (NO_CLAIM) {
            const ci = pageText.indexOf('副本条件');
            const cj = pageText.indexOf('回到起点', ci);
            console.log('NO_CLAIM 模式：不领奖、不退出，留副本内待人工查验');
            console.log('条件行:', ci >= 0 ? pageText.substring(ci, cj > ci ? cj : ci + 120) : '(未见)');
            await page.screenshot({ path: 'kidd-no-claim.png' }).catch(() => {});
        } else if (pageText.includes('领取奖励')) {
            // ★ 领奖明细 toast 只活 1~2 秒，**必须在点「领取奖励」之前就挂轮询**（11-19 实证：
            //   点完 sleep(1500) 再去读，toast 早消失了 → 只能拿「次数已用尽」这种弱证据）。
            const toastP = drain.readRewardToast(page, 9000).catch(() => '');
            // 领奖循环：一层层关弹窗，直到「领取奖励」消失或已离开副本页。
            // 只点一次「确定」在弹窗叠层时会半途而废（炼器窟 boss(0) 实证）。
            let got = false;
            for (let round = 1; round <= 4; round++) {
                pageText = await getPageText(page);
                if (!pageText.includes('副本条件')) { got = true; break; }
                if (!pageText.includes('领取奖励')) { got = true; break; }
                console.log(`领取奖励（第 ${round} 轮）...`);
                if (!(await drain.clickByText(page, '领取奖励'))) {
                    console.log('「领取奖励」点不到');
                    break;
                }
                await sleep(1500);
                // 点「确定」的同时抓奖励明细（toast 是点完确定才弹、只活一两秒，见 dungeon-recover.js）
                await drain.dismissPopups(page, { log: console.log });
                await sleep(1500);
            }
            const toast = (await toastP) || '';
            if (toast) {
                console.log('领奖明细：' + toast);
                // ★ 明细原文就是最硬的证据（11-19 22:44 实测原文：
                //   `获得经验*1333332，铜币*50000，藏宝图碎片*15`）——直接按「物品名 ×数量」解析，
                //   数量 ≥ 期望值即到账；一次给 15 / 16 / 20 都认，不写死「0→1」。
                const gotItems = {};
                for (const n of Object.keys(KIDD_REWARDS)) {
                    const m = toast.replace(/\s+/g, '').match(new RegExp(n + '[×*x](\\d+)'));
                    if (m) gotItems[n] = Number(m[1]);
                }
                const hit = Object.keys(gotItems).filter((n) => gotItems[n] >= KIDD_REWARDS[n]);
                if (hit.length) {
                    toastConfirmed = true;
                    console.log('✔ 领奖到账（明细原文）: ' + hit.map((n) => `${n}×${gotItems[n]}（需 ${KIDD_REWARDS[n]}）`).join('，'));
                } else if (Object.keys(gotItems).length) {
                    console.log('::warning::明细里数量不足: ' + Object.keys(gotItems).map((n) => `${n}×${gotItems[n]}（需 ${KIDD_REWARDS[n]}）`).join('，'));
                } else {
                    console.log('（明细里没有本副本奖励项，可能只结算了经验/铜币）');
                }
            }
            pageText = await getPageText(page);
            if (got && !pageText.includes('副本条件')) {
                // 领完退回入口页，再点副本就显示「次数为 0」= 今天这一次确实用掉了
                const ev = drain.claimEvidenceIn(pageText);
                if (ev === 'used') console.log('奖励已领取，已退回副本入口页（次数已显示 0）');
                else if (ev === 'available') console.log('奖励已领取，已退回副本入口页 —— 但次数还在，领奖可能没结算掉');
                else console.log('奖励已领取，已退出副本');
            } else if (!pageText.includes('领取奖励')) {
                console.log('奖励已领取（领取奖励入口已消失），仍在副本页');
            } else {
                console.log('领奖失败：「领取奖励」仍在，页面:', pageText.substring(0, 300).replace(/\s+/g, ' '));
                await page.screenshot({ path: 'kidd-claim-fail.png' }).catch(() => {});
            }
        } else {
            console.log('::warning::未看到领取奖励入口 → 领不到（页面/条件未满足），页面:', pageText.substring(0, 300));
            await page.screenshot({ path: 'kidd-claim-fail.png' }).catch(() => {});
        }

        // ★ 背包差值对账（补充证据，11-19 用户指定）：开打前基线 vs 领奖后，只看**增量**。
        //   基线的 0 / 1 / 7 都无所谓；一次给 15 / 16 / 20 都算到账，**不写死「0→1」**。
        //   ★ 实测（11-19 23:00 冷1 逐页签 dump）：包裹九个页签（装备/药水/道具/宝箱/材料/宝石/
        //     附魔卡/宠物/其他）里**都没有「藏宝图碎片」**，只有「普通藏宝图 10 / 高级藏宝图 2」，
        //     说明碎片不进包裹（大概率直接进藏宝图系统）。所以这条只作补充：
        //     明细原文（toast）已确认到账时直接跳过；读不到也绝不推翻 toast 结论。
        if (bagBefore && !NO_CLAIM && !toastConfirmed) {
            const need = KIDD_REWARDS;
            const names = Object.keys(need);
            const after = await readBagItems(page, names);
            const show = (v) => (v === null || v === undefined ? '缺失(0)' : v);
            const num = (v) => (v === null || v === undefined ? 0 : v);   // 背包里没有该条目 = 数量 0
            const delta = {};
            for (const n of names) delta[n] = num(after[n]) - num(bagBefore[n]);
            console.log('[对账] ' + names.map((n) => `${n} ${show(bagBefore[n])}→${show(after[n])}(${delta[n] >= 0 ? '+' : ''}${delta[n]})`).join(' / '));
            const hit = names.filter((n) => delta[n] >= need[n]);
            if (hit.length) {
                console.log('✔ 领奖到账（背包增量）: ' + hit.map((n) => `${n} +${delta[n]}（需 +${need[n]}）`).join('，'));
            } else if (names.every((n) => delta[n] === 0)) {
                console.log('（背包里读不到「藏宝图碎片」—— 11-19 实测碎片不进包裹，此条对基德不可用，以明细原文为准）');
            } else {
                console.log('::warning::背包增量不足（' + names.map((n) => `${n} +${delta[n]}`).join('，')
                    + '，需 ' + names.map((n) => `${n} +${need[n]}`).join('，') + '）');
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
        // ★ 异常兜底领奖（2026-11-16）：走到这里说明前面某步异常退出了，但人很可能还在副本里、
        // 条件也已经满足（11-16 就是 36 杀 > 基德手下:20 却没领）。领奖是大头 →
        // 异常路径也要尽力领一次，绝不把奖励丢掉。这里只做「页面有入口就点」，不猜任何条件。
        if (!NO_CLAIM) {
            try {
                let t = await getPageText(page);
                if (t.includes('领取奖励')) {
                    console.log('异常兜底：页面仍有「领取奖励」→ 尽力领一次');
                    for (let round = 1; round <= 3; round++) {
                        t = await getPageText(page);
                        if (!t.includes('领取奖励')) break;
                        if (!(await drain.clickByText(page, '领取奖励'))) { console.log('异常兜底：「领取奖励」点不到'); break; }
                        await sleep(1500);
                        await drain.dismissPopups(page, { log: console.log });
                        await sleep(1500);
                    }
                    t = await getPageText(page);
                    console.log(t.includes('领取奖励') ? '::warning::兜底领奖后「领取奖励」仍在' : '异常兜底领奖完成（入口已消失或已退出副本）');
                } else {
                    console.log('异常兜底：页面没有「领取奖励」入口（可能已领过或不在副本页）');
                }
            } catch (e2) {
                console.log('::warning::异常兜底领奖也没走通：' + e2.message);
            }
        }
        await page.screenshot({ path: 'kidd-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
