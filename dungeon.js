const { chromium } = require('playwright');
// 出航复用 daily.js：它已处理任务页残留/已在目标城/区域横滚/暂无地图/海盗/自动航行，
// 自带一套出航实现曾在 2026-10-28 大号上卡死 5 分钟且传送兜底也到不了伦敦。
const daily = require('./daily.js');
// 扫荡/领奖弹窗处理（「扫荡收获」只有一个「知道了」，点完必须验证真的关掉）
const drain = require('./dungeon-recover.js');

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
// 剩余多少分钟才允许回扫补怪（4 线手动清约 6~8 分钟 + 留给领奖）
const RESCAN_MIN_LEFT = 15;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoGame(page, retries = 3) {
    // runner到游戏服务器慢时，等load事件会30s超时；domcontentloaded不等全量资源，失败重试
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
async function fightOne(page, name) {
    if (!(await clickMonster(page, name))) return false;
    await sleep(300);
    let blades = 0;
    for (let a = 0; a < 12; a++) {
        const txt = await getPageText(page);
        if (txt.includes('关闭')) {
            await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
            await sleep(300);
            console.log(`  [战斗] ${name}: ${blades}刀+结算`);
            return true;
        }
        if (txt.includes('攻击')) {
            await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
            blades++;
            await sleep(300);
            continue;
        }
        // 无弹窗无结算：可能还在过渡，稍等复看一次
        await sleep(300);
        const t2 = await getPageText(page);
        if (!t2.includes('攻击') && !t2.includes('关闭')) break;
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
async function clearRoom(page, tag) {
    let kills = 0;
    let emptyReads = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
        const txt = await getPageText(page);
        const seg = viewSeg(txt);
        if (!seg) {
            console.log(`[${tag}] 找不到“你看到”区块，页面:`, txt.substring(0, 120));
            await sleep(1000);
            continue;
        }
        const mobs = monstersIn(seg);
        if (!mobs.length) {
            // 「本层真的没怪」和「怪还没渲染出来」必须分开。
            // kidd.js 2026-10-29 实证：基德东线首读 0 只就当空房 → 只记 8 间/24 杀（总 48/51）。
            // 炼器窟每层固定 3 只，正常路径第一读就有怪，所以全清时零额外开销；
            // 只有真的读不到（页面还没渲染）才会在这里多等，最多 3 次 ≈4.5 秒。
            emptyReads++;
            if (emptyReads >= 3) return kills;
            console.log(`[${tag}] 房间没读到怪，等渲染（第${emptyReads}/3次）...`);
            await sleep(1500);
            continue;
        }
        emptyReads = 0;
        const before = seg.split(mobs[0]).length - 1;
        await fightOne(page, mobs[0]);
        const after = viewSeg(await getPageText(page));
        const nowCount = after.split(mobs[0]).length - 1;
        kills += Math.max(0, before - nowCount);
        if (before - nowCount === 0 && attempt > 10) {
            await page.screenshot({ path: `dungeon-stuck-${tag}.png` }).catch(() => {});
        }
    }
    await page.screenshot({ path: `dungeon-room-stuck-${tag}.png` }).catch(() => {});
    throw new Error(`[${tag}] 房间怪物清理失败（15次尝试）`);
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

        for (let i = 0; i < 10; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            let pageText = await getPageText(page);
            if (pageText.includes('选择角色') || pageText.includes('Lv.')) {
                console.log('在选角界面，点击进入游戏选角色...');
                await clickText(page, '进入游戏');
                await sleep(5000);
                pageText = await getPageText(page);
            }
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('进入游戏成功');
                break;
            }
            console.log('进入游戏未成功，重试...');
            await sleep(2000);
        }

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        let pageText = await getPageText(page);
        if (pageText.includes('请输入账号密码') || pageText.includes('选择角色')) {
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

        for (const arm of ARMS) {
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
                for (const arm of ARMS) {
                    const r = await runArm(page, arm, '补扫·');
                    if (r.code !== 'ok') { console.log(`[补扫] 中止（${r.code}）`); break; }
                    recov += r.kills;
                    if (!r.back) break;
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
        if (NO_CLAIM) {
            const ci = pageText.indexOf('副本条件');
            const cj = pageText.indexOf('回到起点', ci);
            console.log('NO_CLAIM 模式：不领奖、不退出，留副本内待人工查验');
            console.log('条件行:', ci >= 0 ? pageText.substring(ci, cj > ci ? cj : ci + 120) : '(未见)');
            await page.screenshot({ path: 'dungeon-no-claim.png' }).catch(() => {});
        } else if (allArmsDone && pageText.includes('领取奖励')) {
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

    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'dungeon-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

run();
