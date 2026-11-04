const { chromium } = require('playwright');
// 只读可见节点的页面文本（避免 display:none 残留节点造成的幽灵文案）
const { visibleText } = require('./dungeon-recover.js');
// 复用秘宝的出航/选海域逻辑（同一套「出航→选区域→点目的地→等到达」）
const mb = require('./mibao.js');
// 副本内自恢复（先扫荡/领奖再退本），和 mibao/daily 共用同一套
const drain = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;

// 镇妖塔（2026-11-01 录屏 + 小号实证）：
//   入口：泉州城内走到「少林后山」（守塔武僧只在这一格出现）→「你看到」里 ★守塔武僧
//        下面那行蓝色链接「进入镇妖塔」。（今日剩余 0/1 时这行链接会消失 → 找不到 = 已打过）
//        小号停在「码头」时「你看到」只有 神秘人/★传送/★出航/船老板，没有武僧，所以必须先走图。
//   规则：共 100 层 · 今日剩余 1/1 次 · 一局打到死为止 · 开始后角色属性锁定不可改
//   流程：开始挑战 → 层间页「挑战本层」→ 战斗弹窗（攻击/自动攻击/撤退）→「战胜了第N层」→「继续」
//        → 每 5 层弹一次「第 N 层增益 · 三选一」→ 打不动就「挑战结束，请领取结算」→ 点「领取结算」
//   实测一局约 170 秒到第 61 层（前期楼层「已碾压 5 层」几乎不用打，越往上回合越多）
//   ★ 两层页细节（2026-11-01 录屏逐帧复核 + 用户指出）：
//     ① 层间页的「挑战本层 / 快速碾压」在面板**最底部**，不往下滚是看不到的。
//        滚到底才能点 → 这正是 11-01 第 26 层那两次「点了 8 分钟不动」的真因：
//        按钮在视口外，DOM 派发/force 点击都落空 → 页面上什么都没发生。
//     ② 「快速碾压」由**战力**决定，不是「一次就跳 5 层」的固定按钮：
//        战力压得住就显示，点一下直接推进（toast「已碾压 5 层」，每 5 层弹一次增益）；
//        战力压不住时按钮**直接消失**（不是置灰），此时只能「挑战本层」一层层打。
//        所以在场就碾压，不在场立刻逐层打，别反复试。
const NAV_DEST = '泉州';
const NAV_REGION = '东亚';

const MAX_FLOOR = 100;          // 塔共 100 层
const RUN_LIMIT_MS = 30 * 60 * 1000;   // 整轮上限（实测一局 3 分钟；只当防死循环保险，
                                // 不主动撤退 —— 用户 11-01：一直攻击到死就行）
const FLOOR_STUCK_MS = 60000;   // 单层 60 秒页面毫无变化 → 判定卡住
const GC_POLL = 120;            // 轮询间隔：越快越早看到「战胜了」/「继续」
const ATK_GAP = 250;            // 两次点「攻击」的最小间隔（防连点打空）
const OPEN_WAIT = 400;          // 战斗弹窗刚弹出时先等 0.4 秒再点（点早了服务器没准备好）

// ── 增益三选一规则（用户 2026-11-01 亲定，别自己改） ─────────────────────
//   ① 吸血：整局最多选 2 次
//   ② 免伤 / 状态抗性：最高优先
//   ③ 【次选档】吸血 / 暴击 / 攻击 / 连击 / 敏捷：**同一档，谁品质高选谁**（品质相同再比数值）
//      吸血整局最多 2 次；暴击初始 75%，**可以一路选到 100%**，满 100 后才不选
//   ④ 防御 / 生命上限 等防御类：最后选
//   ⑤ 恢复类：一律不选
//   ⑥ 同档只比 品质（品质3>2>1）→ 数值；属性之间不加人为先后
const LIFESTEAL_MAX = 2;
const CRIT_CAP = 100;

// 只有「档」之间的先后（数字小的先选）。次选档内部**不排序** —— 用户 2026-11-02 明确：
// 「攻击暴击吸血同级，谁品质高选谁」。所以同品质的 攻击+10 就是比 暴击+8 值得拿（品质一样、数值更大），
// 品质不同则一律品质说了算（暴击+8(品质3) 压过 攻击+10(品质2)）。
const SUB_CORE = 0;        // 次选档：吸血 / 暴击 / 攻击 / 连击 / 敏捷（同级，比品质→数值）
const SUB_DEF = 5;         // 防御 / 生命上限 / 体质

// 实际出现过的增益名（录屏 11-01 全片核对）：
//   免伤 / 免疫 / 全抗 / 状态抗性 / 坚韧 / 吸血 / 暴击 / 连击 / 攻击 / 敏捷 / 致盲 /
//   防御 / 生命上限 / 恢复5%生命 / 恢复20%生命 / 全局…
// 注意「全抗」不含「抗性」两个字，只写 /抗性/ 会漏 → 用单字「抗」兜住（抗暴也算抗性类）。
const RE_RECOVER = /恢复|回复|治疗|回血|再生|吸取|偷取/;
const RE_TOP = /免伤|免疫|抗|韧性|坚韧|减伤|格挡/;
const RE_LIFESTEAL = /吸血/;
const RE_ATK = /暴击|连击|攻击|攻速|破防|穿透|暴伤|敏捷|致盲/;
const RE_DEF = /防御|护甲|生命|体质/;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
    console.log(`[zhenyaota] ${msg}`);
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

async function getPageText(page) {
    return await withTimeout(visibleText(page), 8000, '', '读页面');
}

// 给「没有超时」的页面调用兜底：超过 ms 就返回 fallback 并记一条日志，避免整脚本静默挂死
async function withTimeout(promise, ms, fallback, label) {
    let timer;
    const t = new Promise((resolve) => {
        timer = setTimeout(() => {
            log(`[超时] ${label} ${ms}ms 没返回（页面可能被原生弹窗卡住）`);
            resolve(fallback);
        }, ms);
    });
    try {
        return await Promise.race([promise, t]);
    } finally {
        clearTimeout(timer);
    }
}

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
    try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(300);
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await el.click({ force: true }).catch(() => {});
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

async function clickExact(page, text, timeout = 3000) {
    try {
        await page.getByText(text, { exact: true }).first().click({ timeout, force: true });
        return true;
    } catch {
        return false;
    }
}

// 点文本叶子节点，绕过弹窗遮罩（坐标点击会被遮罩吃掉 → 假成功）
async function clickLeaf(page, text, exactOnly = true) {
    return await page.evaluate(({ t, ex }) => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (el.children.length !== 0 || r.width <= 0 || r.height <= 0) return false;
            return ex ? s === t : s.includes(t);
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            all[0].dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, { t: text, ex: exactOnly });
}

async function jsClick(page, text) {
    return await page.evaluate(t => {
        const all = [...document.querySelectorAll('body *')].filter(el => {
            const s = el.textContent || '';
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s.includes(t) && r.width > 0 && r.height > 0;
        });
        if (!all.length) return false;
        all.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            all[0].dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
    }, text);
}

function snip(t, n = 220) {
    return (t || '').replace(/\s+/g, ' ').substring(0, n);
}

async function fail(page, msg, shot) {
    console.log(`ERROR: ${msg}`);
    console.log(`::error::镇妖塔：${msg}`);
    if (shot) await page.screenshot({ path: shot }).catch(() => {});
}

// ── 登录 ──────────────────────────────────────────────────────────────
async function login(page) {
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
            await gotoGame(page);
            await page.waitForTimeout(3000);
            const again = await page.$$('input');
            if (again.length < 2) {
                t = await getPageText(page);
                if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
                    log('无表单但已在游戏流程中（会话有效），跳过登录');
                    break;
                }
                await sleep(2000);
                continue;
            }
            await again[0].fill(ACCOUNT);
            await again[1].fill(PASSWORD);
        } else {
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
        }
        await page.getByText('登录').first().click();
        await sleep(3000);
        const t = await getPageText(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            log('登录成功');
            break;
        }
        log(`登录未成功，重试(${attempt + 1}/10)...`);
        await sleep(2000);
    }

    for (let i = 0; i < 10; i++) {
        await clickText(page, '进入游戏');
        await sleep(5000);
        let t = await getPageText(page);
        if (t.includes('选择角色') || t.includes('Lv.')) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            t = await getPageText(page);
        }
        if (t.includes('你看到') || t.includes('当前城市')) {
            log('进入游戏成功');
            return true;
        }
        log(`进入游戏未成功，重试(${i + 1}/10)...`);
        await sleep(2000);
    }
    return false;
}

// 进本自恢复（抄 mibao.js 的做法）：身处副本房间时城里没有「出航」，不先退本航行必失败。
// 2026-11-01 实证：coldwind6 登录后停在副本里（「副本剩余时间：37分钟 / 回到起点 / 退出副本」），
// 出航重试 3 轮全废 → 镇妖塔被跳过。副本状态是持久的，隔夜也可能还在里面。
async function exitDungeonIfInside(page) {
    const t0 = await getPageText(page);
    if (!(t0.includes('副本条件') && t0.includes('回到起点'))) return false;
    // 副本里「领取奖励 → 确定」本身就是退出副本（提示原文：领取奖励后默认退出副本）。
    // dungeon-recover 已经把这套做完了（扫荡 → 知道了 → 领取奖励 → 确定），
    // 只有「没东西可领（没通关）」时才退而点「退出副本」。
    // 所以这里不再自己写第二套退出流程，直接用它的结果。
    log('人在副本里 → 领取奖励（领完自动退出副本）');
    try {
        const r = await drain.recoverDungeon(page, {
            tag: '自恢复', screenshot: 'zhenyaota-dungeon-recover-fail.png', log,
        });
        if (r.claimed) log(r.swept ? '已扫荡并领取奖励，已退出副本' : '已领取奖励，已退出副本');
        if (r.exited) return true;
        log(`副本里没走通（${r.kind}，领奖=${r.claimed}），仍在副本内`);
        await page.screenshot({ path: 'zhenyaota-dungeon-stuck.png' }).catch(() => {});
    } catch (e) {
        log(`副本内处理异常: ${e.message}`);
    }
    return false;
}

// 回到城内主页面（野区里没有「出航」，要先点码头/城内地图；点错就 goBack）
// ★ 塔面板是浮层，底下的「当前城市 / 你看到」还在 DOM 里 —— 只认文字会被骗：
//   2026-11-02 大号领奖失败后仍停在塔里，这里却报「主页面=true」，把问题盖掉了。
// 塔面板左上角是 uni-app 的导航栏返回键（**没有文字**，是图标字体）：
//   <div class="uni-page-head-btn"><i class="uni-btn-icon"></i></div>
// 2026-11-02 真机探针实测：按文字找「‹」一个都找不到，所以必须按 class 点。
async function clickPanelBack(page) {
    const pos = await page.evaluate(() => {
        const pick = sel => {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                if (r.x > 200 || r.y > 200) continue;          // 只要左上角那个
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, by: sel };
            }
            return null;
        };
        const hit = pick('.uni-page-head-btn') || pick('.uni-btn-icon') || pick('.uni-page-head-hd');
        if (hit) return hit;
        // 兜底：某些页面用文字符号做返回
        const cands = ['‹', '<', '〈', '←', '❮', '⬅'];
        let best = null;
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length !== 0) continue;
            const t = (el.textContent || '').trim();
            if (!cands.includes(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
            if (cx > window.innerWidth * 0.5 || cy > window.innerHeight * 0.25) continue;
            if (!best || cx < best.x) best = { x: cx, y: cy, by: 'text' };
        }
        return best;
    }).catch(() => null);
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y).catch(() => {});
    await sleep(1200);
    return true;
}

async function backToCity(page) {
    const inCity = t => t.includes('当前城市') && !TOWER_PANEL_RE.test(t);
    for (let i = 0; i < 6; i++) {
        const t = await getPageText(page);
        if (inCity(t)) return true;
        if (TOWER_PANEL_RE.test(t)) {
            // 还在塔面板里：先点左上角「‹」，点不到再按 Escape。
            // **绝不 goBack** —— 游戏是 hash 路由，goBack 会把页面顶到别处。
            if (await clickPanelBack(page)) continue;
            await page.keyboard.press('Escape').catch(() => {});
            await sleep(800);
            continue;
        }
        let ok = await clickLeaf(page, '返回');
        if (!ok) ok = await clickExact(page, '返回', 1500);
        if (!ok) ok = await clickLeaf(page, '城内地图');
        if (!ok) await page.goBack().catch(() => {});
        await sleep(2000);
    }
    return inCity(await getPageText(page));
}

// 镇妖塔面板的特征文字（面板是浮层，出现它就不算回到主页面）
const TOWER_PANEL_RE = /今日剩余|当前层数|待领取奖励|领取结算|挑战本层|挑战结束/;

// ── 页面文本解析 ───────────────────────────────────────────────────────
// 今日剩余 1/1
function parseRemain(txt) {
    const m = txt.match(/今日剩余[:：]?\s*(\d+)\s*[\/／]\s*(\d+)/);
    return m ? { left: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
}

// 当前层数 6（页面上是「当前层数第 1 层」，中间夹着「第」字，不能只吃空格）
function parseFloor(txt) {
    let m = txt.match(/当前层数[^\d]{0,4}(\d+)/);
    // 结算页没有「当前层数」，只有「下一层 第61层」——用它报最终层数
    if (!m) m = txt.match(/下一层[^\d]{0,4}(\d+)/);
    // 增益弹窗标题「第 15 层增益 · 三选一」——碾压/战斗刚结束时弹窗会盖住「当前层数」，
    // 靠这个标题也能定位当前层，否则那句「已碾压 → 第N层」只能记到上一层
    if (!m) m = txt.match(/第\s*(\d+)\s*层\s*增益/);
    return m ? parseInt(m[1], 10) : null;
}

// 入口页的角色属性：吸血 3% · 暴击 75%（开始后锁定，之后只能靠增益往上加）
function parseAttrs(txt) {
    const ls = txt.match(/吸血\s*(\d+(?:\.\d+)?)\s*%/);
    const ct = txt.match(/暴击\s*(\d+(?:\.\d+)?)\s*%/);
    return {
        lifestealPct: ls ? parseFloat(ls[1]) : null,
        crit: ct ? parseFloat(ct[1]) : null,
    };
}

// 状态机：镇妖塔里只可能处于这几种页面
function pageState(txt, ignoreBattle = false) {
    // ★ 坑（2026-11-01 小号 coldwind8 实证）：层间页正文里有一句说明文字
    //   「挑战结束点「领取结算」入账」，用 /挑战结束/ 判结束会把正常层间页误判成结算，
    //   结果第 1 层就跑去点领取结算 → 白扔一局。
    //   真结算页的文案是「挑战结束，请领取结算」（带逗号），且不会再出现「挑战本层」按钮。
    const hasFloorBtn = txt.includes('挑战本层');
    // ★★ 坑（2026-11-04 CI 实证 coldwind1 第10层 / coldwind2 第20层）：
    //   「快速碾压」推完 4 层落在 5 的倍数层时，页面进入**增益待选的中间态**——
    //   同一屏同时出现「请选择本层增益」「碾压中…」「本局待领取奖励…领取结算」。
    //   旧逻辑见「领取结算」就判 end → 4 次去点被增益弹层盖住的领取结算全部点空，
    //   报 claim-fail 收工，实际还剩二三十层没打（一局空扔）。
    //   这一态必须先判 buff：增益不选完，碾压不会继续，结算按钮也点不到。
    //   真结束页是「挑战结束，请领取结算」，不会带「碾压中」「请选择本层增益」。
    const buffPending = /碾压中|请选择本层增益|请选择增益/.test(txt);
    if (!hasFloorBtn && /挑战结束[，,]/.test(txt) && txt.includes('领取结算') && !buffPending) return 'end';
    if ((/三选一/.test(txt) && /增益/.test(txt)) || buffPending) return 'buff';
    // 实际文案是「战胜了 第29层·机关怪兽」——"了"和"第"之间**有空格**，旧正则 /战胜了第/ 匹配不到，
    // 2026-11-02 coldwind2 第 29 层就因此被判成 floor，对着战胜弹窗点了 40 秒「挑战本层」后放弃。
    if (/战胜了\s*第\s*\d+\s*层/.test(txt) || (/战胜了/.test(txt) && txt.includes('继续'))) return 'won';
    // 打不过时：战斗弹窗原地换成战报（顶部只有一个 × 关闭），正文红字
    //   「本层挑战失败，塔内体力归零」+「塔内战斗：奖励在结算时统一领取」
    // 关掉它才露出后面的「挑战结束 / 领取结算」页。这段必须先于 end/battle 判，否则会被当成
    // 「已结算」（页面上确实已有 领取结算 字样，只是被弹窗盖着）或「还在打」
    //（战报盖住战斗面板时，「你的体力：x/x」还留在 DOM 里，所以 lost 必须排在 battle 前）。
    if (/本层挑战失败|挑战失败|塔内体力归零|你战败/.test(txt)) return 'lost';
    // ★★ 坑（2026-11-02 coldwind0 第 30 层实证）：战斗面板是**覆盖在层间页之上的浮层**，
    //   弹出后 DOM 里层间页那套文本原封不动还在（「当前层数」「挑战本层」…），
    //   所以版面文本同时包含两边。不先判战斗就会当成还在层间页 → 一直去点被面板盖住的
    //   「挑战本层」（真实点击落在面板上，什么也不触发），一次攻击都不出 → 静默卡死。
    //   取证现场：点得到=「攻击」「自动攻击」「撤退」「第30层·机关怪兽 体力：2433/2433」
    //             「你的体力：2919/2919」；被遮挡=「挑战本层」(12,607 1256x36)。
    //   （2026-11-01 那两次「26 层卡死」也是这个，不是滚动问题。）
    if (!ignoreBattle && (/你的体力\s*[：:]/.test(txt) || (/自动攻击/.test(txt) && /撤退/.test(txt)))) return 'battle';
    // 点「开始挑战」会弹二次确认框：取消 / 确认开始（"今日剩余挑战 1 次，确认开始将消耗 1 次"）
    // 不认这个状态就会一直点被遮住的「开始挑战」→ 原地打转
    if (txt.includes('确认开始')) return 'confirm';
    if (/第\s*\d+\s*回合/.test(txt)) return 'battle';
    if (hasFloorBtn) return 'floor';
    if (!hasFloorBtn && txt.includes('领取结算') && !buffPending) return 'end';   // 兜底
    if (txt.includes('开始挑战') || txt.includes('继续挑战')) return 'ready';
    if (txt.includes('进入镇妖塔')) return 'lobby';   // 还在泉州主页面
    return 'unknown';
}

// ── 增益三选一：读卡 + 按优先级选 ─────────────────────────────────────
// 卡片 DOM 结构（录屏）：属性名+数值 / 属性名+数值 / 品质 N，三张竖排
async function readBuffCards(page) {
    return await page.evaluate(() => {
        const vis = el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        const leaves = [...document.querySelectorAll('body *')].filter(el =>
            el.children.length === 0 && vis(el) && /^品质\s*[123]$/.test((el.textContent || '').trim()));
        const out = [];
        for (const lf of leaves) {
            let p = lf.parentElement, card = null;
            for (let i = 0; i < 4 && p; i++) {
                if ((p.textContent || '').includes('%')) { card = p; break; }
                p = p.parentElement;
            }
            if (!card) continue;
            // 卡片文本是「名字+数值」重复两遍 + 「品质N」，例如
            //   暴击+8%暴击+8%品质2 / 恢复5%生命恢复5%生命品质1 / 全抗+8%全抗+8%品质3
            // 只按「名字+数字%」抓会漏掉「恢复5%生命」这种没有加号的写法（会读成 +0%）
            const txt = (card.textContent || '').replace(/\s+/g, '');
            const body = txt.replace(/品质[123]$/, '');
            const half = (body.length % 2 === 0) ? body.slice(0, body.length / 2) : body;
            const vm = half.match(/(\d+(?:\.\d+)?)%/);
            let nm = half.replace(/[+＋]?\d+(?:\.\d+)?%?/g, '');
            // 卡片上名字重复两次（「连击连击+10%」），去掉叠字，否则日志/分组会认不出来
            if (nm.length % 2 === 0 && nm.slice(0, nm.length / 2) === nm.slice(nm.length / 2)) {
                nm = nm.slice(0, nm.length / 2);
            }
            const q = txt.match(/品质([123])/);
            const r = card.getBoundingClientRect();
            out.push({
                name: nm || half,
                value: vm ? parseFloat(vm[1]) : 0,
                quality: q ? parseInt(q[1], 10) : 0,
                x: Math.round(r.x + r.width / 2),
                y: Math.round(r.y + r.height / 2),
                raw: txt.slice(0, 40),
            });
        }
        return out;
    }).catch(() => []);
}

// 按用户 11-01 定的优先级给每张卡打 tier（数值越小越优先；9=不选）
function scoreCard(card, st) {
    const n = card.name || '';
    if (!n) return { tier: 5, sub: 9, why: '解析失败' };
    if (RE_RECOVER.test(n)) return { tier: 9, sub: 9, why: '恢复类不选' };
    if (RE_TOP.test(n)) return { tier: 0, sub: 0, why: '免伤/状态抗性优先' };
    if (RE_LIFESTEAL.test(n)) {
        if (st.lifesteal >= LIFESTEAL_MAX) return { tier: 9, sub: 9, why: `吸血已选满${LIFESTEAL_MAX}次` };
        return { tier: 1, sub: SUB_CORE, why: `吸血(次选档 ${st.lifesteal + 1}/${LIFESTEAL_MAX})` };
    }
    if (/暴击/.test(n)) {
        if (st.crit >= CRIT_CAP) return { tier: 9, sub: 9, why: `暴击已${st.crit}%（满${CRIT_CAP}）不再选` };
        const after = Math.min(CRIT_CAP, st.crit + (card.value || 0));
        return { tier: 1, sub: SUB_CORE, why: `暴击(次选档 ${st.crit}%→${after}%)` };
    }
    if (/连击/.test(n)) return { tier: 1, sub: SUB_CORE, why: '连击(次选档)' };
    if (RE_ATK.test(n)) return { tier: 1, sub: SUB_CORE, why: '攻击类(次选档)' };
    if (RE_DEF.test(n)) return { tier: 2, sub: SUB_DEF, why: '防御类(最后)' };
    return { tier: 1, sub: SUB_CORE, why: '未识别属性→按次选档' };
}

function chooseCard(cards, st) {
    const scored = cards.map((c, i) => ({ c, i, ...scoreCard(c, st) }));
    const usable = scored.filter(s => s.tier < 9);
    const pool = usable.length ? usable : scored;   // 三个都不该选时，按品质硬挑一个（总得选）
    // ① 优先级(tier) ② 次选内部先后(sub) ③ 同档同属性里品质高的 ④ 数值大的
    pool.sort((a, b) => (a.tier - b.tier) || (a.sub - b.sub) || (b.c.quality - a.c.quality) || (b.c.value - a.c.value));
    return pool[0];
}

// ── 入口：城内地图 → 少林后山 → 点「守塔武僧」→「进入镇妖塔」────────────────
// 2026-11-01 真机实证（小号 coldwind8 逐步验证）：
//   ① 守塔武僧只出现在「少林后山」这一格。泉州城内有 26 个可走格子，后山不在其中任何一格的
//      方位出口里 —— 只能靠【城内地图】按钮弹出的「选择目的地」列表（24 个目的地）跳过去。
//   ② 站到后山后「你看到」= 女鬼 / ★守塔武僧，但**没有**「进入镇妖塔」链接；
//      必须点一下「守塔武僧」这个 NPC，才会展开说明文字 + 蓝色链接「进入镇妖塔」。
//      （大号 19:38 的截图里看不到链接，就是因为那一下没点，不是次数用完。）
const HOUSHAN = '少林后山';
const NPC = '守塔武僧';

// 「你看到:」与「当前城市」之间的条目（女鬼 / ★守塔武僧 …），去掉 ★ 和空白
function listSeen(txt) {
    const i = txt.indexOf('你看到');
    if (i < 0) return [];
    let tail = txt.slice(i + 3);
    for (const stop of ['当前城市', '城内地图', '【聊天】']) {
        const j = tail.indexOf(stop);
        if (j >= 0) tail = tail.slice(0, j);
    }
    return tail.split('\n')
        .map(s => s.replace(/[★\s：:]/g, '').trim())
        .filter(s => s && s !== '你看到' && !s.includes('此塔镇压'));
}

// 文本叶子节点精确点击：忽略【】★ 和空白（页面上是「城内地图」「★守塔武僧」这种写法）
async function clickLeafNorm(page, text) {
    return await page.evaluate(({ t }) => {
        const norm = s => (s || '').trim().replace(/[【】★\s]/g, '');
        const hits = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 && norm(el.textContent) === t;
        });
        if (!hits.length) return false;
        const o = { bubbles: true, cancelable: true, view: window };
        for (const ty of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            hits[0].dispatchEvent(new MouseEvent(ty, o));
        }
        return true;
    }, { t: text }).catch(() => false);
}

// 「开始挑战」在页面上出现两次（弹层标题 + 底部按钮），取 y 最大的那个（按钮在最下面）
async function clickBottomLeaf(page, text) {
    return await page.evaluate(({ t }) => {
        const norm = s => (s || '').trim().replace(/[【】★\s]/g, '');
        const hits = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 && norm(el.textContent) === t;
        });
        if (!hits.length) return false;
        hits.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
        const o = { bubbles: true, cancelable: true, view: window };
        for (const ty of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            hits[0].dispatchEvent(new MouseEvent(ty, o));
        }
        return true;
    }, { t: text }).catch(() => false);
}

// ── 把层间页滚到底（用户 11-01 指出：不往下滚看不到「快速碾压」） ──────────
// 塔的面板比一屏长，「挑战本层 / 快速碾压」在最底部。不滚动的话：
//   · clickExact(force) 点在视口外 → 什么都不发生（Playwright 不报错）
//   · DOM 派发虽然能发出去，但游戏若按坐标命中判定就同样落空
// 所以每次点这两个按钮前都先滚到底，再重新量坐标。
async function scrollPanelBottom(page) {
    return await page.evaluate(() => {
        let n = 0;
        for (const el of document.querySelectorAll('body *')) {
            const st = getComputedStyle(el);
            if (!/auto|scroll/.test(st.overflowY || '')) continue;
            if (el.scrollHeight - el.clientHeight < 8) continue;
            el.scrollTop = el.scrollHeight;
            n++;
        }
        const d = document.scrollingElement || document.documentElement;
        if (d) d.scrollTop = d.scrollHeight;
        try { window.scrollTo(0, document.body.scrollHeight); } catch (e) { /* ignore */ }
        return n;
    }).catch(() => 0);
}

// 量文本叶子节点的屏幕坐标（取最下面那个：弹窗叠在面板上时，上层在下面）
async function measureText(page, text) {
    return await page.evaluate((t) => {
        const norm = s => (s || '').trim().replace(/[【】★\s]/g, '');
        const hits = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0 && norm(el.textContent) === t;
        });
        if (!hits.length) return null;
        hits.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
        const el = hits[0];
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, vh: window.innerHeight };
    }, text).catch(() => null);
}

// 真实点击（鼠标按坐标点）。视口外返回 false，让调用方决定要不要滚。
async function realClick(page, text) {
    let b = await measureText(page, text);
    if (!b) return false;
    if (b.y < 2 || b.y > b.vh - 2) {
        await page.evaluate((t) => {
            const norm = s => (s || '').trim().replace(/[【】★\s]/g, '');
            const hits = [...document.querySelectorAll('body *')].filter(el => {
                const r = el.getBoundingClientRect();
                return el.children.length === 0 && r.width > 0 && r.height > 0 && norm(el.textContent) === t;
            });
            if (!hits.length) return;
            hits.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
            try { hits[0].scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        }, text).catch(() => {});
        await sleep(250);
        b = await measureText(page, text);
        if (!b) return false;
    }
    if (b.y < 2 || b.y > b.vh - 2) return false;
    await page.mouse.click(b.x, b.y).catch(() => {});
    return true;
}

// 点层间页按钮：真点 → 底部叶子派发 → 泛匹配，三级兜底
async function tapBtn(page, text) {
    if (await realClick(page, text)) return 'mouse';
    if (await clickBottomLeaf(page, text)) return 'dom-bottom';
    if (await clickLeaf(page, text)) return 'dom';
    return '';
}

// 「攻击」按钮此刻是否真的可见、且中心点没被别人盖住。
// 用来区分「真在战斗」和「上一场战斗面板的残留 DOM」——后者在文本里一模一样，
// 2026-11-02 coldwind1 第 30 层打赢、选完增益回到层间页，就因为这个残留被判成还在战斗，
// 对着已经消失的面板空点 5 次后卡死。
async function hasVisibleAttack(page) {
    return await page.evaluate(() => {
        const vh = window.innerHeight;
        const hits = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            if (el.children.length !== 0 || r.width <= 0 || r.height <= 0) return false;
            const st = getComputedStyle(el);
            if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
            return (el.textContent || '').trim() === '攻击';
        });
        for (const el of hits) {
            const r = el.getBoundingClientRect();
            if (r.top >= vh || r.bottom <= 0) continue;
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            if (top && (top === el || el.contains(top) || top.contains(el))) return true;
        }
        return false;
    }).catch(() => false);
}

// ── 卡死现场取证 ───────────────────────────────────────────────────────
// 11-01 第 26 层卡了两小时，根因是「按钮在视口外，点了没反应」，可当时的日志只有心跳行，
// 看不出这件事 → 只能靠用户看录屏才定位。
// 所以卡死时除了截图，再 dump 一份「所有可见叶子节点的文字 + 坐标 + 在不在视口内 + 中心点
// 是不是自己被别的元素挡住」。以后一眼就能看出「快速碾压 y=1200 > 视口 736」这种问题。
async function dumpClickables(page, tag = 'stuck') {
    const info = await page.evaluate(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const items = [];
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length !== 0) continue;              // 只看叶子，容器节点没有点击意义
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const st = getComputedStyle(el);
            if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
            const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
            if (!text || text.length > 24) continue;             // 长文本是说明文字，不是按钮
            const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
            const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
            // 四种状态分清楚，别把「只露一半」错报成「被遮挡」（第一版就报错了）：
            //   ok        中心点在视口内，且命中测试就是自己/自己的子节点 → 真点得到
            //   partial   只露了一部分，中心点在视口外 → 点击会落在别处，等于点不到
            //   offscreen 完全在视口外 → 点了也白点（26 层就是这个）
            //   blocked   在视口内但被别的元素盖住
            let state = 'offscreen';
            if (inView) {
                if (cx < 0 || cx >= vw || cy < 0 || cy >= vh) state = 'partial';
                else {
                    const top = document.elementFromPoint(cx, cy);
                    state = (top && (top === el || el.contains(top) || top.contains(el))) ? 'ok' : 'blocked';
                }
            }
            items.push({
                text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                inView, hit: state === 'ok', state,
            });
        }
        // 顺便记下「谁在滚」：游戏面板是内部容器滚动，window.scrollY 永远是 0，
        // 只报 scrollY 会让人误以为页面没滚过。
        const scrollers = [];
        for (const el of document.querySelectorAll('body *')) {
            if (el.scrollHeight - el.clientHeight < 8) continue;
            const st = getComputedStyle(el);
            if (!/auto|scroll/.test(st.overflowY || '')) continue;
            scrollers.push({
                tag: el.tagName, id: el.id || '',
                cls: String(el.className || '').slice(0, 40),
                scrollTop: Math.round(el.scrollTop),
                scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
            });
            if (scrollers.length >= 5) break;
        }
        return { vw, vh, scrollY: Math.round(window.scrollY), scrollers, items };
    }).catch(() => null);

    if (!info) { log(`[取证] ${tag}: 读 DOM 失败`); return null; }

    const pick = st => info.items.filter(i => i.state === st);
    const fmt = a => a.slice(0, 25).map(i => `「${i.text}」(${i.x},${i.y} ${i.w}x${i.h})`).join(' ');
    const sc = (info.scrollers || []).map(s => `${s.tag}${s.id ? '#' + s.id : ''}(${s.scrollTop}/${s.scrollHeight - s.clientHeight})`).join(' ');

    log(`[取证] ${tag} 视口 ${info.vw}x${info.vh} scrollY=${info.scrollY} 滚动容器: ${sc || '无(整页滚动)'} 叶子节点 ${info.items.length}`);
    log(`[取证]   点得到(${pick('ok').length}): ${fmt(pick('ok')) || '无'}`);
    log(`[取证]   视口外(${pick('offscreen').length}): ${fmt(pick('offscreen')) || '无'}`);
    log(`[取证]   只露一半(${pick('partial').length}): ${fmt(pick('partial')) || '无'}`);
    log(`[取证]   被遮挡(${pick('blocked').length}): ${fmt(pick('blocked')) || '无'}`);

    const file = `zhenyaota-dom-${tag}.json`;
    try {
        require('fs').writeFileSync(file, JSON.stringify(info, null, 1));
        log(`[取证] 全量落盘 ${file}`);
    } catch (e) {
        log(`[取证] 落盘失败: ${e.message}`);
    }
    return info;
}

// 卡死统一出口：截图 + DOM 取证，一次叫齐
async function dumpStuck(page, tag) {
    await page.screenshot({ path: `zhenyaota-${tag}.png` }).catch(() => {});
    await dumpClickables(page, tag);
}

// 在塔里：有「开始挑战」按钮 / 有「今日剩余 x/1」/ 有「当前层数」
function atTower(txt) {
    return txt.includes('开始挑战') || txt.includes('继续挑战') ||
        /今日剩余\s*\d+\s*[\/／]/.test(txt) || /当前层数/.test(txt);
}

// 从城内任意位置跳到少林后山
async function gotoHoushan(page) {
    if (listSeen(await getPageText(page)).some(m => m.includes(NPC))) {
        log(`${HOUSHAN}：已经在「${NPC}」跟前`);
        return true;
    }
    for (let round = 1; round <= 3; round++) {
        if (!(await clickLeafNorm(page, '城内地图'))) {
            let ok = await clickText(page, '城内地图', 2500);
            if (!ok) ok = await clickLeaf(page, '城内地图');
            if (!ok) { log(`第${round}轮点不到「城内地图」`); await sleep(1500); continue; }
        }
        await sleep(2500);
        const t = await getPageText(page);
        if (!t.includes('选择目的地') && !t.includes(HOUSHAN)) {
            log(`第${round}轮「城内地图」没弹出目的地列表: ${snip(t, 120)}`);
            await sleep(1500);
            continue;
        }
        log(`「选择目的地」列表已开，点 ${HOUSHAN}`);
        if (!(await clickLeafNorm(page, HOUSHAN))) {
            // 列表可能要先滚动才能看到后山
            await page.mouse.wheel(0, 300);
            await sleep(1200);
            if (!(await clickLeafNorm(page, HOUSHAN))) { log(`第${round}轮列表里找不到「${HOUSHAN}」`); continue; }
        }
        await sleep(3000);
        const after = await getPageText(page);
        const seen = listSeen(after);
        log(`到位判定: 你看到=${seen.join('/') || '(空)'}`);
        if (seen.some(m => m.includes(NPC))) return true;
        await sleep(1500);
    }
    return false;
}

async function openTower(page) {
    let t = await getPageText(page);
    if (atTower(t)) return true;   // 已经在塔里

    if (!(await gotoHoushan(page))) return false;

    // 点一下武僧，才会展开「进入镇妖塔」链接
    for (let i = 0; i < 4; i++) {
        t = await getPageText(page);
        if (t.includes('进入镇妖塔')) break;
        log(`点「${NPC}」展开入口（第${i + 1}次）`);
        if (!(await clickLeafNorm(page, NPC))) {
            let ok = await clickLeaf(page, NPC);
            if (!ok) ok = await clickText(page, NPC, 2000);
            if (!ok) log('点不到武僧名字');
        }
        await sleep(2000);
    }

    for (let i = 0; i < 4; i++) {
        if (t.includes('进入镇妖塔') || (await getPageText(page)).includes('进入镇妖塔')) {
            if (!(await clickLeafNorm(page, '进入镇妖塔'))) {
                if (!(await clickLeaf(page, '进入镇妖塔'))) await clickText(page, '进入镇妖塔', 2500);
            }
            await sleep(2800);
            if (atTower(await getPageText(page))) {
                log('已进入镇妖塔');
                return true;
            }
        }
        await sleep(1200);
    }
    return false;
}

// ── 一局打完 ──────────────────────────────────────────────────────────
async function climbTower(page, attr = {}) {
    // 初始属性从入口页读（大号 吸血3%/暴击75%；小号只有 吸血1%、没有暴击这一项）
    const st = {
        lifesteal: 0,
        crit: attr.crit === null || attr.crit === undefined ? 75 : attr.crit,
        lifestealPct: attr.lifestealPct === null || attr.lifestealPct === undefined ? 3 : attr.lifestealPct,
        picks: [],
    };
    const t0 = Date.now();
    let lastFloor = 0, lastChange = Date.now(), lastText = '';
    let atkCount = 0, lastAtk = 0, buffs = 0;
    // 「快速碾压」按战力判定（在场=压得住），所以不设永久开关：
    //   每层都重新看按钮在不在；只有「按钮在但连点两次都不推进」才封掉碾压，本局改逐层打。
    let sweepBlocked = false, sweepTries = 0;
    let lastHasSweep = null;   // 只在「有/没有」切换时打一行日志，别每层刷屏
    let lostLogged = false;

    let battles = 0, enteredBattleAt = 0;
    let lastAtkOkAt = 0, battleDumped = false;   // 战斗停摆取证用
    let lastState = '';
    let floorStuckSince = 0, floorNudged = false;   // 层间页点不动时的自愈
    let buffEmptySince = 0;                         // 增益待选但读不到卡时的自愈
    let unknownSince = 0, unknownLogged = false;   // 认不出页面持续多久（城里聊天会滚动，不能靠文本变化判卡住）
    let result = 'unknown';

    let lastBeat = 0;
    while (Date.now() - t0 < RUN_LIMIT_MS) {
        const txt = await getPageText(page);
        if (txt !== lastText) { lastText = txt; lastChange = Date.now(); }
        let s = pageState(txt);
        // battle 必须由「此刻真有一个可点的攻击按钮」成立。文本里出现「你的体力」只说明面板存在，
        // 上一场打完选完增益回到层间页时，那套 DOM 还原样留着 → 不校验就会对着空气出招。
        if (s === 'battle' && !(await hasVisibleAttack(page))) {
            s = pageState(txt, true);
            if (s === 'battle') s = 'floor';
        }
        const floor = parseFloor(txt) || 0;
        // 心跳：每 10 秒一行，卡住时至少知道停在哪
        if (Date.now() - lastBeat > 10000) {
            lastBeat = Date.now();
            // 战斗页的关键信息都在文本尾部（回合日志/战报），只打前 60 字永远看不到 → 战斗时打尾部
            const brief = s === 'battle' ? '…' + txt.slice(-200) : snip(txt, 60);
            log(`[心跳] ${Math.round((Date.now() - t0) / 1000)}s state=${s} 第${floor}层 出手${atkCount}次 文本: ${brief}`);
        }
        // 状态迁移留痕：以后出问题能直接看时间线，不用凭空猜（battle 只记第一次）
        if (s !== lastState) {
            // 场次按「进入战斗」计：原来 battles++ 写在战胜分支里，等于在统计「赢了几次」，
            // 战败局一律显示「战斗 0 场」，而打赢一局又会被重复计成 2 场（2026-11-02 实测）。
            if (s === 'battle' && lastState !== 'battle') battles++;
            if (s === 'battle' && lastState === 'battle') { /* 不重复打 */ }
            else if (s === 'battle' && lastState === 'won') { /* 层间继续后回到战斗，不刷屏 */ }
            else log(`[状态] ${lastState || '开始'} → ${s}${floor ? `（第${floor}层）` : ''}`);
            lastState = s;
        }
        if (floor && floor !== lastFloor) {
            lastFloor = floor;
            lastChange = Date.now();
            floorStuckSince = 0; floorNudged = false;
            if (floor > MAX_FLOOR) { log(`已到第${floor}层（塔共${MAX_FLOOR}层），收工`); result = 'top'; break; }
        }

        // 1) 结算：点「领取结算」把奖励收下
        if (s === 'end') {
            log(`挑战结束（第${lastFloor || '?'}层）: ${snip(txt, 200)}`);
            // 奖励明细从「挑战结束」那段文本里抽出来，落进日志方便对账（领取后页面就没了，先抓）
            const rewardLine = txt.match(/挑战结束[\s\S]{0,300}/);
            log(`待领取明细: ${snip(rewardLine ? rewardLine[0] : txt, 260)}`);
            const c = await claimSettlement(page);
            if (c.ok) {
                log(`领取结算成功（第${c.tries}次 / ${c.way}）：待领取奖励已清空`);
                result = 'end';
            } else if (c.mid) {
                // 页面还在增益待选，说明这一局没结束（pageState 已修，理论上到不了这里）。
                // 不打断本局，回主循环重新判状态，免得把能继续打的局当成结束扔掉。
                log('★ 判断为未结束（增益待选），回主循环继续');
                floorStuckSince = 0; floorNudged = false;
                continue;
            } else {
                log('★ 领取结算失败：奖励仍挂在塔里。本局保留残局，下次进来会先结算（不再谎报成功）');
                await dumpStuck(page, 'claim-fail');
                result = 'claim-fail';
            }
            break;
        }

        // 2) 增益三选一
        if (s === 'buff') {
            const cards = await readBuffCards(page);
            if (cards.length < 2) {
                // 碾压中/增益弹层刚出现时卡还没渲染，正常几百毫秒就好；
                // 但若是「碾压中」卡死不散（页面残留），不能无限等：20 秒兜底退出，
                // 保留残局（奖励还在塔里，下次进来先结算），绝不在这里误点「领取结算」。
                if (!buffEmptySince) buffEmptySince = Date.now();
                if (Date.now() - buffEmptySince > 20000) {
                    const t2 = await getPageText(page);
                    log(`增益卡 20 秒仍读不到，页面文本: ${t2.substring(0, 120)}`);
                    await dumpStuck(page, 'buff-empty');
                    result = 'stuck';
                    break;
                }
                log(`增益弹窗读到 ${cards.length} 张卡，等一下重读`);
                await sleep(600);
                continue;
            }
            buffEmptySince = 0;
            const pick = chooseCard(cards, st);
            const show = cards.map(c => `${c.name}+${c.value}%(品质${c.quality})`).join(' / ');
            log(`[增益] 第${lastFloor}层 三选一: ${show} → 选 ${pick.c.name}+${pick.c.value}%(品质${pick.c.quality})，理由=${pick.why}`);
            await page.mouse.click(pick.c.x, pick.c.y);
            await sleep(1200);
            // 应用增益到本地状态（页面不显示当前属性，只能自己累计）
            if (RE_LIFESTEAL.test(pick.c.name)) {
                st.lifesteal++;
                st.lifestealPct += pick.c.value;
            }
            if (/暴击/.test(pick.c.name)) st.crit += pick.c.value;
            st.picks.push({ floor: lastFloor, name: pick.c.name, value: pick.c.value, quality: pick.c.quality, why: pick.why });
            buffs++;
            log(`[增益] 累计: 吸血${st.lifesteal}/${LIFESTEAL_MAX}次(${st.lifestealPct}%) 暴击${st.crit}%`);
            continue;
        }

        // 3) 层间页 → 快速碾压 / 挑战本层
        // 两个按钮都在面板**最底部**，必须先滚到底才点得到（用户 11-01 指出，也是 26 层卡死的真因）。
        // 「快速碾压」由战力决定：战力压得住才出现，点一下连推几层（toast「已碾压 5 层」）；
        // 压不住时按钮直接消失 → 立刻改「挑战本层」逐层打，不要反复试。
        if (s === 'floor') {
            // 层间页连续 15 秒没换层 = 点了没反应，先滚到底再点；40 秒还不动就退出，不静默卡死。
            if (!floorStuckSince) floorStuckSince = Date.now();
            const stuckMs = Date.now() - floorStuckSince;
            if (stuckMs > 40000) {
                log('层间页 40 秒没换层，放弃本局（不动游戏内状态）');
                await dumpStuck(page, 'floor-40s');
                result = 'stuck';
                break;
            }
            if (stuckMs > 15000 && !floorNudged) {
                floorNudged = true;
                sweepBlocked = true; lastHasSweep = false;   // 卡过一次就别再试碾压了
                log(`层间页 ${Math.round(stuckMs / 1000)}s 没换层 → 滚到底再点「挑战本层」`);
                await dumpStuck(page, 'floor-15s');
                await scrollPanelBottom(page);
                log(`  兜底点击方式=${(await tapBtn(page, '挑战本层')) || '全部失败'}`);
                await sleep(1200);
                continue;
            }

            // 「快速碾压」= 战力门禁：压得住才出现（不是置灰），压不住整块消失。
            // 所以每次看到层间页都重新看一眼：在场就碾压，不在场就逐层打，不做永久开关。
            const hasSweep = txt.includes('快速碾压') && !sweepBlocked;
            if (hasSweep !== lastHasSweep) {
                lastHasSweep = hasSweep;
                log(hasSweep
                    ? `第${lastFloor}层有「快速碾压」（战力压得住）→ 先碾压`
                    : `第${lastFloor}层没有「快速碾压」（战力压不住这层）→ 改「挑战本层」一层层打`);
            }
            const btn = hasSweep ? '快速碾压' : '挑战本层';

            await scrollPanelBottom(page);
            const way = await tapBtn(page, btn);
            if (!way) log(`点不到「${btn}」（滚动后仍不在视口/找不到节点）`);

            // 点完不能固定睡 900ms 就读页面：服务器回包有时要 1~2 秒，读早了仍是原样的层间页，
            // 于是每层都误打一条「点了没反应」（2026-11-02 大号 30 层全部命中，每层多耗 1 秒）。
            // 改成边等边看：一旦离开层间页或层数变了就立刻继续，最多等 4 秒。
            let t2 = '', f2 = 0, moved = false;
            const deadline = Date.now() + 4000;
            do {
                await sleep(250);
                t2 = await getPageText(page);
                f2 = parseFloor(t2) || 0;
                moved = pageState(t2) !== 'floor' || f2 > lastFloor;
            } while (!moved && Date.now() < deadline);

            if (f2 > lastFloor) {
                if (btn === '快速碾压') log(`快速碾压: 第${lastFloor}层 → 第${f2}层（连推 ${f2 - lastFloor} 层）`);
                sweepTries = 0;
                lastFloor = f2;
                lastChange = Date.now();
                floorStuckSince = 0;
                floorNudged = false;
            } else if (moved) {
                // 已经进了战斗 / 增益 / 结算 → 这里什么都不做，下一轮状态判定会接上
                floorStuckSince = 0; floorNudged = false;
            } else if (btn === '快速碾压') {
                // 按钮在但点不动（战力刚好卡线 / 点了没命中）→ 试两次就切逐层打
                if (++sweepTries >= 2) {
                    sweepBlocked = true;
                    log(`「快速碾压」连按 ${sweepTries} 次（${way || '未点中'}）层数不动 → 本局改「挑战本层」逐层打`);
                }
            } else {
                // 等满 4 秒还是原样的层间页：多半是滚动/坐标问题，下一轮重试并在 15s 后走兜底
                log(`「挑战本层」点了没反应（${way || '未点中'}），下一轮重试`);
            }
            continue;
        }

        // 4) 开局页 → 开始挑战 / 继续挑战（有未完成的局先接着打）
        if (s === 'ready') {
            const btn = txt.includes('继续挑战') ? '继续挑战' : '开始挑战';
            log(`${btn}（第${lastFloor || 1}层起，今日剩余见上一行）`);
            await scrollPanelBottom(page);   // 按钮同样在面板底部
            let ok = await tapBtn(page, btn);
            if (!ok) ok = await clickBottomLeaf(page, btn);
            if (!ok) ok = await clickExact(page, btn, 3000);
            if (!ok) ok = await clickText(page, btn, 3000);
            await sleep(1800);
            // 二次确认框：取消 / 确认开始
            const t2 = await getPageText(page);
            if (t2.includes('确认开始')) {
                log('二次确认框 → 点「确认开始」');
                if (!(await clickLeafNorm(page, '确认开始'))) {
                    await clickBottomLeaf(page, '确认开始');
                }
                await sleep(2000);
                const t3 = await getPageText(page);
                log(`确认后: ${pageState(t3)}${parseFloor(t3) ? ' 第' + parseFloor(t3) + '层' : ''}`);
            }
            enteredBattleAt = Date.now();
            continue;
        }

        // 4b) 二次确认框还开着（上一轮没点掉）→ 直接点确认开始
        if (s === 'confirm') {
            log('确认框仍在 → 点「确认开始」');
            if (!(await clickLeafNorm(page, '确认开始'))) await clickBottomLeaf(page, '确认开始');
            await sleep(2000);
            continue;
        }

        // 4c) 战败：战报弹窗 → 等它自己收（几秒后出现「挑战结束」结算页）
        if (s === 'lost') {
            if (!lostLogged) {
                lostLogged = true;
                const m = txt.match(/你战败[^。]{0,60}/);
                log(`战败于第${lastFloor}层：${m ? m[0] : snip(txt, 80)}`);
            }
            // 关掉战报弹窗：×（标题左边那个小叉）→ 关闭 → 确定 → Esc
            // 别点「继续」：这页没有这个按钮，乱点会顶到下面结算页上
            if (!(await closeBattleReport(page))) {
                await page.keyboard.press('Escape').catch(() => {});
            }
            await sleep(1000);
            continue;
        }

        // 5) 战斗：战胜了第N层 → 继续
        if (s === 'won') {
            if (!(await clickLeaf(page, '继续'))) {
                if (!(await clickExact(page, '继续', 2500))) await clickText(page, '继续', 2000);
            }
            await sleep(250);
            enteredBattleAt = 0;
            continue;
        }

        // 6) 战斗：点「攻击」。贴着服务器回合节奏点（弹窗刚开先等 0.4 秒）
        if (s === 'battle') {
            if (!enteredBattleAt) { enteredBattleAt = Date.now(); battleDumped = false; lastAtkOkAt = Date.now(); }
            if (Date.now() - enteredBattleAt < OPEN_WAIT) { await sleep(80); continue; }
            if (!txt.includes('攻击中') && Date.now() - lastAtk >= ATK_GAP) {
                lastAtk = Date.now();
                // 战斗面板每回合都在重绘，Playwright 的 actionability 等待（即使 force）会超时 →
                // clickExact 直接返回 false，一次都点不出去（2026-11-02 coldwind8 第 31 层实测：出手 0 次）。
                // 改用真实坐标点击，点不到再退回 DOM 派发。
                if (await realClick(page, '攻击') || await clickLeaf(page, '攻击')) {
                    atkCount++;
                    lastAtkOkAt = Date.now();
                }
            }
            // 出手停摆 20 秒 = 页面已经不是正常战斗（按钮没了 / 被弹窗盖住 / 文案变了）。
            // 2026-11-02 coldwind1 第 31 层出手 5 次后就这样卡到超时，当时日志只有截断的心跳，
            // 事后重登战斗状态不保留、现场全丢 → 这里必须先留证据，再按 Esc 让状态重判。
            if (Date.now() - lastAtkOkAt > 20000 && !battleDumped) {
                battleDumped = true;
                log(`战斗停摆 ${Math.round((Date.now() - lastAtkOkAt) / 1000)}s（已出手${atkCount}次），页面尾部: ${txt.slice(-300)}`);
                await dumpStuck(page, 'battle-stall');
                await page.keyboard.press('Escape').catch(() => {});
                await sleep(800);
            }
            // 战斗里页面文本每回合都在变，这里不判卡死，交给下面统一的 lastChange
            await sleep(GC_POLL);
            continue;
        }

        // 7) 还没进塔（在主页面） → 重新找入口
        if (s === 'lobby') {
            log('还在泉州主页面，重新找「进入镇妖塔」');
            if (!(await openTower(page))) {
                await fail(page, '找不到「进入镇妖塔」入口', 'zhenyaota-entry-fail.png');
                result = 'noentry';
                break;
            }
            continue;
        }

        // 8) 认不出的页面（典型：被挤出塔、回到城里/登录页）
        // ★ 坑（11-01 coldwind2 实证）：原来靠「页面文本 60 秒没变化」判卡住，
        //   可是城里有【聊天】实时滚动，文本每秒都在变 → lastChange 一直被刷新，
        //   于是脚本在城里静默空转 10 分钟，日志一个字都不出。
        //   改成按「连续 unknown 状态持续了多久」判，跟聊天无关。
        if (s === 'unknown') {
            if (!unknownSince) unknownSince = Date.now();
            const dur = Date.now() - unknownSince;
            if (dur > 8000 && !unknownLogged) {
                unknownLogged = true;
                log(`认不出的页面已 ${Math.round(dur / 1000)}s，文本前160字: ${snip(txt, 160)}`);
                await dumpStuck(page, 'unknown');
            }
            if (dur > 12000) {
                // 大概率是被挤出塔 / 掉回城 → 重新走一遍入口（城内地图→少林后山→武僧→进入）
                log('尝试重新进入镇妖塔...');
                if (await openTower(page)) {
                    log('已重新进入镇妖塔，继续打');
                    unknownSince = 0; unknownLogged = false;
                    continue;
                }
                if (dur > 45000) {
                    log('重新进塔也失败，本局放弃（不改动游戏内状态）');
                    result = 'stuck';
                    break;
                }
            }
            await sleep(GC_POLL);
            continue;
        }
        unknownSince = 0; unknownLogged = false;
    }

    if (result === 'unknown') {
        // 只可能是撞了 30 分钟保险：本局在游戏里是持久状态，下次进塔会显示「继续挑战」，
        // 这里不点撤退（用户 11-01：一直攻击到死就行）
        log(`到达 ${Math.round(RUN_LIMIT_MS / 60000)} 分钟保险，本局未结束（游戏里保留，下次进塔可「继续挑战」）`);
    }
    const sec = Math.round((Date.now() - t0) / 1000);
    log(`本局结束: 到第${lastFloor}层 · ${sec}s · 出手${atkCount}次 · 战斗${battles}场 · 增益${buffs}次 · result=${result}`);
    log(`增益选择: ${st.picks.map(p => `第${p.floor}层${p.name}+${p.value}%(品质${p.quality})`).join(' | ') || '无'}`);
    return { floor: lastFloor, sec, atkCount, battles, buffs, result, picks: st.picks };
}

// 关战报弹窗：× / ✕ / X / 关闭 / 确定 / 知道了 都试一遍
async function closeBattleReport(page) {
    const ok = await page.evaluate(() => {
        const norm = s => (s || '').trim().replace(/\s/g, '');
        // 注意：这里**不能**包含「确定」。「领取结算」的二次确认框里也有一个绿色「确定」，
        // 如果把它当通用关闭按钮，就会在流程外偷偷把结算确认掉（2026-11-02 cw0/cw1 就是这么"凑巧"成功的）。
        // 「确定」只由 confirmClaimPopup() 在明确的结算确认场景里点。
        const wanted = ['×', '✕', '✖', 'x', 'X', '关闭', '知道了'];
        const hits = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            if (el.children.length !== 0 || r.width <= 0 || r.height <= 0) return false;
            const t = norm(el.textContent);
            return t && t.length <= 4 && wanted.includes(t);
        });
        if (!hits.length) return false;
        const el = hits[0];
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        for (const ty of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(ty, o));
        }
        return true;
    }).catch(() => false);
    if (ok) { await sleep(600); return true; }
    return false;
}

// ★★ 2026-11-02 用户截图实证：点「领取结算」后还有一层二次确认框（不是战报！）
//   ┌ 领取结算 ─────────────┐
//   │ 领取后本局结束，不可继续挑战。   │
//   │ 【金钱】银贝 ×610            │
//   │ 【物品】低级装备随机箱 ×30     │
//   │ 【物品】中级装备箱 ×35        │
//   │ 【物品】高级装备箱 ×5         │
//   │ [取消]        [确定]  ← 绿色   │
//   └───────────────────────┘
// 必须点「确定」才真正入账。旧代码点完「领取结算」就回读「待领取奖励」——
// 确认框还盖在上面、背景那行「本局待领取奖励（3）」也还在 → 必然判「未生效」，
// 于是靠下一轮 closeBattleReport 把「确定」当通用关闭按钮瞎点，凑巧才领到。
// 现在显式识别这个框，点真实的「确定」。
const CLAIM_CONFIRM_RE = /领取后本局结束|不可继续挑战/;

// 领完后的强证据：页面变成「暂无进行中的挑战」+「开始挑战」（用户第二张截图）
// 结算页残留「领取结算」「待领取奖励」字样，一律算未领完。
function claimDone(txt) {
    if (/暂无进行中的挑战/.test(txt)) return true;
    if (CLAIM_CONFIRM_RE.test(txt)) return false;      // 确认框还在 = 还没点确定
    return !/待领取奖励|领取结算/.test(txt);
}

async function confirmClaimPopup(page) {
    const t = await getPageText(page);
    if (!CLAIM_CONFIRM_RE.test(t)) return false;
    const ok = await tapBtn(page, '确定') || await clickBottomLeaf(page, '确定');
    if (ok) log('  确认框已弹出 → 点「确定」');
    return ok;
}

async function claimSettlement(page) {
    let confirms = 0;
    for (let i = 1; i <= 4; i++) {
        // ⓿ 安全闸：页面还有「增益待选 / 碾压中」时绝不点「领取结算」——
        //   11-04 CI 两次 claim-fail 就是在这个态上连点 4 次全部点空（被增益弹层盖住）。
        const pre = await getPageText(page);
        if (/请选择本层增益|请选择增益|碾压中/.test(pre)) {
            log('页面还有增益待选/碾压进行中，先不点领取结算');
            return { ok: false, tries: i - 1, confirms, mid: true };
        }
        // ① 已经在确认框上（上一轮点完确认框才弹出来）：直接点确定
        if (await confirmClaimPopup(page)) {
            confirms++;
            await sleep(1800);
            const a = await getPageText(page);
            if (claimDone(a)) return { ok: true, tries: i, confirms };
            continue;
        }
        // ② 关掉可能残留的战报 / 提示（只点 × 和「知道了」，不碰「确定」），再滚到底
        await closeBattleReport(page);
        await scrollPanelBottom(page);

        // ③ 点「领取结算」
        const way = await tapBtn(page, '领取结算');
        if (!way) log(`  第${i}次没点到「领取结算」（不在视口/找不到节点）`);
        await sleep(700);

        // ④ 确认框通常在点击后立刻弹出，点它的「确定」
        if (await confirmClaimPopup(page)) {
            confirms++;
            await sleep(2000);
            const a = await getPageText(page);
            if (claimDone(a)) return { ok: true, tries: i, confirms, way };
            log(`  第${i}次点了「确定」但奖励仍未清空 → 重试`);
            continue;
        }

        // ⑤ 没弹确认框（可能这号不需要二次确认）：等回包再看
        await sleep(1400);
        const after = await getPageText(page);
        if (claimDone(after)) return { ok: true, tries: i, confirms, way };
        log(`  第${i}次点「领取结算」未生效（${way || '未点中'}，确认框=${CLAIM_CONFIRM_RE.test(after) ? '在' : '无'}）→ 重试`);
    }
    return { ok: false, tries: 4, confirms };
}

async function run() {
    // 看门狗：整步最多 15 分钟（正常一局 3~10 分钟），超时直接退出，免得把任务链拖死
    const watchdog = setTimeout(() => {
        console.error('ERROR: 镇妖塔超过 15 分钟未结束，强制退出（不影响后续任务）');
        process.exit(0);
    }, 15 * 60 * 1000);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 原生对话框统一接管（记录 + 关掉）。注：Playwright 默认也会自动 dismiss，
        // 所以它**不是** 11-01 那两次静默卡死的原因（已用 probe-dialog.js 实测证否）。
        page.on('dialog', async (d) => {
            log(`[页面对话框] ${d.type()}: ${d.message().substring(0, 120)} → 关闭`);
            try { await d.dismiss(); } catch (e) { /* ignore */ }
        });

        if (!(await login(page))) {
            await fail(page, '登录/进入游戏失败，镇妖塔已跳过', 'zhenyaota-login-fail.png');
            return;
        }
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(1500);

        // 0. 若还在副本里（状态持久），先做完/退本，否则城里没有「出航」
        await exitDungeonIfInside(page);

        // 1. 到泉州
        let t = await getPageText(page);
        if (!t.includes(`当前城市：${NAV_DEST}`)) {
            log(`当前不在${NAV_DEST}，出航前往...`);
            const ok = await mb.sailFlow(page, NAV_DEST, NAV_REGION);
            if (!ok) {
                await fail(page, `出航到${NAV_DEST}失败，镇妖塔已跳过`, 'zhenyaota-nav-fail.png');
                return;
            }
        } else {
            log(`已在${NAV_DEST}`);
        }
        await backToCity(page);

        // 2. 进塔（城内地图 → 少林后山 → 点武僧 → 进入镇妖塔）
        t = await getPageText(page);
        if (!atTower(t) && !(await openTower(page))) {
            // 正常跳过：点到武僧后仍没有「进入镇妖塔」链接 = 这个号没有资格/今日次数已用完
            log(`没进到镇妖塔，跳过。你看到=${listSeen(t).join('/') || '(空)'} 页面: ${snip(t, 160)}`);
            await page.screenshot({ path: 'zhenyaota-noentry.png' }).catch(() => {});
            return;
        }

        t = await getPageText(page);
        const rm = parseRemain(t);
        log(`进入镇妖塔，今日剩余 ${rm ? rm.left + '/' + rm.total : '?'} 次`);
        // 「今日剩余」在开局瞬间就变 0/1，所以不能只看它。真正要判的是「有没有局还在手里」：
        //   实测（2026-11-02 只读探针）重进塔**不会**回到开局页，而是直接落在当前层的层间页，
        //   那里只有「挑战本层」，根本没有「继续挑战」——只认「继续挑战」会把残局当成已打完而跳过。
        // 有局 = 有 当前层数 / 挑战本层 / 快速碾压 / 继续挑战 / 挑战结束待结算，任意一个都说明还能接着打。
        const hasRun = /继续挑战/.test(t) || /挑战本层/.test(t) || /快速碾压/.test(t)
            || /当前层数/.test(t) || /挑战结束/.test(t);
        if (rm && rm.left <= 0 && !hasRun) {
            log('今日次数已用完（且确实没有进行中的局），跳过');
            return;
        }
        if (rm && rm.left <= 0) log('今日次数已用完，但手里还有一局未结算 → 接着打（续打不消耗次数）');
        const attr = parseAttrs(t);
        log(`初始属性: 吸血${attr.lifestealPct === null ? '?' : attr.lifestealPct + '%'} 暴击${attr.crit === null ? '?' : attr.crit + '%'}`);

        // 3. 打
        const res = await climbTower(page, attr);

        // 4. 回主页面（给后面的 daily.js 一个好起点）
        await backToCity(page);
        const done = await getPageText(page);
        const city = done.match(/当前城市：(\S+)/);
        const inTower = TOWER_PANEL_RE.test(done);
        log(`收尾: 当前城市=${city ? city[1] : '?'} 主页面=${!!city && !inTower}${inTower ? '（★ 仍在镇妖塔面板里，没退出来）' : ''}`);
        await page.screenshot({ path: 'zhenyaota-done.png' }).catch(() => {});

        if (res.result === 'noentry' || res.result === 'stuck' || res.result === 'claim-fail') {
            console.log(`::error::镇妖塔异常结束(result=${res.result})，到第${res.floor}层`);
        }
    } catch (e) {
        console.error('ERROR: 镇妖塔流程异常:', e.message);
        console.log(`::error::镇妖塔异常: ${e.message}`);
        await page.screenshot({ path: 'zhenyaota-error.png' }).catch(() => {});
    } finally {
        clearTimeout(watchdog);   // 不清掉会把这个进程挂到 15 分钟
        await browser.close();
    }
}

if (require.main === module) run();

module.exports = { run, scoreCard, chooseCard, parseRemain, parseFloor, parseAttrs, pageState, readBuffCards, listSeen, openTower, gotoHoushan, clickLeafNorm, atTower, login, getPageText, closeBattleReport, scrollPanelBottom, measureText, realClick, tapBtn, dumpClickables, dumpStuck, hasVisibleAttack, claimSettlement, claimDone, confirmClaimPopup, clickPanelBack, backToCity, TOWER_PANEL_RE, CLAIM_CONFIRM_RE };
