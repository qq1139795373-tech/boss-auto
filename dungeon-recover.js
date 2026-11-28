// 副本内自恢复 + 扫荡/领奖弹窗处理（fish / mibao / farm / dungeon 共用）
//
// 为什么要有这个文件
// ---------------------------------------------------------------------------
// 2026-10-27 00:00 波 boss(0)=coldwind6 实证：
//   扫荡成功 → 副本条件 4 项全部 0（已达成）→ 页面上「领取奖励」还在，
//   但领奖那一步被「扫荡收获」弹窗盖住没点掉。
//   21 秒后下一个步骤（钓鱼）的自恢复只读到「副本条件」就点了「退出副本」，
//   当天的炼器窟奖励（经验×10000 / 铜贝×20000 / 补给箱）就这么扔了。
//
// 真实界面（2026-10-28 用户截图）：
//   扫荡后弹「扫荡收获」：标题 + 物品清单 + **只有一个「知道了」按钮**，没有「确定」。
//   点「知道了」关掉它，才能点上面的「领取奖励」；
//   点「领取奖励」再弹「提示：领取奖励后默认退出副本，是否领取奖励？ 取消 | 确定」。
//   所以正确顺序：扫荡 → 知道了 → 领取奖励 → 确定。
//
// 老代码的坑：点「知道了」之后直接 break，没有回头验证弹窗是否真的关闭；
//   clickExact 只要元素存在就返回 true（点没点中不管），弹窗留在原地，
//   后面 clickLeaf('领取奖励') 把「提示」弹在「扫荡收获」之上，两层叠在一起，
//   再点一次「确定」只关掉最上面一层 —— 状态就废了。
//   这里全部改成「点一次 → 重读页面 → 确认目标文本消失」，没消失就补真实坐标点击。
//
// 用法：
//   const { recoverDungeon, closeSweepPopup } = require('./dungeon-recover');
//   const r = await recoverDungeon(page, { tag: '自恢复' });
//   r = { inDungeon, kind, swept, claimed, exited }

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 只拼可见节点：textContent('body') 会把 display:none 的残留弹窗也读进来（幽灵文案）
async function visibleText(page) {
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

// 找「自己就是这段文字、且没有同文本子元素」的最内层可见节点，返回中心坐标
async function findLeafCenter(page, text, exact = true) {
    return await page.evaluate(({ text, exact }) => {
        const visible = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                if (parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const all = Array.from(document.querySelectorAll('a,button,div,span,li,p,em,i,b,label'));
        const hit = all.find(el => {
            if (!visible(el)) return false;
            const t = label(el);
            if (exact ? t !== text : !t.includes(text)) return false;
            return !Array.from(el.children).some(c => visible(c) && label(c) === t);
        });
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { text, exact }).catch(() => null);
}

// 按文本点击。这些页面里链接/按钮/任务行只吃合成事件，必须 pointerdown→…→click 全套
// （同 daily.js 的 clickLeaf）；real=true 时再用真实鼠标坐标补一下
async function clickByText(page, text, { exact = true, real = false } = {}) {
    const pt = await findLeafCenter(page, text, exact);
    if (!pt) return false;
    if (real) {
        try { await page.mouse.click(pt.x, pt.y); return true; } catch (e) { /* fallthrough */ }
    }
    const ok = await page.evaluate(({ text, exact }) => {
        const visible = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                if (parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const all = Array.from(document.querySelectorAll('a,button,div,span,li,p,em,i,b,label'));
        const hit = all.find(el => {
            if (!visible(el)) return false;
            const t = label(el);
            if (exact ? t !== text : !t.includes(text)) return false;
            return !Array.from(el.children).some(c => visible(c) && label(c) === t);
        });
        if (!hit) return false;
        const r = hit.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            hit.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, { text, exact }).catch(() => false);
    return ok;
}

// 用 Playwright 原生 locator 精确点一段文字。
// 为什么需要：真机（2026-11-15）证明 uni 组件对 dispatchEvent 合成事件不感冒（点了 30→30），
// 只有 Playwright 的真实鼠标点击才算数。撤退/关闭这类按钮统一先走这里，失败再退回合成事件。
async function clickTextReal(page, text, { exact = true } = {}) {
    try {
        const loc = page.getByText(text, { exact }).first();
        if ((await loc.count()) === 0) return false;
        if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return false;
        await loc.click({ force: true, timeout: 3500 });
        return true;
    } catch (e) {
        return false;
    }
}

// 点一次 + 验证消失；真实点击优先，没生效再用合成事件补。返回是否确实关掉
async function clickAndVerify(page, text, goneText, { tries = 3, wait = 1200 } = {}) {
    for (let i = 0; i < tries; i++) {
        await clickByText(page, text, { exact: true });
        await sleep(wait);
        let t = await visibleText(page);
        if (goneText && !t.includes(goneText)) return true;
        if (!goneText && !t.includes(text)) return true;
        // 没生效 → 真实坐标再补一下（有些元素只吃真实鼠标事件）
        await clickByText(page, text, { exact: true, real: true });
        await sleep(wait);
        t = await visibleText(page);
        if (goneText && !t.includes(goneText)) return true;
        if (!goneText && !t.includes(text)) return true;
    }
    return false;
}

// 关掉「扫荡收获」弹窗（只有一个「知道了」）。返回是否关掉
async function closeSweepPopup(page, opts = {}) {
    const log = opts.log || (() => { });
    for (let i = 0; i < 3; i++) {
        const t = await visibleText(page);
        if (!t.includes('扫荡收获')) return true;
        log(`关闭「扫荡收获」弹窗（第 ${i + 1} 次）...`);
        const ok = await clickAndVerify(page, '知道了', '扫荡收获', { tries: 2 });
        if (ok) return true;
    }
    return !(await visibleText(page)).includes('扫荡收获');
}

// 点掉挡路的弹窗。扫荡收获只有一个「知道了」；领奖提示有「确定」（绝不点「取消」= 不领奖）
// 关键时序（用户 2026-10-29 纠正）：奖励明细 toast 是**点完「确定」之后**才弹的，只活一两秒。
// 而点完「确定」还要等 1.2 秒复核弹窗关没关 —— 先点再读会漏掉它。
// 所以这里在点「确定」的同时就把抓 toast 的轮询挂上，点完直接取结果。
//
// ★ 2026-11-25：返回值从「关了几个弹窗」改成**抓到的明细原文数组**（'' 之外的都是真抓到的）。
//   原来只打印不返回，recoverDungeon 那条自恢复路径（fish/mibao/farm/zhenyaota 共用）
//   领完奖只剩「离开副本页」这一个页面证据，拿不到明细原文去证明到账。
//   所有现有调用方都忽略返回值，改签名不影响它们。
async function dismissPopups(page, opts = {}) {
    const log = opts.log || (() => { });
    const toasts = [];
    for (let i = 0; i < 5; i++) {
        const t = await visibleText(page);
        const sweep = t.includes('扫荡收获');
        const askClaim = t.includes('是否领取奖励');
        if (!sweep && !askClaim) break;
        if (sweep) {
            await closeSweepPopup(page, { log });
        } else if (askClaim) {
            log('确认领奖提示（点「确定」）...');
            const toastP = readRewardToast(page, opts.toastMs || 4000);   // 先挂上轮询
            await clickAndVerify(page, '确定', '是否领取奖励', { tries: 2 });
            const rw = await toastP;
            if (rw) { log(`领奖明细：${rw}`); toasts.push(rw); }
        }
        await sleep(800);
    }
    return toasts;
}

// 领奖瞬间游戏会弹一个一闪而过的「提示」toast，内容就是这次到底给了什么，例如：
//   获得经验*0，铜币*30000，浴火之蝶*1，奔月副本箱*1，藏宝图碎片*10
// 它盖在「领取奖励后默认退出副本，是否领取奖励？取消|确定」确认框之上（用户 2026-10-29 截图实证），
// 点「确定」后页面回主城/副本门口（不是留在副本里）。也就是说：
//   - 它是**唯一**能证明奖励真到账的读数（之前拿「铜贝 +20000」去对方向就错了）；
//   - 它只存在一两秒，必须在点完「领取奖励」后立刻连着读几次，否则什么都抓不到。
// 每个副本给的东西都不一样，所以**不认具体物品名**，只认「获得…」+ 像清单的文本。
function pickReward(t) {
    const re = /(?:你)?获得[^\n]{5,200}/g;
    let m;
    while ((m = re.exec(t))) {
        let s = m[0];
        for (const stop of ['领取奖励后', '提示', '取消', '确定']) {
            const k = s.indexOf(stop);
            if (k > 0) s = s.slice(0, k);
        }
        s = s.replace(/\s+/g, ' ').trim();
        // 必须像一份奖励清单：带 *N / ×N 的数量标记，或是逗号分隔的多项
        if (/[*×]\s*\d/.test(s) || /[，,]/.test(s)) return s;
    }
    return '';
}

async function readRewardToast(page, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const t = await visibleText(page);
        const r = pickReward(t);
        if (r) return r;
        await sleep(300);
    }
    return '';
}

// ★ 副本的真实机制（用户 2026-10-29 说明，别再自己加戏）：
//   1. 每个副本**每天自动刷新 1 次**机会，不是"剩余多次"、"剩余0次"那套。
//   2. 只要进了副本，不超时 / 不主动退出 / 不领奖，**重登后仍然在副本里**（进本状态是持久的）。
//      所以脚本被杀、被 cancel、下个波次重新登录，人还在里面。**这时候绝不能退本**：
//      当天那 1 次已经花掉了，退出去今天再也进不来，等于白扔一次机会。
//   3. 通关后出现「领取奖励」，领完退回进入副本前的页面（入口页）。
//   4. 此时再点副本，按钮显示「次数为 0 / 次数已用尽」= 今天这一次已经用掉。
//
// 所以判据只有一条：入口页还能不能进。
//   次数 0 / 已用尽 → 'used'      今天打完了
//   剩余N次 / 能进   → 'available' 还没打，或被踢出来没打完
//   都不是          → 'unknown'   不在入口页
function remainTimes(t) {
    const m = t.match(/剩余\s*(\d+)\s*次/);
    if (m) return Number(m[1]);
    if (/次数\s*[为:：]?\s*0|次数已用尽|次数不足|次数已用完/.test(t)) return 0;
    return null;
}

function claimEvidenceIn(t) {
    const n = remainTimes(t);
    if (n === 0) return 'used';
    if (n !== null) return 'available';
    if (t.includes('进入副本')) return 'available';
    return 'unknown';
}

async function claimEvidence(page) {
    return claimEvidenceIn(await visibleText(page));
}

// ★ 领奖后回城市主视图。包裹按钮**只在城市主视图里**（bag-read.js 第一条判据就是页面要有
//   「当前城市」），领完奖停在副本入口页/铁匠铺浮层上直接读包裹 → 全返回 null →
//   得出「增量不足」的假结论（fmsj.js 11-22 写对账时差点埋进去的坑）。
//   只认页面出现「当前城市」，Escape 与左上返回箭头交替试，最多 5 轮。
async function backToCityView(page, opts = {}) {
    const log = opts.log || (() => { });
    // txt 的契约是 **(page) => Promise<页面文本>**，调用时必须把 page 带上。
    // ★ 11-26 踩坑（炼器窟/基德的背包对账从来没真正跑起来）：dungeon.js / kidd.js 传的是
    //   `txt: getPageText`，而 getPageText(page) 是两参形态；旧写法按零参调用 `await txt()`
    //   → getPageText(undefined) → 内部 page.evaluate 立刻抛
    //   「Cannot read properties of undefined (reading 'evaluate')」，被调用方的 try 兜住，
    //   整段对账跳进 catch，只留一条 warning。现在统一在这里补 page。
    //   （零参闭包也兼容：多传一个参数给箭头函数是无害的。）
    const txt = () => (opts.txt ? opts.txt(page) : visibleText(page));
    // 注意：这里**绝不点「退出副本」**。本函数也被「领奖失败」的路径调用，那时若退本，
    // 当天那 1 次机会就白扔了（副本每天只 1 次，进本状态持久）。回不了城就返回 false，
    // 由调用方跳过背包对账并打 warning —— 少一条对账证据，好过毁掉一次机会。
    for (let i = 0; i < 5; i++) {
        if ((await txt()).includes('当前城市')) return true;
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(2000);
        if ((await txt()).includes('当前城市')) return true;
        await Promise.race([
            page.mouse.click(14, 26),                                   // 左上返回箭头
            new Promise((_, rej) => setTimeout(() => rej(new Error('click-timeout')), 8000)),
        ]).catch(() => { });
        await sleep(2000);
    }
    const ok = (await txt()).includes('当前城市');
    if (!ok) log('::warning::领奖后没回到城市主视图 → 读不了包裹，本次跳过背包对账');
    return ok;
}

function identify(t) {
    if (/玄铁矿工|翡翠采掘者|血晶守卫|猫眼猎手|矿采场|赤晶|北幽猫|翠晶/.test(t)) return '炼器窟';
    if (/基德|暗仓|奴隶仓|枢纽广场|金库|机关厅|兽栏/.test(t)) return '基德的宝藏';
    return '未知副本';
}

// 主流程：扫荡（有就扫）→ 领奖（有就领，循环到没有）→ 实在没得领才退本
//
// ★ 为什么「先领奖再退本」是硬要求：进本后重登**人还在副本里**，而每天只有 1 次机会。
//   领完奖励才算这一天打完；没领就点「退出副本」= 那 1 次机会白扔（今天再也进不来）。
//   这也是 2026-10-27 boss(0) 那次事故的实质损失，不是「少拿一份奖励」。
async function recoverDungeon(page, opts = {}) {
    const log = opts.log || ((m) => console.log(m));
    const tag = opts.tag || '自恢复';
    const screenshot = opts.screenshot || null;

    let t = await visibleText(page);
    const inDungeon = t.includes('副本条件') || (t.includes('退出副本') && t.includes('回到起点'));
    if (!inDungeon) return { inDungeon: false, kind: '', swept: false, claimed: false, exited: false };

    const kind = identify(t);
    log(`${tag}：人在副本里（${kind}），先尝试把副本做完（扫荡/领奖）再退...`);

    // 先把扫描遗留的弹窗清掉，否则下面所有点击都被它挡着
    await dismissPopups(page, { log });

    // ---- 1) 扫荡：炼器窟有，基德没有。扫荡入口进本后异步渲染，先等一会 ----
    //  11-25：等渲染的重读统一 2 秒 × 5 次（原来 1.5 秒 × 4 次，约 6 秒 → 现在约 10 秒）
    let swept = false;
    t = await visibleText(page);
    for (let i = 0; i < 5 && !t.includes('扫荡'); i++) {
        await sleep(2000);
        t = await visibleText(page);
    }
    if (t.includes('扫荡') && !t.includes('扫荡收获')) {
        log(`${tag}：发现扫荡入口，先扫荡（不用打怪）...`);
        await clickByText(page, '扫荡', { exact: true });
        let okTxt = '';
        for (let w = 0; w < 8; w++) {
            await sleep(1200);
            okTxt = await visibleText(page);
            if (okTxt.includes('扫荡收获') || okTxt.includes('扫荡成功')) break;
        }
        if (okTxt.includes('扫荡收获') || okTxt.includes('扫荡成功')) {
            swept = true;
            log(`${tag}：扫荡成功`);
            await closeSweepPopup(page, { log });   // ← 必须关掉，否则盖住「领取奖励」
        } else {
            log(`${tag}：扫荡没出结果，继续走领奖`);
        }
    }

    // ---- 2) 领奖：循环到「领取奖励」消失或已离开副本页 ----
    let claimed = false;
    let claimToasts = [];      // 领奖过程中抓到的明细原文（到账的第一手证据）
    for (let round = 1; round <= 5; round++) {
        t = await visibleText(page);
        if (!t.includes('副本条件')) { claimed = true; break; }   // 已退出副本 = 领到了
        if (!t.includes('领取奖励')) break;                       // 没有可领的
        log(`${tag}：点「领取奖励」（第 ${round} 轮）...`);
        if (!(await clickByText(page, '领取奖励', { exact: true }))) {
            log(`${tag}：领取奖励点不到`);
            break;
        }
        await sleep(2000);
        claimToasts = claimToasts.concat((await dismissPopups(page, { log })) || []);
        await sleep(2000);
        t = await visibleText(page);
        if (!t.includes('副本条件') || !t.includes('领取奖励')) { claimed = true; break; }
        log(`${tag}：第 ${round} 轮领奖后仍在副本页（「领取奖励」还在）`);
    }
    const claimToast = claimToasts[claimToasts.length - 1] || '';   // 交回给调用方（fish/mibao/farm/zhenyaota）
    if (claimed) {
        // ★ 2026-11-25：把「到账」和「页面说走完了」分开。这里有明细原文才算到账；
        //   没有就明确写「未经证实」，不能让一句「奖励已领取」冒充到账证据。
        const last = claimToasts[claimToasts.length - 1];
        if (last) log(`${tag}：奖励已领取，到账证据（明细原文）：${last}`);
        else log(`${tag}：::warning::奖励已领取，但没抓到明细原文 → 只有页面证据（「领取奖励」消失 / 已离开副本页），到账未经证实`);
    }
    // 领完检查一次入口页：还是「剩余1次」= 这一次没结算掉，得说清楚
    t = await visibleText(page);
    const ev = claimEvidenceIn(t);
    if (ev === 'used') log(`${tag}：入口页已显示「次数为 0」，今天这一次确实用掉了`);
    else if (ev === 'available') log(`${tag}：入口页仍可「进入副本」（次数还在），领奖可能没结算掉`);

    t = await visibleText(page);
    if (!t.includes('副本条件') && !t.includes('退出副本')) {
        return { inDungeon: true, kind, swept, claimed, exited: true, toast: claimToast };
    }

    // ---- 3) 退本：没有可领的了才走这里 ----
    // 注意：退出副本后今天这 1 次机会就没了（进本状态持久，退了也进不来），
    // 所以走到这里说明这个副本已经被判定为「本次没法打完/没东西可领」，日志里说清楚。
    log(`${tag}：副本里没有可领的奖励了（多半没通关），退出副本 —— 今天这 1 次机会作废`);
    for (let i = 1; i <= 5; i++) {
        await clickByText(page, '退出副本');
        await sleep(2000);
        let tt = await visibleText(page);
        if (tt.includes('退出副本') && tt.includes('确定')) {
            await clickByText(page, '确定', { exact: true });
            await sleep(2000);
            tt = await visibleText(page);
        }
        if (!tt.includes('副本条件')) {
            return { inDungeon: true, kind, swept, claimed, exited: true, toast: claimToast };
        }
        log(`${tag}：第 ${i} 次退出副本未生效，重试...`);
    }
    if (screenshot) {
        try { await page.screenshot({ path: screenshot }); } catch (e) { /* ignore */ }
    }
    const left = await visibleText(page);
    log(`${tag}：退出副本失败，仍在: ${left.replace(/\s+/g, ' ').substring(0, 200)}`);
    return { inDungeon: true, kind, swept, claimed, exited: false, toast: claimToast };
}

// ============================ 血池为 0 的补给 ============================
// 用户 2026-11-15 说明的机制（截图实证）：
//   战斗面板长这样：「攻击 自动攻击 查看 撤退 / 病鸡体力：60/60 / 体力：2691/4197 -0 血池：0」
//   血池 = 出刀的消耗池。**血池 0 时点「攻击」不掉血也不掉回合**，怪纹丝不动，
//   旧代码会白点满 12 次「攻击」然后报「未见结算」，怪留在房间里 → 房间永远清不干净。
//
// 两条补给路径（用户明确分开的两条）：
//   野区点怪（主城/野图）：撤退 → 首页「包裹」→「药水」→ 用「小体力宝」，没有小的才用「体力宝」
//   副本里杀到一半：撤退 → 副本页左下「背包」→ 同样有「药水」→ 用完关掉背包，回去接着杀
// 用哪个：**优先小体力宝，其次体力宝**（用户点名的优先级，不要反过来）。
// ★ 只认这两个名字（用户 2026-11-15 再次强调「其他药不用管，只需要记住体力宝、小体力宝」）：
//   药水页里还有 小体力豆 / 小攻击豆 / 万能药 / 魔能奶糖 / 三倍经验药水 等，一律不碰、绝不误点。
//   「小体力豆」和「小体力宝」只差一个字，所以下面认名字一律用「去等级后缀后全等」，
//   不用 includes —— 否则要大的时候会点到「小体力宝」那一行。

const BLOOD_ITEMS = ['小体力宝', '体力宝'];

// 读血池（面板里写作「血池: 0」或「血池：0」）。读不到返回 null
function readBlood(t) {
    const m = (t || '').match(/血池\s*[:：]\s*(\d+)/);
    return m ? Number(m[1]) : null;
}

// 战斗面板：撤退 + 攻击/自动攻击 同时存在（主界面自己的状态栏没有「撤退」）
function inFightPanel(t) {
    return t.includes('撤退') && (t.includes('攻击') || t.includes('自动攻击'));
}

// 背包/包裹是否已打开：认页签组（装备/药水/道具/材料/宝箱）+ 行内动作（使用/详情/已装备）
// 只看「使用」会误判：默认「全部」页签下列表全是装备，行里只有「详情」「已装备」，没有「使用」
// 包裹是否开着。
// ★ 2026-11-20 冷6 实证（20:56 日志）：包裹切到「网格」视图后**没有「使用/详情」按钮**（只有右下角数量角标），
//   旧判据要求「页签组 + 使用/详情」→ 网格下永远判「没打开」，两个后果：
//     ① healBlood 误报 no-bag（其实已经打开了）；
//     ② closeBagPanel 判 !bagOpened 直接返回「已关」，其实包裹还盖在副本页上 →
//        走廊每一间都读不到「你看到」区块，空转 15 次后整趟副本作废（冷6 今天就是这么废的）。
//   改为只认页签组（与 bag-read.js 的 bagStillOpen 同一判据）：主界面/副本页不含「包裹 + 装备…药水」这组文字。
function bagOpened(t) {
    const flat = (t || '').replace(/\s+/g, '');
    return /包裹/.test(flat) && /(装备[\s\S]{0,10}药水|材料[\s\S]{0,10}宝石)/.test(flat);
}

// 在「名称所在的那一行」里点某个按钮（'使用' / '详情'）。
// 不能直接点 '使用'：列表里每一行都有「使用」，点第一个就会用错药（第一行是「小体力豆」）。
//
// ★ 2026-11-15 真机实证（coldwind0）：
//   按钮是 `<uni-view class="btn use-btn"><uni-text><span>使用</span>…` 三层结构，
//   **dispatchEvent 派发 pointerdown…click 全套，数量 30→30，一点反应都没有**；
//   而 Playwright 的元素点击（内部鼠标真实事件）有效。
//   另外这一行常常在视口外（实测 y=947，视口 800），自己算的坐标滚完就过期了，
//   所以这里只用「打标记 → page.click(标记)」，把滚动和命中都交给 Playwright。
async function clickBtnInRow(page, name, btnText = '使用') {
    const pt = await page.evaluate(({ itemName, btnText }) => {
        document.querySelectorAll('[data-heal-btn]').forEach((el) => el.removeAttribute('data-heal-btn'));
        const vis = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        // 「体力宝」是「小体力宝」的子串，直接 includes 会在只剩大药时点错行，
        // 所以先按「去掉（1级）/ 第1级 后全等」认名字，认不到再退回包含匹配。
        const bare = (s) => s.replace(/[（(][^）)]*[)）]/g, '').replace(/第?\s*\d+\s*级/g, '').replace(/\s+/g, '').trim();
        const nodes = Array.from(document.querySelectorAll('body *')).filter(vis);
        const isNameLeaf = (el) => {
            const t = label(el);
            if (t.includes('使用') || t.includes('数量')) return false;
            if (t.length > itemName.length + 14) return false;
            return !Array.from(el.children).some((c) => vis(c) && label(c).includes(itemName));
        };
        let nameEls = nodes.filter((el) => isNameLeaf(el) && bare(label(el)) === itemName);
        if (!nameEls.length) nameEls = nodes.filter((el) => isNameLeaf(el) && label(el).includes(itemName)
            && bare(label(el)) !== '小' + itemName);   // 要「体力宝」时别把「小体力宝」认成它
        for (const ne of nameEls) {
            let row = ne;
            for (let up = 0; up < 8 && row; up++) {
                row = row.parentElement;
                if (!row) break;
                const rt = label(row);
                if (!rt.includes(btnText)) continue;
                if (!rt.includes(itemName)) continue;               // 必须和物品名同一行，否则会点到隔壁药的按钮
                const r = row.getBoundingClientRect();
                if (r.height <= 0 || r.height > 240) continue;      // 整页/整个列表不算一行
                // 取最外层那个带 btn 类的按钮（uni-view.btn.use-btn），而不是里面没有事件的 span
                const cands = Array.from(row.querySelectorAll('*')).filter((el) => vis(el) && label(el) === btnText);
                if (!cands.length) continue;
                const btnEl = cands.find((el) => /btn/i.test(String(el.className))) || cands[0];
                btnEl.setAttribute('data-heal-btn', '1');
                try { btnEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
                const ur = btnEl.getBoundingClientRect();
                return { x: Math.round(ur.left + ur.width / 2), y: Math.round(ur.top + ur.height / 2), tag: btnEl.tagName, cls: String(btnEl.className).slice(0, 40) };
            }
        }
        return null;
    }, { itemName: name, btnText }).catch(() => null);
    if (!pt) return null;
    // Playwright 会自己把元素滚进视口并在元素坐标上发真实鼠标事件
    const ok = await page.click('[data-heal-btn="1"]', { force: true, timeout: 5000 }).then(() => true).catch(() => false);
    if (!ok) await page.mouse.click(pt.x, pt.y).catch(() => { });
    await page.evaluate(() => {
        const el = document.querySelector('[data-heal-btn="1"]');
        if (el) el.removeAttribute('data-heal-btn');
    }).catch(() => { });
    return pt;
}

// ★ 只补一次真实点击（不要再叠加合成事件，否则「详情」会被点开又关掉）
async function realClick(page, pt) {
    if (!pt) return false;
    const ok = await page.mouse.click(pt.x, pt.y).then(() => true).catch(() => false);
    return ok;
}

// 兼容旧调用：点该行「使用」
async function clickUseInRow(page, name) {
    return !!(await clickBtnInRow(page, name, '使用'));
}

// 读某一行显示的数量（「数量：55」）。读不到返回 -1
async function rowQuantity(page, name) {
    return await page.evaluate((itemName) => {
        const vis = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const bare = (s) => s.replace(/[（(][^）)]*[)）]/g, '').replace(/第?\s*\d+\s*级/g, '').replace(/\s+/g, '').trim();
        const nodes = Array.from(document.querySelectorAll('body *')).filter(vis);
        const isNameLeaf = (el) => {
            const t = label(el);
            if (t.includes('使用') || t.includes('数量')) return false;
            if (t.length > itemName.length + 14) return false;
            return !Array.from(el.children).some((c) => vis(c) && label(c).includes(itemName));
        };
        let nameEls = nodes.filter((el) => isNameLeaf(el) && bare(label(el)) === itemName);
        if (!nameEls.length) nameEls = nodes.filter((el) => isNameLeaf(el) && label(el).includes(itemName)
            && bare(label(el)) !== '小' + itemName);   // 要「体力宝」时别把「小体力宝」认成它
        for (const ne of nameEls) {
            let row = ne;
            for (let up = 0; up < 8 && row; up++) {
                row = row.parentElement;
                if (!row) break;
                const rt = label(row);
                if (!rt.includes('使用')) continue;
                const r = row.getBoundingClientRect();
                if (r.height <= 0 || r.height > 240) continue;
                const m = rt.match(/数量\s*[：:]\s*(\d+)/);
                if (m) return Number(m[1]);
            }
        }
        return -1;
    }, name).catch(() => -1);
}

// 关背包/包裹回游戏视图：先点「关闭」，再试左上返回坐标，再点同名按钮切换，最后 Escape
async function closeBagPanel(page, { log = () => { } } = {}) {
    for (let i = 0; i < 3; i++) {
        let t = await visibleText(page);
        if (!bagOpened(t)) return true;
        if (!(await clickTextReal(page, '关闭'))) await clickByText(page, '关闭', { exact: true });
        await sleep(900);
        t = await visibleText(page);
        if (!bagOpened(t)) return true;
        // 左上角返回箭头（队伍面板就是 (19,20) 那个位置）
        await page.mouse.click(19, 20).catch(() => { });
        await sleep(1000);
        t = await visibleText(page);
        if (!bagOpened(t)) return true;
        // 「包裹/背包」按钮再点一次：多数页面是开/关切换
        for (const nm of ['包裹', '背包']) {
            if (!t.includes(nm)) continue;
            await clickByText(page, nm, { exact: true });
            await sleep(1100);
            t = await visibleText(page);
            if (!bagOpened(t)) return true;
        }
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(900);
    }
    const left = await visibleText(page);
    const ok = !bagOpened(left);
    if (!ok) log(`背包关不掉，页面: ${left.replace(/\s+/g, ' ').substring(0, 120)}`);
    return ok;
}

// 打开背包：副本里叫「背包」，主城/野区在首页叫「包裹」。两个都试，认「使用+详情」
async function openBagPanel(page, { inDungeon = false, log = () => { } } = {}) {
    let t = await visibleText(page);
    if (bagOpened(t)) return true;
    const order = inDungeon ? ['背包', '包裹'] : ['包裹', '背包'];
    for (const name of order) {
        if (!t.includes(name)) continue;
        await clickByText(page, name, { exact: true });
        await sleep(1200);
        t = await visibleText(page);
        if (bagOpened(t)) { log(`已打开「${name}」`); return true; }
        // 有些页面「背包/包裹」是带角标的链接，精确匹配不到时放宽一次
        await clickByText(page, name, { exact: false });
        await sleep(1200);
        t = await visibleText(page);
        if (bagOpened(t)) { log(`已打开「${name}」(模糊)`); return true; }
    }
    log(`打不开背包，页面: ${t.replace(/\s+/g, ' ').substring(0, 120)}`);
    return false;
}

// 切到「药水」页签（默认页签通常是装备，不切过去看不到体力宝）
// 认不出来就顺手试一下「道具」页签：只要列表里能读到体力宝就算成功，不靠页签名硬猜
async function gotoPotionTab(page, { log = () => { } } = {}) {
    let t = await visibleText(page);
    if (t.includes('体力宝')) return true;
    for (const tab of ['药水', '道具']) {
        if (!t.includes(tab)) continue;
        for (let i = 0; i < 2; i++) {
            await clickByText(page, tab, { exact: true });
            await sleep(1000);
            t = await visibleText(page);
            if (t.includes('体力宝')) { log(`已切到「${tab}」`); return true; }
        }
    }
    log(`未切到药水页签，页面: ${t.replace(/\s+/g, ' ').substring(0, 120)}`);
    return false;
}

// ==================== 列表「使用」/「详情」两条路径（2026-11-15 用户截图实证） ====================
// 包裹 → 药水 每一行都有两个按钮：绿色「使用」、蓝色「详情」，**两个都能点**（用户确认）。
//   直接点「使用」：吃掉自定义数量默认值（1 个），列表数量不一定即时刷新；
//   点「详情」弹出「物品详情」：
//     名称：小体力宝   数量：68   使用等级：1级
//     说明：装有恢复体力的奶瓶，内含30000体力，多次使用不会叠加，当体力低于50%时自动恢复体力
//     快速使用：1个 | 3个 | 5个 | 10个 | 50个
//     自定义数量：[ 1 ]  使用
// 所以：**先点该行的「使用」（少一步、最贴近手动操作），点完数量没减少才走「详情」→「快速使用N个」兜底**。
// 弹窗没有「关闭」按钮，收起靠 Escape 或点遮罩。

// 定位弹窗本体：页面上唯一含「快速使用」、且高度小于整屏的容器（取最外层那个）
async function detailPopupRect(page) {
    return await page.evaluate(() => {
        const vis = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const cand = Array.from(document.querySelectorAll('body *'))
            .filter((el) => vis(el) && label(el).includes('快速使用'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter((x) => x.r.height < window.innerHeight * 0.94);
        if (!cand.length) return null;
        cand.sort((a, b) => b.r.height - a.r.height);
        const r = cand[0].r;
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }).catch(() => null);
}

async function detailPopupOpen(page) {
    const t = await visibleText(page);
    return t.includes('物品详情') && t.includes('快速使用');
}

// 弹窗里显示的数量（「数量：68」）。读不到返回 -1
async function popupQuantity(page) {
    return await page.evaluate(() => {
        const vis = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const cand = Array.from(document.querySelectorAll('body *'))
            .filter((el) => vis(el) && label(el).includes('快速使用'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter((x) => x.r.height < window.innerHeight * 0.94);
        if (!cand.length) return -1;
        cand.sort((a, b) => b.r.height - a.r.height);
        const m = label(cand[0].el).match(/数量\s*[:：]\s*(\d+)/);
        return m ? Number(m[1]) : -1;
    }).catch(() => -1);
}

// 在弹窗内部点一段文字（「1个」/「使用」），限定在弹窗容器里，不会点到背后列表的按钮。
// 同样用「打标记 → page.click(标记)」真实点击（uni 组件不认 dispatchEvent）。
async function clickInDetailPopup(page, text) {
    const pt = await page.evaluate((text) => {
        document.querySelectorAll('[data-heal-pop]').forEach((el) => el.removeAttribute('data-heal-pop'));
        const vis = (el) => {
            try {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) { return false; }
        };
        const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const bare = (s) => s.replace(/\s+/g, '').trim();
        const cand = Array.from(document.querySelectorAll('body *'))
            .filter((el) => vis(el) && label(el).includes('快速使用'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter((x) => x.r.height < window.innerHeight * 0.94);
        if (!cand.length) return null;
        cand.sort((a, b) => b.r.height - a.r.height);
        const root = cand[0].el;
        const want = bare(text);
        const hits = Array.from(root.querySelectorAll('*'))
            .filter((el) => vis(el) && bare(label(el)) === want);
        const leaf = hits.find((el) => !Array.from(el.children).some((c) => vis(c) && bare(label(c)) === want)) || hits[0];
        if (!leaf) return null;
        // 优先带 btn 类的外层（真正挂事件的那一层）
        let target = leaf;
        for (let up = 0; up < 4 && target.parentElement; up++) {
            if (/btn/i.test(String(target.className))) break;
            target = target.parentElement;
        }
        if (!/btn/i.test(String(target.className))) target = leaf;
        target.setAttribute('data-heal-pop', '1');
        try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
        const r = target.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, text).catch(() => null);
    if (!pt) return null;
    const ok = await page.click('[data-heal-pop="1"]', { force: true, timeout: 4000 }).then(() => true).catch(() => false);
    if (!ok) await page.mouse.click(pt.x, pt.y).catch(() => { });
    await page.evaluate(() => {
        const el = document.querySelector('[data-heal-pop="1"]');
        if (el) el.removeAttribute('data-heal-pop');
    }).catch(() => { });
    return pt;
}

// 关掉「物品详情」：没有关闭按钮，先 Escape，再点弹窗外的遮罩
async function closeDetailPopup(page, { log = () => { } } = {}) {
    for (let i = 0; i < 3; i++) {
        if (!(await detailPopupOpen(page))) return true;
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(700);
        if (!(await detailPopupOpen(page))) return true;
        const r = await detailPopupRect(page);
        const vp = page.viewportSize() || { width: 640, height: 1100 };
        if (r) {
            const y = r.y > 50 ? r.y - 25 : Math.min(vp.height - 8, r.y + r.h + 25);
            await page.mouse.click(Math.round(vp.width / 2), Math.round(y)).catch(() => { });
            await sleep(800);
        }
    }
    const ok = !(await detailPopupOpen(page));
    if (!ok) log('「物品详情」弹窗关不掉');
    return ok;
}

// 先合成事件点一次 → 验证 → 没生效才补真实鼠标点击（绝不叠加，否则「详情」会被点开又关掉）
// 点一次并验证。clicker 内部已经是**真实点击**了，所以这里默认不再补点 ——
// 消耗类操作（使用药水 / 快速使用）点第二次就是多吃一份，绝不能盲目重试。
// retry 只给「打开弹窗」这种可逆操作用。
async function clickOnceAndCheck(page, clicker, verify, { waits = [1100, 900, 900], retry = false } = {}) {
    const pt = await clicker();
    if (!pt) return false;
    for (const w of waits) {
        await sleep(w);
        if (await verify()) return true;
    }
    if (!retry) return false;
    const pt2 = await clicker();
    if (!pt2) return false;
    for (const w of [1000, 1000]) {
        await sleep(w);
        if (await verify()) return true;
    }
    return false;
}

// 列表数量常常只是本地缓存不刷新：关包重开再读一次真实值。返回 -2 = 重开失败
async function rereadBagQuantity(page, name, { inDungeon = false, log = () => { } } = {}) {
    await closeBagPanel(page, { log });
    await sleep(700);
    if (!(await openBagPanel(page, { inDungeon, log }))) return -2;
    await gotoPotionTab(page, { log });
    return await rowQuantity(page, name);
}

// 列表视图才能用「点该行使用」这条路：列表每行有「数量：N + 使用 + 详情」，
// 网格视图只有名字 + 角标数字，没有「使用」按钮、也没有「数量：」文本。
// ★ 2026-11-20 冷0 实证：背包里明明有 25 个小体力宝（用户截图），脚本却判 no-item，
//   日志停在「已切到「药水」」后两秒直接说「没有可用的体力宝」——
//   因为 useStaminaItem 的 rowQuantity 依赖「数量：N」，网格视图下永远读成 -1。
//   触发条件：11-19 读背包数量时脚本点过「网格」（读数快一半），游戏把视图模式记住了，
//   之后每次打开包裹都是网格视图 → 补药路径全废。所以补药前必须先切回列表。
async function ensureListView(page, { log = () => { } } = {}) {
    let t = await visibleText(page);
    const hasQty = () => /数量\s*[：:]\s*\d+/.test(t);
    if (hasQty()) return true;
    if (!t.includes('列表')) {
        log(`包裹页看不到「列表」切换按钮，页面: ${t.replace(/\s+/g, ' ').substring(0, 120)}`);
        return false;
    }
    log('包裹当前是网格视图（没有「数量：N」和「使用」按钮）→ 切回列表');
    await clickByText(page, '列表', { exact: true });
    await sleep(1800);
    t = await visibleText(page);
    if (hasQty()) { log('已切到列表视图'); return true; }
    log(`切列表后仍读不到「数量：N」，页面: ${t.replace(/\s+/g, ' ').substring(0, 160)}`);
    return false;
}

// 用一次体力宝：优先小体力宝，没有再体力宝。返回 {ok, item, left}
// ★ 2026-11-15 真机实证（coldwind0，弹窗 DOM 已抓全）：
//   1) 列表行那个绿色「使用」**不是直接吃药**，它是打开「物品详情」弹窗（和「详情」同一个弹窗）；
//   2) 真正吃药的按钮在弹窗里：`uni-text.quick-btn`「1个/3个/5个/10个/50个」，
//      以及 `uni-view.confirm-use-btn`「使用」（配 `uni-input.num-input` 自定义数量）；
//   3) 点完「1个」**弹窗会自动关闭**，列表数量立刻从 28 → 27。
//   —— 这就是之前一直判「点不动」的真因：我盯着「弹窗里的数量」，而弹窗已经没了，读到 -1。
// ★ 一次只吃一个（用户 2026-11-15）：体力宝效果是覆盖不是叠加，吃第二个会覆盖前一个的血池，
//   剩余量不会变多。所以永远只点「1个」，上层也不许循环补。
async function useStaminaItem(page, { log = () => { }, inDungeon = false } = {}) {
    // 先确保是列表视图（网格视图读不到「数量：N」、也没有「使用」按钮 → 会误判 no-item）
    await ensureListView(page, { log });
    for (const name of BLOOD_ITEMS) {
        const left = await rowQuantity(page, name);
        if (left === 0) continue;                       // 这一档没了 → 换下一档
        if (left < 0) continue;                         // 页面上没有这个条目
        log(`用「${name}」（剩 ${left} 个）...`);

        // ---- 1) 打开使用弹窗：点该行「使用」，弹不出来再点「详情」 ----
        let opened = false;
        const ptUse = await clickBtnInRow(page, name, '使用');
        if (ptUse) {
            for (let i = 0; i < 3; i++) {
                await sleep(900);
                if (await detailPopupOpen(page)) { opened = true; break; }
                // 有的物品点了「使用」是真直接吃（不弹窗）→ 数量掉一个就算成
                const q = await rowQuantity(page, name);
                if (q >= 0 && q < left) {
                    log(`「${name}」直接吃掉 1 个（列表剩 ${q}）`);
                    return { ok: true, item: name, left: q };
                }
            }
        }
        if (!opened) {
            log(`「${name}」点「使用」没弹出使用弹窗，改点「详情」`);
            const ptD = await clickBtnInRow(page, name, '详情');
            if (ptD) {
                for (let i = 0; i < 3; i++) {
                    await sleep(900);
                    if (await detailPopupOpen(page)) { opened = true; break; }
                }
            }
        }
        if (!opened) {
            log(`「${name}」的使用弹窗打不开，跳过这一档`);
            continue;
        }

        // ---- 2) 弹窗里点「快速使用1个」（只点这一次，绝不重试，避免吃两粒）----
        const beforeP = await popupQuantity(page);
        await clickInDetailPopup(page, '1个');
        for (let i = 0; i < 4; i++) {
            await sleep(1100);
            if (!(await detailPopupOpen(page))) break;      // 弹窗关了（正常情况）
            const p = await popupQuantity(page);
            if (p >= 0 && beforeP >= 0 && p < beforeP) break;
        }
        if (await detailPopupOpen(page)) await closeDetailPopup(page, { log });

        // ---- 3) 以列表数量为准（弹窗点完会自动关，弹窗里的数字读不到） ----
        const after = await rowQuantity(page, name);
        if (after >= 0 && after < left) {
            log(`「${name}」用掉 1 个（列表 ${left} → ${after}）`);
            return { ok: true, item: name, left: after };
        }
        log(`「${name}」点了「1个」但列表数量没变（${left} → ${after}），换下一档`);
    }
    return { ok: false, item: '', left: -1 };
}

// ==================== 血池 0 的处置决策（三副本共用，纯函数可单测） ====================
//
// ★ 2026-11-20 用户要求：体力宝用光时不要提前放弃（冷0 今天海盗王 20 间 / 0 杀、无奖可领，白跑一趟），
//   改成「硬打模式」——没钱买药就继续出刀，能杀几只杀几只；人被打死就复活一次，复活后立刻领奖。
//   依据：11-15 真机实测「血池 0 仍能出刀」（冷0 (0,2) 房 2 秒击杀一只），
//   之前每只怪都因为血池 0 直接 break → 怪留房间 → 三线少怪、51 刀打不满。
//
// ★ 2026-11-20 用户第二次纠正（当晚 22:45）：
//   「没切到药水页这类界面故障也可以杀到死再领奖，你不能动不动就放弃，
//     就算没读到请假设就没有药水了，去完成好吗」
//   → 补药失败不再分辨原因：no-item / no-bag / no-potion-tab / 读不到血池，
//     一律当作「没有体力宝」进入硬打模式，能杀几只杀几只；战死由 reviveOnce 复活一次后领奖。
//     放弃 = 0 杀白跑一趟，比硬打差得多。原因只用来打日志（便于事后修界面 bug），不再影响决策。
//
// bloodItemGone 保留：只用于区分日志措辞（「药水页确实没有」vs「读不到，按没有处理」）。
const BLOOD_GONE_REASONS = new Set(['no-item']);
function bloodItemGone(reason) {
    return BLOOD_GONE_REASONS.has(String(reason || '').trim());
}

// 决策表（输入全部来自调用方已经读到的页面状态）：
//   blood        当前血池（null=读不到）
//   hardMode     已经进入硬打模式（本趟不再开背包）
//   healOk       本次补药是否成功（只有调用过 healBlood 才有意义）
//   healedOnce   这一只怪已经补过 1 个药（体力宝覆盖不叠加，补第二个没用）
//   healReason   healBlood 失败时的 reason（只影响日志，不影响决策）
// 返回：'fight' 直接出刀 / 'heal' 先补药再出刀 / 'hard' 转硬打模式并出刀
// （不再有 'giveup'：任何读不到药的情形都硬打，不提前放弃）
function bloodAction({ blood, hardMode = false, healOk = false, healedOnce = false, healReason = '' } = {}) {
    if (blood !== 0) return 'fight';      // 读不到或还有血池：不动，照常打
    if (hardMode) return 'fight';         // 已确定没药：不再逐只开背包
    if (healOk) return 'heal';            // 还有药：补了再打（最优路径）
    if (healedOnce) return 'hard';        // 补过仍 0 / 补不成 → 再补也没用，硬打
    return 'hard';                        // 没药 or 界面故障 → 一律按「没有体力宝」硬打
}

// 血池为 0 时的完整补给流程。返回 { ok, used, item, blood, reason }
//   opts.inDungeon：在副本里（点「背包」），否则走首页「包裹」
//   opts.force    ：调用方已经自己判过血池 0（且已经把战斗面板撤掉、读不到血池）时置 true，
//                   跳过开头的血池判据直接补药。否则会误报 no-blood-read。
// ★ 只补 1 个（用户 2026-11-15）：体力宝效果是覆盖不是叠加，吃第二个会把前一个的血池覆盖掉，
//   剩余量不会变多，纯属浪费。所以这里没有 maxUse 循环 —— 补完还打不动就是别的原因，不是药不够。
async function healBlood(page, opts = {}) {
    const log = opts.log || (() => { });
    const tag = opts.tag || '补血池';
    let t = await visibleText(page);
    const blood = readBlood(t);
    if (!opts.force) {
        if (blood === null) return { ok: false, used: 0, item: '', blood: null, reason: 'no-blood-read' };
        if (blood > 0) return { ok: true, used: 0, item: '', blood, reason: 'already-ok' };
    }

    // 1) 在战斗面板里先撤退（副本内撤退是「离开战斗」，人还在副本房间里）
    if (inFightPanel(t)) {
        log(`[${tag}] 血池 0，先点「撤退」离开战斗`);
        if (!(await clickTextReal(page, '撤退'))) await clickByText(page, '撤退', { exact: true });
        await sleep(1200);
        t = await visibleText(page);
        if (inFightPanel(t)) {
            log(`[${tag}] 「撤退」没生效，按 Escape 兜底`);
            await page.keyboard.press('Escape').catch(() => { });
            await sleep(800);
            t = await visibleText(page);
        }
    }

    // 2) 打开背包 → 药水页签
    if (!(await openBagPanel(page, { inDungeon: opts.inDungeon, log }))) {
        // ★ 认不出「已打开」不等于没打开（11-20 冷6：网格视图误判 no-bag，包裹就留在了副本页上）
        //   → 无论判成功还是失败，退出前都按一次关包裹，绝不把浮层留给后面的走廊/房间读取。
        await closeBagPanel(page, { log });
        return { ok: false, used: 0, item: '', blood, reason: 'no-bag' };
    }
    if (!(await gotoPotionTab(page, { log }))) {
        await closeBagPanel(page, { log });
        return { ok: false, used: 0, item: '', blood, reason: 'no-potion-tab' };
    }

    // 3) 用体力宝（优先小的），只吃一个
    const r = await useStaminaItem(page, { log, inDungeon: opts.inDungeon });
    await closeBagPanel(page, { log });
    if (!r.ok) {
        log(`[${tag}] 背包里没有可用的体力宝（小体力宝/体力宝），或点了没吃进去`);
        return { ok: false, used: 0, item: '', blood, reason: 'no-item' };
    }
    const nb = readBlood(await visibleText(page));
    if (nb !== null && nb > 0) log(`[${tag}] 血池 ${blood === null ? '?' : blood} → ${nb}`);
    // 关掉包裹后多半已经回到列表/活动页，那里没有「血池：」字段 → 读不到是正常的。
    // 11-28 前这里静默，日志看起来像「补药已验证成功」，实际从没验证过；写清楚，别误导复盘。
    else log(`[${tag}] 补药完成，当前页读不到血池（${nb === null ? '无该字段' : `仍为 ${nb}`}），下一场战斗首帧确认`);
    log(`[${tag}] 已用 1 个「${r.item}」（覆盖式恢复，不能叠加），回到战斗继续`);
    return { ok: true, used: 1, item: r.item, blood: nb === null ? blood : nb, reason: 'healed' };
}

module.exports = {
    recoverDungeon, closeSweepPopup, clickAndVerify, clickByText, clickTextReal, visibleText, dismissPopups,
    readRewardToast, claimEvidence, claimEvidenceIn, remainTimes, sleep, backToCityView,
    readBlood, inFightPanel, healBlood, bloodAction, bloodItemGone, ensureListView,
    openBagPanel, closeBagPanel, gotoPotionTab, useStaminaItem,
    // 药水页细分步骤（探针用）
    clickBtnInRow, clickUseInRow, realClick, clickOnceAndCheck, rowQuantity, rereadBagQuantity,
    detailPopupRect, detailPopupOpen, popupQuantity, clickInDetailPopup, closeDetailPopup,
};
