const { LOGIN_URL } = require('./game-url.js');
const { chromium } = require('playwright');
// 出航复用 daily.js：它已处理任务页残留/已在目标城/区域横滚/暂无地图/海盗/自动航行，
// 自带一套出航实现曾在 2026-10-28 大号上卡死 5 分钟且传送兜底也到不了伦敦。
const daily = require('./daily.js');
// 扫荡/领奖弹窗处理（「扫荡收获」只有一个「知道了」，点完必须验证真的关掉）
const drain = require('./dungeon-recover.js');
// 背包读数/关包裹（与 kidd.js 共用同一套，避免两份实现分叉）
const bagMod = require('./bag-read.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// 炼器窟在北海-伦敦
const NAV_DEST = '伦敦';
const NAV_REGION = '北海';
// DUNGEON_DRY=1 只导航到炼器窑入口页，不真正进入副本（不消耗每日次数）
const DRY = process.env.DUNGEON_DRY === '1';
// DUNGEON_NO_CLAIM=1 打完4线不点领取奖励（留副本内供人工上号查验，挤号后角色仍在副本）
const NO_CLAIM = process.env.DUNGEON_NO_CLAIM === '1';

const MONSTERS = ['猫眼猎手', '翡翠采掘者', '玄铁矿工', '血晶守卫'];
// 4个方向：dir=深入方向, entrance=枢纽处的入口名
const ARMS = [
    { dir: '北', entrance: '幽猫入口', label: '北线' },
    { dir: '西', entrance: '翠晶入口', label: '西线' },
    { dir: '东', entrance: '铁盐岔路', label: '东线' },
    { dir: '南', entrance: '赤晶入口', label: '南线' },
];
// 全清基准：4 方向 × 8 层 × 3 只 = 96（zhsh/副本/炼器窟/炼器窟.txt：
// 「每个方向为 3*8=24 个怪物，一共 4 个方向」；同资料另外强调「每种怪不止 8 只，
// 副本条件只需要每种 8 只，但我需要每个怪物都刷干净」）。
// 只用于「数量对账」诊断与补扫判断，**绝不作为领奖门槛**（2026-11-15：
// 副本限时 60 分钟，领奖是大头，宁可少杀也必须领到）。
const DUNGEON_EXPECT = 96;
// ★ 领奖到账判据（2026-11-25 与基德/附魔秘境/海盗王统一口径）：两条证据分开算。
//   ① 主判据 = 领奖明细 toast 原文里的「炼器窟补给箱×N」，N ≥ 1 即到账
//      （toast 原文形如 `获得经验*10000，铜贝*20000，炼器窟补给箱*1`）；
//   ② 补充 = 进本前读背包基线、领奖后比**增量**（≥ 期望值即到账）。
//   补给箱名来自 11-19 22:58 逐副本点详情页实抓（hdwang-batch.js 的 DUNGEON_REWARDS 表）。
//   经验/铜贝读不到数量（状态页只有经验、无货币），只作明细文本证据，不参与数值对账。
const DUNGEON_REWARDS = { '炼器窟补给箱': 1 };
// 剩余多少分钟才允许回扫补怪（4 线手动清约 6~8 分钟 + 留给领奖）
const RESCAN_MIN_LEFT = 15;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
    // runner到游戏服务器慢时，等load事件会30s超时；domcontentloaded不等全量资源，失败重试
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto(LOGIN_URL, {
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
// 弹窗关掉后节点仍留在 DOM 里 → 会读出「扫荡收获」「是否领取奖励？」这类幽灵文案，
// 导致「弹窗关没关」永远判不出来（daily.js / gongcheng.js 早已改成同一写法）。
async function getPageText(page) {
    return await drain.visibleText(page);
}

// 背包 reader（关包裹兜底用；getPageText 是函数声明，此处已可用）
const bag = bagMod.createBagReader({ getPageText, log: console.log });

// 精确提取副本剩余分钟数（正则从页面原文取，避免控制台乱码误读）
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
    return await daily.sailTo(page, NAV_DEST);
}

// （teleportToDest 已删除：传送花银币且同样依赖旧的面板点击逻辑，sailTo 内部已含「暂无地图」等判断）

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
//（副本条件行在你看到之前，天然排除；不能查祖先文本，因容器以“副本条件”开头会全灭）
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

// 找方向出口按钮（文本以“北：”开头的叶子节点），如返回 null 表示该方向无出口
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
    return txt.includes('铁盐岔路') && txt.includes('翠晶入口') && txt.includes('赤晶入口');
}

// 打一只怪：选怪后反复出刀直到出现结算（一刀可能杀不死，2/3/4刀都有可能），最后关结算
// 安全网：没死的怪由房间循环再选中补杀，房间以“你看到”无怪名为准
//
// 血池为 0（用户 2026-11-15 说明）：面板上「体力：2691/4197 -0 血池：0」时点「攻击」
// 既不结算也不掉怪血，旧代码会白点 12 刀然后记「未见结算」，怪留在房间里清不掉。
// 处理：撤退 → 副本页左下「背包」→「药水」→ 体力宝（优先小体力宝）→ 关背包 → 重新点怪接着打。
// 2026-11-21 与 kidd.js 对齐：补不成药（含背包打不开/没切到药水页这类界面故障）不再放弃这只怪，
// 一律按「没有体力宝」硬打；战死由 reviveOnce 复活一次后立刻去领奖。
let BLOOD_DEAD = false;   // 体力宝用光/补药失败后不再逐只开背包
let BLOOD_HARD = false;   // 硬打模式（本趟不再开背包）
let STOP_WALK = false;    // 复活成功/失败后置位：主线、房间循环都要立刻收手去领奖

// 复活一次（副本内只有 1 次机会）。判据与 kidd.js 完全一致。
async function reviveOnce(page) {
    console.log('  [复活] 点「复活」');
    let ok = await clickLeaf(page, '复活');
    if (!ok) ok = await clickText(page, '复活', 3000);
    if (!ok) return { ok: false, why: 'no-revive-btn' };
    await sleep(2600);
    const t = await getPageText(page);
    if (!t.includes('确认复活')) return { ok: false, why: 'no-dialog' };
    if (!(await clickExact(page, '确定', 3000))) return { ok: false, why: 'no-ok' };
    await sleep(3200);
    const t2 = await getPageText(page);
    if (t2.includes('道具不足')) return { ok: false, why: 'no-item' };
    return { ok: true, why: '' };
}

async function fightOne(page, name) {
    if (!(await clickMonster(page, name))) return false;
    await sleep(300);
    let blades = 0;
    let heals = 0;
    // 上限 18 刀：普通模式一般 3~5 刀就结算，多余刀数不会白点（出结算走「关闭」分支）；
    // 硬打模式血池 0、怪更肉，12 刀可能不够打完（用户 11-21：不能自己拍刀数省时间）。
    for (let a = 0; a < 18; a++) {
        const txt = await getPageText(page);
        if (txt.includes('复活')) {
            // 人被打死了：战斗面板变成「复活」入口，交回上层复活 + 领奖，不空点攻击
            console.log(`  [战斗] ${name}: 人物战死`);
            return 'dead';
        }
        if (txt.includes('关闭')) {
            await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
            await sleep(300);
            console.log(`  [战斗] ${name}: ${blades}刀+结算`);
            return true;
        }
        if (txt.includes('攻击')) {
            // 血池 0 处置：有药→补药再打；补不成（含界面故障）→ 硬打；战死→复活一次后领奖
            if (drain.readBlood(txt) === 0) {
                const act = drain.bloodAction({
                    blood: 0, hardMode: BLOOD_HARD, healedOnce: BLOOD_DEAD || heals >= 1, healReason: '',
                });
                if (act === 'heal') {
                    const h = await drain.healBlood(page, { tag: `补血池·${name}`, inDungeon: true, log: console.log });
                    if (h.ok) {
                        heals++;
                        blades = 0;
                        if (!(await clickMonster(page, name))) { console.log(`  [血池] ${name}: 补药后点不回这只怪`); break; }
                        await sleep(500);
                        continue;
                    }
                    // 补不到 → 按「没有体力宝」硬打（原因只用于日志措辞）
                    BLOOD_HARD = true;
                    BLOOD_DEAD = true;
                    if (drain.bloodItemGone(h.reason)) {
                        console.log(`  [血池] ${name}: 体力宝已用光 → 转硬打模式（继续出刀，战死则复活一次领奖）`);
                    } else {
                        console.log(`::warning::${name} 补药失败（${h.reason}）→ 按「没有体力宝」硬打，不放弃这只`);
                    }
                }
                // act === 'fight'（硬打中）或 'hard'（刚转硬打）→ 往下照常点攻击
            }
            await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
            blades++;
            await sleep(300);
            continue;
        }
        // 无弹窗无结算：可能还在过渡，稍等复看一次
        await sleep(300);
        const t2 = await getPageText(page);
        if (!t2.includes('攻击') && !t2.includes('关闭') && !t2.includes('复活')) break;
    }
    await page.locator('text=关闭').first().click({ force: true, timeout: 300 }).catch(() => {});
    if (blades) console.log(`  [战斗] ${name}: ${blades}刀(未见结算)`);
    await sleep(200);
    return true;
}

// evaluate精确点击页面上的链接文本（绕过遮罩，force click坐标会被遮罩截获）
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

// 打完一条线回枢纽：回到起点→矿洞入口→往北→枢纽广场，带回退验证
async function backToHub(page) {
    for (let i = 0; i < 3; i++) {
        const txt = await getPageText(page);
        if (txt.includes('矿洞入口')) break;
        await clickLeaf(page, '回到起点');
        await sleep(1500);
    }
    if (!(await getPageText(page)).includes('矿洞入口')) {
        console.log('回到起点未到达矿洞入口，当前:', (await getPageText(page)).substring(0, 150));
        await page.screenshot({ path: 'dungeon-backto-start-fail.png' }).catch(() => {});
        return false;
    }
    for (let i = 0; i < 5 && !(await atHub(page)); i++) {
        if (!(await exitLabel(page, '北'))) break;
        await clickExit(page, '北');
        await sleep(1500);
    }
    return await atHub(page);
}

// 清空当前房间的怪，返回击杀数
// ★ 不抛异常（2026-11-21 与 kidd.js 对齐，教训来自 11-16 基德）：旧代码 15 次读不到怪就 `throw`，
//   异常一路冒泡跳过「对账 / 领取奖励」整段 —— 明明已经打了 90+ 只，却把奖励丢掉。
//   领奖是大头（用户 11-15/11-21 两次强调），所以改成：同一只怪连续 3 次打不死 → 本轮跳过它，
//   继续清同房间其它怪；15 次仍清不完 → 告警并带着缺口返回，由上层照常对账 + 领奖。
async function clearRoom(page, tag) {
    let kills = 0;
    let emptyReads = 0;
    const stuckHits = new Map();     // 怪名 → 连续打不死的次数
    const skip = new Set();          // 本轮直接跳过的怪名
    for (let attempt = 0; attempt < 15; attempt++) {
        if (STOP_WALK) return kills;
        const txt = await getPageText(page);
        // 死亡兜底：页面挂着「复活」时读不到「你看到」区块，旧代码会空转 15 次再抛异常。
        // 这里先认出来 → 复活一次 → 停止走图去领奖。
        if (txt.includes('复活')) {
            console.log(`[${tag}] 页面挂着「复活」→ 人物已战死，先复活`);
            const rv = await reviveOnce(page);
            STOP_WALK = true;
            if (rv.ok) console.log('  ✔ 复活成功 → 停止走图，立刻去领奖');
            else console.log(`::error::复活失败（${rv.why}）→ 停止走图；` + (rv.why === 'no-item' ? '本副本已复活过一次，二次死亡领不到奖励' : ''));
            return kills;
        }
        const seg = viewSeg(txt);
        if (!seg) {
            // 包裹浮层没关会整页盖住副本视图（2026-11-20 冷6 实证），先关再重读
            if (bag.bagStillOpen(txt)) {
                console.log(`[${tag}] 页面被包裹浮层盖住 → 先关包裹再读`);
                await bag.closeBag(page);
                continue;
            }
            console.log(`[${tag}] 找不到“你看到”区块，页面:`, txt.substring(0, 120));
            await sleep(1000);
            continue;
        }
        const mobs = monstersIn(seg).filter((m) => !skip.has(m));
        if (!mobs.length) {
            // 「本层真的没怪」和「怪还没渲染出来」必须分开。
            // kidd.js 2026-10-29 实证：基德东线首读 0 只就当空房 → 只记 8 间/24 杀（总 48/51）。
            // 炼器窟每层固定 3 只，正常路径第一读就有怪，所以全清时零额外开销；
            // 只有真的读不到（页面还没渲染）才会在这里多等，最多 5 次 ≈9.5 秒（11-24 用户要求 3→5，11-25 间隔 1.5s→2s）。
            emptyReads++;
            if (emptyReads >= 5) return kills;
            console.log(`[${tag}] 房间没读到怪，等渲染（第${emptyReads}/5次）...`);
            await sleep(2000);
            continue;
        }
        emptyReads = 0;
        const before = seg.split(mobs[0]).length - 1;
        const fr = await fightOne(page, mobs[0]);
        if (fr === 'dead') {
            const rv = await reviveOnce(page);
            STOP_WALK = true;
            if (rv.ok) console.log('  ✔ 复活成功 → 停止走图，立刻去领奖');
            else console.log(`::error::复活失败（${rv.why}）→ 停止走图；` + (rv.why === 'no-item' ? '本副本已复活过一次，二次死亡领不到奖励' : ''));
            return kills;
        }
        const after = viewSeg(await getPageText(page));
        const nowCount = after.split(mobs[0]).length - 1;
        const got = Math.max(0, before - nowCount);
        kills += got;
        if (got === 0) {
            const n = (stuckHits.get(mobs[0]) || 0) + 1;
            stuckHits.set(mobs[0], n);
            if (n >= 3) {
                skip.add(mobs[0]);
                console.log(`::warning::[${tag}] 「${mobs[0]}」连续 ${n} 次打不死 → 本轮跳过它，继续清其它怪`);
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

// 走一条支路：从枢纽沿该方向一路深入（每方向 8 层 × 3 只），走到没有同方向出口为止，再回枢纽。
// 返回 { code, kills, rooms, back }
//   code: 'ok' | 'notHub'(不在枢纽) | 'noTime'(剩余不足5分钟) | 'noExit'(枢纽无该方向出口)
// 抽成函数是为了「数量对账」时能原地把 4 线再跑一遍补怪（2026-11-15）。
async function runArm(page, arm, tagPrefix = '') {
    const tag = `${tagPrefix}${arm.label}`;
    if (!(await atHub(page))) return { code: 'notHub', kills: 0, rooms: 0, back: false };
    const left = await remainMin(page);
    if (left !== null && left < 5) return { code: 'noTime', kills: 0, rooms: 0, back: false, left };
    const started = await exitLabel(page, arm.dir);
    if (!started) return { code: 'noExit', kills: 0, rooms: 0, back: false };
    console.log(`[${tag}] 进入，入口: ${started}`);
    await clickExit(page, arm.dir);
    await sleep(1500);

    let armKills = 0;
    let rooms = 0;
    for (rooms = 0; rooms < 30; rooms++) {
        if (STOP_WALK) break;   // 死亡→复活后不再往下走，交回 run() 去领奖
        const seg = viewSeg(await getPageText(page));
        const present = monstersIn(seg);
        const roomKills = await clearRoom(page, tag);
        armKills += roomKills;
        if (present.length) {
            console.log(`[${tag}] 第${rooms + 1}间: ${present.join('/')} ×${roomKills}`);
        }
        // 炼器窟是「每方向一条直线」，继续沿同一方向深入即可（不需要 visited 回溯）
        const deep = await exitLabel(page, arm.dir);
        if (!deep) {
            console.log(`[${tag}] 到达尽头（${rooms + 1}间，击杀${armKills}）`);
            break;
        }
        await clickExit(page, arm.dir);
        await sleep(1500);
    }
    if (rooms >= 30) console.log(`[${tag}] 房间数达到上限30，强制返回`);

    // 打完回起点再往北走回枢纽广场（比原路走快）
    const back = await backToHub(page);
    if (back) {
        console.log(`[${tag}] 已回到枢纽广场，本线${armKills}杀，剩余${await remainMin(page)}分钟`);
    } else {
        console.log(`[${tag}] 返回枢纽失败`);
        await page.screenshot({ path: `dungeon-back-fail-${tag}.png` }).catch(() => {});
    }
    return { code: 'ok', kills: armKills, rooms: rooms + 1, back };
}

// 扫荡：进入副本后页头「回到起点」左侧若有「扫荡」，一键扫完4线（免手动清怪）。
// 返回 { ok, why, popupStuck }
//   ok=true  → 扫荡成功。**系统保证：扫荡成功 = 4 线怪物全部刷完**（2026-11-15 用户确认），
//              所以不必再校验副本条件，也绝不能因为弹窗关不掉就回头走 4 线（白跑 8 层×4 线）。
//   ok=false → 根本没扫荡成（无入口/点击失败/无结果）→ 走原 4 线手动流程。
async function trySweep(page) {
    // 副本页是异步渲染的：刚进本时「扫荡」链接可能还没出来，先轮询等一会儿（最多约6秒）
    let t0 = await getPageText(page);
    let waited = 0;
    for (let i = 0; i < 4 && !t0.includes('扫荡'); i++) {
        await sleep(1500);
        waited += 1.5;
        t0 = await getPageText(page);
    }
    if (t0.includes('扫荡') && waited > 0) console.log(`等待${waited}秒后扫荡入口出现`);
    if (!t0.includes('扫荡')) {
        // 诊断：无扫荡入口时记录副本条件行+关键按钮，判断是次数/道具限制还是页面没渲染
        const i = t0.indexOf('副本条件');
        const seg = i >= 0 ? t0.slice(i, i + 100).replace(/\s+/g, ' ') : '(页面无副本条件行)';
        console.log(`未见扫荡入口，走手动清怪流程 | ${seg} | 回到起点=${t0.includes('回到起点')} 退出副本=${t0.includes('退出副本')} 领取奖励=${t0.includes('领取奖励')} 文本长=${t0.length}`);
        await page.screenshot({ path: 'dungeon-no-sweep.png' }).catch(() => {});
        return { ok: false, why: 'no-entry' };
    }
    console.log('发现扫荡入口，点击扫荡...');
    let ok = await clickLeaf(page, '扫荡');
    if (!ok) ok = await jsClick(page, '扫荡');
    if (!ok) {
        console.log('扫荡入口点击失败');
        return { ok: false, why: 'click-failed' };
    }
    let txt = '';
    for (let w = 0; w < 8; w++) {
        await sleep(1000);
        txt = await getPageText(page);
        if (txt.includes('扫荡收获') || txt.includes('扫荡成功')) break;
    }
    if (!txt.includes('扫荡收获') && !txt.includes('扫荡成功')) {
        console.log('未出现扫荡结果，页面:', txt.substring(0, 150).replace(/\s+/g, ' '));
        return { ok: false, why: 'no-result' };
    }
    // 走到这里 = 页面出现了「扫荡收获」/「扫荡成功」→ 扫荡已经生效、4 线怪已全清。
    // 「扫荡收获」弹窗只有一个「知道了」（2026-10-28 用户截图确认），它盖在「领取奖励」上面，
    // 点完必须回头验证真的消失了（2026-10-27 boss(0) 就是被它盖住、奖励被下一个步骤扔掉）。
    // 但「关不掉」只是 UI 问题，**不能倒推扫荡失败**，否则会白跑 4 线还可能耗尽时间。
    const closed = await drain.closeSweepPopup(page, { log: console.log });
    if (!closed) {
        console.log('「扫荡收获」弹窗关不掉 → 扫荡本身已成功（怪已全清），领奖前会再关一次，不走刷怪');
        await page.screenshot({ path: 'dungeon-sweep-popup-stuck.png' }).catch(() => {});
        return { ok: true, popupStuck: true };
    }
    console.log('已关闭「扫荡收获」，可以领奖了');
    await sleep(1500);
    console.log('扫荡成功（剩余', await remainMin(page), '分钟），跳过4线清怪');
    return { ok: true, popupStuck: false };
}

// ★ 领奖对账（补充证据，11-19 用户指定口径；11-25 炼器窟补齐）：进本前基线 vs 领奖后，只看**增量**。
//   基线的 0/1/7 都无所谓；一次给 1 个补给箱就算到账，不写死「0→1」。
//   toast 已确认到账时增量没体现只作说明（箱子可能已被开启/使用），绝不推翻 toast 结论。
async function reconcileClaim(page, bagBefore, toastConfirmed) {
    const need = DUNGEON_REWARDS;
    const names = Object.keys(need);
    const after = await bag.readBagItems(page, names);
    const show = (v) => (v === null || v === undefined ? '缺失(0)' : v);
    const num = (v) => (v === null || v === undefined ? 0 : v);
    const delta = {};
    for (const n of names) delta[n] = num(after[n]) - num(bagBefore[n]);
    console.log('[对账] ' + names.map((n) => `${n} ${show(bagBefore[n])}→${show(after[n])}(${delta[n] >= 0 ? '+' : ''}${delta[n]})`).join(' / '));
    const hit = names.filter((n) => delta[n] >= need[n]);
    if (hit.length) {
        console.log('✔ 领奖到账（背包增量）: ' + hit.map((n) => `${n} +${delta[n]}（需 +${need[n]}）`).join('，'));
        return true;
    }
    if (toastConfirmed) {
        console.log('（明细原文已确认到账，背包增量没体现属正常：补给箱可能已被开启/使用）');
        return null;
    }
    console.log('::warning::背包增量不足（' + names.map((n) => `${n} +${delta[n]}`).join('，')
        + '，需 ' + names.map((n) => `${n} +${need[n]}`).join('，') + '）');
    return false;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    let bagBefore = null;          // 领奖对账基线（进本前背包里的补给箱数），null = 没读

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

        // 进游戏统一走 daily.enterMain：强点击（坐标→合成事件→force）+ 判定只认「你看到/当前城市」。
        // 原来这 10 轮都是 clickText('进入游戏')，点了没反应也算点过，卡在选角页时判不出来，
        // 后面所有步骤都对着一个没进游戏的页面操作，整趟白跑还被记成「跑过了」。
        const entered = await daily.enterMain(page, { rounds: 10, pauseMs: 5000 });
        if (entered) console.log('进入游戏成功');
        else console.log('进入游戏失败：10 轮强点击仍未到主界面');

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        let pageText = await getPageText(page);
        if (!entered || pageText.includes('请输入账号密码') || pageText.includes('选择角色')) {
            console.log('ERROR: 未进入游戏主界面，退出');
            console.log('::error::登录失败：未进入游戏主界面，炼器窟已跳过');
            await page.screenshot({ path: 'login-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 上次中断后续打：登录后若已身处副本，跳过出航与进入流程
        // 必须确认是炼器窟（副本条件行含4种炼器窟怪名），否则可能把人困在其他副本里乱打
        const insideDungeon = pageText.includes('副本条件') && pageText.includes('回到起点');
        const inLqk = insideDungeon && MONSTERS.some(m => pageText.includes(m));
        if (insideDungeon && !inLqk) {
            console.log('当前身处其他副本（非炼器窟），跳过不处理，页面:', pageText.substring(0, 120).replace(/\s+/g, ' '));
            await browser.close();
            return;
        }
        const inDungeon = inLqk;
        if (inDungeon) {
            console.log('已在副本内（续打），跳过出航/进入流程');
        } else if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            console.log(`已在${NAV_DEST}`);
        } else {
            console.log(`不在${NAV_DEST}，导航中...`);
            if (!(await sailFlow(page))) {
                console.log('出航未完成，退出');
                await page.screenshot({ path: 'nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
            await sleep(2000);
            pageText = await getPageText(page);
            if (!pageText.includes(`当前城市：${NAV_DEST}`)) {
                console.log(`未到达${NAV_DEST}，退出`);
                await page.screenshot({ path: 'dungeon-nav-fail.png' }).catch(() => {});
                await browser.close();
                return;
            }
        }

        // ★ 领奖对账基线（11-25）：进本前在城里读一次背包，领奖后比**增量**。
        //   续打（登录时已在副本里）读不到基线 → 只说明一行，降级用领奖明细判据，不会误判。
        const rewardNames = Object.keys(DUNGEON_REWARDS);
        if (!inDungeon && !NO_CLAIM && !DRY) {
            bagBefore = await bag.readBagItems(page, rewardNames);
            const show0 = (v) => (v === null || v === undefined ? '缺失(0)' : v);
            console.log('[基线] ' + rewardNames.map((n) => `${n}=${show0(bagBefore[n])}`).join(' / '));
        } else if (inDungeon) {
            console.log('[基线] 续打（已在副本内），读不到背包基线 → 本次只用领奖明细判据');
        }

        if (!inDungeon) {
        // 铁匠铺 → 炼器师 → 炼器窟（说明书里写炼器窑，实际链接是炼器窟）
        console.log('导航到炼器窟入口...');
        let onEntryPage = false;
        for (let i = 0; i < 8; i++) {
            pageText = await getPageText(page);
            if (pageText.includes('进入副本') && pageText.includes('炼器窟')) {
                onEntryPage = true;
                break;
            }
            const seg = viewSeg(pageText);
            if (seg.includes('炼器窟')) {
                await clickExact(page, '炼器窟', 2000);
            } else if (seg.includes('炼器师')) {
                await clickExact(page, '炼器师', 2000);
            } else {
                await jsClick(page, '铁匠铺');
                await sleep(2000);
                await jsClick(page, '城内地图');
                await sleep(2000);
                await jsClick(page, '铁匠铺');
            }
            await sleep(2000);
        }
        pageText = await getPageText(page);
        await page.screenshot({ path: 'dungeon-entry.png' }).catch(() => {});

        if (!onEntryPage && !(pageText.includes('进入副本') && pageText.includes('炼器窟'))) {
            console.log('未到达炼器窑入口页，页面文本:', pageText.substring(0, 300));
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
            console.log('DRY 模式：已到达炼器窑入口页，不进入副本');
            await browser.close();
            return;
        }

        // 进入副本 → 确定。进本是异步的，固定等2.5秒就下结论会在高峰期误报：
        // 实测点击已生效却被判「未进入」，把号留在副本里毁掉后续全部步骤。
        // 改为轮询最多45秒等房间标志（副本条件/回到起点），仍没进再补点，最多3轮
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
            await page.screenshot({ path: 'dungeon-enter-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('已进入副本');
        }

        let totalKills = 0;
        const armResults = [];

        // 扫荡优先：进本后页头（「回到起点」左侧）有「扫荡」就一键完成，免走4线。
        // ★ 判断依据：扫荡成功 = 系统保证 4 线怪已全清 → 直接去领奖，绝不回头刷怪；
        //   只有「没有扫荡入口 / 点击失败 / 没出现扫荡结果」才算失败，才走 4 线手动流程。
        const sw = NO_CLAIM ? { ok: false, why: 'no-claim' } : await trySweep(page);
        const swept = sw.ok;
        if (!swept && !NO_CLAIM) console.log(`扫荡未成功（${sw.why || 'unknown'}）→ 走 4 线手动清怪`);
        if (swept) {
            if (sw.popupStuck) {
                // 扫荡已成功但「扫荡收获」没关掉：领奖前再补关一次，别让它盖住「领取奖励」
                const closed2 = await drain.closeSweepPopup(page, { log: console.log });
                console.log(closed2 ? '补关「扫荡收获」成功，可以直接领奖' : '补关仍失败，领奖可能被弹窗挡住');
            }
            armResults.push('扫荡');
        } else {
        // 回到枢纽广场：不在枢纽就先回到起点，再往北走（矿洞入口→前厅→枢纽广场）
        if (!(await atHub(page)) && !(await backToHub(page))) {
            console.log('未能到达枢纽广场，退出');
            await page.screenshot({ path: 'dungeon-hub-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }
        console.log('到达枢纽广场，剩余', await remainMin(page), '分钟');

        // 四线遍历全程兜住异常（2026-11-21 与 kidd.js 对齐）：任何一线出问题都只告警，
        // 不中断后续对账与领奖。旧代码在 clearRoom 里 throw 会跳过领奖整段。
        try {
            for (const arm of ARMS) {
                if (STOP_WALK) { console.log('人物战死并已复活 → 停止走图，直接去领奖'); break; }
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
            console.log(`::warning::四线遍历异常（${e.message}）→ 不中断，继续对账与领奖`);
            armResults.push(`异常: ${e.message}`);
            await page.screenshot({ path: 'dungeon-arm-error.png' }).catch(() => {});
        }

        // ---- 数量对账（★ 只做诊断与补怪，绝不阻断领奖）----
        // 基线 96 = 4 方向 × 8 层 × 3 只（见文件头 DUNGEON_EXPECT 注释）。
        // 与基德同一原则：时间够就回扫补怪，时间不够就带着缺口直接领奖，只打 ::warning::。
        let totalAll = totalKills;
        if (!swept && !NO_CLAIM && totalAll < DUNGEON_EXPECT) {
            const left = await remainMin(page);
            const gap = DUNGEON_EXPECT - totalAll;
            const canRescan = left === null || left >= RESCAN_MIN_LEFT;
            if (canRescan) {
                console.log(`⚠ 对账 ${totalAll}/${DUNGEON_EXPECT}，差 ${gap} 只 → 回扫一遍补怪（剩余${left}分钟）`);
                let recov = 0;
                try {
                    for (const arm of ARMS) {
                        if (STOP_WALK) break;
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
                    console.log(`回扫补回 ${recov} 只，累计 ${totalKills}/${DUNGEON_EXPECT}`);
                } else {
                    console.log('回扫一圈没补到怪（可能怪确实没刷出来）');
                }
                totalAll = totalKills;
            } else {
                console.log(`⚠ 对账 ${totalAll}/${DUNGEON_EXPECT}，差 ${gap} 只，剩余仅${left}分钟（<${RESCAN_MIN_LEFT}）→ 不回扫，直接领奖`);
            }
        }
        if (swept) console.log('已扫荡，跳过数量对账');
        else if (totalAll >= DUNGEON_EXPECT) console.log(`✔ 对账 ${totalAll}/${DUNGEON_EXPECT} 全清`);
        else console.log(`::warning::炼器窟对账 ${totalAll}/${DUNGEON_EXPECT}，缺 ${DUNGEON_EXPECT - totalAll} 只（不阻断，照常领奖）`);

        console.log('各线结果:', armResults.join(' | '), '| 总击杀:', totalKills, '| 剩余', await remainMin(page), '分钟');
        }

        // 4 线是否都跑完：按 ARMS 的线名精确计数，不依赖 armResults.length
        // （补扫会往 armResults 追加「补扫: X杀」，用 length===4 会被顶成 false 而拒绝领奖）
        const armOk = ARMS.filter(a => armResults.some(r => r.startsWith(`${a.label}: `) && r.includes('杀/'))).length;
        const allArmsDone = swept || armOk === ARMS.length;

        // 领取奖励（只在4线全部走完后）
        pageText = await getPageText(page);
        let toastConfirmed = false;   // 领奖明细里已看到本副本奖励项（硬证据）
        let claimToast = '';          // 领奖明细原文（打印 + 解析用）
        if (NO_CLAIM) {
            const ci = pageText.indexOf('副本条件');
            const cj = pageText.indexOf('回到起点', ci);
            console.log('NO_CLAIM 模式：不领奖、不退出，留副本内待人工查验');
            console.log('条件行:', ci >= 0 ? pageText.substring(ci, cj > ci ? cj : ci + 120) : '(未见)');
            await page.screenshot({ path: 'dungeon-no-claim.png' }).catch(() => {});
        } else if (allArmsDone && pageText.includes('领取奖励')) {
            // ★ 领奖明细 toast 只活 1~2 秒，**必须在点「领取奖励」之前就挂轮询**（11-19 实证：
            //   点完 sleep(1500) 再去读，toast 早没了 → 只能拿「次数已用尽」这种弱证据）。
            const toastP = drain.readRewardToast(page, 9000).catch(() => '');
            // 领奖要循环：可能还有「扫荡收获」压在下面，一层层关，直到「领取奖励」消失
            // 或已经离开副本页。只点一次「确定」在弹窗叠层时会半途而废（boss(0) 实证）。
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
            claimToast = (await toastP) || '';
            if (claimToast) {
                console.log('领奖明细：' + claimToast);
                // ★ 明细原文就是最硬的证据：按「物品名 ×数量」解析，数量 ≥ 期望值即到账。
                const flatToast = claimToast.replace(/\s+/g, '');
                const gotItems = {};
                for (const n of Object.keys(DUNGEON_REWARDS)) {
                    const m = flatToast.match(new RegExp(n + '[×*x](\\d+)'));
                    if (m) gotItems[n] = Number(m[1]);
                }
                const hit = Object.keys(gotItems).filter((n) => gotItems[n] >= DUNGEON_REWARDS[n]);
                if (hit.length) {
                    toastConfirmed = true;
                    console.log('✔ 领奖到账（明细原文）: ' + hit.map((n) => `${n}×${gotItems[n]}（需 ${DUNGEON_REWARDS[n]}）`).join('，'));
                } else if (Object.keys(gotItems).length) {
                    console.log('::warning::明细里数量不足: ' + Object.keys(gotItems).map((n) => `${n}×${gotItems[n]}（需 ${DUNGEON_REWARDS[n]}）`).join('，'));
                } else {
                    console.log('（明细里没有本副本奖励项，可能只结算了经验/铜贝）');
                }
            } else {
                console.log('::warning::没抓到领奖明细 toast（只活 1~2 秒），改用背包增量对账');
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
                await page.screenshot({ path: 'dungeon-claim-fail.png' }).catch(() => {});
            }
        } else if (!allArmsDone) {
            console.log('未完成全部4线，不领奖');
        } else {
            console.log('未看到领取奖励入口，页面:', pageText.substring(0, 300));
            await page.screenshot({ path: 'dungeon-claim-fail.png' }).catch(() => {});
        }

        // ★ 领奖对账（11-25，与附魔秘境/海盗王同一口径）：明细原文 + 背包增量双证据。
        //   增量必须在**回到城市主视图之后**读——包裹按钮只在主视图上有，停在副本入口页/铁匠铺
        //   浮层上读包裹会全返回 null，得出「增量不足」的假结论。
        if (!NO_CLAIM && !DRY && bagBefore && allArmsDone) {
            try {
                if (await drain.backToCityView(page, { txt: getPageText, log: console.log })) {
                    await reconcileClaim(page, bagBefore, toastConfirmed);
                }
            } catch (e) {
                console.log(`::warning::领奖对账异常（${e.message}）→ 不影响领奖结论`);
            }
        }

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'dungeon-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
