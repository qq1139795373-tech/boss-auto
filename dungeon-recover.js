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

// 点一次 + 验证消失；合成事件没生效就补真实坐标点击。返回是否确实关掉
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
async function dismissPopups(page, opts = {}) {
    const log = opts.log || (() => { });
    let n = 0;
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
            if (rw) log(`领奖明细：${rw}`);
        }
        n++;
        await sleep(800);
    }
    return n;
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

// 领奖成功后会回到副本入口页，按钮变成「进入副本（次数已用尽）」（用户 2026-10-29 截图）。
// 这比「页面没有副本条件」更硬：说明这一次的次数确实被消耗、奖励确实结算了。
//   返回 'used'      = 次数已用尽 → 确实领到了
//        'available' = 还能进副本 → 很可能没领
//        'unknown'   = 不在入口页
async function claimEvidence(page) {
    const t = await visibleText(page);
    if (t.includes('次数已用尽') || t.includes('剩余0次')) return 'used';
    if (t.includes('进入副本')) return 'available';
    return 'unknown';
}

function identify(t) {
    if (/玄铁矿工|翡翠采掘者|血晶守卫|猫眼猎手|矿采场|赤晶|北幽猫|翠晶/.test(t)) return '炼器窟';
    if (/基德|暗仓|奴隶仓|枢纽广场|金库|机关厅|兽栏/.test(t)) return '基德的宝藏';
    return '未知副本';
}

// 主流程：扫荡（有就扫）→ 领奖（有就领，循环到没有）→ 退本
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
    let swept = false;
    t = await visibleText(page);
    for (let i = 0; i < 4 && !t.includes('扫荡'); i++) {
        await sleep(1500);
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
    for (let round = 1; round <= 4; round++) {
        t = await visibleText(page);
        if (!t.includes('副本条件')) { claimed = true; break; }   // 已退出副本 = 领到了
        if (!t.includes('领取奖励')) break;                       // 没有可领的
        log(`${tag}：点「领取奖励」（第 ${round} 轮）...`);
        if (!(await clickByText(page, '领取奖励', { exact: true }))) {
            log(`${tag}：领取奖励点不到`);
            break;
        }
        await sleep(1500);
        await dismissPopups(page, { log });        // 关「扫荡收获」→ 点「确定」并顺手抓奖励明细
        await sleep(1500);
        t = await visibleText(page);
        if (!t.includes('副本条件') || !t.includes('领取奖励')) { claimed = true; break; }
        log(`${tag}：第 ${round} 轮领奖后仍在副本页（「领取奖励」还在）`);
    }
    if (claimed) log(`${tag}：奖励已领取，副本结束`);
    // 领奖后人物回到副本入口页：这里核对「进入副本（次数已用尽）」，比「页面没有副本条件」更硬。
    const ev = await claimEvidence(page);
    if (ev === 'used') log(`${tag}：入口页显示「次数已用尽」= 本次次数已消耗，领奖确认`);
    else if (ev === 'available') log(`${tag}：入口页仍可「进入副本」（未见次数已用尽），领奖可能未完成`);

    t = await visibleText(page);
    if (!t.includes('副本条件') && !t.includes('退出副本')) {
        return { inDungeon: true, kind, swept, claimed, exited: true };
    }

    // ---- 3) 退本：没有可领的了才走这里 ----
    log(`${tag}：没有可领的奖励了，退出副本...`);
    for (let i = 1; i <= 3; i++) {
        await clickByText(page, '退出副本');
        await sleep(1500);
        let tt = await visibleText(page);
        if (tt.includes('退出副本') && tt.includes('确定')) {
            await clickByText(page, '确定', { exact: true });
            await sleep(1500);
            tt = await visibleText(page);
        }
        if (!tt.includes('副本条件')) {
            return { inDungeon: true, kind, swept, claimed, exited: true };
        }
        log(`${tag}：第 ${i} 次退出副本未生效，重试...`);
    }
    if (screenshot) {
        try { await page.screenshot({ path: screenshot }); } catch (e) { /* ignore */ }
    }
    const left = await visibleText(page);
    log(`${tag}：退出副本失败，仍在: ${left.replace(/\s+/g, ' ').substring(0, 200)}`);
    return { inDungeon: true, kind, swept, claimed, exited: false };
}

module.exports = { recoverDungeon, closeSweepPopup, clickAndVerify, clickByText, visibleText, dismissPopups, readRewardToast, claimEvidence, sleep };
