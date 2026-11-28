const { LOGIN_URL } = require('./game-url.js');
const { chromium } = require('playwright');
// 出航/回城直接用 daily.js 里已验证的实现（野区→sailTo 13s PASS），
// 攻城自己的 sailFlow 是旧版「城内地图→码头」半截回城，10-27 20:00 全部卡死。
const daily = require('./daily.js');
// 血池补给（撤退 → 首页「包裹」→ 药水 → 体力宝）
const drain = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// GONGCHENG_TEST=1 流程测试：登录→出航→逐个城门→刷新→读怪物攻城页，不杀怪
const TEST = process.env.GONGCHENG_TEST === '1';
// GC_VIEW=1 只读模式：登录 → 打开怪物攻城页 → 截图 → 关浏览器。不出航、不走到城门、不花铜贝。
// GC_VIEW=mail：登录 → 打开邮件列表读首屏（**不点领取**）→ 截图 → 关浏览器。
// 用途：活动结束后看结算与功勋到账（规则：结束后 5 分钟按档位排名邮件发放），活动进行中查状态，排查异常。
const VIEW_MODE = process.env.GC_VIEW === 'mail' ? 'mail' : (process.env.GC_VIEW === '1' ? 'page' : '');
const VIEW = VIEW_MODE !== '';
// 每场击杀目标（用户 11-10 定）：**最低打够 5 只就收工，不用非得超过别人**。
// 所以默认值就是 5，不再往上加；真需要多刷才用 GC_KILL_TARGET 临时调。
// 11-10 那次「5 只没入账」不是上限问题，是号被带到威尼斯（最低档）→ 低档击杀不计分。
const KILL_TARGET = Number(process.env.GC_KILL_TARGET) || 5;
// 多个号同时守同一个门时，**选怪起点要按账号散开**，否则自家人抢自家人：
// 今天（10-31）4 个伦敦号在 20:00/20:01/20:02 分别同点 序号0/1/2 的同一只怪，
// 而一只怪只算一次击杀 → 每波 4 个号白打，27 次尝试才 5 杀。
// 选怪槽位：把「最脆一档」的怪按槽位散开，避免多个号从同一位置开始抢同一只。
// 旧规则是「账号末尾数字 % 5」，跑 6 个号必撞（coldwind1 与 coldwind6 都是 1）。
// 现在改成显式表 SLOT_MAP，见下方。GC_STAGGER=0 可关掉错开（全部槽 0）；GC_SLOT=0..4 可强制指定。
const SLOTS = 5;
// ★ 显式槽位映射（11-14 20:00 六号同场实测后改）。
// 旧规则「账号末尾数字 % 5」有一个必然撞车：coldwind6(6%5=1) 与 coldwind1(1%5=1) 同槽，
// 两号会从同一位置开始挑怪、自己人抢同一只。当晚两号最终都打满 5 只，但点空/被抢次数明显高于同场其他号。
// 现在按「同城必须一槽一号」硬编码：五个小号 0/1/2/6/8 各占 0~4；大号单独在荷姆兹成城，固定 0。
// 请注意：若将来大号与某个小号落到同一城市，需要重新分配，否则会重新撞槽（日志里 `槽N` 能直接看出来）。
const SLOT_MAP = {
    coldwind: 0,
    coldwind0: 0,
    coldwind1: 1,
    coldwind2: 2,
    coldwind6: 3,
    coldwind8: 4,
};
const ACCT_SLOT = (() => {
    if (process.env.GC_STAGGER === '0') return 0;
    if (process.env.GC_SLOT != null && process.env.GC_SLOT !== '') {
        const forced = parseInt(process.env.GC_SLOT, 10);
        if (Number.isFinite(forced)) return ((forced % SLOTS) + SLOTS) % SLOTS;
    }
    const name = String(ACCOUNT || '').trim();
    if (SLOT_MAP[name] != null) return SLOT_MAP[name] % SLOTS;
    // 表里没有的账号（临时加号、补跑）退回旧规则
    const m = name.match(/(\d+)$/);
    if (m) return parseInt(m[1], 10) % SLOTS;
    let h = 2166136261;
    for (const c of name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h % SLOTS;
})();
// 攻城怪基础名（5城结构一致，仅城市后缀不同：如「攻城先锋·长安」；截图已证实伦敦/威尼斯/圣乔治/长安/荷姆兹同构）
const MONSTER_BASE = ['攻城先锋', '攻城重甲', '攻城步兵', '攻城斥候'];
// 11-07：列表页同名条目没有血量也没有状态，只能按**种类**猜体力排队，优先打脆的。
// 常识排序：斥候=侦察（最脆）→ 步兵 → 先锋 → 重甲（最肉）。
// 意义在于圣乔治档 100 级号打 105 级怪打不动（11-03 被抢 288~460 次 0 杀），
// 少打几万血往往就是能不能抢到的分界。今晚跑完看日志里各种类的战斗结果校正顺序。
const MONSTER_PRIORITY = ['攻城斥候', '攻城步兵', '攻城先锋', '攻城重甲'];
// 城市档位（按等级入榜，本档及更高档击杀计分）；城门按积分从低到高排。
// 用户 10-31 定：**积分最少的门人最少** → 主战场永远是 gates[0]，被抢也不往上跳
//（今天 coldwind2 20:05 跳到东城门那次恰是被抢最多的一轮：17 次）。
const LOW_GATE = 0;
// battleSec = 单场战斗上限（秒）。怪物体力随档位暴涨：伦敦档一场 1 分钟内解决，
// 荷姆兹档实测 165000 体力、12~14 回合、约 60~80 秒（10-31 用户录屏），给 3 倍余量。
const CITIES = [
    { city: '威尼斯', region: '地中海', minLv: 30, maxLv: 69, battleSec: 90, gates: [
        { gate: '北城门', lv: 40, score: 12 }, { gate: '东城门', lv: 50, score: 14 },
        { gate: '西城门', lv: 60, score: 16 }, { gate: '南城门', lv: 70, score: 20 }] },
    { city: '伦敦', region: '北海', minLv: 70, maxLv: 99, battleSec: 120, gates: [
        { gate: '北城门', lv: 75, score: 25 }, { gate: '东城门', lv: 85, score: 30 },
        { gate: '西城门', lv: 95, score: 36 }, { gate: '南城门', lv: 100, score: 45 }] },
    { city: '圣乔治', region: '非洲', minLv: 100, maxLv: 129, battleSec: 150, gates: [
        { gate: '北城门', lv: 105, score: 80 }, { gate: '东城门', lv: 115, score: 90 },
        { gate: '西城门', lv: 125, score: 100 }, { gate: '南城门', lv: 130, score: 120 }] },
    { city: '长安', region: '东亚', minLv: 130, maxLv: 139, battleSec: 200, gates: [
        { gate: '北城门', lv: 135, score: 200 }, { gate: '东城门', lv: 145, score: 230 },
        { gate: '西城门', lv: 155, score: 260 }, { gate: '南城门', lv: 160, score: 320 }] },
    { city: '荷姆兹', region: '印度洋', minLv: 140, maxLv: 200, battleSec: 240, gates: [
        { gate: '北城门', lv: 165, score: 400 }, { gate: '东城门', lv: 175, score: 450 },
        { gate: '西城门', lv: 185, score: 500 }, { gate: '南城门', lv: 200, score: 600 }] },
];
// 当前档位的单场上限（run() 选定城市后写入）
let BATTLE_LIMIT_MS = 120000;

// 血池（用户 2026-11-15）：面板里自己那行是「体力：20720/20720 -0 血池：18353」。
// 血池 0 时点「攻击」对任何怪都不掉血 —— 不处理的话 30 分钟窗口会全烧在空点上，
// 而且每只怪都会被「出手4次体力没变」误判成尸体。攻城窗口足够长（30 分钟），
// 补药的十几秒花得起，所以按用户 11-15 定的两条路补药：撤退 → 首页「包裹」→ 药水 →
// 体力宝（优先小体力宝，没有才用大体力宝）。
let BLOOD_DEAD = false;      // 整波判死（时间/规则层面收工，不再由「血池 0」触发）
let BLOOD_HARD = false;      // ★ 用户 11-20 / 11-28：补不上药就按「没有体力宝」硬打，不许撤退换只、不许收工
let BLOOD_HEALS = 0;         // 本波已成功补药次数
let BLOOD_HEAL_FAILS = 0;    // 补过药、下一场又读到 0 的连续次数（有击杀就清零）
// 用户 2026-11-15「体力宝效果是覆盖不是叠加」= 连着吃第二个不会让血池更多，**不等于补一次就永久失效**。
// 11-28 大号 20:00 就是这个理解把整波封死的：包里还有 73 个小体力宝，补了 1 次后
// 第二只怪 0.1 秒又读到 0，直接 ::error:: 收工，击杀 0。改成按「连续无效」判。
const BLOOD_HEAL_MAX = 3;    // 一波最多补 3 次（纯防死循环）；到顶仍 0 → 转硬打，不是收工
const BLOOD_HEAL_FAIL_MAX = 2;// 连续 2 次补药后仍归零 → 说明不是缺药，转硬打
// 补药后第一帧可能是上一场战斗面板的残影（无怪物体力行）。没读到怪物血量时，
// 这场战斗至少等这么久才允许判「血池 0」，避免 0.1 秒误杀整波。
const BLOOD_GRACE_MS = Number(process.env.GC_BLOOD_GRACE_MS) || 1500;

// 用户 10-31：自动攻击「能用，但攻击间隔很高，远不如快速点攻击效率高，选自动攻击大概率抢不到怪」
// → 默认改成高频点「攻击」；自动攻击只作为可选（AUTO_ATTACK=1），留作逐回合点不动时的兜底。
const USE_AUTO_ATTACK = process.env.AUTO_ATTACK === '1';

// 用户 10-31 晚：攻击点击「尽可能的快，因为会被抢怪，时间不等人」。
// 所以把原来固定 1.2 秒的点击闸门改成**回合结算就出手**：
//   轮询 120ms → 一看到怪物体力数字变了（= 上一回合结算完）立刻点下一击；
//   点击之间只留 200ms 的物理下限（再快只是把同一回合点两遍，白送一次「攻击中」）。
// 三个数值都可被环境变量覆盖，现场觉得太激进可以调大：GC_POLL / GC_ATK_GAP。
// 120 → 80：抢怪看的是「从点击到出手」的延迟，轮询越密越早发现面板/回合结算。
// 6 个号并发时每台机器约 75 次 evaluate/秒，若发现 CPU 吃紧用 GC_POLL=120 调回。
const POLL_MS = Number(process.env.GC_POLL) || 80;
const ATK_GAP_MS = Number(process.env.GC_ATK_GAP) || 350;
// 进程级总时长上限（含登录/出航/导航）。默认 55 分钟，20:00-20:30 的窗口本来就够；
// 本地串行跑多个号时必须给每号限时（GC_MAX_SEC），否则第一个号能一直吃到 20:30，
// 后面的号连登录都赶不上。到点走上方的「强制收尾」分支，优雅关浏览器，不留僵尸进程。
const START_TS = Date.now();
const MAX_RUN_MS = (Number(process.env.GC_MAX_SEC) || 55 * 60) * 1000;
const FIRST_ATK_SETTLE_MS = 400;   // 面板刚弹出就点会弹「攻击失败」直接报废一只，先等 0.4s
// 运行时按等级选定，sailFlow/传送/找怪共用
let NAV_DEST = '威尼斯';
let NAV_REGION = '地中海';
let MONSTERS = MONSTER_BASE.map(n => `${n}·威尼斯`);

function pickCity(lv) {
    for (const c of CITIES) if (lv >= c.minLv && lv <= c.maxLv) return c;
    return lv < CITIES[0].minLv ? CITIES[0] : CITIES[CITIES.length - 1];
}

// 主页点「状态」→ 用户信息页读等级 → 返回等级或 null
// ★ 11-10 事故：旧版只读一次，读不到就 `pickCity(30)` 兜底 → 最低档威尼斯。
//   而档位规则是「本档及更高档击杀计分」，低档杀怪 0 分 → 大号 20:24 那波 5 只全白打。
//   所以这里必须重试到拿到为止：每轮先确保人在城内主界面（有「出航」），再点状态，
//   拿到页面后轮询最多 6 秒（用户信息页经常慢半拍）。
async function readLevel(page, attempts = 3) {
    for (let a = 1; a <= attempts; a++) {
        // 不在城内主界面时点「状态」会点空（战场/城门列表/副本都没有这个入口）
        for (let i = 0; i < 5; i++) {
            if ((await getPageText(page)).includes('出航')) break;
            await clickExact(page, '取消', 800);
            await sleep(2000);
        }
        if (!(await clickText(page, '状态', 3000))) {
            log(`主页未见「状态」入口（第${a}/${attempts}次），等页面就绪...`);
            await sleep(2000);
            continue;
        }
        await sleep(2500);
        let t = await getPageText(page);
        let m = t.match(/等级[:：]?\s*(\d+)/);
        for (let c = 0; c < 5 && !m; c++) {
            await sleep(2000);
            t = await getPageText(page);
            m = t.match(/等级[:：]?\s*(\d+)/);
        }
        await page.keyboard.press('Escape');
        await sleep(800);
        if (m) return parseInt(m[1]);
        log(`用户信息页未解析到等级（第${a}/${attempts}次），页面文本:`, t.replace(/\s+/g, ' ').substring(0, 160));
        await sleep(1500);
    }
    return null;
}

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

// 只拼接**可见**节点：textContent 会把 display:none 的 toast 一起读进来，
// 而游戏 toast 弹过一次后节点永久留在 DOM 里（daily.js 10-27 已踩过这个坑）。
// 攻城这边的后果更严重：上一只的「已被击杀」残留，会让下一只一开场就判「被抢」，
// 大号荷姆兹档「打了一堆全是被已击杀」很可能大半是这么来的。
async function getPageText(page) {
    return await page.evaluate(() => {
        const visible = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                if (parseFloat(cs.opacity) === 0) return false;
            } catch (e) { return false; }
            return true;
        };
        const walk = (node) => {
            let out = '';
            for (const n of node.childNodes) {
                if (n.nodeType === 3) { out += n.nodeValue; continue; }
                if (n.nodeType !== 1) continue;
                if (!visible(n)) continue;
                out += walk(n);
            }
            return out;
        };
        return document.body ? walk(document.body) : '';
    }).catch(() => '');
}

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

function bjNow() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return { hour: d.getUTCHours(), min: d.getUTCMinutes() };
}

// 北京时间的「当天第几秒」。分钟精度不够用：20:00 前最后 1 分钟要秒级刷新，
// 抢第一批怪（用户 11-14：早到了页面不会自己出怪，必须手动点「刷新」才显示）。
function bjDaySec() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

function log(...args) {
    const { hour, min } = bjNow();
    console.log(`[${hour}:${String(min).padStart(2, '0')}][gongcheng]`, ...args);
}

// 主页文本截取：当前城市开始的一段，用于日志观察位置
function cityBlock(txt) {
    const a = txt.indexOf('当前城市');
    if (a < 0) return '(无当前城市)';
    return txt.substring(a, a + 220).replace(/\s+/g, ' ');
}

// 活动时段：20:00整点刷怪，每5分钟一波，20:30结束
// （2026-10-24实测：活动页明示「开放：周二、周六 20:00-20:30」，20:34查状态=未开启，窗口就是20:30整）
function eventPhase() {
    const { hour, min } = bjNow();
    const t = hour * 60 + min;
    if (t < 20 * 60) return 'wait';
    if (t < 20 * 60 + 30) return 'live';
    return 'over';
}

// 回城内主界面。**必须点页面自带的方位出口「南：★码头」**——点「城内地图」只会弹出
// 「选择目的地」列表，人不会移动（10-26 daily.js 实证，10-27 20:00 攻城复现：5 个号全卡在
// 「未看到出航确认框」，因为出航面板压根没打开）。城内主界面的唯一判据是页面有「出航」。
async function backToCity(page, maxTry = 3) {
    for (let i = 0; i < maxTry; i++) {
        if ((await getPageText(page)).includes('出航')) return true;
        await clickExact(page, '取消', 800);
        const exits = await page.evaluate(() => {
            const out = [];
            for (const el of document.querySelectorAll('body *')) {
                if (el.children.length) continue;
                const s = (el.textContent || '').trim();
                if (!/^[东西南北][：:].*码头$/.test(s)) continue;
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                out.push({ text: s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
            }
            return out;
        }).catch(() => []);
        if (exits.length) {
            const e = exits[0];
            log(`回城：点方位出口「${e.text}」`);
            if (!(await clickText(page, e.text, 2500))) {
                await page.mouse.click(e.x, e.y).catch(() => {});
            }
            await sleep(3000);
            if ((await getPageText(page)).includes('出航')) return true;
        }
        // 兜底：城内地图 → 列表里的纯「★码头」
        log('回城兜底：城内地图 → ★码头');
        await clickText(page, '城内地图', 2500);
        await sleep(1500);
        await clickText(page, '★码头', 2500);
        await sleep(3000);
    }
    return (await getPageText(page)).includes('出航');
}

async function sailFlow(page) {
    log(`出航到 ${NAV_DEST}（${NAV_REGION}）`);
    const ok = await daily.sailTo(page, NAV_DEST);
    if (!ok) {
        log('出航未完成（daily.sailTo 返回 false）');
        return false;
    }
    log(`到达${NAV_DEST}`);
    return true;
}

async function teleportToDest(page) {
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
        // 传送兜底也要进主界面：原来只点一次，点了没反应就接着点传送面板，兜底整条失效
        await daily.enterMain(page, { rounds: 4, pauseMs: 3000 });

        let ok = await clickText(page, '传送', 2000);
        if (!ok) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            ok = await clickText(page, '传送');
        }
        if (!ok) {
            log('传送兜底: 找不到传送入口');
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
            log(`传送兜底: 已到达${NAV_DEST}`);
            return true;
        }
        log('传送兜底: 未检测到到达');
        await page.screenshot({ path: 'teleport-fail.png' }).catch(() => {});
        return false;
    } catch (e) {
        log('传送兜底错误:', e.message);
        return false;
    }
}

// 数一数「你看到」里可点的攻城怪（叶子节点，带当前城市后缀；测试怪物不会命中）
// 5城结构一致：同名四怪「攻城先锋/重甲/步兵/斥候」+·城市后缀，仅后缀随城市变
async function countMonsters(page) {
    return await page.evaluate(({ names, city }) => {
        const els = [...document.querySelectorAll('body *')].filter(el => {
            if (el.children.length !== 0) return false;
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            if (!s.includes(city)) return false;
            return names.some(n => s.includes(n));
        });
        return els.length;
    }, { names: MONSTERS, city: NAV_DEST });
}

// 点本轮第 tried 只攻城怪，返回点击结果（含实际序号 pick / 最高优先级档只数 topCount）
async function clickMonster(page, tried) {
    const target = await page.evaluate(({ names, city, tried, order, slot, slots }) => {
        // 11-07 20:29 用户澄清关键机制：**怪死了不会自动从列表消失**，不点「刷新」
        // 就一直显示，点进去照样能开面板，只有点攻击才提示已被击杀。
        // 所以「最近点过就跳过、8 秒后再放回来」那套是错的 —— 8 秒一到尸体重新进入
        // 候选池，又去点同一批死怪（日志里 13→11→9→17 就是标记过期在循环）。
        // 现在整份快照按序号顺序只扫一遍（tried 0..total-1），扫完统一刷新拿新快照。
        const els = [...document.querySelectorAll('body *')].filter(el => {
            if (el.children.length !== 0) return false;
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            if (!s.includes(city)) return false;
            return names.some(n => s.includes(n));
        });
        // 11-07：按种类排队，脆的排前面（DOM 顺序不动，只在本次挑选里排序；
        // Array.sort 自 ES2019 起稳定，同种类的先后仍是页面顺序，不会打乱槽位分散）
        const prio = (s) => {
            for (let i = 0; i < order.length; i++) if (s.includes(order[i])) return i;
            return order.length;
        };
        els.sort((a, b) => prio(a.textContent || '') - prio(b.textContent || ''));
        if (tried >= els.length) return { done: true, total: els.length, clicked: '' };
        // 槽位分散要落在**最高优先级那一档内部**，不然 5 个号又会从列表正中间开始、
        // 直接跳过最脆的斥候（原来 base 从 mid 起算，斥候在 0..topCount 区段根本轮不到）。
        // topCount 少于号数时（比如只剩 2 只斥候）必然撞车，那就先到先得。
        const topPrio = prio(els[0].textContent || '');
        const topCount = els.filter(e => prio(e.textContent || '') === topPrio).length;
        const span = topCount >= slots ? Math.floor(topCount / slots) : 1;
        const base = (slot * span) % topCount;
        const idx = (base + tried) % els.length;
        const el = els[idx];
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return {
            done: false,
            total: els.length,
            topCount,
            pick: idx,
            clicked: (el.textContent || '').trim(),
            cx: Math.round(r.left + r.width / 2),
            cy: Math.round(r.top + r.height / 2),
        };
    }, { names: MONSTERS, city: NAV_DEST, tried, order: MONSTER_PRIORITY, slot: ACCT_SLOT, slots: SLOTS });
    if (target.done) return target;
    // 用真实鼠标点击元素中心（合成 dispatchEvent 实测无法触发战斗弹窗，2026-10-24首跑教训）
    await page.mouse.click(target.cx, target.cy);
    return target;
}

// 目标已经没了（被别的玩家抢掉、或列表刷新后消失）时，游戏的提示文案不固定。
// 用户 10-27：大号那档人多，怪会被中途击杀，一路提示出错，只能撤退选下一只。
// 所以这里不赌文案：① 宽匹配常见词 ② **8 秒内没进战斗菜单**就直接算被抢。
const LOST_RE = /已被击杀|已被讨伐|已经被击杀|已经死亡|已死亡|已经不存在|不存在|已消失|已被消灭|请重新选择|目标无效|超出范围|战斗失败/;

// 严格版「这只怪被人抢了」判据（11-07 20:18 真机撞出来的）。
// 主界面聊天栏会滚**别的玩家**的击杀播报，里面同样有「已被击杀」「不存在」这些词，
// 宽泛的 LOST_RE 在列表页读到它就当成自己这只被抢：当场连撤 10 只，
// 日志里 [被抢·列表页] 打出来的却是整页开头，根本看不出命中哪个词。
// 所以只认**明确指向当前这只怪**的句子 —— 用户 11-07 手动截图给的原话是
// 「操作失败，该怪已被击杀」，带「该怪」，跟聊天播报（「XXX 已被击杀」）能分开。
const LOST_STRICT = /该怪物已被击杀|该怪已被击杀|操作失败|已被其他玩家|目标已被|请重新选择目标|该怪物已死亡/;

// 战斗菜单长这样：「攻击 / 自动攻击 / 查看 / 撤退」（10-27 真机截图）。
// 城门怪物列表没有这几个词，正好可以作为「有没有真的打起来」的判据。
function inBattleMenu(t) {
    return t.includes('撤退') && (t.includes('攻击') || t.includes('自动攻击'));
}

// 血池决策（纯函数，单测 blood-gate-test.js）。四种结果：
//   fight —— 不用管血池（读到 >0 / 读不到 / 不在战斗面板 / 已转入硬打模式）
//   wait  —— 血池 0，但这场还没出现怪物体力行、且仍在宽限内：多半是上一场的残影面板，先等
//   heal  —— 血池 0，撤退补药（retry=true 表示「补过之后又归零」，调用方记一次无效）
//   hard  —— ★ 不再补了，按「没有体力宝」硬打（补到上限 / 连续补药无效）。绝不等于放弃整波，
//            用户 11-20、11-28 两次强调：补血失败也要先打怪，不许动不动就放弃。
//   giveup——仅用于整波判死（dead），「血池 0」本身不再产生这个结果。
function bloodGate(s) {
    const pick = (v, d) => (v === undefined || v === null ? d : v);   // 0 是合法值（单测要能关掉宽限）
    if (s.inBattle === false) return { act: 'fight' };
    if (s.hard) return { act: 'fight' };                             // 已转硬打：不再碰血池
    if (s.blood === null || s.blood === undefined) return { act: 'fight' };
    if (s.blood > 0) return { act: 'fight' };
    if (!s.hasMonsterHp && s.elapsedMs < pick(s.graceMs, BLOOD_GRACE_MS)) return { act: 'wait' };
    if (s.dead) return { act: 'giveup', why: '本波已判收工' };
    if (s.heals >= pick(s.healMax, BLOOD_HEAL_MAX)) return { act: 'hard', why: `本波已补 ${s.heals} 次仍为 0` };
    if (s.fails >= pick(s.failMax, BLOOD_HEAL_FAIL_MAX)) return { act: 'hard', why: `连续 ${s.fails} 次补药后血池仍为 0` };
    return { act: 'heal', retry: s.heals > 0 };
}

// 关掉可能弹出的提示框（不同提示按钮不一样：关闭 / 确定 / 取消）
// 传入当前页面文本 t 有两条好处：① 只点真正存在的按钮；② 不存在就不点。
// clickText 找不到元素要白等 timeout + 2.5 秒，一次「无按钮」就烧 3~4 秒；
// 一个晚上被抢 20 只 × 3 秒 ≈ 白扔一分钟，攻城窗口只有 30 分钟。
async function closePopup(page, t = '') {
    for (const w of ['关闭', '确定', '取消']) {
        if (t && !t.includes(w)) continue;
        if (await clickExact(page, w, 600)) { await sleep(250); return true; }
        if (!t) break;   // 没给文本时只试「关闭」，其余交给 Esc
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
    return false;
}

// 撤退回城门列表。同样先看文本：没有「撤退」按钮时硬点要白等 3 秒
// （「攻击失败」那种无按钮浮层就是这么被浪费掉的）。
// 刷新怪物列表。这是**唯一能让死条目从列表消失的手段**：用户 11-07 澄清，
// 怪被打死不会自动下架，不点「刷新」就一直显示、还能点进去（攻击才提示已被击杀）。
// 所以「刷新没用、别多刷」那条 11-03 的结论已作废。
// 11-07 另删：原来刷前要清 DOM 上的「已试过」标记（gcTriedAt），那套标记本身已移除，
// 清标记这段一并删掉，省一次 page.evaluate。
async function refreshList(page, wait = 2500) {
    await clickText(page, '刷新', 3000);
    await sleep(wait);
}

async function retreat(page, t = '') {
    const ok = (t && !t.includes('撤退')) ? false : await clickExact(page, '撤退', 700);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
    return ok;
}

// 从战斗面板读出**怪物**体力（面板里写作「攻城斥候·荷姆兹体力：45124/165000」）。
// 自己那行是「体力：20720/20720 -0 血池：18353」——没有怪名前缀、且排在后面，
// 所以取第一个匹配就一定是怪物那行。
function monsterHp(t) {
    const m = t.match(/体力[：:]\s*(\d+)\s*\/\s*(\d+)/);
    return m ? `${m[1]}/${m[2]}` : '';
}

// 打一只怪。返回 win（打赢）| lost（目标已被抢/点空，立刻换下一只）| stuck（开着战斗但长时间无进展）| timeout
// openMs：点怪后等战斗面板的最长时间。11-03 实证 456 次尝试里有 228 次是「等满 3 秒
// 没出面板」，而同一份日志里正常出面板都在 1.5 秒内 —— 3 秒里有一半是纯白等，
// 一波怪存活只有 10~20 秒，每只多等 1.8 秒就等于每波少试 2 只。压到 1200ms。
async function resolveBattle(page, openMs = Number(process.env.GC_OPEN_MS) || 1200) {
    const t0 = Date.now();
    let lastAttack = 0, clicks = 0, hpChanges = 0;
    let hpPrev = '', hpAtClick = '', panelAt = 0, zeroHpAt = 0, hpMax = '';
    let lastText = '', lastChange = Date.now(), dumped = false;
    let atkLogged = false;
    let atkFail = 0, atkFailLogged = false;   // 「攻击失败」累计次数（只为日志，不再用于撤退）
    let staleLogged = false;                   // 残留击杀提示是否已记过（只为日志节流）
    let panelBaseText = '';                    // 战斗面板第一帧文本，用于区分「残句」和「本只真被抢」
    // 每只怪收尾打一行战斗账：几秒、点了几次、体力结算了几次（≈回合数）、怪物满血。
    // 周二实战就看这行判断瓶颈到底是服务器回合慢，还是我们点击慢。
    // hpMax 一起打出来：今晚一跑就能看出四种怪谁最脆，直接验证 MONSTER_PRIORITY 猜得对不对。
    const fin = (res) => {
        const ms = Date.now() - t0;
        const rounds = hpChanges + (clicks > 0 ? 1 : 0);
        const per = rounds > 0 ? `${(ms / rounds / 1000).toFixed(1)}s/回合` : '回合未结算';
        log(`[战斗] ${(ms / 1000).toFixed(1)}s 出手${clicks}次 体力结算${hpChanges}次 ${per} 满血${hpMax || '?'} 攻击失败${atkFail}次 → ${res}`);
        return res;
    };
    // 单场上限按档位给（BATTLE_LIMIT_MS）。原来写死 180 秒：伦敦档够用但白等，
    // 荷姆兹档实测 60~80 秒、余量只剩 2 倍，遇到更厚的怪会被误判超时。
    while (Date.now() - t0 < BATTLE_LIMIT_MS) {
        const t = await getPageText(page);
        if (t !== lastText) { lastText = t; lastChange = Date.now(); }

        // 1) 打赢优先。收尾也提速：只点真的存在的「关闭」，不再做 3 轮盲点。
        if (t.includes('你战胜了') || t.includes('攻城积分+') || t.includes('战斗胜利')) {
            for (let k = 0; k < 2; k++) {
                const tx = k === 0 ? t : await getPageText(page);
                if (!tx.includes('关闭')) break;
                await clickExact(page, '关闭', 700);
                await sleep(250);
            }
            await page.keyboard.press('Escape').catch(() => {});
            await sleep(250);
            BLOOD_HEAL_FAILS = 0;   // 这一只打赢了 → 补药确实有效，无效计数清零
            return fin('win');
        }

        // 1.5) 血池为 0 → 先撤退补药（用户 2026-11-15）。
        //      判据只认面板里自己那行「血池: 0」，读不到就是 null，不会误触发。
        //      补药流程：撤退 → 首页「包裹」→「药水」→ 小体力宝（没有才用体力宝）→ 关包裹 → 回来继续抢。
        //
        // ★ 2026-11-28 修复两处踩空（当晚大号击杀 0 的直接原因）：
        //   ① 补完药点下一只时，页面可能还停在上一场战斗面板的残影 —— 只有「撤退/攻击」和
        //      上一场的「血池：0」，没有怪物体力行。原来一进来就判 0，0.1 秒就把本波封死。
        //      真面板必有「体力：X/Y」怪物行，所以没读到怪物血量时先给 GRACE 宽限，不判血池。
        //   ② 「覆盖式恢复、不能叠加」被写成了「本波只补 1 次」。覆盖式只说明连着吃不会更多，
        //      不等于补一次就永久失效。
        //   ★ 补不上药（没药 / 包裹页签读不到 / 补到上限仍 0）一律转 `hard` 硬打这只，
        //     **不许撤退换只、更不许收工** —— 用户 11-20、11-28 两次强调「补血失败也要先打怪」。
        const hpNow = monsterHp(t);
        const g = bloodGate({
            inBattle: inBattleMenu(t),
            blood: drain.readBlood(t),
            hasMonsterHp: !!hpNow,
            elapsedMs: Date.now() - t0,
            heals: BLOOD_HEALS,
            fails: BLOOD_HEAL_FAILS,
            hard: BLOOD_HARD,
            dead: BLOOD_DEAD,
        });
        if (g.act === 'giveup') {
            log(`[血池] ${g.why}，撤出这只`);
            await closePopup(page, t);
            await retreat(page, t);
            return fin('noBlood');
        }
        if (g.act === 'hard') {
            BLOOD_HARD = true;
            log(`::warning::[血池] ${g.why} → 按「没有体力宝」硬打这只，不再补药、不换只`);
            await closePopup(page, t);
            await retreat(page, t);
            return fin('hard');
        }
        if (g.act === 'heal') {
            if (g.retry) {
                BLOOD_HEAL_FAILS++;
                log(`[血池] 补药后又归零（连续第 ${BLOOD_HEAL_FAILS}/${BLOOD_HEAL_FAIL_MAX} 次），再补一次`);
            }
            log('[血池] 为 0，撤退补药...');
            // force：血池判据这里已经读过（面板一撤就读不到了，不 force 会误报 no-blood-read）。
            // 撤退由 healBlood 自己做（它先点「撤退」再开包裹），保证补完药回到的是活动页。
            const h = await drain.healBlood(page, { tag: '补血池·攻城', inDungeon: false, force: true, log });
            if (!h.ok) {
                // ★ 11-20 / 11-28 铁律：药真没了、或包裹/页签读不到，都不许放弃。
                //   攻城没有领奖环节，能在场上就继续打；血池 0 打不动也会一直抢到窗口结束。
                BLOOD_HARD = true;
                log(`::warning::[血池] 补不上药（${h.reason}）→ 按「没有体力宝」硬打这只，不撤不收工`);
                return fin('hard');
            }
            BLOOD_HEALS++;
            log(`[血池] 补药成功（${h.item}×${h.used}），继续抢怪`);
            return fin('healed');
        }
        // g.act === 'wait'（残影面板，还没读到怪物体力行）或 'fight'：继续走正常战斗流程

        // 2) 判「有没有真的进战斗」。原来只认 inBattleMenu（撤退 + 攻击按钮），
        //    可面板已弹出、按钮还没渲染完时会被判成"没打起来"，白等满 openMs
        //    （10-31 5 个号共 17 次，合计白扔约 2 分钟）。视频实证面板里必有
        //    「体力：165000/165000」，加它兜底。
        const hp = monsterHp(t);
        if (hp && !hpMax) hpMax = hp.split('/')[1];
        // 11-07：hp 兜底只管前 2.4 秒（面板已弹出、按钮还没渲染完的那一小段）。
        // 再往后必须是「撤退+攻击」按钮都在才算在战斗里 —— 否则主界面自己状态栏的
        // 「体力：32000/32000」会被当成怪物血量，人还在列表页却被判成已开战。
        const inBattle = inBattleMenu(t) || (!!hp && Date.now() - t0 < openMs * 2);
        // 战斗面板第一帧的文本。用户 11-07 20:27 指出关键事实：
        // **面板显示满血不代表怪还活着**（快照可能已经过时，人刚点开时怪已经被打死了）。
        // 所以「体力 > 0」不能当活着的证据。唯一能区分真假的是：
        // 这句「该怪物已被击杀」是**面板一打开就在**（上一只残留），
        // 还是**点进战斗之后才冒出来**（本只真被抢）。基线在下面第 4 条用。
        if (inBattle && !panelBaseText) panelBaseText = t;

        // 3) 没进战斗：怪已被抢（游戏弹提示）或点空了（列表刚刷新）
        if (!inBattle) {
            // 11-07 20:24 真机：第一只 win 之后，「操作失败，该怪物已被击杀」这句提示
            // **不会消失**，一直挂在主界面上，于是后面每只怪一点开就被判 lost，
            // 一口气连撤 16 只。列表页看不到战斗面板，本来就无法区分「怪死了」和
            // 「点空了」，一律归 dead（会累计到 8 次触发刷新，正好把残留清掉）。
            // 真被抢的判据只在面板内用（下面第 4 条）—— 那里提示必然是本只的。
            // 正常点开怪 1.5 秒内就出面板，原来等 8 秒、后来 3 秒纯浪费 → 1.2 秒
            if (Date.now() - t0 > openMs) {
                if (!dumped) {
                    dumped = true;
                    log(`[没打起来] ${Date.now() - t0}ms 未出战斗面板，文本前200字: ${t.replace(/\s+/g, ' ').substring(0, 200)}`);
                }
                // 没进战斗说明人还在列表页：这里根本没有战斗面板要关，closePopup + retreat
                // 各自空转 250ms（各按一次 Esc 再 sleep），11-03 一局丢 456 只 ≈ 白烧 114 秒。
                // 只按一次 Esc 收掉可能的遮罩，立刻回去点下一只。
                await page.keyboard.press('Escape').catch(() => {});
                // 11-07：点了根本没出面板 = 点的是列表里的死条目（快照过期/别人已打死）。
                // 单独记成 dead，跟「进了面板才被抢」分开统计：只有 dead 才值得刷列表。
                return fin('dead');
            }
            await sleep(POLL_MS);
            continue;
        }

        // 4) 面板内弹出「已被击杀」这类提示 → 还是被抢，撤退。
        //    这条以前是**静默** return（10-31 共约 15 次无声撤退，日志只留一个"被抢=22"的
        //    总数、不知道弹的是哪句），现在把原文留下来。
        if (LOST_STRICT.test(t)) {
            const mm = t.match(LOST_STRICT);
            // 真被抢：这句是**这次进面板之后才出现**的（基线里没有）。
            if (!(panelBaseText && LOST_STRICT.test(panelBaseText))) {
                // 一次血都没打掉就提示已被击杀 = 这只在列表快照里本来就是尸体
                // （用户 11-07：怪死了列表不刷新、还能点进去，攻击才提示击败）。
                // 单独记 dead：连 3 只 dead 就值得刷一次列表把尸体清掉。
                // 打掉过血才提示 = 真被别人收尾，记 lost，刷新没用、只换下一只。
                const corpse = hpChanges === 0;
                if (!dumped) { dumped = true; log(`[${corpse ? '尸体' : '被抢'}·面板内] 命中「${mm && mm[0]}」，已换下一只`); }
                await closePopup(page, t);
                await retreat(page, t);
                return fin(corpse ? 'dead' : 'lost');
            }
            // 面板一打开就有 = 上一只留下的残句（面板 DOM 复用），忽略继续打。
            // 这种面板里的怪其实也已经是死的：点下去一直「攻击失败」、体力不动，
            // 由下面「50 秒无任何变化」的 stuck 兜底撤退。
            if (!staleLogged) {
                staleLogged = true;
                log(`[残留提示] 面板一打开就有「${mm && mm[0]}」，判为上一只残留，继续打`);
            }
        }

        // 5) 「攻击失败」**不再撤退**（11-07 晚推翻 10-31 的规则）。
        //    10-31 定「弹攻击失败就撤退」的理由是「怪被别人打死了」。但当晚用户实证：
        //    圣乔治压根没人抢怪，赤手空拳 30 回合打死一只（怪 32000 血），
        //    而脚本每只 1 秒就撤 —— 一晚 196 次撤退、0 杀。
        //    真因：这句话只是**这一击被服务器拒了**（回合没结算完就点，或多点了一下），
        //    面板还在、怪还活着。把它当撤退依据 = 自己把每只活怪报销掉。
        //    所以改成只记账不撤退，安全网交给下面「50 秒无任何变化」的 stuck 判断：
        //    真死怪页面是死的、什么都不变，50 秒后自然会撤。
        //    注意：这里**只记账、不 continue**。如果「攻击失败」是挂在面板上的常驻文案，
        //    一旦 continue 就再也不出手了 —— 那是另一种卡死（自己给自己造的死循环）。
        if (inBattleMenu(t) && /攻击失败/.test(t)) {
            atkFail++;
            if (!atkFailLogged) {
                atkFailLogged = true;
                log(`[攻击失败] 出现（不撤退，继续打）文本前100字: ${t.replace(/\s+/g, ' ').substring(0, 100)}`);
            }
        }

        // 6) 出手：**尽可能快**（用户 10-31 晚「会被抢怪，时间不等人」）。
        //    判据从「固定 1.2 秒点一次」换成「一回合结算完立刻点」：
        //      · 「攻击中…」= 上一击服务器还没回，点也白点 → 120ms 后再看；
        //      · 怪物体力数字变了 = 上一回合结算完 → 立刻点下一击；
        //      · 体力一直不变（文案可能不刷数字）→ 1.4 秒兜底再点，避免死等。
        //    面板刚弹出必须先等 FIRST_ATK_SETTLE_MS，否则会弹「攻击失败」白扔一只。
        if (USE_AUTO_ATTACK && !t.includes('攻击中')) {
            if (await clickText(page, '自动攻击', 1500)) {
                if (!atkLogged) { atkLogged = true; log('已点自动攻击（AUTO_ATTACK=1）'); }
                await sleep(1800);
                continue;
            }
        }
        if (!USE_AUTO_ATTACK) {
            if (!panelAt) panelAt = Date.now();
            const hpNum = hp ? parseInt(hp.split('/')[0], 10) : -1;
            if (hp && hp !== hpPrev) {
                if (hpPrev) { hpChanges++; lastChange = Date.now(); }
                hpPrev = hp;
            }
            if (hpNum === 0) {
                // 体力归零 = 怪已经死了，这时再点「攻击」只会弹「攻击失败」
                if (!zeroHpAt) zeroHpAt = Date.now();
                if (Date.now() - zeroHpAt > 6000) {
                    log('[体力归零] 6 秒未见胜利提示，撤回列表换下一只');
                    await closePopup(page, t);
                    await retreat(page, t);
                    return fin('lost');
                }
                await sleep(POLL_MS);
                continue;
            }
            const settled = Date.now() - panelAt >= FIRST_ATK_SETTLE_MS;
            const roundDone = !!hp && !!hpAtClick && hp !== hpAtClick;  // 上一回合已结算
            // 11-07 晚：兜底从 1.4 秒提到 2.2 秒。
            // 用户手动打一只 32000 血的斥候要 30 回合；脚本 1.4 秒盲点一次，
            // 服务器那一回合还没吃完就又点，回「操作失败」→ 一晚 128 次。
            // 30 回合 × 2.2 秒 ≈ 66 秒，仍远小于 BATTLE_LIMIT_MS(120s)，来得及。
            const due = clicks === 0 || roundDone || Date.now() - lastAttack >= 2200;
            if (settled && due && Date.now() - lastAttack >= ATK_GAP_MS) {
                if (!t.includes('攻击中')) {
                    lastAttack = Date.now();
                    if (await clickExact(page, '攻击', 700)) {
                        clicks++;
                        if (hp) hpAtClick = hp;
                        if (!atkLogged) { atkLogged = true; log('已点攻击（逐回合·顶速）'); }
                    }
                }
            }
        }

        // 6.5) 出手多次、体力一次没变 → 这只其实是尸体。
        //      用户 11-07 说清楚了两件事：① 面板显示满血**不代表怪还活着**（快照过时）；
        //      ② 死怪照样能点进面板，只有点攻击才提示已被击杀。
        //      所以「体力满」不能当活着的证据，能当证据的是**体力有没有真的往下掉**。
        //      实测：打死一只 32000 血的斥候 28 次出手、27 次体力结算；
        //      尸体则是 0 次结算。4 次出手（≈9 秒）还一动不动就可以判死了。
        if (clicks >= 4 && hpChanges === 0 && Date.now() - t0 > 8000) {
            log(`[体力不动] 出手${clicks}次体力一次没变，判为尸体，换下一只`);
            await closePopup(page, t);
            await retreat(page, t);
            return fin('dead');
        }

        // 7) 界面开着但 15 秒一点变化都没有 → 卡住，撤退换只。
        //    原来是 50 秒：攻城窗口只有 30 分钟，50 秒够点两只别的怪了。
        if (Date.now() - lastChange > 15000) {
            log('战斗 15 秒无任何变化，判定卡住，撤退换下一只');
            await closePopup(page, t);
            await retreat(page, t);
            return fin('stuck');
        }
        await sleep(POLL_MS);   // 原来是 600ms：这一条就吃掉了半个回合的响应速度
    }
    log(`[诊断] ${Math.round(BATTLE_LIMIT_MS / 1000)}秒仍未结束，文本前300字: ${(await getPageText(page)).replace(/\s+/g, ' ').substring(0, 300)}`);
    await page.screenshot({ path: `gc-battle-timeout-${ACCOUNT}.png` }).catch(() => {});
    await closePopup(page);
    await retreat(page);
    await sleep(400);
    return fin('timeout');
}

// 城内地图 → 点目标城门
async function goToGate(page, gate) {
    await clickText(page, '城内地图');
    await sleep(2000);
    let ok = await clickText(page, gate, 3000);
    if (!ok) {
        for (let s = 0; s < 3 && !ok; s++) {
            await page.mouse.wheel(0, 300);
            await sleep(800);
            ok = await clickText(page, gate, 2000);
        }
    }
    await sleep(2500);
    await page.keyboard.press('Escape');
    await sleep(800);
    const t = await getPageText(page);
    log(`城门[${gate}] ${ok ? '点击成功' : '点击失败(列表未见?)'} | ${cityBlock(t)}`);
    return ok;
}

// 主页找「怪物攻城」入口，读状态和击杀数
async function checkEventPage(page) {
    const t = await getPageText(page);
    if (!t.includes('怪物攻城')) {
        log('主页未见「怪物攻城」入口（非活动时间可能不显示）');
        return;
    }
    const ok = await clickText(page, '怪物攻城', 3000);
    await sleep(2500);
    const t2 = await getPageText(page);
    const st = t2.match(/状态[:：]\s*(未开启|进行中|已结束|已关闭)/);
    const kl = t2.match(/击杀[:：]\s*(\d+)/);
    const sc = t2.match(/积分[:：]\s*(\d+)/);
    const xg = t2.match(/攻城功勋[:：]\s*(\d+)/);
    log(`怪物攻城页(${ok ? '打开' : '入口点击失败'}): 状态=${st ? st[1] : '?'} 积分=${sc ? sc[1] : '?'} 击杀=${kl ? kl[1] : '?'} 功勋=${xg ? xg[1] : '?'} | ${t2.substring(0, 80).replace(/\s+/g, ' ')}`);
    await page.keyboard.press('Escape');
    await sleep(800);
}

// 人在副本里时先退本：副本页面是「副本 / 退出副本 / 剩余N分钟」，没有「出航」「传送」，
// 攻城前的导航必然失败（10-24 20:34 实证）。
async function leaveDungeon(page) {
    for (let i = 0; i < 5; i++) {
        const t = await getPageText(page);
        if (!t.includes('退出副本')) return true;
        log('检测到在副本内，先退出副本');
        await clickText(page, '退出副本', 3000);
        await sleep(2000);
        await clickText(page, '确定', 2000);
        await sleep(2500);
        if ((await getPageText(page)).includes('出航')) { log('已退出副本，回到城内'); return true; }
    }
    const ok = !(await getPageText(page)).includes('退出副本');
    if (!ok) log('退出副本失败，仍停留在副本内');
    return ok;
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
            log(`登录尝试${attempt + 1}`);

            let pageText = await getPageText(page);
            if (pageText.includes('进入游戏') || pageText.includes('你看到') || pageText.includes('当前城市')) {
                log('登录成功');
                break;
            }
            log('登录未成功，重试...');
            await sleep(2000);
        }

        // 进游戏统一走 daily.enterMain：强点击（坐标→合成事件→force）+ 判定只认「你看到/当前城市」。
        // 原来这 10 轮都是 clickText('进入游戏')，点了没反应也算点过，卡在选角页时判不出来，
        // 后面所有步骤都对着一个没进游戏的页面操作，整趟白跑还被记成「跑过了」。
        const entered = await daily.enterMain(page, { rounds: 10, pauseMs: 5000 });
        if (entered) log('进入游戏成功');
        else log('进入游戏失败：10 轮强点击仍未到主界面');

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        let pageText = await getPageText(page);
        if (!entered || pageText.includes('请输入账号密码') || pageText.includes('选择角色')) {
            log('ERROR: 未进入游戏主界面，退出');
            await page.screenshot({ path: 'gongcheng-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 0. 时段闸门放在最前面：不在 19:45~20:30 就直接退出。
        //    旧版是先出航到档位城市、再判时段 —— 非活动时段白烧一次铜贝（跨海域更贵），
        //    万一手滑在活动结束后跑，还要多花一次传送银币。
        if (!TEST && !VIEW) {
            const { hour, min } = bjNow();
            const nowT = hour * 60 + min;
            if (nowT < 19 * 60 + 45) {
                log(`非怪物攻城时段(活动周二/六 20:00-20:30，当前${hour}:${min})，直接退出（未出航，不花铜贝）`);
                await checkEventPage(page).catch(() => {});
                await browser.close();
                return;
            }
            if (nowT >= 20 * 60 + 30) {
                log(`活动已结束(当前${hour}:${min})，直接退出（未出航，不花铜贝）`);
                await checkEventPage(page).catch(() => {});
                await browser.close();
                return;
            }
        }

        // 只读模式：只读页面就退出，不做出航/导航（活动结束后查结算走这条）
        if (VIEW) {
            if (VIEW_MODE === 'mail') {
                // 邮件列表只读：**绝不点「领取所有」**，只看发放了什么
                const opened = await clickText(page, '邮件', 5000);
                await sleep(3500);
                const t = await getPageText(page);
                const lines = t.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
                log(`=== 邮件列表（${opened ? '已打开' : '入口点击失败'}，只读未领取） ===`);
                for (const s of lines.slice(0, 60)) log('  | ' + s.slice(0, 90));
                await page.screenshot({ path: 'gongcheng-mail.png', fullPage: true }).catch(() => {});
                log('只读模式结束（未领取、未出航、未花铜贝）');
                await browser.close();
                return;
            }
            await checkEventPage(page);
            await sleep(1500);
            // 再读一次完整文本，结算明细（奖励/名次）可能不在 checkEventPage 抓的那几个字段里
            const full = await getPageText(page);
            const lines = full.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
            const keys = /(状态|积分|击杀|功勋|奖励|排名|名次|结算|已结束|领取|邮件|铜贝|银币|经验)/;
            const picked = lines.filter(s => keys.test(s) && s.length <= 80).slice(0, 40);
            log('=== 活动页明细 ===');
            for (const s of picked) log('  | ' + s);
            await page.screenshot({ path: 'gongcheng-settle.png', fullPage: true }).catch(() => {});
            log('只读模式结束（未出航，未花铜贝）');
            await browser.close();
            return;
        }

        // 0.5 前置：人在副本里的话先退本
        //   10-24 20:34 那次攻城失败就卡在这：页面停在「副本 / 退出副本 / 剩余21分钟」，
        //   压根没有「出航」可点 → sailFlow 直接失败 → nav 失败 → 整个窗口白费。
        await leaveDungeon(page);

        // 1. 读等级选档位城市（状态→用户信息页）
        // ★ 绝不能再用 `lv === null ? 30` 兜底：30 级 = 威尼斯（最低档），低档击杀不计分，
        //   硬跑 30 分钟等于白杀（11-10 20:24 实证）。读不到就拒绝出航，宁可这一波不打。
        let lv = await readLevel(page);
        if (lv === null && process.env.GC_LEVEL) {
            const forced = Number(process.env.GC_LEVEL);
            if (forced > 0) {
                lv = forced;
                log(`等级读取失败，改用 GC_LEVEL=${forced}`);
            }
        }
        if (lv === null) {
            // 裸 console.log：`::error::` 必须在行首才会被 Actions 解析成红叉（log() 会加时间前缀）
            console.log('::error:: 读不到等级，拒绝出航（默认按最低档只会白杀，本波跳过）');
            await page.screenshot({ path: 'gongcheng-nolevel.png' }).catch(() => {});
            await browser.close();
            process.exitCode = 1;
            return;
        }
        let cfg = pickCity(lv);
        if (process.env.GC_CITY) {
            const forced = CITIES.find(c => c.city === process.env.GC_CITY);
            if (forced) {
                cfg = forced;
                log(`GC_CITY=${forced.city} 强制指定档位（等级 ${lv} 本应去 ${pickCity(lv).city}）`);
            }
        }
        NAV_DEST = cfg.city;
        NAV_REGION = cfg.region;
        MONSTERS = MONSTER_BASE.map(n => `${n}·${cfg.city}`);
        BATTLE_LIMIT_MS = (cfg.battleSec || 120) * 1000;
        log(`等级=${lv === null ? '?' : lv} → ${cfg.city}(${cfg.region})档，守 ${cfg.gates[LOW_GATE].gate}(${cfg.gates[LOW_GATE].score}分)，单场上限 ${cfg.battleSec}s，选怪槽位 ${ACCT_SLOT}/${SLOTS}${USE_AUTO_ATTACK ? '，自动攻击已开启' : ''}`);
        pageText = await getPageText(page);

        // 2. 到档位城市
        if (pageText.includes(`当前城市：${NAV_DEST}`)) {
            log(`已在${NAV_DEST}`);
        } else {
            log(`不在${NAV_DEST}，导航中...`);
            const arrived = await sailFlow(page);
            if (!arrived) {
                log('出航未完成，先查是否在副本/非城内，退出后重试一次');
                await leaveDungeon(page);
                if (await sailFlow(page)) {
                    log(`重试出航成功`);
                } else if ((await getPageText(page)).includes('暂无地图')) {
                    log('该号没有这张海图（暂无地图），跳过传送以免白花银币');
                } else {
                    log('出航未完成，改用传送兜底...');
                    await page.screenshot({ path: 'gongcheng-sail-fail.png' }).catch(() => {});
                    await teleportToDest(page);
                }
            }
            await sleep(2000);
            pageText = await getPageText(page);
            if (!pageText.includes(`当前城市：${NAV_DEST}`)) {
                log(`未到达${NAV_DEST}，本波放弃`);
                console.log(`::error:: 未到达${NAV_DEST}（不再静默 exit=0）`);
                await page.screenshot({ path: 'gongcheng-nav-fail.png' }).catch(() => {});
                await browser.close();
                process.exitCode = 1;
                return;
            }
        }

        // 3. 时段已在最前面卡过（未出航前就退出），这里不再重复判断

        // 4. 主战场：积分最低的北门（用户 10-31：积分最少的门人最少）
        await goToGate(page, cfg.gates[LOW_GATE].gate);

        if (TEST) {
            // 流程测试：逐门走一遍+刷新+读战绩页，不杀怪
            for (let i = 0; i < cfg.gates.length; i++) {
                if (i > 0) await goToGate(page, cfg.gates[i].gate);
                const c = await countMonsters(page);
                log(`TEST ${cfg.gates[i].gate}(${cfg.gates[i].score}分) 攻城怪数=${c}`);
                await clickText(page, '刷新', 3000);
                await sleep(3000);
                const c2 = await countMonsters(page);
                log(`TEST ${cfg.gates[i].gate} 刷新后=${c2}`);
            }
            await checkEventPage(page);
            await page.screenshot({ path: 'gongcheng-test.png' }).catch(() => {});
            log('流程测试完成');
            await browser.close();
            return;
        }

        // 5. 杀怪主循环（用户 10-31 定）：**所有号统一守积分最少的北城门**。
        //    怪被打光就一直刷新等新怪，直到杀满 5 只或过了 20:30 —— 不换门、不往上跳
        //    （积分高的门人更多，跳上去只会被抢得更狠）。
        let kills = 0;
        let tried = 0;
        let emptyRounds = 0;        // 连续空列表轮数（只用于日志节流，不触发换门）
        let lostStreak = 0;         // 连续失败只数（只用于日志节流，不换门）
        let deadStreak = 0;         // 连续「点了没出面板」只数 → 到阈值才刷一次列表
        const GATE = cfg.gates[LOW_GATE];
        const stat = { win: 0, lost: 0, dead: 0, stuck: 0, timeout: 0 };  // dead=点空死条目，lost=进了面板才被抢
        const t0 = Date.now();

        while (true) {
            if (kills >= KILL_TARGET) {
                log(`杀满${KILL_TARGET}只，收工（后续回流程继续刷野怪）`);
                break;
            }
            const ph = eventPhase();
            if (ph === 'over') {
                log('已过20:30，活动结束');
                break;
            }
            if (Date.now() - START_TS > MAX_RUN_MS) {
                log(`运行已超 ${Math.round(MAX_RUN_MS / 60000)} 分钟，强制收尾（GC_MAX_SEC）`);
                break;
            }

            if (ph === 'wait') {
                const { hour, min } = bjNow();
                // ★ 20:00 前的刷新节奏（用户 11-14 强调）：提前到位后页面**不会自己出怪**，
                //   必须手动点「刷新」才会显示出新一波。所以 20:00 前一直刷；
                //   最后 90 秒把间隔从 15s 压到 3s —— 第一批怪是最抢手的，15 秒一次会整段错过。
                const left = 20 * 3600 - bjDaySec();
                const gap = left <= 90 ? 3000 : 15000;
                if (left % 15 < 4 || left <= 90) {
                    log(`等20:00开怪（当前${hour}:${min}，还差${left}秒，每${gap / 1000}秒刷新一次）`);
                }
                const clicked = await clickText(page, '刷新', 3000);
                if (!clicked) log('⚠ 没点到「刷新」，下一轮重试');
                await sleep(gap);
                continue;
            }

            const total = await countMonsters(page);
            if (total === 0) {
                // 怪被杀光：一直刷，刷到出新怪为止（用户定）。日志每 10 轮打一行，
                // 免得空窗期刷出几百行噪音。
                emptyRounds++;
                if (emptyRounds === 1 || emptyRounds % 10 === 0) {
                    log(`${GATE.gate}(${GATE.score}分)没有攻城怪（连续${emptyRounds}轮），继续刷新等下一波`);
                }
                // 开局前 3 轮（20:00 刚开、页面还没渲染出怪）用 1.2s 快刷抢第一批；
                // 之后回到 3s，避免空窗期刷太躁。
                await refreshList(page, emptyRounds <= 3 ? 1200 : 3000);
                tried = 0;
                continue;
            }
            emptyRounds = 0;

            // 挑怪：从列表中间起挑（用户 10-31 定，第一只是所有人都在抢的），
            // 再按账号槽位散开 SLOTS 份，避免五个号自己人抢同一只。
            // tried = 本轮已试过的只数，从起点往后走、绕一圈回到起点，都试过才刷新列表。
            if (tried >= total) {
                log(`可见${total}只都试过了，刷新列表`);
                await refreshList(page, 2500);
                tried = 0;
                continue;
            }
            const r = await clickMonster(page, tried);
            if (r.done) {
                log(`可见${r.total}只都试过了，刷新列表`);
                await refreshList(page, 2500);
                tried = 0;
                continue;
            }
            log(`点怪[${r.clicked}] 序号${r.pick}/${r.total}（槽${ACCT_SLOT}，最脆一档${r.topCount}只，本轮第${tried + 1}只）`);
            // 原来这里死等 1.5 秒再进战斗判定 —— resolveBattle 自己会轮询等面板（openMs），
            // 再叠 1.5 秒纯属白等：27 次尝试 × 1.5s ≈ 40 秒，攻城窗口里就是半只怪。
            // 11-03 再压：300ms → 100ms，一局 456 次尝试又能省 91 秒。
            await sleep(100);

            const res = await resolveBattle(page);
            stat[res] = (stat[res] || 0) + 1;
            // 血池为 0：补药成功就回到列表重新抢（不算这只失败，不推进 tried）；
            // 补不上药转硬打，也是回到列表重新点这只接着打 —— 不换只、不收工。
            if (res === 'healed') {
                log('血池已补，回到列表继续抢怪');
                continue;
            }
            if (res === 'hard') {
                log('无药可补，按「没有体力宝」硬打（不回退、不收工）');
                continue;
            }
            if (res === 'noBlood') {
                if (BLOOD_DEAD) {
                    log(`::error::本波已判收工（补药 ${BLOOD_HEALS} 次 / 连续无效 ${BLOOD_HEAL_FAILS} 次）`);
                    break;
                }
                tried++;
                log('本只血池 0，换下一只继续抢');
                continue;
            }
            if (res === 'win') {
                kills++;
                lostStreak = 0;
                deadStreak = 0;
                log(`击杀成功 → ${kills}/${KILL_TARGET}`);
                // 杀完刷新：刚死这只在列表里变成尸体但不会自己消失（用户 11-07 澄清），
                // 刷一次既能把它清掉，也能顺带看这一门还剩几只活的。
                // 5 只封顶，最多花十秒，比反复点尸体划算。
                // 11-10：等待 2000→1200。列表刷新本身 1 秒内就完成，多等的 0.8 秒 ×5 只
                // 在 30 分钟窗口里不算多，但能让下一只更早开始（每波怪存活只十几秒）。
                await refreshList(page, 1200);
                tried = 0;
                continue;
            } else {
                // lost = 这只被别的玩家抢掉了（人多时是常态），撤退后立刻换下一只
                tried++;
                if (res === 'lost' || res === 'dead') lostStreak++;
                log(`本只(${res})，撤退换下一只（连续失败${lostStreak}）`);
                // 11-07 20:29 用户澄清：**列表是快照，死怪不点刷新就一直留着**，
                // 而且还能点进去、只有攻击才提示已被击杀。所以：
                //   · dead（尸体 / 点了没出面板）= 刷新有用，刷新能把它们清出列表；
                //   · lost（打掉过血才被人收尾）= 真被抢，刷新没用，只换下一只。
                // 阈值 3：尸体一只大约 1.5 秒，3 只 ≈ 4.5 秒 > 一次刷新 2 秒，到这就划算。
                // 早先设 8 是建立在「刷新没用」的错误结论上，撤掉。
                // 11-10 末段加速：20:25 之后还没杀满，就把刷新阈值 3→2。
                // 那时候列表里多半是别人扫过的尸体快照，而 20:25 会刷最后一波新怪 ——
                // 只有尽早刷新才能看到新怪，干点尸体等于把这波也白扔。
                const late = (20 * 60 + 30 - (bjNow().hour * 60 + bjNow().min)) <= 5;
                const deadLimit = late ? 2 : 3;
                if (res === 'dead') {
                    deadStreak++;
                    if (deadStreak >= deadLimit) {
                        log(`连续${deadStreak}只是尸体，刷新列表清掉死条目`);
                        await refreshList(page, 2000);
                        // 关键：这里**不把 tried 归零**。刷新万一没把尸体清掉（或者清得不彻底），
                        // 归零就会原地重扫同样三只尸体 → 刷新 → 再重扫，30 分钟窗口全废。
                        // 保持 tried 只会丢掉少量条目（刷新后序号下移），但保证一定往前走。
                        // 只有「整份快照扫完」（下面的 tried >= total）才归零重来，
                        // 那时拿到的确实是一份新快照。
                        deadStreak = 0;
                    }
                } else {
                    deadStreak = 0;
                }
                // 连续被抢不换门（用户 10-31 定：所有号统一守积分最少的北城门，上面几个门人更多），
                // 但「刷新」的结论要更正：11-03 认为「刷新不能让怪变多变活、别多刷」是错的 ——
                // 刷新是让列表从快照回到当前状态的唯一手段（死怪靠它才消失）。
                // 现在的刷新时机只有两个：整份快照扫完（tried 到 total）、连续 3 只尸体。
                if (lostStreak % 10 === 0) {
                    log(`连续${lostStreak}只失败，继续守 ${GATE.gate}(${GATE.score}分)，接着换下一只`);
                }
            }
        }

        // 5. 战绩页核对
        await checkEventPage(page);
        await page.screenshot({ path: 'gongcheng-end.png' }).catch(() => {});
        log(`结束: 击杀${kills}只 | 战斗统计 win=${stat.win} 点空=${stat.dead} 被抢=${stat.lost} 卡住=${stat.stuck} 超时=${stat.timeout} 补药=${stat.healed || 0} 转硬打=${stat.hard || 0} 血池收工=${stat.noBlood || 0}`);

    } catch (e) {
        console.error('[gongcheng] 错误:', e.message);
        await page.screenshot({ path: 'gongcheng-fail.png' }).catch(() => {});
    } finally {
        await browser.close().catch(() => {});
    }
}

// 供本地探针/单测复用（tasks.js 用 spawn 子进程调用，require.main 保护不影响 CI）
if (require.main === module) run();

module.exports = { LOST_RE, inBattleMenu, bloodGate, closePopup, resolveBattle, countMonsters, clickMonster, refreshList, goToGate, readLevel, pickCity, eventPhase, monsterHp, CITIES };
