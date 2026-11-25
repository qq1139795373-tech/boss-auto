// 奔月秘境 · 小号批量（进本 → DFS 全图清怪 → 领奖）
//
// 用法：
//   ACCOUNTS="coldwind0,coldwind1,coldwind2,coldwind8" GAME_PASSWORD=*** node bymj-batch.js
//   MAX_SEC=3300   硬兜底秒数（从进程启动算）。**正常不由它决定**：走图的主判据是
//                  页面上的「副本剩余时间」，剩 6 分钟才停手领奖；走完全图则自然结束。
//                  3300 只在 timeLeft 读不到时防止无限走图（2026-11-21 用户：
//                  「自动任务没有必要省时间，打完副本拿材料才是正道」）。
//   CLAIM=0        不领奖（默认领）
//
// 铁律：
//   1) 本地手跑时大号别和用户同时在线（抢会话会顶掉用户）。CI 每个 runner 独立会话，
//      tasks.js 逐号传 ACCOUNTS，大号也跑（11-22 实测 783~1025s，会打 boss 月神）。
//   2) 领奖优先：时间不够、补药失败、回退失败，都停止走图并立刻领奖，
//      绝不因为「没清干净」而放弃奖励（用户 11-15 明确：领奖是大头）。
//   3) 不点「退出副本」，不点「重置副本」「奖励兑换」。
const { chromium } = require('playwright');
const daily = require('../daily.js');
const drain = require('../dungeon-recover.js');
// 背包读数与账号锁：与 kidd.js / hdwang-batch.js 共用同一份实现（11-19 统一）
const { createBagReader, evTo } = require('../bag-read.js');
const acct = require('../acct-lock.js');

const { LOGIN_URL: URL } = require('../game-url.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 页面文本也套硬超时：page.evaluate 不受 setDefaultTimeout 约束，超时会整趟静默挂死（11-19 22:25 实证）
const txt = (page) => Promise.race([daily.getPageText(page), evTo(12000)]);

const ACCOUNTS = (process.env.ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
// ★ 密码统一走 account-pass（11-22）：本脚本一份 PASSWORD 服务整串 ACCOUNTS，
//   而大号 coldwind 与小号 coldwindN 密码不同 → 混类列表直接报错，绝不拿错密码去登。
const pass = require('../account-pass.js');
// ★ 缺参数必须以非 0 退出（11-22 随入库一起改）：原来只 console.log 一句再 return，
//   tasks.js 会把它当成功（exit=0），日志里「没有 ACCOUNTS」淹没在几百行里，等于整步静默空转。
if (!ACCOUNTS.length) { console.log('::error::没有 ACCOUNTS'); process.exit(2); }
try { pass.assertSameClass(ACCOUNTS); }
catch (e) { console.log('::error::' + e.message); process.exit(2); }
const PASSWORD = pass.resolveOrExit(ACCOUNTS[0]).password;
const MAX_SEC = Number(process.env.MAX_SEC || 3300);
const CLAIM = process.env.CLAIM !== '0';
const TEAM_NAME = process.env.BYMJ_TEAM || '一起战斗吧！';

// 只认完整怪物名（结尾锚定，避免把房间名 月影池 / 月神祭坛 当怪）
const MON_RE = /^(月岩巨人|宫守卫|玉兔精|月宫守卫|玉鳞兽|星河渔夫|鹊桥喜鹊|桂木灵卫|星衍术士|影月|月龙|月神侍女|月神)(\((?:boss|BOSS)\))?$/;
const isMon = (t) => MON_RE.test(t);
// ★ 2026-11-17 用户明确的两条副本机制：
//   ① 副本内只有 1 次复活机会；
//   ② 复活之后再次死亡 = 副本直接失败，页面只剩「退出」、不再渲染「领取奖励」→ 这趟白打。
// 小号血池上限扛不住「月神(boss)」的单刀（冷0/冷2/冷8 三个号死在完全同一点：33 间/78 杀，
// 月神祭坛清掉 4 个侍女后打 boss，血池归零→补 1 个小体力宝→回战斗→下一刀就死→复活→再死→失败）。
// 而「月神」不在 5 项条件里（条件是 桂木灵卫/月神侍女/月龙/星衍术士/影月），跳过它不影响 5/5 的达成。
// ★ 但要认清代价（用户 2026-11-17 补充）：月神**有几率掉落重要道具**，副本之所以设置得难打就是因为它。
//   所以「跳过」不是最优解，是小号的止损解：不跳 = 大概率死 = 整趟作废（连条件奖都没）；跳 = 稳拿条件奖、放弃那份掉落。
//   大号战力高，正常打，不跳。以后小号战力够了，用 BYMJ_FIGHT_BOSS=1 一键放开，不用改代码。
const isBossMon = (t) => /^月神\s*([(（]\s*boss\s*[)）])?$/i.test(t);
const skipBoss = () => process.env.BYMJ_FIGHT_BOSS === '1' ? false : /^coldwind\d+$/i.test(ACC);

const ROOM_SUF = ['月道', '鹊桥', '星河渡口', '玉兔菜园', '桂木桥', '月影池', '月神祭坛', '副本入口', '菜园'];
const CONDS = ['桂木灵卫', '月神侍女', '月龙', '星衍术士', '影月'];
const OPP = { 东: '西', 西: '东', 南: '北', 北: '南' };
const DXY = { 东: [1, 0], 西: [-1, 0], 南: [0, 1], 北: [0, -1] };

let ACC = '';
let T0 = Date.now();
const el = () => Math.round((Date.now() - T0) / 1000);
const log = (...a) => console.log(`[${ACC}][${el()}s]`, ...a);

function conds(t) {
    const o = {};
    for (const c of CONDS) {
        const m = t.match(new RegExp(c + '\\s*[:：]\\s*(\\d+)'));
        o[c] = m ? Number(m[1]) : null;
    }
    return o;
}
const condStr = (o) => CONDS.map((c) => `${c}:${o[c] === null ? '?' : o[c]}`).join(' ');
const allZero = (o) => CONDS.every((c) => o[c] === 0);
function timeLeft(t) {
    const m = t.match(/副本剩余时间\s*[：:]\s*(\d+)\s*分钟/);
    return m ? Number(m[1]) : null;
}

async function gotoGame(page, n = 3) {
    for (let i = 1; i <= n; i++) {
        try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); return; } catch (e) { await sleep(3000); }
    }
    throw new Error('打开失败');
}
// ★ page.evaluate 不受 setDefaultTimeout 约束，渲染进程一忙就无限等（11-19 22:25 卡死 4 分钟实证）
//   → 所有 evaluate 都套 Promise.race 硬超时，超时由上层 catch 兜住转去领奖，而不是整趟静默挂死。
async function leaves(page) {
    return Promise.race([page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length) continue;
            const s = (el.textContent || '').trim();
            if (!s || s.length > 34) continue;
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
// mouse 点不动就用 DOM click 兜底（uni-app 的部分按钮只吃合成事件）
async function jsClick(page, s, exact = true) {
    return Promise.race([page.evaluate(({ s, exact }) => {
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
    }, { s, exact }), evTo(10000)]).catch(() => false);
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
function roomName(ls) {
    const c = ls.filter((l) => !l.t.includes('：') && !l.t.includes(':') && ROOM_SUF.some((s) => l.t === s));
    return c.length ? c[0].t : '?';
}

async function login(page, account) {
    for (let a = 1; a <= 10; a++) {
        const ins = await page.$$('input');
        if (ins.length < 2) {
            const t = await txt(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) return true;
            await gotoGame(page); await sleep(3000); continue;
        }
        await ins[0].fill(account); await ins[1].fill(PASSWORD);
        await page.getByText('登录').first().click().catch(() => {});
        await sleep(3000);
        let t = await txt(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            log('登录成功');
            for (let i = 0; i < 8; i++) {
                await daily.clickText(page, '进入游戏', 2000).catch(() => {});
                await sleep(4000);
                t = await txt(page);
                if (t.includes('你看到') || t.includes('当前城市')) return true;
            }
            return true;
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
    // 有的怪（月龙这类）点一次不开面板：先看是否有确认框，再补一次 JS 点击
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
    let hits = 0;
    let heals = 0;
    for (let a = 0; a < 90; a++) {
        const t = await txt(page);
        if (t.includes('关闭')) { await clickLeaf(page, '关闭', true); await sleep(350); return true; }
        if (t.includes('攻击')) {
            // ★ 血池 0 必须立刻补药，不许「先试几刀」（用户 2026-11-15 纠正）：
            //   有的怪攻击力很高，等打几刀人就被砍死 —— 2026-11-16 coldwind0 就是血池 0 还硬打，
            //   人物死亡后页面只渲染「复活」，副本条件 5/5 全 0 却**没有「领取奖励」**，
            //   223 杀白打、奖励领不到。死亡 = 副本失败，比浪费一个体力宝严重得多。
            // 血池 0 的处理（2026-11-20 用户要求 + 冷0 实证 + 22:45 二次修正）：
            //   ① 还有体力宝 → 撤退补药再打（最优，血池回来就能正常出刀）；
            //   ② 补不成——不管是「体力宝真用光」还是「包裹打不开/没切到药水页」这类界面故障
            //      —— 一律当作没有药，转「硬打模式」：不再逐只开背包，继续出刀，
            //      人被打死由 clearRoom / dfs 复活一次，复活后立刻去领奖。
            //      用户原话「没有体力宝的情况下可以杀到死，复活一次领取奖励」「就算没读到请假设就没有药水了」。
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
    await clickLeaf(page, '关闭', true).catch(() => {});
    return false;
}

async function clearRoom(page, tag) {
    let failSame = 0, lastName = '';
    for (let k = 0; k < 20; k++) {
        const ls = await leaves(page);
        // ★ 死亡即处理（用户 2026-11-17：副本内只有 1 次复活机会，复活后再死 = 副本失败只剩「退出」）。
        //   dfs 只在**进入新房间**时查「复活」，人死在当前房间时要空转十几轮「回不去（位置漂移）」
        //   才被发现（冷2/冷8 实测 21 秒），这期间页面一直挂着死亡状态。这里每轮先查，死立刻复活并停图。
        if (ls.some((l) => l.t === '复活')) {
            log('  ✖ 人物死亡 → 立刻复活（复活机会只有 1 次，不再打任何怪）');
            const rv = await tryRevive(page);
            if (rv.ok) { log('  ✔ 复活成功，停止清怪，去领奖'); st.reason = 'revived'; }
            else {
                log(`  ::error::复活失败（${rv.why}）→ 本趟作废；` +
                    (rv.why === 'no-item' ? '复活机会已用掉，二次死亡领不到奖励' : ''));
                st.reason = 'dead';
            }
            stopAll = true;
            return false;
        }
        // ★ 打击优先级（用户 2026-11-17）：「月神侍女」是 5 项条件之一，和「月神(boss)」同一个房间。
        //   必须先清侍女再碰 boss：先打 boss 会把血池耗在非条件目标上，侍女没打完 → 条件不满 → 奖励缩水。
        //   排序固定为 条件怪(0) → 其他普通怪(1) → boss(2)，boss 永远最后，不依赖页面渲染顺序。
        //   注意 月神侍女 必须先于 boss 命中 CONDS，否则会被误判成 boss（isBossMon 用整名锚定，不会串）。
        const pri = (t) => (CONDS.some((c) => t.startsWith(c)) ? 0 : (isBossMon(t) ? 2 : 1));
        let mons = ls.filter((l) => isMon(l.t)).sort((a, b) => (pri(a.t) - pri(b.t)) || (a.a - b.a));
        if (skipBoss()) {
            const bosses = mons.filter((m) => isBossMon(m.t));
            if (bosses.length) {
                log(`  [${tag}] 跳过副本 boss ${bosses.map((m) => m.t).join(',')}（小号扛不住；不在条件里，但**它的掉落也一并放弃**）`);
                mons = mons.filter((m) => !isBossMon(m.t));
            }
        }
        if (!mons.length) return true;
        log(`  [${tag}] 剩 ${mons.length}: ${mons.map((m) => m.t).join(',')}`);
        const target = mons[0].t;
        const ok = await fight(page, target);
        // ★ 击杀只认「真清掉这只」：旧写法失败也 st.kills++，于是「90 刀未出结算 → 重打一次成功」
        //   被算成 2 只（11-22 cw1 的 [1,13] 玉鳞兽、cw6 的 [4,10] 各多计 1），
        //   汇总里才出现 119/120 交替的假差异 —— 120 不是多杀一只，是同一只被数了两遍。
        if (ok) { st.kills++; failSame = 0; }
        else {
            failSame = lastName === target ? failSame + 1 : 1;
            lastName = target;
            if (failSame >= 3) { log(`  ⚠ ${target} 连续 ${failSame} 次打不开，跳过这只`); return false; }
        }
        await sleep(400);
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

// 硬打模式：体力宝真的用光时不再逐只开背包，继续出刀（战死由复活逻辑处理后去领奖）
let HARD_FIGHT = false;
let st = { rooms: 0, kills: 0, healFail: 0, reason: '' };
let stopAll = false;

async function dfs(page, x, y, depth) {
    if (stopAll) return;
    st.visited.add(`${x},${y}`);
    const ls = await leaves(page);
    const nm = roomName(ls);
    let t = await txt(page);
    const tl = timeLeft(t);
    log(`(${x},${y}) ${nm} | 深${depth} | ${condStr(conds(t))} | 剩${tl}分`);
    if ((Date.now() - T0) / 1000 > MAX_SEC) { log('::warn::硬兜底到点（正常应先由副本剩 6 分钟触发），停止走图'); st.reason = 'timeout'; stopAll = true; return; }
    if (tl !== null && tl <= 6) { log(`::warn::副本剩 ${tl} 分钟，停止走图`); st.reason = 'dungeon-time'; stopAll = true; return; }
    if (st.healFail >= 3) { log('::warn::连续补药失败 3 次，停止走图'); st.reason = 'no-blood'; stopAll = true; return; }
    // 死亡处理（用户 2026-11-16 明确）：页面有「复活」= 已经死了。
    //   ★ 副本里只能复活一次，再次死亡就复活不了（会提示「道具不足」）。
    //   ★ 死了就复活 → 直接领奖，不管怪清没清干净（领奖是大头）。
    //   ★ 死亡状态下副本不渲染「领取奖励」，不复活就一个奖励都拿不到（2026-11-16 coldwind0 实证）。
    if (ls.some((l) => l.t === '复活')) {
        const rv = await tryRevive(page);
        if (rv.ok) {
            log('✔ 复活成功 → 停止走图，立刻去领奖（不再清怪）');
            st.reason = 'revived';
        } else {
            log(`::error::复活失败（${rv.why}）→ 停止走图；` +
                (rv.why === 'no-item' ? '本副本已复活过一次，二次死亡无法复活，今天的奖励领不到了' : ''));
            st.reason = 'dead';
        }
        stopAll = true;
        return;
    }
    if (depth > 80) { log('::warn::深度超 80，停止'); st.reason = 'depth'; stopAll = true; return; }

    st.rooms++;
    if (!(await clearRoom(page, `${x},${y}`))) log('  ⚠ 本间没清干净，继续走');
    if (stopAll) return;   // 死亡/复活后 clearRoom 已置 stopAll，别再读出口白打一行日志
    const ex = await exits(page);
    log(`  出口: ${ex.join(' / ') || '(无)'}`);

    for (const e of ex) {
        if (stopAll) return;
        const dir = e[0];
        const [dx, dy] = DXY[dir];
        const nx = x + dx, ny = y + dy;
        if (st.visited.has(`${nx},${ny}`)) continue;
        if (!(await move(page, dir))) { log(`  ⚠ 点不动 ${dir}`); continue; }
        st.backFail = 0;
        await dfs(page, nx, ny, depth + 1);
        if (stopAll) return;
        let back = await move(page, OPP[dir]);
        if (!back) { await sleep(1200); back = await move(page, OPP[dir]); }
        if (!back) {
            // 回退失败不终止整趟：继续从这个房间探索，宁可坐标偏移也要把新房间走一遍
            log(`  ⚠ 回不去 ${OPP[dir]}（位置漂移），继续探索`);
            st.backFail = (st.backFail || 0) + 1;
            // ★ 2026-11-23 冷0 实证：这个计数原来只加不清、阈值只有 4，一次连续漂移就让整趟收工
            //   （44 间 / 94 杀 vs 其它号 57 间 / 119 杀，而且当时还剩 51 分钟）。
            //   现在是「连续」语义：① 任何一次成功移动（进入或回退）都清零；
            //   ② 阈值 4 → 8；③ 触发时只放弃**当前这条分支**，累计 3 条分支漂移才整趟收工。
            if (st.backFail >= 8) {
                st.drift = (st.drift || 0) + 1;
                log(`  ⚠ 连续回退失败 ${st.backFail} 次（漂移分支 ${st.drift}/3）→ 放弃这条分支，保留其它出口`);
                st.backFail = 0;
                if (st.drift >= 3) { log('  ⚠ 3 条分支都漂移，收工'); st.reason = 'stuck'; stopAll = true; }
                return;
            }
        } else {
            st.backFail = 0;
        }
    }
}

// 进本：长安 → 广场 → 嫦娥仙子 → 奔月秘境 → 建队（如需）→ 进入副本
async function enterDungeon(page) {
    let t = await txt(page);
    if (t.includes('副本条件') && t.includes('回到起点')) { log('已在副本内（续跑）'); return true; }

    if (!t.includes('当前城市：长安')) {
        log('不在长安，出航…');
        log('sailTo: ' + (await daily.sailTo(page, '长安').catch((e) => 'err ' + e.message)));
        await sleep(2500); await page.keyboard.press('Escape').catch(() => {}); await sleep(1000);
        t = await txt(page);
        if (!t.includes('当前城市：长安')) { log('::error::到不了长安'); return false; }
    }
    if (!t.includes('嫦娥仙子')) {
        log('城内地图 → 广场');
        await clickLeaf(page, '城内地图', false); await sleep(2600);
        if (!(await clickLeaf(page, '广场', true))) { log('::error::城内地图里找不到广场'); return false; }
        await sleep(3200);
    }
    await clickLeaf(page, '嫦娥仙子', false); await sleep(2600);
    if (!(await clickLeaf(page, '奔月秘境', true))) { log('::error::嫦娥仙子旁没有奔月秘境地标'); return false; }
    await sleep(4200);

    t = await txt(page);
    if (t.includes('今日已完成')) { log('今日已完成（次数已用）'); st.reason = 'already-done'; return false; }
    // 队伍目标不一致：普通队伍打不了副本 → 查看队伍 → 退出(队员)/解散(队长) → 回入口 → 创建队伍
    if (/队伍目标是【|队伍目标副本不一致/.test(t) && !t.includes('副本·奔月秘境')) {
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
        // 关掉队伍面板回游戏
        await page.mouse.click(19, 20).catch(() => {});
        await sleep(2200);
        t = await txt(page);
        if (!t.includes('奔月秘境')) {
            log('重新走到奔月入口');
            if (!t.includes('嫦娥仙子')) {
                if (await clickHard(page, '城内地图', false)) await sleep(2600);
                if (await clickHard(page, '广场', true)) await sleep(3200);
            }
            await clickHard(page, '嫦娥仙子', false); await sleep(2600);
            await clickHard(page, '奔月秘境', true); await sleep(4200);
            t = await txt(page);
        }
        log('退队后入口页: ' + t.replace(/\s+/g, ' ').slice(0, 200));
    }
    if (t.includes('请先创建或加入队伍')) {
        log('创建队伍');
        await clickHard(page, '创建队伍', false); await sleep(2600);
        const inputs = await page.$$('input');
        if (inputs.length) { await inputs[0].fill(TEAM_NAME).catch(() => {}); await sleep(500); }
        await clickHard(page, '确定', true);
        await sleep(3200);
        t = await txt(page);
    }

    log('点「进入副本」');
    await clickHard(page, '进入副本', false);
    await sleep(2600);
    for (const w of ['确定', '确认']) { if (await clickLeaf(page, w, true).catch(() => false)) { log('点了 ' + w); await sleep(2200); break; } }
    for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const t3 = await txt(page);
        if (t3.includes('副本条件') && t3.includes('回到起点')) { log(`已进本（约 ${(i + 1) * 2}s）`); return true; }
    }
    log('::error::进本失败');
    log((await txt(page)).replace(/\s+/g, ' ').slice(0, 400));
    st.reason = 'enter-fail';
    return false;
}

// 点「确认复活么？」弹窗里的按钮。
// 实测（2026-11-16 coldwind0）：mouse.click / locator.click / elementHandle.click 全都没反应，
// 只有 dispatch touchstart+touchend（再补 pointer/mouse 序列）才真正触发这个 uni 弹窗。
// 通用触摸版按钮点击：不限弹窗标题。2026-11-17 冷6 实证——领奖确认框
// 「领取奖励后默认退出副本，是否领取奖励？」的「确定」只认触摸序列，
// clickLeaf 的合成鼠标事件返回 true 但弹窗纹丝不动（tapDialogOk 写死了「确认复活」，够不着）。
async function tapOkByTouch(page, word = '确定') {
    return Promise.race([page.evaluate((w) => {
        const cands = [...document.querySelectorAll('body *')].filter((el) => {
            if (el.children.length) return false;
            if ((el.textContent || '').trim() !== w) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        if (!cands.length) return false;
        const t = cands[cands.length - 1];   // 后渲染的弹窗在最上层
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
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, word), evTo(10000)]).catch(() => false);
}

async function tapDialogOk(page, word = '确定') {
    return page.evaluate((word) => {
        const all = Array.from(document.querySelectorAll('body *'));
        const hit = all.filter((el) => (el.textContent || '').includes('确认复活'));
        if (!hit.length) return false;
        let box = hit[0];
        for (const el of hit) if (el.getBoundingClientRect().height < box.getBoundingClientRect().height) box = el;
        const t = Array.from(box.querySelectorAll('*')).find((el) => (el.textContent || '').trim() === word);
        if (!t) return false;
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
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, word).catch(() => false);
}

// 死亡复活（用户 2026-11-16 明确）：
//   ★ 副本里能复活一次，第二次死亡复活会提示「道具不足」，那就真的救不回来了。
//   ★ 所以一看到「复活」就马上复活，复活后立刻领奖，不管怪清没清干净。
// 返回 {ok, why}
async function tryRevive(page) {
    const l0 = (await leaves(page)).filter((l) => l.t === '复活').sort((a, b) => a.a - b.a)[0];
    if (!l0) return { ok: false, why: 'not-dead' };
    log('  [复活] 点「复活」');
    await page.mouse.click(l0.x, l0.y);
    await sleep(2600);
    let t = await txt(page);
    if (!t.includes('确认复活')) {
        log('  [复活] 没弹确认框，页面: ' + t.replace(/\s+/g, ' ').slice(0, 160));
        return { ok: false, why: 'no-dialog' };
    }
    log('  [复活] 弹「确认复活么？」→ 点「确定」');
    await tapDialogOk(page, '确定');
    await sleep(3200);
    t = await txt(page);
    if (t.includes('道具不足')) return { ok: false, why: 'no-item' };
    let ls = await leaves(page);
    if (!ls.some((l) => l.t === '复活')) return { ok: true, why: '' };
    log('  [复活] 弹窗还在 → 再点一次「确定」');
    await tapDialogOk(page, '确定');
    await sleep(3000);
    t = await txt(page);
    if (t.includes('道具不足')) return { ok: false, why: 'no-item' };
    ls = await leaves(page);
    return ls.some((l) => l.t === '复活') ? { ok: false, why: 'still-dead' } : { ok: true, why: '' };
}

// 背包读数统一在 ../bag-read.js（与基德 / 海盗王同一份）：
//   · 网格视图 + CDP 触摸滑动 + 两种数量格式 —— 旧实现用 mouse.wheel 滚不动，只读到第一屏，
//     箱数会假读成 0（11-19 已验证 wheel 对包裹列表完全无效）；
//   · 返回里带 opened 标记，用来区分「包裹没打开=读失败（null）」和「打开了但没这条=真的 0 个」。
const bag = createBagReader({ getPageText: txt, log: (...a) => log(...a) });

// 读背包「宝箱」页里「奔月副本箱」的数量（只能在主界面做）。读失败返回 null，绝不抛异常。
async function readBymjBox(page) {
    const r = await bag.readBagItemsVerbose(page, ['奔月副本箱']);
    if (!r.opened) return null;                        // 包裹都没打开 → 读失败
    const v = r.items['奔月副本箱'];
    return v === null || v === undefined ? 0 : v;       // 打开着但没这条 → 真有 0 个
}

// 领奖（领奖优先：条件没全 0 也点，奖励按已达成条件结算）
async function claim(page) {
    let t = await txt(page);
    const ls = await leaves(page);
    const hasBtn = ls.some((l) => l.t === '领取奖励');
    if (!hasBtn) {
        // 2026-11-16 实证：人物死亡时页面只有「复活/回到起点/退出副本」，**绝不渲染「领取奖励」**。
        // 这是「条件全 0 却领不到奖」的唯一原因，必须写进日志，别再当成「页面没入口」糊过去。
        const dead = ls.some((l) => l.t === '复活');
        if (dead) {
            log('::error::人物处于死亡状态（页面有「复活」）→ 副本不渲染「领取奖励」，奖励领不到；' +
                '根因是血池 0 时没有立刻补药、被怪打死');
            return { ok: false, reason: 'dead' };
        }
        log('⚠ 页面上没有「领取奖励」，无法领奖');
        return { ok: false, reason: 'no-button' };
    }
    log(`点「领取奖励」（当前条件 ${condStr(conds(t))}）`);
    await clickLeaf(page, '领取奖励', true);
    await sleep(2500);
    let clicked = '';
    for (const w of ['确定', '确认', '知道了']) {
        if (await clickLeaf(page, w, true).catch(() => false)) { clicked = w; break; }
    }
    if (clicked) { log('点了 ' + clicked); await sleep(2500); }
    // 弹窗还在（冷6 的典型形态）→ 用触摸序列重点一次
    if (/是否领[取奖]|确认领|是否退出/.test(await txt(page))) {
        log('⚠ 确认框仍在 → 改用触摸序列点「确定」');
        await tapOkByTouch(page, '确定');
        await sleep(2800);
        if (/是否领[取奖]|确认领|是否退出/.test(await txt(page))) {
            log('⚠ 触摸也没关掉 → 再点一次');
            await tapOkByTouch(page, '确定');
            await sleep(2800);
        }
    }
    t = await txt(page);
    const toast = (t.match(/领奖明细[^]{0,300}/) || [''])[0].replace(/\s+/g, ' ').slice(0, 300);
    if (toast) log('领奖明细: ' + toast);
    await sleep(2500);
    t = await txt(page);
    // 领奖成功的真实形态（2026-11-16 coldwind1/2 实证）：点完「领取奖励 → 确定」后，
    // 人直接被传出副本、回到长安城内（页面出现「当前城市：」且不再有「副本条件」）。
    // 所以不能再只认「今日已完成」——那个字只在入口页显示，副本内领奖后根本看不到。
    const backToTown = !t.includes('副本条件') && t.includes('当前城市：');
    // ★ 到账只认硬证据：toast「领奖明细」，或入口/页面明确写「今日已完成」。
    //   「点完确定就被传出副本回城」只是现象，条件不足被踢出副本也会这样，
    //   不能当成功判据（2026-11-16 四个号全靠这条已导致一次误报）。
    let done = t.includes('今日已完成') || !!toast;
    let why = toast ? '有「领奖明细」' : (done ? '页面显示「今日已完成」' : '');
    // ★ 硬证据（2026-11-17 coldwind1 实证）：这个游戏领奖后**根本不弹「领奖明细」**。
    //   冷1 今天跑完点确定被传回长安、无 toast，但背包「奔月副本箱」是 2 个（11-16 + 今天各 1）→ 实际都到账。
    //   只认 toast 会把已到账的记成 unverified。回城后查背包箱数，比进本前多 1 个即确认到账。
    if (!done && backToTown && st.boxBefore !== null && st.boxBefore !== undefined) {
        const after = await readBymjBox(page);
        if (after !== null) {
            st.boxAfter = after;
            log(`[对账] 背包「奔月副本箱」${st.boxBefore} → ${after}`);
            if (after > st.boxBefore) { done = true; why = `背包箱数 ${st.boxBefore}→${after}`; }
            else log('::warning::箱数没有增加 → 这次领奖可能没到账（或箱子被用掉了一个）');
        } else {
            log('[对账] 背包读数失败，退回只看 toast');
        }
    }
    if (done) log(`✔ 已领奖（${why}）`);
    else if (backToTown) log('::warning::点了确定、人被传出副本回城，但**没有「领奖明细」也读不到背包箱数**→ 到账未证实（也可能是条件不足被踢出）');
    else log('⚠ 点完了，但没看到结算证据（既没回城也没「今日已完成」）');
    if (!done) log('页面: ' + t.replace(/\s+/g, ' ').slice(0, 400));
    return { ok: done, reason: done ? '' : (backToTown ? 'unverified' : 'no-done-marker'), toast, box: st.boxAfter };
}

async function runAccount(account) {
    ACC = account;
    T0 = Date.now();
    st = { rooms: 0, kills: 0, healFail: 0, reason: '', visited: new Set(), claimed: null, boxBefore: null, boxAfter: null };
    stopAll = false;
    // 同账号互斥：这个号正被别的脚本跑着（任务流程 / 基德 / 海盗王 / 探针）就不登，
    // 两个会话同时在线会互相顶号，两边都白跑（11-19 两个批量脚本抢号也是这么互相拖死的）。
    const lock = acct.acquire(account, { tag: 'bymj-batch.js' });
    if (!lock.ok) {
        log(`::warning::${account} 正被${acct.describe(lock.st)}占用 → 跳过（不登录）`);
        return { rooms: 0, kills: 0, reason: 'locked', claimed: null, boxBefore: null, boxAfter: null };
    }
    log('==== 开始 ====');
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    try {
        await gotoGame(page); await sleep(3000);
        if (!(await login(page, account))) { st.reason = 'login-fail'; log('::error::登录失败'); return st; }
        await sleep(3000);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(1200);

        // 进本前在主界面记背包「奔月副本箱」基线（领奖后用它做硬对账，见 claim）
        // ★ 2026-11-23：冷6 / 冷2 都在这里读到「读取失败」——当时页面正好是一层加载壳
        //   （紧接着就是「回城失败」「白屏恢复 reload」）。基线丢了，后面领奖只能靠 toast，
        //   toast 一错过就变成「到账未证实」。所以读失败要等页面就绪后重试，别一次定生死。
        for (let r = 1; r <= 5; r++) {
            st.boxBefore = await readBymjBox(page);
            if (st.boxBefore !== null) break;
            if (r < 5) {
                log(`[基线] 背包读取失败（第${r}/5次），等页面就绪后重试...`);
                await sleep(2500);
                await page.keyboard.press('Escape').catch(() => {});
                await sleep(800);
            }
        }
        log(`[基线] 背包「奔月副本箱」= ${st.boxBefore === null ? '读取失败（重试 5 次仍失败）' : st.boxBefore + ' 个'}`);
        await sleep(1000);

        if (!(await enterDungeon(page))) return st;
        await sleep(1200);

        await dfs(page, 0, 0, 0);

        let t = await txt(page);
        log(`==== 走图结束：房间 ${st.rooms} 间 / 击杀 ${st.kills} 只 / 用时 ${el()}s / 剩 ${timeLeft(t)} 分 ====`);
        log(`条件 ${condStr(conds(t))}`);
        await page.screenshot({ path: `bymj-batch-${account}.png`, fullPage: true }).catch(() => {});

        if (CLAIM) st.claimed = await claim(page);
        else log('CLAIM=0，不领奖');
        return st;
    } catch (e) {
        log('异常: ' + e.message);
        st.reason = 'exception';
        return st;
    } finally {
        await browser.close().catch(() => {});
        acct.release(account);          // 本号跑完立刻放锁，下一个号不受影响
    }
}

async function main() {
    if (!ACCOUNTS.length) { console.log('::error::没有 ACCOUNTS'); return; }
    const out = [];
    for (const a of ACCOUNTS) {
        const r = await runAccount(a);
        out.push({ acc: a, rooms: r.rooms, kills: r.kills, reason: r.reason || '-', claim: r.claimed ? (r.claimed.ok ? 'ok' : r.claimed.reason) : 'no', box: `${r.boxBefore === null ? '?' : r.boxBefore}->${r.boxAfter === null || r.boxAfter === undefined ? '?' : r.boxAfter}` });
        await sleep(3000);
    }
    console.log('\n===== 汇总 =====');
    for (const o of out) console.log(`${o.acc}\t房间${o.rooms}\t击杀${o.kills}\t流程:${o.reason}\t领奖:${o.claim}\t奔月箱:${o.box}`);
}
main();
