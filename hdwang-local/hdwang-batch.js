// 海盗王的诅咒 · 按 ACCOUNTS 逐号跑（2026-11-22 起随 0:00 流程入库；tasks.js 每步只传当前这一个号）
//
// 用法：
//   ACCOUNTS="coldwind0" node hdwang-batch.js
//   MAX_SEC=3300   硬兜底秒数（从进程启动算）。海盗王的主判据是**四项条件全满即收工领奖**，
//                  条件没满就一直清；3300 只防异常情况下无限走图。
//                  2026-11-21 用户：「自动任务没有必要省时间，打完副本拿材料才是正道」。
//   CLAIM=0        不领奖（默认领）
//
// 入口：马六甲 · 渔村 · NPC 玛拉玛 ·「海盗王的诅咒」（用户 11-18 截图实证）
// 通关条件（普通）：黄金守卫×3 / 深海巨章×3 / 暗影船长×3 / 黑胡子分身×3
// 开放：每日 00:00-22:50，每天 1 次；需 1~5 人组队（1 人队可进）
//
// 铁律：不点「重置副本」「奖励兑换」「退出副本」。
//   大号可以进 ACCOUNTS：11-22 起 tasks.js 按号逐个 spawn、每 runner 独立会话，
//   实测大号 277s 跑通 12 只（42 间房）。本地手跑时才需要注意别和在线的大号撞会话。
const { chromium } = require('playwright');
const daily = require('../daily.js');
const drain = require('../dungeon-recover.js');
// 背包读数与账号锁：与 kidd.js / bymj-batch.js 共用同一份实现（11-19 统一，别再各写一套）
const { createBagReader, evTo } = require('../bag-read.js');
const acct = require('../acct-lock.js');

const { LOGIN_URL: URL } = require('../game-url.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 页面文本也套硬超时：page.evaluate 不受 setDefaultTimeout 约束，超时会整趟静默挂死（11-19 22:25 实证）
const txt = (page) => Promise.race([daily.getPageText(page), evTo(12000)]);
const flatPage = (s) => (s || '').replace(/\s+/g, '');   // 页签切换判据用（去空白后比内容变化）
// ★ 副本奖励表（11-19 22:58 逐副本点开详情页实抓，用户 22:36 截图核对）。
//   对账只认**本副本**的奖励项：`藏宝图碎片` 几乎每个副本都给（5~15），跨副本一定会串味。
//   经验/铜贝读不到（状态页只有经验、无货币），所以只用可读道具。
const DUNGEON_REWARDS = {
    '炼器窟': { '炼器窟补给箱': 1 },                                  // 无浴火之蝶/碎片，只有专属箱
    '基德的宝藏': { '藏宝图碎片': 15 },                                // 无专属箱
    '附魔秘境': { '卡魂碎片箱': 1, '藏宝图碎片': 5 },
    '奔月秘境': { '奔月副本箱': 1, '浴火之蝶': 1, '藏宝图碎片': 10 },
    '海盗王的诅咒': { '浴火之蝶': 1, '藏宝图碎片': 5 },
    '五行阵': { '藏宝图碎片': 5 },                                     // 以下三个只有碎片，无法自证
    '诸葛副本': { '藏宝图碎片': 5 },
    '巨鲸探险': { '藏宝图碎片': 5 },
};
const MY_DUNGEON = '海盗王的诅咒';
const EXPECT = DUNGEON_REWARDS[MY_DUNGEON];
// 表里没有本副本 → 直接说清楚，别让 Object.keys(undefined) 抛个看不懂的 TypeError
if (!EXPECT) {
    console.log(`::error::DUNGEON_REWARDS 里没有「${MY_DUNGEON}」，现有：${Object.keys(DUNGEON_REWARDS).join(' / ')}`);
    process.exit(1);
}
const REWARDS = Object.keys(EXPECT);
const fmtBag = (v) => (v === null || v === undefined ? '缺失(0)' : v);

const ACCOUNTS = (process.env.ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
// ★ 密码统一走 account-pass（11-22）：去掉内置默认密码——原来缺 GAME_PASSWORD 时会静默用
//   「小号密码」去登，配到大号上就是一次错密码登录，日志还看不出原因。
//   一份 PASSWORD 服务整串 ACCOUNTS，所以混入大号+小号的列表直接报错退出。
const pass = require('../account-pass.js');
const MAX_SEC = Number(process.env.MAX_SEC || 3300);
const CLAIM = process.env.CLAIM !== '0';
const TEAM_NAME = process.env.HD_TEAM || '一起战斗吧！';

if (!ACCOUNTS.length) { console.log('::error::没有 ACCOUNTS'); process.exit(2); }
try { pass.assertSameClass(ACCOUNTS); }
catch (e) { console.log('::error::' + e.message); process.exit(2); }
const PASSWORD = pass.resolveOrExit(ACCOUNTS[0]).password;

// 条件怪（4 项 ×3）。只打这四类，杂兵全跳过 —— 每只怪都要耗血，小号扛不住无谓消耗。
const CONDS = ['黄金守卫', '深海巨章', '暗影船长', '黑胡子分身'];
const NEED = 3;
// ★ 房间里的怪是**纯名叶子**（实测：水手舱里 "海盗精英" @50,171、"海盗巡逻兵" @127,171）；
//   顶部条件栏是「黄金守卫:3」带数量后缀且固定在 y≈67 —— 必须精确匹配纯名，否则会去点条件栏。
const isCond = (t) => CONDS.includes(t);
const condOf = (t) => CONDS.includes(t) ? t : null;
// 从顶部条件栏读"剩余待击杀数"，比自计数可靠
function needLeft(pageText) {
    const o = {};
    for (const c of CONDS) {
        const m = pageText.match(new RegExp(c + '\\s*[:：]\\s*(\\d+)'));
        o[c] = m ? Number(m[1]) : null;
    }
    return o;
}

const OPP = { 东: '西', 西: '东', 南: '北', 北: '南' };
const DXY = { 东: [1, 0], 西: [-1, 0], 南: [0, 1], 北: [0, -1] };

let ACC = '';
let T0 = Date.now();
const el = () => Math.round((Date.now() - T0) / 1000);
const log = (...a) => console.log(`[${ACC}][${el()}s]`, ...a);

// 硬打模式：体力宝真的用光时，不再逐只怪开背包，继续出刀（战死由 clearRoom 复活一次后领奖）
let HARD_FIGHT = false;
let st = { rooms: 0, kills: 0, healFail: 0, reason: '', visited: new Set(), got: {}, boxBefore: null, boxAfter: null };
let stopAll = false;

async function leaves(page) {
    // ★ page.evaluate 不受 setDefaultTimeout 约束，渲染进程一忙就无限等（22:25 卡死 4 分钟）。
    //   这里用 Promise.race 硬超时，让 dfs 的 catch 兜住并转入领奖，而不是整趟静默挂死。
    return Promise.race([page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length) continue;
            const s = (el.textContent || '').trim();
            if (!s || s.length > 40) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            out.push({ t: s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), a: r.width * r.height });
        }
        return out;
    }), evTo(12000)]);
}
async function clickLeaf(page, s, exact = true) {
    const l = (await leaves(page)).filter((x) => (exact ? x.t === s : x.t.includes(s))).sort((a, b) => a.a - b.a)[0];
    if (!l) return false;
    await page.mouse.click(l.x, l.y);
    return true;
}
async function jsClick(page, s, exact = true) {
    return page.evaluate(({ s, exact }) => {
        const hit = Array.from(document.querySelectorAll('body *')).filter((el) => {
            if (el.children.length) return false;
            const t = (el.textContent || '').trim();
            if (exact ? t !== s : !t.includes(s)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }).sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return ra.width * ra.height - rb.width * rb.height;
        })[0];
        if (!hit) return false;
        hit.click();
        return true;
    }, { s, exact });
}
async function clickHard(page, s, exact = true) {
    const before = await txt(page);
    if (await clickLeaf(page, s, exact)) {
        await sleep(2400);
        if ((await txt(page)) !== before) return true;
    }
    const r = await jsClick(page, s, exact);
    if (r) await sleep(2600);
    return r;
}
// 弹窗按钮只认触摸序列（奔月实证：合成鼠标事件返回 true 但弹窗不动）
async function tapOkByTouch(page, word = '确定') {
    return page.evaluate((w) => {
        const cands = [...document.querySelectorAll('body *')].filter((el) => {
            if (el.children.length) return false;
            if ((el.textContent || '').trim() !== w) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        if (!cands.length) return false;
        const t = cands[cands.length - 1];
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const mk = (type) => new TouchEvent(type, {
            bubbles: true, cancelable: true,
            touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: t, clientX: cx, clientY: cy })],
            targetTouches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: t, clientX: cx, clientY: cy })],
            changedTouches: [new Touch({ identifier: 1, target: t, clientX: cx, clientY: cy })],
        });
        for (const type of ['touchstart', 'touchend']) { try { t.dispatchEvent(mk(type)); } catch (e) { } }
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(type, opts));
        return true;
    }, word).catch(() => false);
}

async function login(page) {
    for (let a = 1; a <= 10; a++) {
        const ins = await page.$$('input');
        if (ins.length < 2) {
            const t = await txt(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) return true;
            await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
            await sleep(3000); continue;
        }
        await ins[0].fill(ACC); await ins[1].fill(PASSWORD);
        await page.getByText('登录').first().click().catch(() => { });
        await sleep(3500);
        let t = await txt(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            log('登录成功');
            // 进游戏统一走 daily.enterMain：原来 8 轮点击后无条件 return true，
            // 没进游戏也算登录成功，海盗王整趟对着空页面点怪。
            return await daily.enterMain(page, { rounds: 8, pauseMs: 4000, log: (m) => log(m) });
        }
        log(`登录重试 ${a}`);
    }
    return false;
}

async function fight(page, name) {
    if (!(await clickLeaf(page, name, true))) {
        if (!(await jsClick(page, name, true))) return false;
    }
    await sleep(1400);
    let t0 = await txt(page);
    if (!t0.includes('攻击') && !t0.includes('关闭')) {
        for (const w of ['确定', '确认', '挑战']) {
            if (t0.includes(w) && (await clickHard(page, w, true).catch(() => false))) { log(`  ${name}: 点了「${w}」`); await sleep(1400); break; }
        }
        t0 = await txt(page);
    }
    if (!t0.includes('攻击') && !t0.includes('关闭')) {
        await jsClick(page, name, true);
        await sleep(1400);
    }
    let hits = 0, heals = 0;
    for (let a = 0; a < 110; a++) {
        const t = await txt(page);
        if (t.includes('关闭')) { await clickLeaf(page, '关闭', true); await sleep(350); return true; }
        if (t.includes('攻击')) {
            // 血池 0 的处理（2026-11-20 用户要求 + 当天冷0 实证 + 22:45 二次修正）：
            //   ① 还有体力宝 → 撤退补药再打（最优）；
            //   ② 补不成——不管是「体力宝真用光」还是「背包打不开/没切到药水页」这类界面故障
            //      —— 一律当作没有药，转「硬打模式」：不开背包了，照常出刀，能杀几只杀几只；
            //      人被打死由 clearRoom 复活一次，复活后立刻领奖。
            //      —— 硬打比 0 杀白跑好，用户原话：「就算没读到请假设就没有药水了，去完成好吗」。
            if (drain.readBlood(t) === 0) {
                const act = drain.bloodAction({
                    blood: 0, hardMode: HARD_FIGHT, healedOnce: heals >= 1, healReason: '',
                });
                if (act === 'heal') {
                    heals++;
                    log(`  [血池] ${name}: 血池 0，撤退补药...`);
                    const h = await drain.healBlood(page, { tag: `补血池·${name}`, inDungeon: true, log: (m) => log('  ' + m) });
                    if (h.ok) {
                        if (!(await clickLeaf(page, name, true))) { log(`  ⚠ ${name} 补药后点不回这只怪`); return false; }
                        await sleep(700);
                        continue;
                    }
                    HARD_FIGHT = true;
                    if (drain.bloodItemGone(h.reason)) {
                        log('  ⚔ 体力宝已用光 → 转硬打模式（继续出刀，战死则复活一次领奖）');
                    } else {
                        log(`  ::warning::${name} 补药失败（${h.reason}）→ 按「没有体力宝」硬打，不放弃这只`);
                    }
                }
            }
            await clickLeaf(page, '攻击', true); hits++; await sleep(280); continue;
        }
        await sleep(450);
        const t2 = await txt(page);
        if (!t2.includes('攻击') && !t2.includes('关闭')) {
            await sleep(900);
            const t3 = await txt(page);
            if (!t3.includes('攻击') && !t3.includes('关闭')) break;
        }
    }
    log(`  ⚠ ${name} 未出结算（${hits} 刀）`);
    await clickLeaf(page, '关闭', true).catch(() => { });
    return false;
}

async function tryRevive(page) {
    const l0 = (await leaves(page)).filter((l) => l.t === '复活').sort((a, b) => a.a - b.a)[0];
    if (!l0) return { ok: false, why: 'not-dead' };
    log('  [复活] 点「复活」');
    await page.mouse.click(l0.x, l0.y);
    await sleep(2600);
    let t = await txt(page);
    if (!t.includes('确认复活')) return { ok: false, why: 'no-dialog' };
    await tapOkByTouch(page, '确定');
    await sleep(3200);
    t = await txt(page);
    if (t.includes('道具不足')) return { ok: false, why: 'no-item' };
    const ls = await leaves(page);
    return ls.some((l) => l.t === '复活') ? { ok: false, why: 'still-dead' } : { ok: true, why: '' };
}

function allDone() { return CONDS.every((c) => (st.got[c] || 0) >= NEED); }
function gotStr() { return CONDS.map((c) => `${c}:${st.got[c] || 0}/${NEED}`).join(' '); }

async function clearRoom(page, tag) {
    let failSame = 0, lastName = '';
    for (let k = 0; k < 20; k++) {
        const ls = await leaves(page);
        if (ls.some((l) => l.t === '复活')) {
            log('  ✖ 人物死亡 → 立刻复活并停止走图');
            const rv = await tryRevive(page);
            if (rv.ok) { log('  ✔ 复活成功，停止清怪去领奖'); st.reason = 'revived'; }
            else { log(`  ::error::复活失败（${rv.why}）→ 本趟作废`); st.reason = 'dead'; }
            stopAll = true;
            return false;
        }
        // 只用条件怪；同名的打到 3 只为止
        const mons = ls.filter((l) => isCond(l.t) && (st.got[condOf(l.t)] || 0) < NEED).sort((a, b) => a.a - b.a);
        if (!mons.length) return true;
        log(`  [${tag}] 本间条件怪: ${mons.map((m) => m.t).join(',')} | 进度 ${gotStr()}`);
        const target = mons[0].t;
        const c = condOf(target);
        const ok = await fight(page, target);
        if (ok) { st.kills++; st.got[c] = (st.got[c] || 0) + 1; }
        else {
            failSame = lastName === target ? failSame + 1 : 1;
            lastName = target;
            if (failSame >= 3) { log(`  ⚠ ${target} 连续 3 次打不开，跳过`); return false; }
        }
        if (allDone()) { log(`  ✔ 4 项条件全满（${gotStr()}）`); return true; }        await sleep(400);
    }
    return false;
}

async function exits(page) {
    const ls = await leaves(page);
    return ls.filter((l) => /^(东|南|西|北)：/.test(l.t)).map((l) => l.t);
}
async function move(page, dir) {
    const ls = await leaves(page);
    const p = ls.filter((l) => new RegExp('^' + dir + '：').test(l.t)).sort((a, b) => a.a - b.a)[0];
    if (!p) return false;
    await page.mouse.click(p.x, p.y);
    await sleep(3000);
    return true;
}

async function dfs(page, x, y, depth) {
    if (stopAll) return;
    st.visited.add(`${x},${y}`);
    const ls = await leaves(page);
    let t = await txt(page);
    const roomNames = ls.filter((l) => /^(甲板层\d?|武器舱|水手舱|储物舱|船长室前厅|船长室|藏宝阁|船底监狱|入口)$/.test(l.t) && l.y > 200).map((l) => l.t);
    log(`(${x},${y}) ${roomNames[0] || '?'} | 深${depth} | ${gotStr()}`);
    if ((Date.now() - T0) / 1000 > MAX_SEC) { log('::warn::硬兜底到点（正常应由条件全满收工），停止走图'); st.reason = 'timeout'; stopAll = true; return; }
    if (st.healFail >= 3) { log('::warn::连续补药失败 3 次，停止'); st.reason = 'no-blood'; stopAll = true; return; }
    if (ls.some((l) => l.t === '复活')) {
        const rv = await tryRevive(page);
        if (rv.ok) { log('✔ 复活成功 → 去领奖'); st.reason = 'revived'; } else { log(`::error::复活失败（${rv.why}）`); st.reason = 'dead'; }
        stopAll = true; return;
    }
    if (depth > 80) { log('::warn::深度超 80'); st.reason = 'depth'; stopAll = true; return; }

    st.rooms++;
    await clearRoom(page, `${x},${y}`);
    if (stopAll) return;
    if (allDone()) { log('✔ 条件全满，收工领奖'); return; }
    const ex = await exits(page);
    log(`  出口: ${ex.join(' / ') || '(无)'}`);
    // ★ 出口顺序固定为 西→南→东→北：22:25/22:31 两次都卡死在 (1,-1) 走「北」进入甲板层区，
    //   页面在那里点不动（mouse.click 挂死，evaluate 超时也救不回来）。先西/南可绕开该区域。
    const ORD = { 西: 0, 南: 1, 东: 2, 北: 3 };
    ex.sort((a, b) => ORD[a[0]] - ORD[b[0]]);
    for (const e of ex) {
        if (stopAll || allDone()) return;
        const dir = e[0];
        const [dx, dy] = DXY[dir];
        const nx = x + dx, ny = y + dy;
        if (st.visited.has(`${nx},${ny}`)) continue;
        if (!(await move(page, dir))) { log(`  ⚠ 点不动 ${dir}`); continue; }
        await dfs(page, nx, ny, depth + 1);
        if (stopAll || allDone()) return;
        let back = await move(page, OPP[dir]);
        if (!back) { await sleep(1200); back = await move(page, OPP[dir]); }
        if (!back) {
            log(`  ⚠ 回不去 ${OPP[dir]}`);
            st.backFail = (st.backFail || 0) + 1;
            if (st.backFail >= 4) { log('  ⚠ 连续回退失败 4 次，收工'); st.reason = 'stuck'; stopAll = true; return; }
        }
    }
}

async function enterDungeon(page) {
    let t = await txt(page);
    // 副本内页面判据（实测）：顶部写「副本条件： 黄金守卫:3 …」+ 有「回到起点」「退出副本」
    if ((t.includes('副本条件') || t.includes('通关条件')) && t.includes('回到起点')) { log('已在副本内（续跑）'); return true; }
    if (!t.includes('当前城市：马六甲')) {
        log('不在马六甲，出航…');
        log('sailTo: ' + (await daily.sailTo(page, '马六甲').catch((e) => 'err ' + e.message)));
        await sleep(2500); await page.keyboard.press('Escape').catch(() => { }); await sleep(1200);
        t = await txt(page);
        if (!t.includes('当前城市：马六甲')) { log('::error::到不了马六甲'); st.reason = 'no-city'; return false; }
    }
    if (!t.includes('海盗王的诅咒')) {
        if (!t.includes('玛拉玛')) {
            log('城内地图 → 渔村');
            await clickHard(page, '城内地图', false); await sleep(2600);
            if (!(await clickHard(page, '渔村', true))) { log('::error::城内地图里找不到渔村'); st.reason = 'no-village'; return false; }
            await sleep(3200);
        }
        log('点 NPC「玛拉玛」');
        await clickLeaf(page, '玛拉玛', true); await sleep(2600);
        t = await txt(page);
        if (!t.includes('海盗王的诅咒')) { log('::error::玛拉玛旁没出现「海盗王的诅咒」'); st.reason = 'no-landmark'; return false; }
    }
    await clickHard(page, '海盗王的诅咒', true); await sleep(3500);
    t = await txt(page);
    log('入口: ' + t.replace(/\s+/g, ' ').slice(0, 220));
    if (t.includes('今日已完成')) { log('今日已完成（次数已用）'); st.reason = 'already-done'; return false; }

    // 队伍目标不一致：账号身上带着**其他队伍**时，入口页只给「查看队伍」、不给「进入副本」，
    // 直接点「进入副本」必然 enter-fail。典型场景是普通队伍（11-21 19:00 冷8 实测：
    // 昨天组的 5 人普通队「一起战斗吧！」就触发过一次，解散后正常建队进本）。
    // ★ 副本队伍不在这个范围：领奖退出副本时队伍**自动解散**（同日冷8 海盗王入口原文就是
    //   「请先创建或加入队伍」，证明身上没有奔月残留队），所以这里只兜普通队伍/异常残留。
    // 处理与 bymj-batch.js 完全一致：查看队伍 → 退出(队员)/解散(队长) → 关面板 → 重走入口。
    if (/队伍目标是【|队伍目标副本不一致/.test(t) && !t.includes('副本·海盗王的诅咒')) {
        log('队伍目标不一致 → 查看队伍');
        if (!(await clickHard(page, '查看队伍', true))) { st.reason = 'no-teamview'; return false; }
        let tt = await txt(page);
        log('队伍面板: ' + tt.replace(/\s+/g, ' ').slice(0, 160));
        let left = false;
        if (tt.includes('退出')) {
            log('是队员 → 退出');
            await clickHard(page, '退出', true); await sleep(1800);
            for (const w of ['确定', '确认']) { if (await clickHard(page, w, true).catch(() => false)) { log('退出确认'); break; } }
            left = true;
        } else if (tt.includes('解散')) {
            log('是队长 → 解散');
            await clickHard(page, '解散', true); await sleep(1800);
            for (const w of ['确定', '确认']) { if (await clickHard(page, w, true).catch(() => false)) { log('解散确认'); break; } }
            left = true;
        }
        if (!left) { log('::error::队伍面板既没有退出也没有解散'); st.reason = 'no-leave-btn'; return false; }
        await sleep(2000);
        await page.mouse.click(19, 20).catch(() => { });   // 关掉队伍面板回游戏
        await sleep(2200);
        t = await txt(page);
        if (!t.includes('海盗王的诅咒')) {
            log('重新走到海盗王入口');
            if (!t.includes('玛拉玛')) {
                if (await clickHard(page, '城内地图', false)) await sleep(2600);
                if (await clickHard(page, '渔村', true)) await sleep(3200);
            }
            await clickHard(page, '玛拉玛', true); await sleep(2600);
            await clickHard(page, '海盗王的诅咒', true); await sleep(3500);
            t = await txt(page);
        }
        log('退队后入口页: ' + t.replace(/\s+/g, ' ').slice(0, 200));
    }

    if (t.includes('请先创建或加入队伍')) {
        log('创建队伍');
        await clickHard(page, '创建队伍', false); await sleep(2600);
        const inputs = await page.$$('input');
        if (inputs.length) { await inputs[0].fill(TEAM_NAME).catch(() => { }); await sleep(500); }
        for (const w of ['确定', '创建', '确认']) {
            if (await clickHard(page, w, true).catch(() => false)) { log('点了 ' + w); break; }
        }
        await sleep(3200);
        t = await txt(page);
        log('建队后: ' + t.replace(/\s+/g, ' ').slice(0, 200));
    }
    log('点「进入副本」');
    await clickHard(page, '进入副本', false);
    await sleep(2600);
    for (const w of ['确定', '确认']) { if (await clickLeaf(page, w, true).catch(() => false)) { log('点了 ' + w); await sleep(2200); break; } }
    for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const t3 = await txt(page);
        if (t3.includes('回到起点') || (t3.includes('攻击') || t3.includes('东：'))) { log(`已进本（约 ${(i + 1) * 2}s）`); return true; }
    }
    log('::error::进本失败');
    log((await txt(page)).replace(/\s+/g, ' ').slice(0, 400));
    st.reason = 'enter-fail';
    return false;
}

// ★ 海盗王**不掉宝箱**（与基德同类），所以没有「箱子 +1」这种硬对账。
//   奖励里的「浴火之蝶」是**多副本共用道具**（奔月/基德等也会掉），数量变化无法归属到本趟 → 只作参考。
//   ★★「今日已完成」**也不能**当领奖证据（11-19 22:35 用户明确：**副本中途退出也算完成**，
//      只代表当天次数消耗掉），所以事后页面状态无法反推是否领到奖。
//   ★★ 正解（用户 11-19 22:37-22:39 指出）：「开打前读一次背包 → 领奖后再读一次」比**增量**。
//     判据是 `领奖后 - 开打前 >= 期望值`，**不是固定数量、更不是「0→1」**：
//       · 基线是 0 / 1 / 7 都无所谓，只看差值；
//       · 一次给 1 个、2 个、3 个……只要增量 ≥ 期望值就算到账（多给也认，因为副本内掉落会叠进去）；
//       · 增量不足（如海盗王碎片只 +2 而期望 +5）不判成功，只告警，降级用 toast 证据。
//     数量 0 时背包不显示该条目（null 即 0，是「没有」不是「读失败」）。
//     前提是读数本身要准——旧实现点完页签立刻读，读到的是上一个页签 → 全号 0→0 假读数。
//   证据等级：ok(bag)=背包差值（硬） > ok(toast)=领奖明细原文 > ok(act)=只证明点了领奖+回城。
// 读背包多件道具数量（一次开包裹）。实现统一在 ../bag-read.js：
//   · 与基德 / 奔月两份脚本共用同一份，网格视图 + CDP 触摸滑动 + 两种数量格式；
//   · 数量为 0 时背包里没有该条目 → 返回 null（调用方按 0 算差值）；
//   · 关包裹按「页签组」判据，包裹本来就关着时绝不去点左上角。
const bag = createBagReader({ getPageText: txt, log: (...a) => log(...a) });
const readBagItems = bag.readBagItems;

async function claim(page) {
    let t = await txt(page);
    const ls = await leaves(page);
    if (!ls.some((l) => l.t === '领取奖励')) {
        if (ls.some((l) => l.t === '复活')) { log('::error::死亡状态，副本不渲染「领取奖励」'); return { ok: false, reason: 'dead' }; }
        log('⚠ 页面上没有「领取奖励」');
        return { ok: false, reason: 'no-button' };
    }
    log(`点「领取奖励」（进度 ${gotStr()}）`);
    // ★ 领奖明细 toast 只活 1–2 秒，**必须在点击前就挂轮询**（dungeon-recover.js:194 有原文实证：
    //   `获得经验*8888，铜币*30000，浴火之蝶*1，藏宝图碎片*5` —— 与本副本详情页「通关奖励」一致）。
    //   今天 6 个号全 unverified 的根因就是点完 sleep(2500) 才去读文本，toast 早消失了。
    const toastP = drain.readRewardToast(page, 9000).catch(() => '');
    await clickLeaf(page, '领取奖励', true);
    await sleep(1500);
    for (const w of ['确定', '确认', '知道了']) {
        if (await clickLeaf(page, w, true).catch(() => false)) { log('点了 ' + w); await sleep(1800); break; }
    }
    t = await txt(page);
    if (/是否领[取奖]|确认领/.test(t)) { log('⚠ 确认框仍在 → 触摸序列'); await tapOkByTouch(page, '确定'); await sleep(2200); }
    const toast = (await toastP) || '';
    if (toast) log('领奖明细: ' + toast);
    await sleep(1500);
    t = await txt(page);
    const backToTown = !t.includes('副本条件') && !t.includes('通关条件') && !t.includes('回到起点') && t.includes('当前城市：');
    // ★ 判据只有一条能证明「到账」：领奖明细 toast（列出经验/铜贝/浴火之蝶/藏宝图碎片）。
    //   「今日已完成」**不作证据**——副本中途退出也算完成（11-19 22:35 用户明确）；只当旁注。
    let done = !!toast;
    let why = toast ? '领奖明细' : '';
    let ev = toast ? 'toast' : '';
    if (!done && backToTown) { done = true; why = '动作级：按钮存在+点过领取奖励+回城'; ev = 'act'; }
    if (t.includes('今日已完成')) log('（旁注：页面已显示「今日已完成」——中途退出也算完成，不作领奖证据）');
    // ★ 背包差值对账（用户 11-19 指定）：浴火之蝶 +1 或 藏宝图碎片 +5 = 领奖到账
    if (backToTown && st.boxBefore) {
        st.boxAfter = await readBagItems(page, REWARDS);
        const d = {};
        for (const n of REWARDS) {
            const b = st.boxBefore[n] === null ? 0 : st.boxBefore[n];
            const a = st.boxAfter[n] === null ? 0 : st.boxAfter[n];
            d[n] = a - b;
        }
        log(`[对账] ` + REWARDS.map((n) => `${n} ${fmtBag(st.boxBefore[n])}→${fmtBag(st.boxAfter[n])}(${d[n] >= 0 ? '+' : ''}${d[n]})`).join(' / '));
        const hit = Object.entries(EXPECT).filter(([n, need]) => d[n] >= need);
        if (!done && hit.length) {
            done = true; ev = 'bag';
            why = '背包差值 ' + hit.map(([n, need]) => `${n}+${d[n]}(需+${need})`).join(' ');
        }
    }
    if (done) log(`✔ 已领奖（${why}｜证据等级 ${ev}）`);
    else log('⚠ 到账未证实；页面: ' + t.replace(/\s+/g, ' ').slice(0, 300));
    return { ok: done, reason: done ? '' : 'unverified', ev, toast };
}

async function runAccount(account) {
    ACC = account;
    T0 = Date.now();
    st = { rooms: 0, kills: 0, healFail: 0, reason: '', visited: new Set(), got: {}, boxBefore: null, boxAfter: null };
    stopAll = false;
    // 同账号互斥：这个号正被别的脚本跑着（任务流程 / 基德 / 奔月 / 探针）就不登，
    // 两个会话同时在线会互相顶号，两边都白跑。
    const lock = acct.acquire(account, { tag: 'hdwang-batch.js' });
    if (!lock.ok) {
        log(`::warning::${account} 正被${acct.describe(lock.st)}占用 → 跳过（不登录）`);
        return { rooms: 0, kills: 0, reason: 'locked', got: {} };
    }
    log('==== 开始 ====');
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(20000);           // 防 hang：Playwright 默认无超时，卡死后整趟作废（22:19 实证）
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    try {
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        if (!(await login(page))) { st.reason = 'login-fail'; log('::error::登录失败'); return st; }
        await sleep(2500);
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(1200);
        // ★ 领奖基准：浴火之蝶 +1、藏宝图碎片 +5（本副本详情页「通关奖励」原文）。
        //   数量 0 时背包不显示该条目 → null 当 0；对账只看**增量**（+1/+2/+3 都算，够期望值即可）。
        st.boxBefore = await readBagItems(page, REWARDS);
        log(`[基线] ` + REWARDS.map((n) => `${n}=${fmtBag(st.boxBefore[n])}`).join(' / '));
        if (!(await enterDungeon(page))) return st;
        await sleep(1200);
        try { await dfs(page, 0, 0, 0); }
        catch (e) { log(`::warn::走图中止（${e.message}）→ 直接去领奖`); st.reason = st.reason || 'walk-abort'; }
        const t = await txt(page);
        log(`==== 走图结束：房间 ${st.rooms} 间 / 击杀 ${st.kills} 只 / 用时 ${el()}s ====`);
        log(`条件 ${gotStr()}`);
        await page.screenshot({ path: `hdwang-${account}.png`, fullPage: true }).catch(() => { });
        if (CLAIM) st.claimed = await claim(page);
        return st;
    } catch (e) {
        log('异常: ' + e.message); st.reason = 'exception'; return st;
    } finally {
        await browser.close().catch(() => { });
        acct.release(account);          // 本号跑完立刻放锁，下一个号不受影响
    }
}

(async () => {
    if (!ACCOUNTS.length) { console.log('::error::没有 ACCOUNTS'); return; }
    const out = [];
    for (const a of ACCOUNTS) {
        const r = await runAccount(a);
        out.push({ acc: a, ...r });
        await sleep(3000);
    }
    console.log('\n===== 汇总 =====');
    for (const o of out) {
        console.log(`${o.acc}\t房间${o.rooms}\t击杀${o.kills}\t条件:${CONDS.map((c) => `${c}${o.got[c] || 0}`).join('/')}\t流程:${o.reason || '-'}\t领奖:${o.claimed ? (o.claimed.ok ? `ok(${o.claimed.ev})` : o.claimed.reason) : 'no'}\t背包:${fmtBag(o.boxBefore && o.boxBefore['浴火之蝶'])}->${fmtBag(o.boxAfter && o.boxAfter['浴火之蝶'])}|碎片${fmtBag(o.boxBefore && o.boxBefore['藏宝图碎片'])}->${fmtBag(o.boxAfter && o.boxAfter['藏宝图碎片'])}`);
    }
})();
