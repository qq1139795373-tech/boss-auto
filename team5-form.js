// 组「一起战斗吧！」普通 5 人队（用户 11-16/11-18 定下的规矩，11-22 用于 11:30 打世界boss 前的战力加成）
//   队长：笑嘻嘻(coldwind8)　队员：一缕寒风(coldwind 大号160) / 笑嘻L(coldwind0) / 笑呵呵(coldwind1) / 笑哈哈(coldwind2)
// 链路（11-15/11-16/11-20/11-22 四次验证过）：
//   队伍面板「创建队伍」= 普通队伍（副本入口建的才是副本队）
//   → 队长逐个「邀请」（点好友行末的「邀请」，每邀一人面板收起，要重开）
//   → 队员「队伍 → 邀请列表 → 同意」→ 队长「我的队伍」复核 5/5
// 不走「队伍列表 → 申请」：服务器上有 63 个同名「一起战斗吧！」队伍，翻不到自己那支。
//
// ★ 11-22 实测（`team5-1122.log`）：从启动到 5/5 共 **165 秒**；组完关掉 4 个队员的浏览器，
//   队伍仍是 5/5；再重新登录，队长看到 5/5、队员看到自己在队里 → **队员离线/重登都不会拆队**。
//   所以「先组队 → 各号下线 → 稍后各自登录打 boss」这条路成立：队伍在服务器上，不依赖队员在线。
//   （用户 23:07 补充：0:00 那趟副本各自建队会把 5 人队拆掉，所以只能在打 boss 前那一刻组。）
//
// ★ 谁在调它（11-22 深夜定）：常规路径是 boss.yml 里的 form job —— 11:30 派发后 form 先跑完，
//   matrix 各号才开始登录，串行、零重叠。team5.yml 保留给「中途队伍散了想单独补一次」的手动场景。
//
// ★ 密码：大号与小号各不相同，一律走 account-pass.js 解析（本文件不写任何密码字面量），
//   本文件不写任何密码字面量（11-22 用户提醒「大号小号密码不一样的，不要弄错了」）。
//   CI 里两份来源都能拿到：secrets.GAME_ACCOUNT/GAME_PASSWORD=大号，secrets.GAME_ACCOUNTS_JSON=小号表。
//
// 用法（boss-auto 目录）：
//   node team5-form.js                     组队并复核 5/5（仅在 11:15-11:55 北京时间执行，失败重试到 5 轮）
//   TEAM5_FORCE=1 node team5-form.js       跳过时间窗口（本地验证用）
//   DROP_MEMBERS=1 node team5-form.js      组完关掉 4 个队员，复核队伍是否还在（验证离线保留）
// 退出码：0=5/5 成立（或不在窗口内主动跳过）；2=没组满 / 关键步骤失败
const { chromium } = require('playwright');
const daily = require('./daily.js');
const acct = require('./acct-lock.js');
const pass = require('./account-pass.js');

const { LOGIN_URL: URL } = require('./game-url.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (p) => daily.getPageText(p);
const flat = (s) => (s || '').replace(/\s+/g, ' ').trim();
const TEAM = process.env.TEAM_NAME || '一起战斗吧！';
const DROP_MEMBERS = process.env.DROP_MEMBERS === '1';

const LEADER_ACC = process.env.TEAM5_LEADER || 'coldwind8';
const MEMBER_ACCS = (process.env.TEAM5_MEMBERS || 'coldwind,coldwind0,coldwind1,coldwind2')
    .split(',').map((s) => s.trim()).filter(Boolean);

// 昵称只用于「邀请时应点到哪一行」。邀请按昵称匹配行，所以账号换人时这里也要改。
const NICK = {
    coldwind8: '笑嘻嘻', coldwind: '一缕寒风', coldwind0: '笑嘻L', coldwind1: '笑呵呵', coldwind2: '笑哈哈',
};
const nickOf = (a) => NICK[a] || a;

// ── 时间窗口：只在 11:15~11:55（北京时间）组队 ───────────────────────────────
// 为什么要有这道闸门：这个 workflow 可能被别的派发误触发（0:00/06:00/18:00 那三趟不需要组队，
// 而且 0:00 副本会拆队）。
//
// ★ 时间账（11-23 深夜按用户要求放宽：boss 时段 11:30-12:30 共 60 分钟，比原先算的宽裕）：
//   组队本体实测 165s（一次成）/ 3 轮没满约 7.7 分钟（11-25 实测 463s）；
//   默认 5 轮全用完 ~11.4 分钟（见 TEAM5_ATTEMPTS），前置 CI 冷启动 90~180s。
//   11:30 派发 → form 约 11:32~11:34 启动 → 最坏 11:45 收工，仍早于 12:30 boss 时段结束。
//   到 12:30 收摊，可用 46~54 分钟。
//   上限放到 11:55 是为了「迟到派发也有救」：11:55 启动 → 约 11:58 组完 → 仍有 30 分钟打 boss，
//   比直接放弃这一段加成划算。再晚（12:00 之后）就没意义了，所以窗口到 11:55 为止。
//   11:45 那道旧上限作废（用户 11-23 23:03 指出中午时间宽裕，不必卡这么死）。
//   账号互顶不是这条闸门的理由（任务串行、顶号只在特殊情况偶发；CI 各 runner 临时目录独立，
//   acct-lock 对跨 runner 本来就无效）—— 这道闸门防的是「加成吃不全」。
const WINDOW_START_MIN = 11 * 60 + 15;
const WINDOW_END_MIN = 11 * 60 + 55;

// 组队最多试几轮（含第一轮）。
// 11-23 用户：失败重试两次，还不成才放着照打 boss（当时默认 3）；
// 11-24 用户：「类似于这种只有三次重试的加到5次」→ 默认改 5 轮。
// 上限 5 也是 envInt 的硬顶（防止误配成很大的值把 form job 撑爆，job timeout 25 分钟兜底）。
function envInt(v, dflt, lo, hi) {
    const n = Number(String(v === undefined ? '' : v).trim());
    if (!Number.isFinite(n)) return dflt;
    const i = Math.trunc(n);
    return i < lo || i > hi ? dflt : i;
}
const TEAM5_ATTEMPTS = envInt(process.env.TEAM5_ATTEMPTS, 5, 1, 5);
const TEAM5_RETRY_PAUSE_MS = envInt(process.env.TEAM5_RETRY_PAUSE_MS, 5000, 0, 60000);

function bjNow(nowMs) {
    const d = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
    return { hour: (d.getUTCHours() + 8) % 24, min: d.getUTCMinutes() };
}
/** 该不该现在组队（纯函数，单测直接调） */
function shouldFormTeam(nowMs) {
    const { hour, min } = bjNow(nowMs);
    const t = hour * 60 + min;
    return t >= WINDOW_START_MIN && t <= WINDOW_END_MIN;
}

// ── 密码来源：env + GAME_ACCOUNTS_JSON + secrets.GAME_ACCOUNT/GAME_PASSWORD ──
// CI 里 GAME_ACCOUNTS_JSON 是「[{account,password},...]」，每号密码不同；
// 直接塞进 GAME_PASSWORD 会把大小号混成一份 → 必然有一个登不上。
// 所以按账号拆成 GAME_PASSWORD_<账号大写>，再交给 account-pass 的优先级链。
function buildEnv(src = process.env) {
    const env = { ...src };
    let injected = 0;
    const raw = src.GAME_ACCOUNTS_JSON;
    if (raw) {
        try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                for (const it of arr) {
                    if (!it || !it.account) continue;
                    const pwd = typeof it.password === 'string' ? it.password.trim() : '';
                    if (!pwd || pwd === 'null' || pwd === 'undefined') continue;
                    env[`GAME_PASSWORD_${String(it.account).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`] = pwd;
                    injected++;
                }
            }
        } catch (e) {
            console.log('::warning::GAME_ACCOUNTS_JSON 不是合法 JSON，只按环境变量里的密码取');
        }
    }
    // secrets.GAME_ACCOUNT / GAME_PASSWORD = 大号（repo 级 secret，master 与 multi-boss 都读得到）
    const mainAcc = String(src.GAME_ACCOUNT || '').trim();
    if (mainAcc && src.GAME_PASSWORD) {
        const k = `GAME_PASSWORD_${mainAcc.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
        if (!env[k]) { env[k] = src.GAME_PASSWORD; injected++; }
    }
    if (injected) console.log(`[team5] 已按账号拆出 ${injected} 份密码（不回落到共用 GAME_PASSWORD）`);
    return env;
}

const evTo = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('ev-timeout')), ms));
async function leaves(page) {
    return Promise.race([page.evaluate(() => {
        const out = [];
        for (const el2 of document.querySelectorAll('body *')) {
            if (el2.children.length) continue;
            const s = (el2.textContent || '').trim();
            if (!s || s.length > 40) continue;
            const r = el2.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            out.push({ t: s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), a: Math.round(r.width * r.height) });
        }
        return out;
    }), evTo(12000)]);
}
async function jsClick(page, s, exact = true) {
    return Promise.race([page.evaluate(({ s, exact }) => {
        const hit = Array.from(document.querySelectorAll('body *')).filter((e) => {
            if (e.children.length) return false;
            const t = (e.textContent || '').trim();
            if (exact ? t !== s : !t.includes(s)) return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }).sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return ra.width * ra.height - rb.width * rb.height;
        })[0];
        if (!hit) return false;
        hit.click();
        return true;
    }, { s, exact }), evTo(10000)]);
}
// 先按坐标点最小叶子，点完文本没变再合成事件兜底（遮罩挡住时坐标点无效）
async function clickHard(page, s, exact = true) {
    const before = await txt(page);
    const l = (await leaves(page)).filter((x) => (exact ? x.t === s : x.t.includes(s))).sort((a, b) => a.a - b.a)[0];
    if (l) {
        await Promise.race([page.mouse.click(l.x, l.y), evTo(8000)]).catch(() => { });
        await sleep(2200);
        if ((await txt(page)) !== before) return true;
    }
    const r = await jsClick(page, s, exact).catch(() => false);
    if (r) await sleep(2400);
    return r;
}
// 从「进入游戏」点到真正进主界面。
// 11-25 血案：笑呵呵(coldwind1) 登录后停在选角页，旧实现用 daily.clickText 连点 8 次
// 全部点空（按钮在遮罩/自绘层下，Playwright 报成功但页面没动），而且第 8 次之后
// 直接 `return true` —— 日志写着「登录成功」，后面 3 轮邀请「同意」也点不到，
// 组队永远 4/5，还查不出原因。这里两层修正：
//   1) 点击走 daily.clickEnterGame（坐标点击 → 合成事件 → force 三层兜底）；
//   2) 成功判据只认「你看到 / 当前城市」，进不去就返回 false，绝不假装成功。
// 选角页要点两次：第一次把登录页切到选角，第二次才是真进游戏。
async function enterMain(page) {
    for (let i = 0; i < 10; i++) {
        const how = await daily.clickEnterGame(page).catch(() => null);
        await sleep(4000);
        let t = await txt(page);
        if (t.includes('你看到') || t.includes('当前城市')) return true;
        if (t.includes('选择角色')) {
            await daily.clickEnterGame(page).catch(() => null);
            await sleep(4000);
            t = await txt(page);
            if (t.includes('你看到') || t.includes('当前城市')) return true;
        }
        if (!how) console.log(`[login] 第 ${i + 1} 轮没找到「进入游戏」按钮（页面：${flat(t).slice(0, 60)}）`);
    }
    return false;
}
async function login(page, acc, pwd) {
    for (let a = 1; a <= 10; a++) {
        const ins = await page.$$('input');
        if (ins.length < 2) {
            const t = await txt(page);
            if (t.includes('你看到') || t.includes('当前城市')) return true;
            // 原来这里看到「进入游戏」就 return true —— 停在选角页会被当成已登录。
            if (t.includes('进入游戏') && await enterMain(page)) return true;
            await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
            await sleep(3000); continue;
        }
        await ins[0].fill(acc); await ins[1].fill(pwd);
        await page.getByText('登录').first().click().catch(() => { });
        await sleep(3000);
        const t = await txt(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            if (t.includes('你看到') || t.includes('当前城市')) return true;
            if (await enterMain(page)) return true;
            return false;
        }
    }
    return false;
}
// 底部「队伍」平时在视口外 → 先滚到底再点；首页若被弹窗盖住先 Escape
async function openTeam(page) {
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(600);
    await page.mouse.wheel(0, 700).catch(() => { });
    await sleep(500);
    let ok = await clickHard(page, '队伍', true);
    if (!ok) { await page.mouse.wheel(0, 700).catch(() => { }); await sleep(500); ok = await clickHard(page, '队伍', true); }
    await sleep(2600);
    return ok;
}
async function tab(page, label) {
    const ok = await clickHard(page, label, true);
    await sleep(2500);
    return ok;
}
async function openInvite(page) { await tab(page, '邀请'); }

async function inviteOne(page, name) {
    const ls = await leaves(page);
    const nameLeaf = ls.find((l) => l.t === name);
    if (!nameLeaf) return 'name-not-found';
    const btns = ls.filter((l) => l.t === '邀请' && Math.abs(l.y - nameLeaf.y) <= 16 && l.x > nameLeaf.x)
        .sort((a, b) => a.x - b.x);
    if (!btns.length) return 'no-btn';
    await Promise.race([page.mouse.click(btns[0].x, btns[0].y), evTo(8000)]).catch(() => { });
    return 'clicked';
}
async function acceptInvite(page) {
    await openTeam(page);
    await tab(page, '邀请列表');
    // 2026-11-23 修：原来 3 轮、且「第 2 轮还没按钮就直接 failed」，有效等待只有 1.8 秒。
    // 实测笑呵呵（coldwind1）在第 2 轮没读到「同意」→ 判 failed → 队伍 4/5 → 整个 job exit 2 红叉。
    // 邀请列表是异步拉的，晚一两秒很正常 → 改成 6 轮 × 2 秒，并且点完要复核「按钮是否真的消失」，
    // 避免点了没生效也返回 ok（假阳性比失败更糟：会让人以为 5/5 已经成立）。
    for (let i = 0; i < 6; i++) {
        const ls = await leaves(page);
        const agree = ls.filter((l) => ['同意', '接受', '确认'].includes(l.t)).sort((a, b) => a.a - b.a);
        if (!agree.length) {
            await sleep(2000);
            continue;
        }
        await Promise.race([page.mouse.click(agree[0].x, agree[0].y), evTo(8000)]).catch(() => { });
        await sleep(2800);
        const after = await leaves(page);
        const still = after.filter((l) => ['同意', '接受', '确认'].includes(l.t));
        if (!still.length) return { ok: true, panel: flat(await txt(page)).slice(0, 160) };
        console.log(`[邀请列表] 点击后按钮仍在（第 ${i + 1} 轮），继续重试`);
        await sleep(1500);
    }
    return { ok: false, panel: flat(await txt(page)).slice(0, 160) };
}
// 人数用「N级」出现次数数：队长视角带「管理」后缀、队员视角没有，
// 原来的 /(\d+)\.\s*名字\s*(\d+)级/ 正则对队员视角会漏数（11-22 实测把 5 人读成 2 人）。
async function memberCount(page) {
    const t = flat(await txt(page));
    return (t.match(/\d+\s*级/g) || []).length;
}
// 队伍面板全文 —— 复核用，也用来发现面板上有没有「队伍加成」这类字样
async function teamPanelText(page) {
    await openTeam(page);
    await tab(page, '我的队伍');
    return flat(await txt(page));
}

async function main() {
    const { hour, min } = bjNow();
    const hhmm = `${hour}:${String(min).padStart(2, '0')}`;
    if (process.env.TEAM5_FORCE !== '1' && !shouldFormTeam()) {
        console.log(`[team5] 北京时间 ${hhmm} 不在组队窗口 11:15-11:55，跳过（TEAM5_FORCE=1 可强制；这趟不登录任何账号）`);
        return 0;
    }

    const all = [LEADER_ACC, ...MEMBER_ACCS];
    // 密码逐个号解析：大号小号不同，缺一个就整体退出（不猜、不回落默认值）
    const ENV = buildEnv();
    const AUTH = {};
    for (const a of all) AUTH[a] = pass.resolveOrExit(a, ENV);
    try { pass.assertDistinctPasswords(all.map((a) => AUTH[a])); } catch (e) {
        console.log('::error::' + e.message);
        return 2;
    }
    console.log(`[team5] 北京时间 ${hhmm}｜队长 ${LEADER_ACC}｜队员 ${MEMBER_ACCS.join(', ')}`);
    console.log(`[team5] 密码来源：${all.map((a) => pass.describe(AUTH[a])).join(' / ')}`);

    const T0 = Date.now();
    const el = () => Math.round((Date.now() - T0) / 1000);
    const log = (acc, ...a) => console.log(`[+${el()}s][${acc}]`, ...a);

    const browser = await chromium.launch({ headless: true });
    const P = {};
    const ctxs = {};
    let skipped = 0;
    for (const a of all) {
        const lk = acct.acquire(a, { tag: 'team5-form.js' });
        if (!lk.ok) { console.log(`[team5] ${a} 正被「${lk.st && lk.st.tag}」占着 → 跳过`); skipped++; continue; }
        ctxs[a] = await browser.newContext();
        P[a] = await ctxs[a].newPage();
    }
    if (skipped) console.log(`::warning::有 ${skipped} 个号被占用，队伍会组不满`);

    // 1) 并发登录
    await Promise.all(all.filter((a) => P[a]).map(async (a) => {
        const page = P[a];
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
        await sleep(2800);
        const ok = await login(page, a, AUTH[a].password);
        log(a, `${nickOf(a)} 登录${ok ? '成功' : '失败'}`);
        if (!ok) {
            // 没进主界面就拿不到队伍按钮，留着只会让后面「邀请/同意」空点、白耗两分钟
            log(a, '停在选角/登录页没进去 → 本号不参与组队');
            await page.close().catch(() => { });
            delete P[a];
            return;
        }
        await sleep(2200);
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(800);
    }));
    const loginFail = all.filter((a) => !P[a]);
    if (loginFail.length) console.log(`::warning::未登录: ${loginFail.join(',')}`);

    // 2) 队员若还在别的队里（当天打过副本会留副本队）→ 队长「解散」/队员「退出」
    for (const a of MEMBER_ACCS) {
        if (!P[a]) continue;
        const page = P[a];
        await openTeam(page);
        const t = flat(await txt(page));
        log(a, '队伍页: ' + t.slice(0, 120));
        if (t.includes('解散') || t.includes('退出')) {
            const btn = t.includes('解散') ? '解散' : '退出';
            log(a, `在队伍中 → 点「${btn}」`);
            await clickHard(page, btn, true);
            await sleep(2000);
            for (const w of ['确定', '确认']) {
                if (await clickHard(page, w, true).catch(() => false)) { log(a, '确认 ' + w); break; }
            }
            await sleep(2400);
            await page.keyboard.press('Escape').catch(() => { });
            await sleep(1000);
        }
    }

    // 3) 队长建队（面板里建 = 普通队伍，不是副本队）
    const lead = P[LEADER_ACC];
    if (!lead) { console.log('::error::队长没登录，终止'); await browser.close(); return 2; }
    await openTeam(lead);
    let lt = flat(await txt(lead));
    if (lt.includes('解散')) {
        // 队长自己也在旧队伍里（昨天那支没散）→ 先解散再建
        log(LEADER_ACC, '队长在旧队伍里 → 解散');
        await clickHard(lead, '解散', true);
        await sleep(1800);
        for (const w of ['确定', '确认']) { if (await clickHard(lead, w, true).catch(() => false)) break; }
        await sleep(2200);
        await openTeam(lead);
        lt = flat(await txt(lead));
    }
    // 如果队伍已经是 5/5（比如重复派发），直接复核走人，不拆重建
    if (/5\s*\/\s*5/.test(lt) || (await memberCount(lead)) >= 5) {
        log(LEADER_ACC, '已在 5 人队中，无需重建');
        log(LEADER_ACC, `【最终队伍】${lt.slice(0, 400)}`);
        await lead.screenshot({ path: 'team5-final.png' }).catch(() => { });
        await browser.close();
        for (const a of all) acct.release(a);
        return 0;
    }
    const okCreate = await clickHard(lead, '创建队伍', true);
    log(LEADER_ACC, '点创建队伍: ' + okCreate);
    await sleep(2600);
    const ins = await lead.$$('input');
    if (ins.length) { await ins[0].fill(TEAM).catch(() => { }); await sleep(500); }
    await clickHard(lead, '确定', true);
    await sleep(3000);
    log(LEADER_ACC, '建队后: ' + flat(await txt(lead)).slice(0, 200));
    await lead.screenshot({ path: 'team5-created.png' }).catch(() => { });

    // 4) 队长逐个邀请（每邀请一人面板会收起 → 每次重新打开）
    const invited = [];
    const inviteAll = async () => {
        for (const a of MEMBER_ACCS) {
            if (!P[a] || invited.includes(a)) continue;
            for (let attempt = 0; attempt < 2; attempt++) {
                await openInvite(lead);
                const r = await inviteOne(lead, nickOf(a));
                log(LEADER_ACC, `邀请 ${nickOf(a)}（第 ${attempt + 1} 次）: ${r}`);
                await sleep(2000);
                if (r === 'clicked') { invited.push(a); break; }
                await sleep(1000);
            }
        }
    };
    // 5) 每一轮：邀请 → 队员同意 → 复核人数。不满 5 人就再来一轮（默认 5 轮，可用环境变量调）。
    //    重试能救的是「邀请没点到 / 队员接受慢」这类偶发失败；救不了「这个号正被另一条分支的
    //    runner 登录着」——那种情况邀请列表里根本点不中，几轮都组不满，最后照常去打 boss。
    let panel = '';
    let n = 0;
    for (let round = 1; round <= TEAM5_ATTEMPTS; round++) {
        if (round > 1) {
            // 两轮之间队伍可能散了（队员被判离线 / 队长被顶下线）→ 先确认队伍还在，不在就重建
            const t = await teamPanelText(lead);
            if (!t.includes('解散')) {
                log(LEADER_ACC, `第 ${round} 轮前发现队伍已不在 → 重建`);
                await clickHard(lead, '创建队伍', true);
                await sleep(2600);
                const ins2 = await lead.$$('input');
                if (ins2.length) { await ins2[0].fill(TEAM).catch(() => { }); await sleep(500); }
                await clickHard(lead, '确定', true);
                await sleep(3000);
            }
        }
        invited.length = 0;
        await inviteAll();
        for (const a of invited) {
            const r = await acceptInvite(P[a]);
            log(a, `${nickOf(a)} 接受(第 ${round} 轮): ${r.ok ? 'ok' : 'failed'}`);
            await sleep(1000);
        }
        await sleep(1500);
        panel = await teamPanelText(lead);
        n = await memberCount(lead);
        log(LEADER_ACC, `【第 ${round}/${TEAM5_ATTEMPTS} 轮队伍】${panel.slice(0, 300)}`);
        log(LEADER_ACC, `【人数】${n}/5　累计 ${el()}s`);
        if (n >= 5) break;
        if (round < TEAM5_ATTEMPTS) {
            log(LEADER_ACC, `不满 5 人 → ${Math.round(TEAM5_RETRY_PAUSE_MS / 1000)}s 后重试邀请`);
            await sleep(TEAM5_RETRY_PAUSE_MS);
        }
    }
    await lead.screenshot({ path: 'team5-final.png' }).catch(() => { });

    // 7) 可选：关掉队员，验证「队员离线后队伍还在不在」
    if (DROP_MEMBERS) {
        for (const a of MEMBER_ACCS) {
            if (!ctxs[a]) continue;
            await ctxs[a].close().catch(() => { });
            delete P[a];
            log(a, '已关闭该号浏览器（模拟下线）');
        }
        await sleep(6000);
        const panel2 = await teamPanelText(lead);
        const n2 = await memberCount(lead);
        log(LEADER_ACC, `【队员下线后】${panel2.slice(0, 400)}`);
        log(LEADER_ACC, `【人数】${n2}/5`);
        await lead.screenshot({ path: 'team5-after-drop.png' }).catch(() => { });
        if (n2 !== 5) console.log(`::warning::队员下线后队伍人数变成 ${n2}/5（说明离线不留队）`);
    }

    await browser.close();
    for (const a of all) acct.release(a);
    // 不足 5 人只告警、不红叉：boss 仍会照打（少几人加成而已），红叉要留给真故障。
    if (n !== 5) console.log(`::warning::组队只到 ${n}/5（已试满 ${TEAM5_ATTEMPTS} 轮），boss 照打但少 ${5 - n} 人加成`);
    return 0;
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }).catch((e) => {
        console.log('::error::team5-form 异常: ' + (e && e.message));
        process.exit(2);
    });
}
// 只导出给单测用；被 require 时不会跑主流程
module.exports = { shouldFormTeam, buildEnv, bjNow, envInt, TEAM5_ATTEMPTS, WINDOW_START_MIN, WINDOW_END_MIN };
