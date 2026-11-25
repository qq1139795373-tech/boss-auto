// 情侣迷宫 · 双人组队进本（单进程两个浏览器，两个号同时在线）
//
// 规则来源（用户 2026-11-22）：
//   1) 20:37 副本详情：入口 威尼斯·教堂·证婚人·红娘·「情侣迷宫」；条件「击杀 银锁 ×1」；
//      奖励 经验8888 / 银贝99 / 一只玫瑰×9；「需与交往/已婚伴侣 2 人组队，每日 1 次」。
//   2) 20:57「是谁创建的谁操作进本，另一个人需要点击准备」→ 队长建队+进本，队员点准备。
//   3) 21:02「一个号杀完怪就行，另一个号只需要上号领取奖励」→ 只队长打怪，队员挂机后领奖。
//   4) 21:09「今天一缕寒风+笑嘻了为了录视频已经跑过了」→ 本轮用 冷0(笑嘻L) + 冷8(笑嘻嘻) 这对。
//   5) 21:05 情侣配对实测（qllm-couple-scan.js）：
//        冷0 笑嘻L(132) ↔ 冷8 笑嘻嘻(132)；冷1 笑呵呵(132) ↔ 冷2 笑哈哈(132)；
//        冷6 笑嘻了(134) ↔ 大号 一缕寒风(160)。
//
// 视频实证（2026-11-22 20-53-45.mp4，大号视角）：
//   队伍面板空 → 情侣迷宫入口页点「创建队伍」→ 队伍立刻建好（1 人，我是队长，标签「副本：情侣迷宫」）
//   → 队伍面板「邀请」→ 好友列表里点伴侣的「邀请」→ 切小号接受（邀请是持久的，跨登录仍在）
//   → 队长点「进入副本」→ 副本内「花园入口」，唯一出口「南：相思径」
//   → 战斗是回合制浮层（点怪→自动打→结算→关闭），小怪「迷情小妖」、末段「钻石守卫」
//   → 条件变成「银锁:0」时，条件行旁出现「领取奖励」可点。
//
// 用法（boss-auto 目录）：
//   node -r ./local-proxy-bypass.js qllm-run.js
//   MODE=team        只做组队（建队/邀请/接受/准备），不进本 —— 用来确认按钮文字，不消耗次数
//   MODE=full        组队后进本、队长清怪、领奖（队长这一侧跑完就结束）
//   MODE=memberclaim 队员单独上号领奖（队长那一趟已经退号之后）
//   MODE=bag         读背包（一只玫瑰等材料数量），用来核对奖励到账
//
// ★★ 本副本是「分部操作」，不是缺陷（用户 2026-11-23 21:00 纠正）：
//   队长领奖不会把队员带出副本，队员页面上的条件仍是「银锁:1」（客户端缓存，条件本身队伍共享）。
//   用户的操作一直是：队长打完领奖 → 退大号 → 登小号 → 队员侧点「领取奖励」。
//   所以完整流程固定是两段，缺一不可：
//     ① MODE=full LEADER=冷A MEMBER=冷B        （队长清怪 + 领奖，结束即退出）
//     ② MODE=memberclaim MEMBER=冷B            （队员单独上号领奖，约 20 秒）
//   不要试图在 ① 里顺手让队员领奖：队员那一侧的连接在队长领奖时已经失效，
//   必须在队长退号后重新登录才会同步成「银锁:0」。
//
// ★ 只有本副本需要两个人同时进本（用户 2026-11-22 22:56：「其余副本虽说有需要组队的地方，
//   但是都可以创建队伍后单人入本」）—— 所以只有这里会同时登两个号、需要两份密码：
//     同小号对：GAME_PASSWORD=a12345678 即可（两号同类，一份密码通用）
//     大号+冷6 ：必须分开给 GAME_PASSWORD_LEADER=大号密码 GAME_PASSWORD_MEMBER=小号密码，
//                只给一份 GAME_PASSWORD 会在启动时直接报错退出，不会拿错密码去登。
const { chromium } = require('playwright');
const daily = require('./daily.js');
const { evTo, createBagReader } = require('./bag-read.js');
const acct = require('./acct-lock.js');

const { LOGIN_URL: URL } = require('./game-url.js');
const pass = require('./account-pass.js');
const LEADER = process.env.LEADER || 'coldwind0';        // 笑嘻L 132 —— 建队 + 进本 + 杀怪
const MEMBER = process.env.MEMBER || 'coldwind8';        // 笑嘻嘻 132 —— 接受邀请 + 准备 + 领奖
// ★ 两个号分别解析密码（11-22 用户提醒「大号小号密码不一样的，不要弄错了」）：
//   情侣迷宫的三对组合里有一对是「大号一缕寒风 + 冷6 笑嘻了」，大号密码与冷N 不同，
//   一份 GAME_PASSWORD 不可能同时登对两个号 → 优先读 GAME_PASSWORD_LEADER / GAME_PASSWORD_MEMBER，
//   两边都落到公用 GAME_PASSWORD 且类别不同时直接报错退出，不用错密码硬登。
const MODE = process.env.MODE || 'team';
// memberclaim 只登队员一个号（队长把怪打完、领完奖下线了），此时不为队长要密码
const NEED_LEADER = MODE !== 'memberclaim';
// leave 只登队长一个号（队长解散队伍，队员自动离队），此时不为队员要密码
const NEED_MEMBER = MODE !== 'leave';
const LEADER_AUTH = NEED_LEADER ? pass.resolveOrExit(LEADER, process.env, 'LEADER') : null;
const MEMBER_AUTH = NEED_MEMBER ? pass.resolveOrExit(MEMBER, process.env, 'MEMBER') : null;
try {
    pass.assertDistinctPasswords([LEADER_AUTH, MEMBER_AUTH]);
} catch (e) {
    console.log('::error::' + e.message);
    process.exit(2);
}
const PWD_OF = {};
if (MEMBER_AUTH) PWD_OF[MEMBER] = MEMBER_AUTH.password;
if (LEADER_AUTH) PWD_OF[LEADER] = LEADER_AUTH.password;
console.log(`[qllm] 本次登录：${LEADER_AUTH ? '队长 ' + pass.describe(LEADER_AUTH) : '队长不登录（memberclaim）'} / ${MEMBER_AUTH ? '队员 ' + pass.describe(MEMBER_AUTH) : '队员不登录（leave）'}`);
const PARTNER_NICK = process.env.PARTNER_NICK || '笑嘻嘻';
const TEAM_NAME = process.env.TEAM_NAME || '一起战斗吧！';
// 单场战斗的墙上时钟上限（不是「多少秒能打完」的猜测，只是读不到任何状态时的死兜底）：
// 银锁实测 160~230s，留到 10 分钟；正常打赢立刻 return，不会真等满。
const FIGHT_MAX_MS = Number(process.env.FIGHT_MAX_MS || 600000);

// ★ 清怪阶段的墙上时钟预算（11-23 23:37 用户「刷副本里也有一条判断，没刷干净再跑一轮房间，
//   这些冗余你不考虑进去吗」—— 之前只按实测 396s/690s 做计划，把重试路径全漏了）。
//   代码里真实存在的重试（相乘是几十小时，所以不能拿乘积当计划，必须给一个预算）：
//     · clearRoom：每间最多 10 轮「读页面 → 打一只」，任一只打满 FIGHT_MAX_MS(600s) 才放弃
//     · moveBy：每个方向最多重试 3 次 × 2.7s；DFS 每一步最多试 4 个方向 ≈ 32s
//     · DFS：90 步上限（18 间房的实测只用了约 20 步，多出来的是回溯和走不进去的重试）
//   预算用完时的处理**不按步数、按能否领奖**判断：
//     银锁已死（条件归零）→ 立刻停止探索去领奖，保住当天奖励（房间没走完也领得到）
//     银锁没死（领奖按钮不会出现）→ 继续探索，宁可超预算也不能空手退出
//   这样「重试多花的时间」只会挤掉多余的探索，不会把整趟 job 顶到硬超时、连奖都领不到。
const CLEAR_BUDGET_MS = Number(process.env.QLLM_CLEAR_BUDGET_MS || 20 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (s) => (s || '').replace(/\s+/g, ' ').trim();
const txt = (page) => Promise.race([daily.getPageText(page), evTo(12000)]);
const T0 = Date.now();
const el = () => Math.round((Date.now() - T0) / 1000);
const log = (who, ...a) => console.log(`[qllm][${el()}s][${who}]`, ...a);

async function gotoGame(page) {
    for (let i = 1; i <= 3; i++) {
        try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); return; } catch (e) { await sleep(2500); }
    }
    throw new Error('打开登录页失败');
}

async function leaves(page) {
    return Promise.race([page.evaluate(() => {
        const out = [];
        for (const elm of document.querySelectorAll('body *')) {
            if (elm.children.length) continue;
            const s = (elm.textContent || '').trim();
            if (!s || s.length > 34) continue;
            const r = elm.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            out.push({ t: s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), a: Math.round(r.width * r.height) });
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
        const hit = Array.from(document.querySelectorAll('body *')).filter((elm) => {
            if (elm.children.length) return false;
            const t = (elm.textContent || '').trim();
            if (exact ? t !== s : !t.includes(s)) return false;
            const r = elm.getBoundingClientRect();
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
        await sleep(2300);
        if ((await txt(page)) !== before) return true;
    }
    const r = await jsClick(page, s, exact);
    if (r) await sleep(2500);
    return r;
}

async function login(page, acc) {
    // 密码按账号取，不再共用一份（大号/小号密码不同）
    const pw = PWD_OF[acc];
    if (!pw) { log(acc, '::error::这个号没有解析到密码，拒绝用别的号的密码登'); return false; }
    for (let a = 1; a <= 10; a++) {
        const ins = await page.$$('input');
        if (ins.length < 2) {
            const t = await txt(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) return true;
            await gotoGame(page); await sleep(2500); continue;
        }
        await ins[0].fill(acc); await ins[1].fill(pw);
        await page.getByText('登录').first().click().catch(() => { });
        await sleep(3000);
        let t = await txt(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            for (let i = 0; i < 8; i++) {
                await daily.clickText(page, '进入游戏', 2000).catch(() => { });
                await sleep(3800);
                t = await txt(page);
                if (t.includes('你看到') || t.includes('当前城市')) return true;
            }
            return true;
        }
        log(acc, `登录重试 ${a}`);
    }
    return false;
}

async function gotoVenice(page, who) {
    let t = await txt(page);
    if (t.includes('当前城市：威尼斯')) { log(who, '已在威尼斯'); return true; }
    log(who, '出航去威尼斯…');
    await daily.sailTo(page, '威尼斯').catch(() => { });
    await sleep(3000);
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(1200);
    t = await txt(page);
    if (t.includes('当前城市：威尼斯')) { log(who, '已到威尼斯'); return true; }
    log(who, '::error::到不了威尼斯: ' + flat(t).slice(0, 150));
    return false;
}

async function goByExit(page, name) {
    const ls = await leaves(page);
    const hit = ls.filter((x) => new RegExp(`^(东|南|西|北)：\\s*${name}$`).test(x.t.replace(/\s+/g, '')))[0];
    if (!hit) return false;
    await page.mouse.click(hit.x, hit.y);
    return true;
}

// 威尼斯 → 东：教堂 → 红娘 → 情侣迷宫入口页
async function gotoEntry(page, who) {
    let n = 0;
    for (let i = 1; i <= 20; i++) {
        const f = flat(await txt(page));
        if (/情侣迷宫/.test(f) && /进入副本|今日已完成|次数|通关条件|当前副本队伍/.test(f)) {
            log(who, `到入口页（第 ${i} 轮）`);
            return true;
        }
        if (/情侣迷宫/.test(f)) {
            await clickHard(page, '情侣迷宫', false);
            await sleep(2600); continue;
        }
        if (/红娘/.test(f) && n < 5) { n++; await clickHard(page, '红娘', false); await sleep(2500); continue; }
        if (/证婚人/.test(f) && n < 5) { n++; await clickHard(page, '证婚人', false); await sleep(2500); continue; }
        if (/当前城市/.test(f) && /教堂/.test(f)) { await goByExit(page, '教堂'); await sleep(3000); continue; }
        log(who, `[${i}] 未识别页面: ${f.slice(0, 120)}`);
        if (await clickHard(page, '城内地图', false)) await sleep(2500);
    }
    log(who, '::error::没到情侣迷宫入口: ' + flat(await txt(page)).slice(0, 250));
    return false;
}

async function openPage(browser, acc, tag) {
    const page = await (await browser.newContext()).newPage();
    await gotoGame(page); await sleep(2500);
    if (!(await login(page, acc))) throw new Error(`${acc} 登录失败`);
    await sleep(2800);
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(1200);
    // 续跑：人已经在副本里（重登会回到起点，但进度保留）→ 直接原地打，别再走组队流程
    if (inDungeon(flat(await txt(page)))) { log(tag, '已在副本内（续跑）'); return page; }
    if (!(await gotoVenice(page, tag))) throw new Error(`${acc} 到不了威尼斯`);
    if (!(await gotoEntry(page, tag))) throw new Error(`${acc} 到不了情侣迷宫入口`);
    return page;
}

// 退队：入口页只对「不在任何队伍里」的人显示「创建队伍」。
// 11-22 实测：冷0 还在 5 人普通队「一起战斗吧！」里 → 入口页只有「查看队伍」+ 红字「队伍目标是【副本0】」。
// 队长（冷8）面板上有「解散」，队员是「退出队伍」；解散/退出都会弹确认。
// 退队：**队长点「解散」，队员点「退出」**（用户 11-22 21:18 指出，11-20 组队时已验过）。
// 打开队伍面板最稳的入口是副本页的「查看队伍」（底部「队伍」tab 11-22 两次实测点不开）。
async function leaveTeam(page, who, role) {
    let f = flat(await txt(page));
    if (!/队伍名称/.test(f)) {
        if (!(await clickHard(page, '查看队伍', true))) await clickLeaf(page, '队伍', true);
        for (let i = 0; i < 6; i++) {
            await sleep(1500);
            f = flat(await txt(page));
            if (/队伍名称/.test(f)) break;
        }
    }
    if (!/队伍名称/.test(f)) { log(who, '当前不在任何队伍里（队伍面板未出现）'); return true; }
    const mem = f.match(/队伍名称[：:]\s*(\S+)\s*(\S+)/);
    log(who, `队伍面板: ${mem ? mem[1] + ' / ' + mem[2] : ''} | ${f.slice(0, 160)}`);
    const isLeader = /1\.[^\d]{1,8}(\d+)级\(队长\)/.test(f) && f.indexOf('(队长)') < 200;
    const words = role === 'leader' || isLeader ? ['解散', '退出'] : ['退出', '解散'];
    for (const w of words) {
        if (await clickHard(page, w, true)) {
            log(who, `点了「${w}」（${role === 'leader' || isLeader ? '队长' : '队员'}）`);
            await sleep(1800);
            for (const c of ['确定', '确认']) {
                if (await clickHard(page, c, true)) { log(who, `确认「${c}」`); break; }
            }
            await sleep(2500);
            log(who, '退队后: ' + flat(await txt(page)).slice(0, 180));
            return true;
        }
    }
    log(who, '::warning::队伍面板里既没「解散」也没「退出」');
    return false;
}

// 副本页缓存了旧状态（队伍目标/是否显示「创建队伍」）→ 必须退出去重新进一次
async function refreshEntry(page, who) {
    await Promise.race([page.mouse.click(19, 20), evTo(6000)]).catch(() => { });   // 左上返回箭头
    await sleep(2200);
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(1200);
    const f = flat(await txt(page));
    if (/情侣迷宫/.test(f)) { log(who, '⚠ 返回后仍在副本页'); }
    return await gotoEntry(page, who);
}

// 队长：入口页「创建队伍」→ 弹窗（队伍名称 / 入队等级 / 取消 确定）→ 确定
async function createTeam(page) {
    log('队长', '入口页原文: ' + flat(await txt(page)).slice(0, 280));
    if (!(await clickHard(page, '创建队伍', true))) {
        log('队长', '::error::点不到「创建队伍」');
        return false;
    }
    await sleep(2800);
    let f = flat(await txt(page));
    if (/队伍名称/.test(f) && /确定/.test(f)) {
        const ins = await page.$$('input');
        log('队长', `建队弹窗：输入框 ${ins.length} 个`);
        if (ins.length >= 1) {
            await ins[0].fill(TEAM_NAME).catch(() => { });
            await sleep(600);
            if (ins.length >= 2) await ins[1].fill('').catch(() => { });   // 入队等级留空=不限
            await sleep(500);
        }
        if (await clickHard(page, '确定', true)) { log('队长', `已提交队伍名称「${TEAM_NAME}」`); await sleep(3000); }
        else { log('队长', '::error::建队弹窗没有「确定」'); return false; }
    }
    f = flat(await txt(page));
    log('队长', '建队后: ' + f.slice(0, 280));
    return !/请先创建或加入队伍/.test(f);
}

async function invitePartner(page) {
    // 建完队在入口页，需要先进「查看队伍」的队伍面板（队长面板上才是「解散 | 邀请」）
    let f = flat(await txt(page));
    if (!/邀请/.test(f)) {
        await clickHard(page, '查看队伍', true);
        await sleep(2600);
        f = flat(await txt(page));
    }
    log('队长', '队伍面板: ' + f.slice(0, 240));
    if (!(await clickHard(page, '邀请', true))) {
        log('队长', '::error::队伍面板上找不到「邀请」');
        return false;
    }
    await sleep(2500);
    log('队长', '邀请面板: ' + flat(await txt(page)).slice(0, 400));
    // 好友列表里点伴侣那一行的「邀请」（多行同名按钮 → 取与伴侣名 y 最接近的那个）
    const r = await page.evaluate((nick) => {
        const els = Array.from(document.querySelectorAll('body *')).filter((e) => !e.children.length);
        const info = els.map((e) => {
            const t = (e.textContent || '').trim();
            const b = e.getBoundingClientRect();
            return { t, x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
        }).filter((o) => o.w > 0 && o.h > 0);
        const target = info.filter((o) => o.t === nick)[0];
        if (!target) return { ok: false, why: '没找到好友 ' + nick };
        const btns = info.filter((o) => o.t === '邀请' && Math.abs(o.y - target.y) < 30);
        if (!btns.length) return { ok: false, why: '伴侣行没有「邀请」按钮', near: info.filter((o) => Math.abs(o.y - target.y) < 40).map((o) => o.t) };
        return { ok: true, x: btns[0].x, y: btns[0].y };
    }, PARTNER_NICK);
    if (!r.ok) { log('队长', '::error::' + r.why + ' ' + JSON.stringify(r.near || [])); return false; }
    await page.mouse.click(r.x, r.y);
    await sleep(2600);
    log('队长', '邀请后: ' + flat(await txt(page)).slice(0, 300));
    return true;
}

// 队员：进队伍面板的「邀请列表」接受邀请，再点「准备」
async function acceptAndReady(page) {
    let f = flat(await txt(page));
    log('队员', '入口页原文: ' + f.slice(0, 300));
    if (/取消准备/.test(f)) { log('队员', '已处于「准备」状态，无需再点'); return true; }

    // 打开队伍面板：底部「队伍」tab 点不开，用「查看队伍」
    if (!/队伍名称/.test(f)) {
        if (!(await clickHard(page, '查看队伍', true))) await clickLeaf(page, '队伍', true);
        for (let i = 0; i < 5; i++) {
            await sleep(1600);
            f = flat(await txt(page));
            if (/队伍名称/.test(f)) break;
        }
    }
    log('队员', '队伍面板: ' + f.slice(0, 260));

    // 邀请列表页签
    if (/邀请列表/.test(f)) {
        await clickHard(page, '邀请列表', false);
        await sleep(2400);
        f = flat(await txt(page));
        log('队员', '邀请列表: ' + f.slice(0, 320));
    }
    for (const w of ['接受', '同意', '加入']) {
        if (await clickHard(page, w, false)) {
            log('队员', `点了「${w}」`);
            await sleep(2800);
            for (const c of ['确定', '确认']) { if (await clickHard(page, c, true)) { await sleep(1500); break; } }
            break;
        }
    }
    f = flat(await txt(page));
    log('队员', '接受后: ' + f.slice(0, 260));

    // 「准备」可能在队伍面板，也可能要回副本入口页
    if (!/准备/.test(f)) {
        await clickHard(page, '我的队伍', false);
        await sleep(2200);
        f = flat(await txt(page));
    }
    if (/准备/.test(f)) {
        if (await clickHard(page, '准备', true)) { log('队员', '已点「准备」'); await sleep(2800); }
    } else {
        log('队员', '::warning::当前页没有「准备」，返回副本入口页再找');
        await Promise.race([page.mouse.click(19, 20), evTo(6000)]).catch(() => { });
        await sleep(2500);
        f = flat(await txt(page));
        log('队员', '返回后: ' + f.slice(0, 260));
        if (/准备/.test(f) && await clickHard(page, '准备', true)) log('队员', '已点「准备」');
    }
    log('队员', '最终: ' + flat(await txt(page)).slice(0, 300));
    return /准备|2人/.test(flat(await txt(page)));
}

// ==================== 副本内：进本 / 清怪 / 领奖 ====================
// 视频实证（20-53-45.mp4 90~150s）：进本后是「花园入口」，唯一出口「南：相思径」；
// 条件行显示「副本条件：银锁:1」，达成后变「银锁:0 领取奖励」（领取奖励就在条件后面）。
// 战斗是回合制浮层（点怪 → 自动打 → 「你战胜了 XXX」→ 点「关闭」），不需要点「攻击」也能打完。
// ★ 22:34 实测纠正：**「银锁」是同心殿堂里的一只怪**（页面「你看到： 银锁」），
//   不是条件计数里的抽象目标 —— 必须把它当怪打，杀掉后条件才从「银锁:1」变「银锁:0」。
const KNOWN_MON = ['银锁', '迷情小妖', '嫉妒之灵', '情侣守护者', '钻石守卫', '玫瑰精', '花妖', '同心守卫'];

function seenSeg(t) {
    const i = t.indexOf('你看到：');
    if (i < 0) return '';
    let s = t.slice(i + 4);
    for (const cut of ['背包', '副本条件', '退出副本', '回到起点']) {
        const j = s.indexOf(cut);
        if (j >= 0) s = s.slice(0, j);
    }
    return s.trim();
}

function monsIn(t) {
    const seg = seenSeg(t).replace(/\s+/g, '');
    const out = [];
    for (const m of KNOWN_MON) {
        let n = 0, s = seg;
        while (s.includes(m)) { n++; s = s.replace(m, '|'); }
        if (n) out.push({ name: m, n });
    }
    return out;
}

const condLeft = (t) => { const m = flat(t).match(/银锁[:：]\s*(\d+)/); return m ? Number(m[1]) : null; };
// 房间名 = 「你看到：」之后、最后一个方向出口之后的词（页面上房间名永远印在中央格，出口在四周）
const roomOf = (t) => {
    const seg = seenSeg(t).replace(/\s+/g, '');
    const m = seg.match(/(?:[东南西北]：[^\s：]{1,10})*([^\s：]{2,10})$/);
    return (m && m[1]) || '?';
};
const inDungeon = (t) => /副本条件|退出副本/.test(t) && /回到起点|剩余时间/.test(t);
// 入口页「进入副本」按钮上的次数。页面实际有两种写法（2026-11-23 实跑取证）：
//   今天还能做  → 「进入副本（剩余1次）」
//   今天做完了  → 「进入副本（次数已用尽）」
// 两种都要认 —— 只按「剩余N次」写会漏掉用完的状态，于是照样建队邀请，
// 最后卡在「进本超时」报红叉（11-23 22:21 实测就这么红的）。
// 读不到返回 null —— 不拿 null 当 0，否则一次文本抓取失败就会被误判成「今天做过了」，白丢当天这一次。
const runsLeftOf = (t) => {
    const s = String(t || '');
    if (/进入副本[（(]次数已用尽[）)]/.test(s)) return 0;
    const m = s.match(/进入副本[（(]剩余\s*(\d+)\s*次[）)]/);
    return m ? Number(m[1]) : null;
};

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

async function fightOne(page, name, who, capMs = FIGHT_MAX_MS) {
    if (!(await clickMonster(page, name))) {
        if (!(await clickLeaf(page, name, true))) {
            if (!(await jsClick(page, name, true))) return { res: 'nopanel' };
        }
    }
    await sleep(1500);
    let t = await txt(page);
    // 可能先弹「挑战」确认
    if (!/关闭|攻击/.test(t) && /挑战/.test(t)) {
        for (const w of ['确定', '确认', '挑战']) if (await clickHard(page, w, true).catch(() => false)) { await sleep(1400); break; }
        t = await txt(page);
    }
    if (!/关闭|攻击/.test(t)) return { res: 'nopanel', why: flat(t).slice(0, 120) };
    // 情侣迷宫的战斗浮层有「攻击 / 自动攻击 / 撤退」（视频 119s）→ 优先点「自动攻击」，让它一次打完
    // ★ 不能用固定轮数当上限（11-22 冷0/冷1 连续踩）：
    //   原来写死 150 轮，一轮「读页面 0.3s + sleep 0.6~0.7s」≈ 0.9s，实际只等到 ~135s；
    //   同心殿堂的「银锁」血厚，实测要 160~230s → 必然先返回 stuck，再重打一次才赢（白打一遍）。
    //   改成按墙上时钟判定，并且**只在页面真没反应时**才会用满上限；打赢/战死都立刻 return。
    // ★ 23:37 追加：上限还要被「清怪预算的剩余时间」压低（capMs）——否则一只卡死的怪
    //   就能吃掉 10 分钟，把整趟挤到 job 硬超时，最后连领奖都做不到。
    const t0 = Date.now();
    const cap = Math.max(60000, Math.min(FIGHT_MAX_MS, capMs));   // 至少给 60s，别刚出手就被砍
    let auto = false;
    while (Date.now() - t0 < cap) {
        t = await txt(page);
        if (/复活/.test(t)) return { res: 'dead' };
        if (/关闭/.test(t)) { await clickLeaf(page, '关闭', true); await sleep(700); return { res: 'win' }; }
        if (!auto && /自动攻击/.test(t)) { auto = await clickLeaf(page, '自动攻击', true); await sleep(1200); continue; }
        if (/攻击/.test(t)) { await clickLeaf(page, '攻击', true); await sleep(700); continue; }
        await sleep(600);
    }
    return { res: 'stuck', why: `fight>${Math.round(cap / 1000)}s` };
}

// 一间房：清到「你看到：」里没有已知怪为止，最多 8 只，打不动的跳过
// capMs：这只怪最多打多久（由清怪预算的剩余量决定，见 CLEAR_BUDGET_MS）
async function clearRoom(page, who, capMs = FIGHT_MAX_MS) {
    let killed = 0;
    for (let guard = 0; guard < 10; guard++) {
        const t = await txt(page);
        const list = monsIn(t);
        if (!list.length) break;
        const target = list[0].name;
        log(who, `  打 ${target}（本间剩 ${list.map((m) => m.name + '×' + m.n).join('、')}）`);
        const r = await fightOne(page, target, who, capMs);
        log(who, `  → ${r.res}${r.why ? ' ' + r.why : ''}`);
        if (r.res !== 'win') { await sleep(1200); break; }
        killed++;
        if (killed >= 8) break;
    }
    return killed;
}

// 走一个方向：地图是网格（中央当前房间 @260,255，上下 ±57、左右 ±170）。
// 11-22 实测：左右相邻格是**无文字的空白格子**（DOM 里抓不到），只能按坐标点。
const CENTER = { x: 260, y: 255 };
const DIRS = [['up', 0, -57], ['down', 0, 57], ['left', -170, 0], ['right', 170, 0]];

// 11-22 22:32 实测：这个副本左右格子点不动（4 个方向各试一次，左右页面文本完全不变），
// 只有南北一条走廊（花园入口 → 相思径 → 相思径 → …），且房间名重复，不能靠名字判断来路。
const DOWN = { x: 260, y: 312 };
const UP = { x: 260, y: 198 };

// 按方向走：先点「南：xxx」文字，失败再直接 JS click `.direction-area.<dir>` 元素
// （11-22 实测：左右格子是 .direction-area.east/.west，无文字，坐标点击有时打不透）
const DIRNAME = { 北: 'north', 南: 'south', 东: 'east', 西: 'west' };

async function jsClickDir(page, label) {
    const d = DIRNAME[label];
    return Promise.race([page.evaluate((dd) => {
        const el = document.querySelector('.direction-area.' + dd);
        if (!el) return false;
        el.click();
        return true;
    }, d), evTo(8000)]).catch(() => false);
}

// ★ 十字地图的坐标模型（22:30 加，全图探索用）：
//   房间是个十字格子，页面只印相邻四格的名字，东西两侧常常没有名字（只有格子）。
//   以前只顺着「南」往下走，试炼台的东/西两间、同心殿堂的爱心左厅/爱心右厅一次都没进 ——
//   视频实测（20-53-45.mp4 111~157s）试炼台有 6 间带怪，右左厅各 1 只钻石守卫。
const DELTA = { 北: [0, -1], 南: [0, 1], 东: [1, 0], 西: [-1, 0] };
const REVERSE = { 北: '南', 南: '北', 东: '西', 西: '东' };
// 这间房有哪些方向的出口（只看「你看到：」这一段，避免把聊天/条件里的字算进来）
function exitsOf(t) {
    const seg = seenSeg(t).replace(/\s+/g, '');
    const out = [];
    const re = /([北南东西])[:：]/g;
    let m;
    while ((m = re.exec(seg))) if (!out.includes(m[1])) out.push(m[1]);
    return out;
}

async function moveBy(page, label, retry = 3) {
    const d = DIRNAME[label];
    for (let i = 0; i < retry; i++) {
        const before = flat(await txt(page));
        // ① 有文字的出口：点文字
        const ls = await leaves(page);
        const cand = ls.filter((x) => new RegExp('^' + label + '：').test(x.t)).sort((a, b) => a.a - b.a)[0];
        if (cand) await page.mouse.click(cand.x, cand.y);
        else await jsClickDir(page, label);          // ② 无文字的左右格子：直接点 DOM
        await sleep(2700);
        let after = flat(await txt(page));
        if (after !== before) { log('队长', `  ${label} → ${roomOf(after)}`); return after; }
        // ③ 兜底：JS click 方向元素
        if (cand && await jsClickDir(page, label)) {
            await sleep(2700);
            after = flat(await txt(page));
            if (after !== before) { log('队长', `  ${label}(JS) → ${roomOf(after)}`); return after; }
        }
        log('队长', `  ${label} 没反应（第 ${i + 1} 次）`);
        await sleep(1400);
    }
    return null;
}

async function move(page, pt, label) {
    const before = flat(await txt(page));
    await page.mouse.click(pt.x, pt.y);
    await sleep(2300);
    const after = flat(await txt(page));
    if (after === before) return null;
    log('队长', `  ${label} → ${(after.match(/([^\s：]{2,10})\s*(?:你看到|背包)/) || [])[1] || '?'}`);
    return after;
}

async function stepTo(page, dx, dy) {
    await page.mouse.click(CENTER.x + dx, CENTER.y + dy);
    await sleep(2200);
    return flat(await txt(page));
}

async function walkTo(page, fromRoom) {
    const before = flat(await txt(page));
    for (const [name, dx, dy] of DIRS) {
        const after = await stepTo(page, dx, dy);
        if (after === before) continue;                       // 那个方向没格子/点了没反应
        if (!inDungeon(after)) continue;
        // 排除文字出口方向（南：相思径 等）造成的一步往返：只要房间名变了就算走了
        const room = (after.match(/([^\s：]{2,10})\s*(?:你看到|背包)/) || [])[1] || '';
        if (room && room === fromRoom) continue;              // 回到来路，退回去
        log('队长', `  走 ${name} → ${room || '未知房间'}`);
        return { dir: name, dest: room, text: after };
    }
    return null;
}

async function enterDungeon(page, who) {
    let f = flat(await txt(page));
    if (!/进入副本/.test(f)) {
        await Promise.race([page.mouse.click(19, 20), evTo(6000)]).catch(() => { });
        await sleep(2600);
        f = flat(await txt(page));
    }
    log(who, '进本前入口页: ' + f.slice(0, 220));
    if (!/进入副本/.test(f)) { log(who, '::error::找不到「进入副本」'); return false; }
    if (!(await clickHard(page, '进入副本', false))) { log(who, '::error::点不到「进入副本」（队伍未满 2 人/未准备？）'); return false; }
    await sleep(2800);
    for (const w of ['确定', '确认']) { if (await clickLeaf(page, w, true)) { log(who, `确认「${w}」`); await sleep(2500); break; } }
    for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const t = flat(await txt(page));
        if (inDungeon(t)) { log(who, `已进本（约 ${(i + 1) * 2}s）`); return true; }
    }
    log(who, '::error::进本超时: ' + flat(await txt(page)).slice(0, 200));
    return false;
}

async function claimReward(page, who) {
    for (let i = 0; i < 6; i++) {
        const t = flat(await txt(page));
        if (/领取奖励/.test(t)) {
            log(who, '点「领取奖励」');
            if (await clickHard(page, '领取奖励', false)) {
                await sleep(2600);
                for (const w of ['确定', '确认']) { if (await clickLeaf(page, w, true)) { await sleep(1800); break; } }
                const after = flat(await txt(page));
                log(who, '领奖后: ' + after.slice(0, 260));
                return !/领取奖励/.test(after) || /获得/.test(after);
            }
        }
        await sleep(1500);
    }
    log(who, '::warning::没点到「领取奖励」或条件未达成');
    return false;
}

async function main() {
    const a = acct.acquire(LEADER, { tag: 'qllm-run.js' });
    if (!a.ok) { log('队长', `::error::${LEADER} 被占用（${a.st && a.st.tag}）`); return 1; }
    const b = acct.acquire(MEMBER, { tag: 'qllm-run.js' });
    if (!b.ok) { log('队员', `::error::${MEMBER} 被占用（${b.st && b.st.tag}）`); return 1; }

    const browserA = await chromium.launch({ headless: true });
    const browserB = await chromium.launch({ headless: true });
    try {
        // MODE=bag：读背包确认情人玫瑰到账
        if (MODE === 'bag') {
            const p = await (await browserA.newContext()).newPage();
            await gotoGame(p); await sleep(2500);
            if (!(await login(p, MEMBER))) return 1;
            await sleep(3000);
            await p.keyboard.press('Escape').catch(() => { });
            await sleep(1200);
            const bg = createBagReader({ getPageText: daily.getPageText, log: (m) => log('队员', m) });
            const r = await bg.readBagItems(p, ['一只玫瑰', '浴火之蝶', '藏宝图碎片']);
            log('队员', '背包读数: ' + JSON.stringify(r));
            return 0;
        }
        // MODE=memberclaim：队员单独上号领奖（用户 21:02「另一个号只需要上号领取奖励」）
        if (MODE === 'memberclaim') {
            const p = await (await browserA.newContext()).newPage();
            await gotoGame(p); await sleep(2500);
            if (!(await login(p, MEMBER))) return 1;
            await sleep(3500);
            await p.keyboard.press('Escape').catch(() => { });
            await sleep(1500);
            let t = flat(await txt(p));
            log('队员', '登录后: ' + t.slice(0, 220));
            if (!inDungeon(t)) { log('队员', '不在副本内（可能已退出）'); return 0; }
            log('队员', '条件: 银锁:' + condLeft(t));
            // 页面可能是缓存 → 点「回到起点」强制刷新一次
            if (condLeft(t) !== 0) {
                await clickHard(p, '回到起点', false);
                await sleep(3000);
                t = flat(await txt(p));
                log('队员', '回到起点后: ' + t.slice(0, 220) + '｜银锁:' + condLeft(t));
            }
            const ok = await claimReward(p, '队员');
            log('队员', '领奖结果: ' + ok + '｜' + flat(await txt(p)).slice(0, 200));
            return 0;
        }
        // MODE=leave：只把残留的情侣队伍解散掉（队长解散，队员自动离队），不进本、不领奖。
        // 为什么需要：一次中途失败会在服务器上留下「2 人且队员已准备」的队伍，
        // 下次流程虽然开头会 leaveTeam，但队员那侧显示的是「取消准备」不是「准备」，
        // acceptAndReady 找不到按钮会 warning 并绕一圈。用这个模式可以在失败后把现场清干净。
        if (MODE === 'leave') {
            const pl = await (await browserA.newContext()).newPage();
            await gotoGame(pl); await sleep(2500);
            if (!(await login(pl, LEADER))) return 1;
            await sleep(3000);
            await pl.keyboard.press('Escape').catch(() => { });
            await sleep(1200);
            if (!(await gotoVenice(pl, '队长'))) return 1;
            if (!(await gotoEntry(pl, '队长'))) return 1;
            await leaveTeam(pl, '队长', 'leader');
            log('队长', '退出后: ' + flat(await txt(pl)).slice(0, 200));
            return 0;
        }
        // MODE=shot：走到相思径第 2 段，截图 + 抓所有可点元素（确认南出口到底能不能点、点在哪）
        if (MODE === 'shot') {
            const p = await (await browserA.newContext()).newPage();
            await gotoGame(p); await sleep(2500);
            if (!(await login(p, LEADER))) return 1;
            await sleep(3500);
            await p.keyboard.press('Escape').catch(() => { });
            await sleep(1500);
            for (let i = 0; i < 2; i++) { await moveBy(p, '南'); await sleep(800); }
            log('队长', '当前: ' + flat(await txt(p)).slice(0, 200));
            const ls2 = await leaves(p);
            log('队长', 'leaves: ' + ls2.map((x) => `${x.t}@${x.x},${x.y}/${x.a}`).join(' | '));
            const cells = await p.evaluate(() => {
                const out = [];
                for (const e of document.querySelectorAll('*')) {
                    const r = e.getBoundingClientRect();
                    if (!r.width || !r.height || r.width > 340 || r.height > 120) continue;
                    if (Math.abs(r.width - 130) > 60 && Math.abs(r.width - 70) > 40) continue;   // 只留格子尺寸
                    out.push(`${e.tagName}.${(e.className || '').toString().slice(0, 24)}「${(e.textContent || '').trim().slice(0, 10)}」@${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)}/${Math.round(r.width)}x${Math.round(r.height)}`);
                }
                return out.slice(0, 40);
            }).catch(() => []);
            log('队长', '格子: ' + cells.join(' | '));
            await p.screenshot({ path: 'qllm-room3.png' }).catch(() => { });
            return 0;
        }
        // MODE=dumpdungeon：人已在副本内（续跑），只抓可点元素与图形按钮坐标，不动任何东西
        if (MODE === 'dumpdungeon') {
            const pageD = await (await browserA.newContext()).newPage();
            await gotoGame(pageD); await sleep(2500);
            if (!(await login(pageD, LEADER))) return 1;
            await sleep(3500);
            await pageD.keyboard.press('Escape').catch(() => { });
            await sleep(1500);
            const t = flat(await txt(pageD));
            log('队长', '页面: ' + t.slice(0, 300));
            if (inDungeon(t)) {
                const ls = await leaves(pageD);
                log('队长', '可点文字: ' + ls.map((x) => `${x.t}@${x.x},${x.y}/${x.a}`).join(' | '));
                const imgs = await pageD.evaluate(() => {
                    const out = [];
                    for (const e of document.querySelectorAll('*')) {
                        const r = e.getBoundingClientRect();
                        if (!r.width || !r.height || r.width > 90 || r.height > 90) continue;
                        if ((e.textContent || '').trim()) continue;
                        out.push(`${e.tagName}.${(e.className || '').toString().slice(0, 20)}@${Math.round(r.x)},${Math.round(r.y)}/${Math.round(r.width)}x${Math.round(r.height)}`);
                    }
                    return out.slice(0, 40);
                }).catch(() => []);
                log('队长', '无文字图形元素: ' + imgs.join(' | '));
                // 地图格子：副本是网格布局（中央=当前房间，上下左右各一格），格子本身可能没有文字
                const cells = await pageD.evaluate(() => {
                    const out = [];
                    for (const e of document.querySelectorAll('div,span,img')) {
                        const r = e.getBoundingClientRect();
                        if (r.width < 60 || r.width > 320 || r.height < 18 || r.height > 95) continue;
                        out.push({
                            t: (e.textContent || '').trim().slice(0, 14),
                            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                            w: Math.round(r.width), h: Math.round(r.height),
                            cls: (e.className || '').toString().slice(0, 36),
                        });
                    }
                    return out.slice(0, 60);
                }).catch(() => []);
                log('队长', '格子候选: ' + cells.map((c) => `[${c.t}]@${c.x},${c.y}(${c.w}x${c.h},${c.cls})`).join(' | '));
                log('队长', '视口: ' + JSON.stringify(await pageD.evaluate(() => ({ w: innerWidth, h: innerHeight })).catch(() => ({}))));
                // 四个方向逐个试，每次点完记下页面文本和截图，再点反方向回位
                const before = flat(await txt(pageD));
                log('队长', '起点: ' + before.slice(0, 160));
                for (const [name, dx, dy] of DIRS) {
                    await pageD.mouse.click(CENTER.x + dx, CENTER.y + dy);
                    await sleep(2300);
                    const t1 = flat(await txt(pageD));
                    log('队长', `→${name}: ${t1.slice(0, 170)}`);
                    await pageD.screenshot({ path: `qllm-dir-${name}.png` }).catch(() => { });
                    await pageD.mouse.click(CENTER.x - dx, CENTER.y - dy);
                    await sleep(2300);
                    const t2 = flat(await txt(pageD));
                    log('队长', `  ←回: ${t2 === before ? '回到起点' : t2.slice(0, 120)}`);
                }
                await pageD.screenshot({ path: 'qllm-dungeon.png' }).catch(() => { });
            } else {
                log('队长', '不在副本内');
            }
            return 0;
        }
        // 两个号并行登录（各自约 90s，串行会翻倍）
        const [pageA, pageB] = await Promise.all([
            openPage(browserA, LEADER, '队长'),
            openPage(browserB, MEMBER, '队员'),
        ]);
        // MODE=dump：把入口页所有可点元素与截图落盘，用来定位「创建队伍」到底长什么样
        if (MODE === 'dump') {
            for (const [pg, who] of [[pageA, '队长'], [pageB, '队员']]) {
                const ls = await leaves(pg);
                log(who, '可点元素: ' + ls.map((x) => `${x.t}@${x.x},${x.y}/${x.a}`).join(' | '));
                await pg.screenshot({ path: `qllm-entry-${who}.png` }).catch(() => { });
            }
            // 继续点「查看队伍」，看队伍列表页有没有创建/加入/目标设置
            await clickHard(pageA, '查看队伍', true);
            await sleep(2800);
            const ls2 = await leaves(pageA);
            log('队长', '查看队伍页文字: ' + flat(await txt(pageA)).slice(0, 500));
            log('队长', '查看队伍页可点: ' + ls2.map((x) => `${x.t}@${x.x},${x.y}/${x.a}`).join(' | '));
            await pageA.screenshot({ path: 'qllm-teamview-队长.png' }).catch(() => { });
            return 0;
        }
        // 两号都还在副本里（今天那次已用掉、未打完）→ 直接续跑，不要再走组队
        const inA0 = inDungeon(flat(await txt(pageA)));
        const inB0 = inDungeon(flat(await txt(pageB)));
        if (inA0 && inB0) {
            log('队长', '两号都在副本内 → 跳过硬队流程，直接续跑');
        } else {
            // ★ 幂等：今天已经做过了就别再建队（2026-11-23 加，为了能挂进每日任务链重复触发）。
            //   入口页显示「进入副本（剩余 0 次）」时，「创建队伍」按钮根本不存在，
            //   createTeam 会返回 false → 整步变成红叉，看起来像故障，实际是正常状态。
            //   这里返回 3（不是 1）：调用方 qllm-daily.js 据此跳过第二段，不再白登录一次队员号。
            //   放在 inA0/inB0 之后是有意的 —— 人在副本内时次数早就扣了，那种情况要走续跑。
            const runsLeft = runsLeftOf(flat(await txt(pageA)));
            if (runsLeft === 0) {
                log('队长', '今日次数已用完（入口页「剩余 0 次」）→ 今天已完成，不建队、不报错');
                log('队长', '::notice::QLLM_ALREADY_DONE');
                return 3;
            }
            // 队员（冷8）是普通队的队长 → 队长点「解散」，队员点「退出」（11-20 已验证，11-22 用户再次指正）
            // 不解散的话入口页永远是红字「队伍目标是【副本0】，与当前副本不一致」且没有「创建队伍」。
            await leaveTeam(pageB, '队员', 'leader');
            await sleep(2000);
            await leaveTeam(pageA, '队长', 'member');
            await sleep(1500);
            // 副本页缓存旧状态 → 必须退出去重新进
            await refreshEntry(pageA, '队长');
            await refreshEntry(pageB, '队员');
            // 上次跑可能已留下「1 人队长队」→ 入口页会出现「我的 / 队长」标记，此时不必重建
            const fA = flat(await txt(pageA));
            if (/我的/.test(fA) && /队长/.test(fA)) {
                log('队长', '入口页已有自己的队伍，跳过建队');
            } else if (!(await createTeam(pageA))) return 1;
            // 队伍已 2 人时重发邀请没有意义，也点不到「邀请」（面板上是「解散 | 邀请」但列表已无空位）
            if (/2人/.test(fA) && /我的/.test(fA)) {
                log('队长', '队伍已是 2 人，跳过邀请');
            } else if (!(await invitePartner(pageA))) {
                log('队长', '::warning::邀请未成功，继续尝试进本（队伍可能已满或已在队内）');
            }
            await sleep(2000);
            if (!(await acceptAndReady(pageB))) return 1;
            await sleep(1500);
        }

        log('队长', '组队后入口页: ' + flat(await txt(pageA)).slice(0, 400));
        if (MODE !== 'full') { log('队长', 'MODE=team → 只验证组队，不进本'); return 0; }

        // 队长进本（队员已准备，会被一起拉进去）；已在副本内则跳过
        if (!inDungeon(flat(await txt(pageA)))) {
            if (!(await enterDungeon(pageA, '队长'))) return 1;
        } else {
            log('队长', '已在副本内，直接开打');
        }
        log('队员', '当前: ' + flat(await txt(pageB)).slice(0, 200));

        // ★ 全图探索清怪（22:30 改，修「漏怪」）：
        //   旧版只沿「南」一路走到头，于是 ①试炼台的东/西两间、②同心殿堂的爱心左厅/爱心右厅
        //   一次都没进；③一看到「银锁:0」就领奖收工。视频逐秒统计：迷情小妖 14 只（相思径 6 +
        //   试炼台 6 + 盟誓台 2）、银锁 1、钻石守卫 2（左右厅各 1，每只经验+169 银币+94）。
        //   现在按坐标做深度优先：四个方向都试、走不进去就标记并换向、走完一圈按原路回溯；
        //   条件归零也不停，把整张图清空再领奖。
        const visited = new Set(['0,0']);
        const trail = [];
        let pos = [0, 0];
        for (let step = 0; step < 90; step++) {
            const t = flat(await txt(pageA));
            if (!inDungeon(t)) { log('队长', '已离开副本页: ' + t.slice(0, 140)); break; }
            visited.add(pos.join(','));
            const dirs = exitsOf(t);
            const mons = monsIn(t).map((m) => m.name + '×' + m.n).join('、') || '（空）';
            log('队长', `#${step + 1} (${pos[0]},${pos[1]}) ${roomOf(t)}｜银锁:${condLeft(t)}｜出口 ${dirs.join('/') || '无'}｜${mons}`);
            const before = condLeft(t);
            await clearRoom(pageA, '队长');
            const t2 = flat(await txt(pageA));
            if (condLeft(t2) === 0 && before !== 0) log('队长', '  ★ 银锁已死 → 条件归零（继续清完剩下的房间）');
            // 找一个还没去过的相邻格
            let moved = null;
            for (const d of ['南', '东', '西', '北']) {
                if (!dirs.includes(d)) continue;
                const nx = pos[0] + DELTA[d][0], ny = pos[1] + DELTA[d][1];
                if (visited.has(`${nx},${ny}`)) continue;
                if (await moveBy(pageA, d)) { pos = [nx, ny]; trail.push(d); moved = d; break; }
                visited.add(`${nx},${ny}`);       // 点不动 → 这格进不去，别再试
                log('队长', `  ${d} 走不进去 → 标记不可达`);
            }
            if (moved) continue;
            // 四周都去过了 → 沿来路回退一格，继续找别的岔路
            const lastDir = trail[trail.length - 1];
            if (!lastDir) { log('队长', '全图探索完成（起点四周已无新房间）'); break; }
            if (!(await moveBy(pageA, REVERSE[lastDir]))) { log('队长', `回溯 ${REVERSE[lastDir]} 失败 → 停止探索`); break; }
            pos = [pos[0] - DELTA[lastDir][0], pos[1] - DELTA[lastDir][1]];
            trail.pop();
        }
        // 全图清完才领奖；条件没归零说明银锁没打死，也照常试一次（按钮不出现会自动跳过）
        log('队长', `探索结束：走过 ${visited.size} 间房｜银锁:${condLeft(flat(await txt(pageA)))}`);
        await claimReward(pageA, '队长');
        log('队长', '最终: ' + flat(await txt(pageA)).slice(0, 300));
        log('队员', '最终: ' + flat(await txt(pageB)).slice(0, 200));
        return 0;
    } finally {
        await browserA.close().catch(() => { });
        await browserB.close().catch(() => { });
        acct.release(LEADER); acct.release(MEMBER);
    }
}

// 只在被直接执行时才跑主流程；被 require（单测 qllm-daily-test.js 要拿 runsLeftOf）时什么都不做
if (require.main === module) {
    main().then((c) => process.exit(c)).catch((e) => { console.error('错误:', e.message); process.exit(1); });
}
module.exports = { runsLeftOf, inDungeon, condLeft, exitsOf };
