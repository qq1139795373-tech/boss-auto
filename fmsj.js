// 附魔秘境（威尼斯 · 城内地图 → 铁匠铺 → 附魔师 → 附魔秘境）
//
// 用户 2026-11-22 20:14：这个副本加在大号钓鱼之后，本来就是一个地图，领奖逻辑和之前定好的一样，读背包宝箱。
//   · 「一个地图」→ 威尼斯，钓鱼收竿后人就在城里，直接城内地图 → 铁匠铺，不用出航；
//   · 「领奖逻辑和之前定好的一样」→ 与基德/炼器窟同一套：**点领奖前先挂领奖明细轮询**，
//     明细原文里的「物品×N」是硬证据，再用**背包增量**做补充对账（本副本的到账物是宝箱「卡魂碎片箱」）；
//   · 大号限定：131 级小号 11-22 实测满血一刀被秒（破碎星灵一刀打穿 2 万血），这个本不是给小号刷的。
//
// 副本结构（11-22 冷6 全程只点「北」探完，25 间直线）：
//   1 秘境入口(无怪) → 2 幻卡回廊(破碎星灵×5) → 3~23 各 2 只同名精英 → 24 卡魂深渊(卡魂之主×1) → 25 秘境祭坛(终点)
//   通关条件只有「破碎星灵:2」，第 2 间就够；后面 22 间是材料与经验，默认全刷，
//   但「精英·泉州路霸」「精英·巨型仙人掌」两只永远不打（用户 11-23 前点名排除）。
//
// 铁律沿用（与 kidd.js / dungeon.js 一致，别再各写一套）：
//   · 领奖优先：条件满足就领，绝不因为「某只怪打不死」把奖励丢掉；
//   · 死亡 → 复活一次 → 立刻停手去领奖（副本内只 1 次复活，不硬撑第二次死）；
//   · 打不动的怪（点不开/240 刀不结算/血池 0 且补药失败）→ 记失败跳过，继续清同房间其它怪；
//   · 领不到奖且条件没满足时**不退本**（当天那次机会已经花掉，退出去就白扔）。
//
// 用法：
//   GAME_ACCOUNT=coldwind GAME_PASSWORD=12345678 node fmsj.js
//   默认永不打的怪：精英·泉州路霸 / 精英·巨型仙人掌（用户 11-22 点名排除，即便能打也不碰）
//   FMSJ_SKIP="某怪,某怪"  在默认之外再追加不打的怪
//   FMSJ_ALL=1  临时解除默认排除、全刷（调试用，正常不要动）
//   FMSJ_NO_CLAIM=1  刷完不领奖、留副本内（人工查验用，等同 11-22 那次手动验证）
const { chromium } = require('playwright');
const daily = require('./daily.js');
const drain = require('./dungeon-recover.js');
const { createBagReader, evTo } = require('./bag-read.js');
const acct = require('./acct-lock.js');

const URL = 'http://yiyu.yiyutx.top/yysh/#/pages/login/login';
const ACC = process.env.GAME_ACCOUNT || process.env.ACCOUNT || 'coldwind';
const PASSWORD = process.env.GAME_PASSWORD || '';
const NO_CLAIM = process.env.FMSJ_NO_CLAIM === '1';
// 目标物品与期望数量（领奖明细 / 背包增量共用同一张表）
const FMSJ_REWARDS = { '卡魂碎片箱': 1 };
// 明细里还会给这些，只作展示（不作为成败判据）
const FMSJ_EXTRA = ['藏宝图碎片'];
// 默认不打的怪：用户 11-22 点名这两只永久跳过（不影响通关条件，条件只要破碎星灵）
const DEFAULT_SKIP = ['精英·泉州路霸', '精英·巨型仙人掌'];
const SKIP = [
    ...(process.env.FMSJ_ALL === '1' ? [] : DEFAULT_SKIP),
    ...(process.env.FMSJ_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean),
];
const MAX_HITS = Number(process.env.FMSJ_MAX_HITS || 240);
const MAX_ROOMS = Number(process.env.FMSJ_MAX_ROOMS || 30);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (page) => Promise.race([daily.getPageText(page), evTo(12000)]);
const flat = (s) => (s || '').replace(/\s+/g, ' ').trim();
const T0 = Date.now();
const el = () => Math.round((Date.now() - T0) / 1000);
const log = (...a) => console.log(`[fmsj][${el()}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// 副本内已知怪物名（25 间实测全集）。长名在前，避免「精英·艾斯」被短名截断。
const KNOWN = [
    '破碎星灵', '卡魂之主',
    '精英·贪婪的哥布林', '精英·巨型仙人掌', '精英·变异向日葵', '精英·变异魔鬼鱼', '精英·变异史莱姆',
    '精英·莫迪奥拉', '精英·莱温特', '精英·巴德拉', '精英·飞翼兽', '精英·灰太狼', '精英·泉州路霸',
    '精英·幽灵', '精英·偷矿者', '精英·巨熊', '精英·白野象', '精英·吸血僵尸', '精英·天狼蜘蛛',
    '精英·火蝙蝠', '精英·假太监', '精英·艾斯', '精英·狼人',
].sort((a, b) => b.length - a.length);

// ==================== 页面原语 ====================
async function gotoGame(page) {
    for (let i = 1; i <= 3; i++) {
        try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); return; } catch (e) { await sleep(3000); }
    }
    throw new Error('打开登录页失败（3 次重试均失败）');
}
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
async function tapOkByTouch(page, word = '确定') {
    return Promise.race([page.evaluate((w) => {
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
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, word), evTo(10000)]).catch(() => false);
}

// ★ 点怪只能点「怪物列表」里的元素：精英房间里房间名与怪同名（精英·狼人房里有 2 只精英·狼人），
//   房间名在罗盘中心（53x16）比怪物条目（59x19）更小，按「同文字取最小面积」会稳定点到房间标题
//   → 11-22 首跑 21 间全部 nopanel，一只精英都没打成。
async function monsterItems(page) {
    return Promise.race([page.evaluate(() => {
        const out = [];
        for (const it of document.querySelectorAll('.monster-list .monster-item')) {
            const t = (it.textContent || '').trim();
            if (t) out.push(t);
        }
        return out;
    }), evTo(10000)]).catch(() => []);
}
async function clickMonster(page, name) {
    const pos = await Promise.race([page.evaluate((nm) => {
        for (const it of document.querySelectorAll('.monster-list .monster-item')) {
            if ((it.textContent || '').trim() !== nm) continue;
            const r = it.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
    }, name), evTo(10000)]).catch(() => null);
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y);
    return true;
}

async function login(page) {
    for (let a = 1; a <= 10; a++) {
        const ins = await page.$$('input');
        if (ins.length < 2) {
            const t = await txt(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) return true;
            await gotoGame(page); await sleep(3000); continue;
        }
        await ins[0].fill(ACC); await ins[1].fill(PASSWORD);
        await page.getByText('登录').first().click().catch(() => { });
        await sleep(3000);
        let t = await txt(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            log('登录成功');
            for (let i = 0; i < 8; i++) {
                await daily.clickText(page, '进入游戏', 2000).catch(() => { });
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

// ==================== 副本页解析 ====================
const inDungeon = (t) => t.includes('副本条件') || (t.includes('退出副本') && t.includes('回到起点'));
const condLeft = (t) => {
    const m = t.match(/破碎星灵[:：]\s*(\d+)/);
    return m ? Number(m[1]) : null;
};
const leftMin = (t) => {
    const m = t.match(/副本剩余时间[:：]\s*(\d+)/);
    return m ? Number(m[1]) : null;
};
// ★ 「本房间有哪些怪」只看「你看到：」段（到第一个出口前）。
//   否则起点页的条件行「破碎星灵:2」会被当成怪（11-22 冷1 就是这么空退一次本的）。
const seenSeg = (t) => ((t.split('你看到：')[1] || '').split(/北：|南：|东：|西：/)[0] || '');
const claimModal = (t) => /是否领[取奖]|确认领取|是否退出|是否离开/.test(t);
const exitModal = (t) => /是否退出|是否离开/.test(t);
const bloodLine = (t) => {
    const b = (t.match(/血池[:：]\s*(\d+)/) || [])[1];
    const hp = (t.match(/体力[:：]\s*([\d]+\/[\d]+)/) || [])[1];
    return `血池=${b === undefined ? '?' : b} 体力=${hp || '?'}`;
};

// ==================== 导航 ====================
async function gotoVenice(page) {
    let t = await txt(page);
    if (t.includes('当前城市：威尼斯')) { log('已在威尼斯（钓鱼同一张图，直接用城内地图）'); return true; }
    log('不在威尼斯，出航…');
    log('sailTo: ' + (await daily.sailTo(page, '威尼斯').catch((e) => 'err ' + e.message)));
    await sleep(3000);
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(1200);
    return (await txt(page)).includes('当前城市：威尼斯');
}

// 回 { ok, reason }：reason='used' 表示今天这次已经用掉了（不报错，正常跳过）
async function gotoEntry(page) {
    let faCount = 0;
    for (let i = 1; i <= 14; i++) {
        const t = await txt(page);
        if (t.includes('进入副本') && !/次数已用尽|次数为\s*0|今日已完成/.test(t)) { log('已到附魔秘境入口页'); return { ok: true }; }
        if (/次数已用尽|次数为\s*0|今日已完成/.test(t)) { log('今日次数已用尽（入口页原文）→ 本步跳过'); return { ok: false, reason: 'used' }; }
        if (t.includes('附魔秘境')) {
            log(`[${i}] 点「附魔秘境」`);
            if (!(await clickHard(page, '附魔秘境', true))) await clickHard(page, '附魔秘境', false);
            await sleep(3000); continue;
        }
        if (t.includes('附魔师') && faCount < 3) {
            faCount++; log(`[${i}] 点「附魔师」NPC（它才是开附魔秘境入口的人）`);
            await clickHard(page, '附魔师', false); await sleep(2800); continue;
        }
        if (t.includes('铁匠铺') && faCount === 0) {
            log(`[${i}] 点「铁匠铺」`);
            await clickHard(page, '铁匠铺', false); await sleep(2800); continue;
        }
        log(`[${i}] 城内地图 → 铁匠铺`);
        if (await clickHard(page, '城内地图', false)) await sleep(2600);
        await clickHard(page, '铁匠铺', false); await sleep(2800);
    }
    log('::error::没走到附魔秘境入口页');
    return { ok: false, reason: 'nav' };
}

async function enter(page) {
    let t = await txt(page);
    if (inDungeon(t)) { log('已在副本内（续跑）'); return true; }
    log('点「进入副本」');
    await clickHard(page, '进入副本', false);
    await sleep(2800);
    for (const w of ['确定', '确认']) if (await clickLeaf(page, w, true).catch(() => false)) { await sleep(2200); break; }
    for (let i = 0; i < 20; i++) {
        await sleep(2000);
        t = await txt(page);
        if (inDungeon(t)) { log(`已进本（约 ${(i + 1) * 2}s）| 剩余 ${leftMin(t)} 分钟 | 条件 破碎星灵:${condLeft(t)}`); return true; }
    }
    log('::error::进本失败: ' + flat(t).slice(0, 200));
    return false;
}

async function walkNorth(page) {
    const ls = await leaves(page);
    const n = ls.filter((x) => /^北：/.test(x.t)).sort((a, b) => a.a - b.a)[0];
    if (!n) return false;
    log('向北 → ' + n.t);
    await page.mouse.click(n.x, n.y);
    await sleep(3200);
    return true;
}

// 条件满后可能弹「是否领取奖励」——清怪阶段一律点「取消」，领奖留到清完统一做
async function dismissClaimAsk(page) {
    log('  出现领奖确认框 → 点「取消」，领奖留到清完统一做');
    for (const w of ['取消', '关闭']) {
        if (await clickLeaf(page, w, true).catch(() => false)) { await sleep(1600); return true; }
    }
    log('::warning::没找到「取消」，保留原状');
    return false;
}

let REVIVED = false;      // 副本内只复活一次
async function reviveOnce(page) {
    const l = (await leaves(page)).filter((x) => x.t === '复活').sort((a, b) => a.a - b.a)[0];
    if (!l) return false;
    log('人物死亡 → 点「复活」（副本内仅 1 次）');
    await page.mouse.click(l.x, l.y);
    await sleep(2200);
    for (const w of ['确定', '确认']) {
        if (await clickLeaf(page, w, true).catch(() => false)) { await sleep(2000); break; }
        await tapOkByTouch(page, w); await sleep(2000);
    }
    REVIVED = true;
    return !(await leaves(page)).some((x) => x.t === '复活');
}

// ==================== 打一只 ====================
// {res:'win'|'dead'|'stuck'|'nopanel', hits, why}
async function fightOne(page, name) {
    if (!(await clickMonster(page, name))) {
        if (!(await clickLeaf(page, name, true))) {
            if (!(await jsClick(page, name, true))) return { res: 'nopanel', hits: 0, why: '点不到怪' };
        }
    }
    await sleep(1600);
    let t = await txt(page);
    if (!t.includes('攻击') && !t.includes('关闭') && !claimModal(t)) {
        if (t.includes('挑战')) {
            for (const w of ['确定', '确认', '挑战']) {
                if (t.includes(w) && (await clickHard(page, w, true).catch(() => false))) { await sleep(1400); break; }
            }
            t = await txt(page);
        }
    }
    if (!t.includes('攻击') && !t.includes('关闭')) {
        await jsClick(page, name, true); await sleep(1600); t = await txt(page);
    }
    if (!t.includes('攻击')) return { res: 'nopanel', hits: 0, why: flat(t).slice(0, 160) };

    log(`  开打 ${name} | ${bloodLine(t)}`);
    let hits = 0, heals = 0;
    for (let a = 0; a < MAX_HITS; a++) {
        t = await txt(page);
        if (t.includes('复活')) return { res: 'dead', hits };
        if (t.includes('关闭')) {
            await clickLeaf(page, '关闭', true); await sleep(600);
            return { res: 'win', hits };
        }
        if (t.includes('攻击')) {
            if (drain.readBlood(t) === 0) {
                if (heals >= 1) { log('  血池 0 且已补过一次 → 判打不动'); return { res: 'stuck', hits, why: '血池0无药' }; }
                heals++;
                log('  血池 0 → 退出去补体力宝');
                const h = await drain.healBlood(page, { tag: `补血池·${name}`, inDungeon: true, log: (m) => log('  ' + m) });
                if (!h.ok) { log(`  补药失败（${h.reason}）→ 判打不动，按既有铁律继续硬打的场景这里不适用（本副本怪不强）`); return { res: 'stuck', hits, why: '补药失败:' + h.reason }; }
                if (!(await clickLeaf(page, name, true))) { log('  补药后点不回怪'); return { res: 'stuck', hits, why: '点不回' }; }
                await sleep(900); continue;
            }
            if (hits % 20 === 0) log(`  第 ${hits} 刀 | ${bloodLine(t)}`);
            await clickLeaf(page, '攻击', true); hits++; await sleep(300); continue;
        }
        await sleep(450);
    }
    log(`  ${MAX_HITS} 刀仍未结算 → 判打不动`);
    await clickLeaf(page, '关闭', true).catch(() => { });
    return { res: 'stuck', hits, why: 'no-settle' };
}

// ==================== 领奖（与基德/炼器窟同一套） ====================
const toastOf = (toast) => {
    const norm = (toast || '').replace(/\s+/g, '');
    const got = {};
    for (const n of [...Object.keys(FMSJ_REWARDS), ...FMSJ_EXTRA]) {
        const m = norm.match(new RegExp(n + '[×*x](\\d+)'));
        if (m) got[n] = Number(m[1]);
    }
    return got;
};

async function claim(page) {
    let pageText = await txt(page);
    if (NO_CLAIM) {
        const ci = pageText.indexOf('副本条件');
        const cj = pageText.indexOf('回到起点', ci);
        log('FMSJ_NO_CLAIM=1：不领奖、不退本，留副本内待人工查验');
        log('条件行:', ci >= 0 ? pageText.substring(ci, cj > ci ? cj : ci + 120) : '(未见)');
        return { ok: false, skipped: true };
    }
    if (!pageText.includes('领取奖励')) {
        log('::warning::页面上没有「领取奖励」入口 → 领不到（条件未满足或已领过）');
        log('页面:', flat(pageText).slice(0, 300));
        return { ok: false };
    }
    // ★ 领奖明细 toast 只活 1~2 秒，必须在点「领取奖励」之前挂好轮询（11-19 实证：点完再读什么都抓不到）
    const toastP = drain.readRewardToast(page, 9000).catch(() => '');
    let got = false;
    for (let round = 1; round <= 4; round++) {
        pageText = await txt(page);
        if (!pageText.includes('副本条件')) { got = true; break; }
        if (!pageText.includes('领取奖励')) { got = true; break; }
        log(`领取奖励（第 ${round} 轮）...`);
        if (!(await drain.clickByText(page, '领取奖励'))) { log('「领取奖励」点不到'); break; }
        await sleep(1500);
        await drain.dismissPopups(page, { log: log });
        await sleep(1500);
    }
    const toast = (await toastP) || '';
    let toastOk = false;
    if (toast) {
        log('领奖明细：' + toast);
        const gotItems = toastOf(toast);
        const hit = Object.keys(FMSJ_REWARDS).filter((n) => gotItems[n] >= FMSJ_REWARDS[n]);
        const extra = FMSJ_EXTRA.filter((n) => gotItems[n] !== undefined);
        if (hit.length) {
            toastOk = true;
            log('✔ 领奖到账（明细原文）: ' + hit.map((n) => `${n}×${gotItems[n]}（需 ${FMSJ_REWARDS[n]}）`).join('，'));
        } else if (Object.keys(gotItems).length) {
            log('::warning::明细里数量不足: ' + Object.keys(gotItems).map((n) => `${n}×${gotItems[n]}`).join('，'));
        } else {
            log('（明细里没有本副本奖励项，可能只结算了经验/铜币）');
        }
        if (extra.length) log('明细附带: ' + extra.map((n) => `${n}×${gotItems[n]}`).join('，'));
    } else {
        log('::warning::没抓到领奖明细 toast（只活了 1~2 秒），改用背包增量对账');
    }

    pageText = await txt(page);
    if (!pageText.includes('副本条件')) log('已退出副本（领奖后默认退出），当前城市: ' + (flat(pageText).match(/当前城市[:：]\s*(\S+)/) || [, '?'])[1]);
    else if (!pageText.includes('领取奖励')) log('奖励已领取（入口消失），仍在副本页');
    else { log('::warning::领奖失败：「领取奖励」仍在'); await page.screenshot({ path: 'fmsj-claim-fail.png' }).catch(() => { }); }

    return { ok: toastOk || got, toastOk, by: toastOk ? 'toast' : 'exit' };
}

// ★ 背包增量对账（补充证据，11-19 用户指定口径）：进本前基线 vs 领奖后，只看**增量**。
//   本副本的到账物是宝箱「卡魂碎片箱」，用户明确要求「读背包宝箱」。
//   ★ 必须在退回主视图之后读：包裹按钮只在城市主视图上有，读在浮层上会全返回 null，
//     那样会得出「增量不足」的假结论（11-22 写这版时差点埋进去）。
async function reconcile(page, bagBefore, toastOk) {
    if (!bagBefore) { log('[对账] 没读到进本前基线 → 本次只用领奖明细判据'); return null; }
    if (!(await txt(page)).includes('当前城市')) { log('::warning::不在城市主视图，读不了包裹 → 跳过背包对账'); return null; }
    const names = Object.keys(FMSJ_REWARDS);
    const after = await bag.readBagItems(page, names);
    const show = (v) => (v === null || v === undefined ? '缺失(0)' : v);
    const num = (v) => (v === null || v === undefined ? 0 : v);
    const delta = {};
    for (const n of names) delta[n] = num(after[n]) - num(bagBefore[n]);
    log('[对账] ' + names.map((n) => `${n} ${show(bagBefore[n])}→${show(after[n])}(${delta[n] >= 0 ? '+' : ''}${delta[n]})`).join(' / '));
    const hit = names.filter((n) => delta[n] >= FMSJ_REWARDS[n]);
    if (hit.length) {
        log('✔ 领奖到账（背包增量）: ' + hit.map((n) => `${n} +${delta[n]}（需 +${FMSJ_REWARDS[n]}）`).join('，'));
        return true;
    }
    if (toastOk) { log('（明细原文已确认到账，背包增量没体现属正常：宝箱可能直接进系统）'); return null; }
    log('::warning::背包增量不足（' + names.map((n) => `${n} +${delta[n]}`).join('，') + '）');
    return false;
}

// 领完奖退回的是「附魔秘境入口页」（铁匠铺里的浮层），下一步是威尼斯的秘宝抽奖，
// 所以必须退回主视图，否则后面那步会对着浮层找按钮。
async function backToCityView(page) {
    for (let i = 0; i < 4; i++) {
        if ((await txt(page)).includes('当前城市')) return true;
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(1200);
        if ((await txt(page)).includes('当前城市')) return true;
        for (const w of ['返回', '关闭']) {
            if (await clickLeaf(page, w, true).catch(() => false)) { await sleep(1500); break; }
        }
        if ((await txt(page)).includes('当前城市')) return true;
        await Promise.race([page.mouse.click(14, 26), evTo(8000)]).catch(() => { });   // 左上返回箭头
        await sleep(1500);
    }
    const t = await txt(page);
    if (!t.includes('当前城市')) log('::warning::领奖后没退回主视图，页面: ' + flat(t).slice(0, 200));
    return t.includes('当前城市');
}

// ==================== 主流程 ====================
const bag = createBagReader({ getPageText: daily.getPageText, log: log });

async function main() {
    // 大号限定：131 级小号满血一刀被秒（11-22 冷2 实测 dead/1 刀），这步只给大号跑。
    if (/^coldwind\d+$/.test(ACC) && process.env.FMSJ_FORCE !== '1') {
        log(`${ACC} 是小号 → 跳过附魔秘境（131 级实测满血一刀被秒，本副本不是给小号刷的；确有需要时 FMSJ_FORCE=1）`);
        return 0;
    }
    if (!PASSWORD) { log('::error::没有 GAME_PASSWORD'); return 1; }
    acct.guard(ACC, { tag: 'fmsj.js' });

    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    const st = { killed: {}, failed: {}, skipped: {}, rooms: 0, stops: '', claimed: false };
    let code = 0;
    try {
        await gotoGame(page); await sleep(3000);
        if (!(await login(page))) { log('::error::登录失败'); return 1; }
        await sleep(3000);
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(1200);

        // 基线：进本前在城里读一次背包（宝箱页），领奖后比增量。
        // ★ 续跑（登录时已在副本内）时读不到包裹 → 基线置空，只用明细原文判据，别拿 0 当基线。
        let bagBefore = null;
        const cityNow = (await txt(page)).includes('当前城市');
        if (!NO_CLAIM && cityNow) {
            const names = Object.keys(FMSJ_REWARDS);
            bagBefore = await bag.readBagItems(page, names);
            const show = (v) => (v === null || v === undefined ? '缺失(0)' : v);
            log('[基线] ' + names.map((n) => `${n}=${show(bagBefore[n])}`).join(' / '));
        } else if (!NO_CLAIM) {
            log('[基线] 不在城市主视图（可能已在副本内续跑）→ 本次只用领奖明细判据');
        }

        if (!inDungeon(await txt(page))) {
            if (!(await gotoVenice(page))) { log('::error::没到威尼斯'); return 0; }
            const g = await gotoEntry(page);
            if (!g.ok) return g.reason === 'used' ? 0 : 1;   // 次数已用尽属正常跳过，不去把它记成失败
            if (!(await enter(page))) return 1;
            await sleep(2500);
        } else {
            log('登录时已在副本内 → 直接续跑');
        }

        log(SKIP.length ? `跳过名单: ${SKIP.join(' / ')}` : '跳过名单: 无（全刷）');
        for (let room = 1; room <= MAX_ROOMS; room++) {
            let t = await txt(page);
            if (!inDungeon(t)) { st.stops = `第 ${room} 间前已不在副本内`; break; }
            st.rooms = room;
            log(`—— 第 ${room} 间 —— 剩余 ${leftMin(t)} 分钟 | 条件 破碎星灵:${condLeft(t)}`);
            log(`  本间怪物段: 「${seenSeg(t)}」`);

            let guard = 0;
            while (guard++ < 12) {
                t = await txt(page);
                if (claimModal(t)) {
                    if (exitModal(t)) { st.stops = '出现「是否退出」确认框 → 不退本，停手'; log(`::warning::${st.stops}`); break; }
                    await dismissClaimAsk(page); t = await txt(page); continue;
                }
                if (leftMin(t) !== null && leftMin(t) <= 3) { st.stops = '副本剩余时间 ≤3 分钟 → 停手领奖'; log(`::warning::${st.stops}`); break; }
                const names = await monsterItems(page);
                const cnt = {};
                for (const nm of names) cnt[nm] = (cnt[nm] || 0) + 1;
                const list = Object.entries(cnt).map(([name, n]) => ({ name, n }));
                const unknown = list.filter((m) => !KNOWN.includes(m.name));
                if (unknown.length) log(`  ⚠ 名单外的怪: ${unknown.map((u) => `${u.name}×${u.n}`).join('、')}`);
                const skipHere = list.filter((m) => SKIP.includes(m.name));
                if (skipHere.length && guard === 1) {
                    log(`  按名单跳过: ${skipHere.map((s) => `${s.name}×${s.n}`).join('、')}`);
                    for (const s of skipHere) st.skipped[s.name] = (st.skipped[s.name] || 0) + s.n;
                }
                const todo = list.filter((m) => !SKIP.includes(m.name) && !st.failed[`${room}|${m.name}`]);
                if (!todo.length) { log('  本间可打的怪已清完'); break; }

                const target = todo[0];
                const before = target.n;
                const r = await fightOne(page, target.name);
                log(`  结果: ${r.res} / ${r.hits} 刀 ${r.why ? '/ ' + r.why : ''}`);
                if (r.res === 'dead') {
                    st.failed[`${room}|${target.name}`] = 'dead';
                    // ★ 铁律：战死 → 复活一次 → 立刻停手去领奖，不硬撑第二次死
                    if (!REVIVED) await reviveOnce(page);
                    st.stops = `战死（${target.name}）→ 复活一次后停手领奖`;
                    break;
                }
                if (r.res !== 'win') { st.failed[`${room}|${target.name}`] = r.why || r.res; continue; }
                const afterNames = await monsterItems(page);
                const after = afterNames.filter((x) => x === target.name).length;
                log(`  ${target.name}: ${before} → ${after}`);
                if (after < before) st.killed[target.name] = (st.killed[target.name] || 0) + (before - after);
                else { st.failed[`${room}|${target.name}`] = '打了但房里数量没变'; log('  ⚠ 数量没变 → 记为未清，跳过'); }
                await sleep(800);
            }
            if (st.stops) break;

            t = await txt(page);
            if (claimModal(t)) {
                if (exitModal(t)) { st.stops = '清完本间后出现「是否退出」→ 不退本，停手'; log(`::warning::${st.stops}`); break; }
                await dismissClaimAsk(page);
            }
            if (!(await walkNorth(page))) { st.stops = '到头（无北出口）'; log('没有北出口 → 走到尽头了'); break; }
        }

        // 领奖（不设「房间清完」门槛：条件一满足就该领，别让某只怪吃掉整次奖励）
        const t = await txt(page);
        const cond = condLeft(t);
        log(`清怪阶段结束 | 条件 破碎星灵:${cond} | 剩余 ${leftMin(t)} 分钟`);
        if (cond === 0) {
            const c = await claim(page);
            st.claimed = !!c.ok;
            if (!c.ok && !c.skipped) code = 1;
            // 领奖后先退回主视图（包裹按钮只在城市主视图上有），再做背包宝箱对账
            if (!c.skipped) {
                await backToCityView(page);
                await reconcile(page, bagBefore, !!c.toastOk);
            }
        } else if (!inDungeon(t)) {
            st.stops = '清怪结束时已不在副本内（可能已被领奖或踢出）';
            log(`::warning::${st.stops}`);
            await page.screenshot({ path: 'fmsj-not-in-dungeon.png' }).catch(() => { });
        } else {
            st.stops = st.stops || `条件未满足（破碎星灵:${cond}）→ 不领奖、不退本`;
            log(`::warning::${st.stops}`);
            log('★ 当天这次机会已花掉，按铁律不退本：号留在副本内，下波登录会续跑');
            code = 1;
        }

        st.total = Object.values(st.killed).reduce((a, b) => a + b, 0);
        log('===== 汇总 =====');
        log(`房间 ${st.rooms} 间 | 清怪 ${st.total} 只 | 领奖 ${st.claimed ? 'ok' : (NO_CLAIM ? '按 FMSJ_NO_CLAIM 跳过' : '未领到')}`);
        log(`击杀明细: ${JSON.stringify(st.killed)}`);
        log(`按名单跳过: ${Object.keys(st.skipped).length ? JSON.stringify(st.skipped) : '无'}`);
        log(`失败明细: ${JSON.stringify(st.failed)}`);
        log(`停手原因: ${st.stops || '全部房间走完'}`);
        const tf = await txt(page);
        log(`终态: ${flat(tf).slice(0, 240)}`);
    } catch (e) {
        log('异常: ' + e.message);
        // 异常兜底领奖：人很可能还在副本里、条件已满足，别把奖励丢掉
        if (!NO_CLAIM) {
            try {
                const t = await txt(page);
                if (t.includes('领取奖励')) {
                    log('异常兜底：页面仍有「领取奖励」→ 尽力领一次');
                    for (let i = 0; i < 3; i++) {
                        if (!(await txt(page)).includes('领取奖励')) break;
                        if (!(await drain.clickByText(page, '领取奖励'))) break;
                        await sleep(1500);
                        await drain.dismissPopups(page, { log: log });
                        await sleep(1500);
                    }
                    log('异常兜底结束（入口' + ((await txt(page)).includes('领取奖励') ? '仍在 → 未领到' : '已消失 → 已领') + '）');
                }
            } catch (e2) { log('::warning::异常兜底领奖也没走通: ' + e2.message); }
        }
        await page.screenshot({ path: 'fmsj-error.png' }).catch(() => { });
        code = 1;
    } finally {
        await browser.close().catch(() => { });
        log(`本次退出码 ${code}`);
    }
    return code;
}

if (require.main === module) {
    main().then((c) => process.exit(c)).catch((e) => { console.error('错误:', e.message); process.exit(1); });
}
// 以下导出只给单测用（`node fmsj-test.js` 校验解析口径），被 require 时不会跑主流程
module.exports = { condLeft, leftMin, seenSeg, toastOf, KNOWN, FMSJ_REWARDS, SKIP, DEFAULT_SKIP };
