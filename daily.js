const { chromium } = require('playwright');
const drain = require('./dungeon-recover.js');

const ACCOUNT = process.env.GAME_ACCOUNT;
const PASSWORD = process.env.GAME_PASSWORD;
// DAILY_DRY=1 只读模式：登录→解析每日任务→打印按城市聚合的执行计划，不杀怪不出航
const DRY = process.env.DAILY_DRY === '1';

// 城市所属海域（用户提供的出航选择全图 zhsh/地区城市分布/；地区栏可左右滚动，最右第6区未截图）
const CITY_REGION = {
    // 地中海
    '里斯本': '地中海', '威尼斯': '地中海', '亚历山大': '地中海', '突尼斯': '地中海',
    '马赛': '地中海', '雅典': '地中海', '伊斯坦堡': '地中海', '阿尔及尔': '地中海',
    '拉古扎': '地中海', '伊斯坦布尔': '地中海',
    // 北海
    '爱丁堡': '北海', '伦敦': '北海', '南特': '北海', '阿姆斯特丹': '北海',
    '汉堡': '北海', '奥斯陆': '北海', '哥本哈根': '北海',
    // 非洲
    '亚特兰蒂斯': '非洲', '莫桑比克': '非洲', '马达加斯加': '非洲', '蒙巴萨': '非洲',
    '达喀尔': '非洲', '圣乔治': '非洲', '卢旺达': '非洲', '开普敦': '非洲',
    // 东亚
    '长安': '东亚', '扬州': '东亚', '杭州': '东亚', '泉州': '东亚',
    '广州': '东亚', '马六甲': '东亚', '大阪': '东亚', '京都': '东亚',
    // 印度洋
    '亚丁': '印度洋', '荷姆兹': '印度洋', '锡兰': '印度洋', '孟买': '印度洋',
};
// 地区栏可左右滚动：前5区能看到，最右「新大陆」需横滚才露出来（用户实证）
const ALL_REGIONS = ['地中海', '北海', '非洲', '东亚', '印度洋', '新大陆'];

// 「用户手动告知」的特殊任务：地图寻路拿不到目标的那几条（详情无「城市·野区」、点寻路弹「没有目标地图」）。
// 用户口头告知后在这里记一行（城市 + 掉落它的怪），脚本只做一件事：去这座城再点一次寻路。
//
// ★ 严禁靠野怪分布表（monster-map.json）自动反查推断 —— 用户 10-26 明确：
//   「你检索我给你的文本你自己看不出来的，比如铁矿石，如果我不告知你是偷矿者掉落，你能判断吗？」
//   怪表只作为人工查询资料留在仓库里，不参与自动决策。
//
// ★ 也不许为了这类任务跨海域白跑：10-26 21:35 实测 coldwind0 专程航行到威尼斯，铁矿石寻路**仍然**弹
//   「没有目标地图」（游戏没给这条任务配目标地图，不是城市问题）→ 空烧一路铜贝。所以默认留空：
//   寻路不通就直接记账放着（`未完成·寻路无目标地图…等你告知城市`），等用户在场时手动带着走。
const MANUAL_HINTS = {
    // 格式：{ 任务名: { city, monster, area, walk? } }
    //   walk = 用户告知的**固定走法**（只点这个方向，不做任何自动探索/推断）
    //   没有 walk 的 hint 只表示「去这座城再点一次寻路」，多数没用（游戏没配目标地图，白跑一趟）
    //
    // ★ 用户 10-28 纠正：不是「特殊任务一律不动」，而是**告知过走法就要执行**，没告知过的才放着。
    '铁矿石': {
        city: '威尼斯',
        monster: '偷矿者',
        area: '矿山',
        // 用户 2026-10-26 告知并实测（probe-walk-ore.run5.log 18 杀 3/3）：
        // 威尼斯城内「北：西城门」→ 北：铁匠铺 → 北：居民区 → 北：北城门 → 北：矿山
        // → 病鸡 → 野猪 → 野狼 → 僵尸 → 老虎 → 空层 → 第 12 层（偷矿者 + 白虎王）
        // 一路只点「北」；空层那步合成事件点不动，必须补真实坐标点击。
        walk: { dir: '北', maxSteps: 14 },
    },
};

// 任务 → 用户告知过的城市（只查 MANUAL_HINTS，不做任何自动检索）
function locateTask(task) {
    for (const [key, hint] of Object.entries(MANUAL_HINTS)) {
        if (task.target === key || task.name === key || (task.name || '').includes(key) || (task.target || '').includes(key)) {
            return { key, ...hint };
        }
    }
    return null;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function clickText(page, text, timeout = 5000) {
    const el = page.getByText(text, { exact: false }).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        return true;
    }
    return false;
}

// 读页面文本：只取**可见**节点。
// textContent 会把 display:none 的节点也算进去，而游戏的 toast 弹过一次后 DOM 节点会永久留在页面里
// → 上一条任务留下的「任务已完成」会被反复读到（10-27 boss2 劫匪 0 杀收工、boss4 盐矿 2 杀收工的根因）。
// 这里保留 textContent 的「无分隔符拼接」特性（各进度正则依赖无空格），只跳过不可见子树。
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

// evaluate精确点击叶子文本（按文本长度升序，短者优先=最内层），绕过遮罩
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

// 选海域标签：.region-bar 是横向滚动，最右「新大陆」默认被裁掉，找不到就横滚再找
// 返回 true=已切到该海域 / 'nomap'=该号没有这个海域的海图（点标签即弹「暂无地图，查看失败」）/ false=点不到
async function selectRegion(page, region) {
    const noMap = async () => (await getPageText(page)).includes('暂无地图');
    // 读 chip 位置 + 区域栏可视范围：chip 中心一旦超出可视区，坐标点击就会打偏
    const read = () => page.evaluate((r) => {
        const bar = document.querySelector('.region-bar');
        if (!bar) return null;
        const wrapEl = bar.querySelector('.scroll-view_H') || bar;
        const wb = wrapEl.getBoundingClientRect();
        for (const chip of bar.querySelectorAll('.region-chip')) {
            if ((chip.textContent || '').trim() !== r) continue;
            const b = chip.getBoundingClientRect();
            if (!b.width || !b.height) return null;
            const cx = b.x + b.width / 2;
            return {
                x: Math.round(cx), y: Math.round(b.y + b.height / 2),
                active: chip.classList.contains('active-region'),
                inView: cx > wb.left + 8 && cx < wb.right - 8,
                scrollLeft: cx < wb.left + 8 ? 'right' : (cx > wb.right - 8 ? 'left' : null),
                barX: Math.round(wb.x + wb.width * 0.6), barY: Math.round(wb.y + wb.height / 2),
            };
        }
        return null;
    }, region).catch(() => null);

    const barCenter = async () => await page.evaluate(() => {
        const b = document.querySelector('.region-bar');
        if (!b) return null;
        const w = b.querySelector('.scroll-view_H') || b;
        const r = w.getBoundingClientRect();
        return { x: Math.round(r.x + r.width * 0.6), y: Math.round(r.y + r.height / 2) };
    }).catch(() => null);

    for (let i = 0; i < 5; i++) {
        const p = await read();
        if (!p) {
            // chip 完全没有尺寸（被裁得很彻底）→ 直接往右滚找
            const c = await barCenter();
            if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(300, 0); }
            await sleep(700);
            continue;
        }
        if (p.active) return true;
        if (!p.inView) {
            // 中心点在可视区外：先滚到能点，再点（否则会点到隔壁 chip / 城市行上）
            await page.mouse.move(p.barX, p.barY);
            await page.mouse.wheel(p.scrollLeft === 'right' ? -200 : 200, 0);
            await sleep(800);
            continue;
        }
        await page.mouse.click(p.x, p.y);
        await sleep(1200);
        // 该号没有这个海域的海图：点标签就弹「暂无地图，查看失败」，区域也不会切
        if (await noMap()) return 'nomap';
        const after = await read();
        if (after && after.active) return true;
    }
    // DOM 兜底：合成事件点（uni-app 的 tap，绕过滚动区对坐标点击的拦截）
    const leafOk = await clickLeaf(page, region);
    await sleep(1000);
    if (await noMap()) return 'nomap';
    return leafOk;
}

async function closePopup(page) {
    await page.mouse.click(10, 10);
    await sleep(500);
    await page.keyboard.press('Escape');
    await sleep(1000);
}

async function currentCity(page) {
    const m = (await getPageText(page)).match(/当前城市[：:]\s*([\u4e00-\u9fa5]{2,6})/);
    return m ? m[1] : null;
}

// 页面是否显示「当前城市：X」（冒号全半角都兼容）
function atCity(txt, dest) {
    return new RegExp(`当前城市[：:]\\s*${dest}`).test(txt);
}

// 出航到指定城市（照 farm.js pickConfirm：重开面板3轮，防弹窗吃掉面板点击）
// 出航失败原因：'nomap' = 该号没有该区域地图（游戏弹「暂无地图，查看失败」）
let SAIL_FAIL = '';
function sailFailReason() { return SAIL_FAIL; }

// 起航判定：航行中/剩余距离/停止自动航行 任一出现即算离港（只认「停止自动航行」会误判，见 fish.js）
async function waitSailing(page, sec) {
    for (let i = 0; i < sec; i++) {
        const t = await getPageText(page);
        if (t.includes('航行中') || t.includes('剩余距离') || t.includes('停止自动航行')) return true;
        await sleep(1000);
    }
    return false;
}

async function sailTo(page, dest) {
    SAIL_FAIL = '';
    await backToMain(page); // 任务页/弹窗残留会让出航面板打不开
    // 已在目标城市：出航列表不列当前城市，硬选必然失败
    const preSail = await getPageText(page);
    if (!preSail.includes('停止自动航行') && !preSail.includes('剩余距离') && preSail.includes(`当前城市：${dest}`)) {
        console.log(`已在${dest}，无需出航`);
        return true;
    }
    // 不在城内主界面（无「出航」）→ 点码头出口回城（点「城内地图」只弹目的地列表，人不动）
    if (!(await getPageText(page)).includes('出航')) {
        console.log('当前不在城内主界面，尝试回城（点码头出口）...');
        if (!(await backToCity(page))) console.log('回城未成功，继续尝试出航（大概率会失败）');
    }
    // 选海域：已知海域直接点；未知则逐海域轮询搜索城市（含出航确认检测）
    const region = CITY_REGION[dest];
    const regions = region ? [region] : ALL_REGIONS;
    let picked = false;
    for (let round = 1; round <= 3 && !picked; round++) {
        // 重开出航面板
        await page.mouse.click(10, 10);
        await page.keyboard.press('Escape');
        await sleep(500);
        let step = await clickText(page, '出航', 2000);
        if (!step) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            await clickText(page, '出航');
        }
        await sleep(2000);
        let regionNoMap = false;
        for (const r of regions) {
            // 地区栏横向滚动，最右「新大陆」需横滚才露出来
            // nomap = 该号没这个海域的海图（点标签即弹「暂无地图，查看失败」）
            const rp = await selectRegion(page, r);
            if (rp === 'nomap') {
                console.log(`海域「${r}」无海图（点标签就提示暂无地图）`);
                if (regions.length === 1) { regionNoMap = true; break; }
                continue;   // 多海域轮询时跳过这个区，继续找
            }
            if (!rp) console.log(`海域标签「${r}」没点到`);
            await sleep(1000);
            for (let s = 0; s < 5; s++) {
                // 第2轮起用合成事件点击，绕过遮罩对坐标点击的拦截（farm.js 同款）
                const ok = round === 1 ? await clickText(page, dest, 2000) : await clickLeaf(page, dest);
                if (ok) {
                    // 高峰期确认框慢半拍，最多8秒轮询（farm.js 实证：单次1.5秒查询会误判）
                    for (let c = 0; c < 8; c++) {
                        await sleep(1000);
                        let t = await getPageText(page);
                        // 「暂无地图」和出航确认框会同时出现（实测），必须先判 nomap
                        if (t.includes('暂无地图')) {
                            console.log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                            SAIL_FAIL = 'nomap';
                            picked = false;
                            break;
                        }
                        if (t.includes('出航确认')) {
                            // 确认框先渲染、toast 后弹的情况：再复检一次
                            await sleep(800);
                            t = await getPageText(page);
                            if (t.includes('暂无地图')) {
                                console.log(`「暂无地图，查看失败」→ 该号没有${dest}的地图/海图，不再重试也不传送`);
                                SAIL_FAIL = 'nomap';
                                picked = false;
                                break;
                            }
                            picked = true;
                            break;
                        }
                    }
                    if (picked) break;
                }
                await page.mouse.wheel(0, 300);
                await sleep(1000);
            }
            if (picked) break;
            if (regions.length > 1) console.log(`${r}没找到${dest}，换下一个海域...`);
        }
        if (regionNoMap) {
            SAIL_FAIL = 'nomap';
            console.log(`「暂无地图，查看失败」→ 该号没有${region}海域的海图，${dest}到不了，不传送`);
            break;
        }
        if (!picked) console.log(`未看到${dest}出航确认框，重开面板重试(${round}/3)...`);
    }
    if (!picked) {
        if (SAIL_FAIL === 'nomap') return false;
        console.log(`未看到${dest}出航确认框，放弃出航（不盲点立即出发干等5分钟）`);
        await page.screenshot({ path: `daily-sail-fail.png` }).catch(() => {});
        return false;
    }
    await sleep(1000);
    await clickText(page, '立即出发');
    if (!(await waitSailing(page, 25))) {
        console.log('点立即出发后未见起航，重点一次再等...');
        await clickText(page, '立即出发');
        if (!(await waitSailing(page, 20))) {
            console.log('起航未确认(航行中/剩余距离都没出现)，放弃出航');
            await page.screenshot({ path: 'daily-sail-fail.png' }).catch(() => {});
            return false;
        }
    }
    await clickExact(page, '自动航行', 5000);
    console.log(`航行去${dest}中...`);
    for (let w = 0; w < 100; w++) {
        await sleep(3000);
        const txt = await getPageText(page);
        if (atCity(txt, dest)) {
            console.log(`到达${dest}`);
            return true;
        }
        if (txt.includes('遭遇海盗')) {
            console.log('遭遇海盗，选择避战...');
            await clickExact(page, '避战', 3000);
            await sleep(2000);
            const t2 = await getPageText(page);
            if (!t2.includes('停止自动航行')) {
                if (await clickExact(page, '自动航行', 3000)) console.log('恢复自动航行');
            }
            continue;
        }
        if (!txt.includes('停止自动航行') && await clickExact(page, '自动航行', 1500)) {
            console.log('自动航行(重新)启动');
        }
    }
    console.log(`航行未完成（约5分钟）`);
    return false;
}

// 传送兜底（照 dungeon.js，城市参数化）
async function teleportToDest(page, dest) {
    console.log('传送兜底: 重新登录游戏...');
    try {
        await gotoGame(page);
        await page.waitForTimeout(3000);
        const inputs = await page.$$('input');
        if (inputs.length >= 2) {
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
            await page.getByText('登录').first().click();
            await sleep(3000);
        }
        await closePopup(page);
        await sleep(1000);
        await clickText(page, '进入游戏');
        await sleep(3000);
        let ok = await clickText(page, '传送', 2000);
        if (!ok) {
            await clickText(page, '城内地图');
            await sleep(2000);
            await clickText(page, '码头');
            await sleep(3000);
            ok = await clickText(page, '传送');
        }
        if (!ok) {
            console.log('传送兜底: 找不到传送入口');
            return false;
        }
        await sleep(2000);
        // 海域选择：已知直接点；未知逐海域轮询（城市可点中即跳出）
        const region = CITY_REGION[dest];
        const regions = region ? [region] : ALL_REGIONS;
        let picked = false;
        for (const r of regions) {
            // 地区栏横向滚动，最右「新大陆」需横滚才露出来
            const rp = await selectRegion(page, r);
            if (rp === 'nomap') {
                console.log(`传送面板: 海域「${r}」无海图，跳过`);
                if (regions.length === 1) return false;   // 目标区都没图，传送也没用
                continue;
            }
            if (!rp) console.log(`海域标签「${r}」没点到`);
            await sleep(1000);
            for (let s = 0; s < 5; s++) {
                if (await clickText(page, dest, 2000)) {
                    picked = true;
                    break;
                }
                await page.mouse.wheel(0, 300);
                await sleep(1000);
            }
            if (picked) break;
        }
        if (!picked) console.log('传送兜底: 城市列表里没找到目标');
        await sleep(3000);
        let txt = await getPageText(page);
        if (!atCity(txt, dest)) {
            await clickText(page, '确定');
            await sleep(2000);
            await clickText(page, '确认');
            await sleep(2000);
            txt = await getPageText(page);
        }
        if (atCity(txt, dest)) {
            console.log(`传送兜底: 已到达${dest}`);
            return true;
        }
        console.log('传送兜底: 未检测到到达');
        return false;
    } catch (e) {
        console.log('传送兜底错误:', e.message);
        return false;
    }
}

// ---------- 每日任务专用 ----------

// 打开任务页并确保每日任务已展开（提交后该区会自动折叠，每次都重新检测）
// 任务页标志：有「活动任务/跑商任务」分节；展开验证：出现任务行（每日·X）
// 展开方式：真实坐标点击「每日任务 (0/10)▼」标题行（点标题或▼箭头均可，合成事件无效）
async function openDailyList(page) {
    for (let i = 0; i < 6; i++) {
        const txt = await getPageText(page);
        if (/每日[·・][\u4e00-\u9fa5]/.test(txt)) return txt; // 已展开
        const onTaskPage = txt.includes('活动任务') || txt.includes('跑商任务');
        if (!onTaskPage) {
            if (!(await clickExact(page, '任务', 2000))) await clickLeaf(page, '任务');
            await sleep(2000);
            continue;
        }
        // 在任务页：定位「每日任务 (x/y)」标题行，真实鼠标点其中心展开
        const box = await page.evaluate(() => {
            const els = [...document.querySelectorAll('body *')].filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 &&
                    /每日任务\s*[（(]\d+\/\d+[）)]/.test(el.textContent || '');
            });
            if (!els.length) return null;
            els.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
            const r = els[0].getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (box) {
            await page.mouse.click(box.x, box.y).catch(() => {});
        } else {
            await page.getByText('每日任务', { exact: false }).first().click({ force: true, timeout: 2000 }).catch(() => {});
        }
        await sleep(1800);
    }
    console.log('每日任务折叠区展开失败，页面:', (await getPageText(page)).substring(0, 120).replace(/\s+/g, ' '));
    return await getPageText(page);
}

// 点开某条每日任务的详情（按行号），解析进度段；返回 {rowNo,name,city,area,x,n,full} 或 null
async function readTaskDetail(page, rowNo, taskName) {
    for (let i = 0; i < 3; i++) {
        await clickRow(page, rowNo, taskName);
        await sleep(1500);
        if ((await getPageText(page)).includes('任务进度')) break;
        // 兜底：行号定位失败（如行10）时用真实点击名字文本
        await page.getByText(taskName, { exact: false }).first().click({ force: true, timeout: 2000 }).catch(() => {});
        await sleep(1500);
        if ((await getPageText(page)).includes('任务进度')) break;
        await clickLeaf(page, taskName);
        await sleep(1500);
    }
    await sleep(1200);
    const txt = await getPageText(page);
    const i = txt.indexOf('任务进度');
    const j = txt.indexOf('任务奖励', i);
    if (i < 0) {
        console.log(`[${taskName}] 详情里没有任务进度段`);
        await clickExact(page, '取消', 1500);
        return null;
    }
    const seg = txt.substring(i, j > i ? j : i + 200);
    // 「威尼斯·矿山」在详情里可能被渲染成「威尼斯 · 矿山」（点号两侧带空格/换行，textContent 原样带出）
    // —— 10-26 实测：盐矿详情写的就是「威尼斯 · 矿山」，原正则不容忍空格 → 整条被判「无地点」跳过。
    // 点号还可能是 ·(B7) ・(30FB) •(2022) ∙(2219)，统一吃进来。
    const LOC_RE = /([\u4e00-\u9fa5]{2,5})\s*[·・•∙]\s*([★☆]?[\u4e00-\u9fa5]{2,8})/; // 区域可能带★前缀（如★码头=特殊场景）
    let loc = seg.match(LOC_RE);
    const cnt = seg.match(/(\d+)\s*\/\s*(\d+)/);
    // 任务类型与目标：从「任务介绍」段解析（独立短句、不带地点，如“击杀山匪8只”“收集5份盐矿”）。
    // 不能用进度段解析——进度文本无空格（击杀山匪长安·望马坡0/8），数字锚定会把地名当怪名。
    let type = null, target = null;
    const ii = txt.indexOf('任务介绍');
    const intro = ii >= 0 ? txt.substring(ii, txt.indexOf('任务要求', ii) > 0 ? txt.indexOf('任务要求', ii) : ii + 120) : '';
    // 兜底：部分任务的地点只写在「任务介绍」（如「前往威尼斯·湿地附近探索，收集3个龟壳」）
    if (!loc) {
        const il = intro.match(LOC_RE);
        if (il) {
            loc = il;
            console.log(`[${taskName}] 进度段无地点，从任务介绍取: ${il[0]}`);
        }
    }
    const ik = intro.match(/击杀(?:\d+\s*[只个头匹]?\s*)?([\u4e00-\u9fa5]{2,6})/);
    const im = intro.match(/收集(?:\d+\s*[个份只张枚]?\s*)?([\u4e00-\u9fa5]{2,6})/);
    if (ik) { type = 'kill'; target = ik[1]; }
    else if (im) { type = 'mat'; target = im[1]; }
    else {
        // 兜底：介绍段解析失败 → 用任务行短名当目标（行名本身就是怪名/物品名）
        type = txt.includes('击杀') ? 'kill' : 'mat';
        target = taskName;
        console.log(`[${taskName}] 介绍段解析失败，兜底目标=${target} 类型=${type}`);
    }
    // 条件满足时详情按钮变为「提交」，以此判断完成（列表行进度不可信！
    // 实测寻路蜂列表显示「/」或「0/5」，详情却是 218/2 条件满足可直接提交）
    const satisfiable = txt.includes('条件满足');
    // 已提交的任务详情仍显示 5/5（条件满足）但提交按钮已消失（探针截图实证：
    // 列表右列变「已完成」）；用按钮元素存在性区分 已提交/可提交
    const hasSubmitBtn = await page.evaluate(() =>
        [...document.querySelectorAll('body *')].some(el => {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && s === '提交' && r.width > 0 && r.height > 0;
        })
    );
    await clickExact(page, '取消', 1500);
    await sleep(500);
    if (!loc && !cnt && !satisfiable) {
        console.log(`[${taskName}] 进度段解析失败:`, seg.substring(0, 80).replace(/\s+/g, ' '));
        return null;
    }
    // loc 可能缺失（收集类进度段无「城市·野区」）：满条件也能提交，未满则无法导路只能跳过
    const x = cnt ? parseInt(cnt[1], 10) : 0;
    const n = cnt ? parseInt(cnt[2], 10) : Infinity;
    // 进度文本无空格（如“击杀山匪长安·望马坡0/8”），城市名会带上任务目标前缀，剥掉：
    // 1) 城市段完整包含目标名 → 取目标名之后；2) 前缀被截断（如“魔士兵雅典”）→ 剥掉与目标后缀重合的开头
    let city = loc ? loc[1] : null;
    if (city && target) {
        if (city.includes(target)) {
            city = city.substring(city.indexOf(target) + target.length);
        } else {
            for (let l = Math.min(target.length - 1, city.length - 1); l >= 1; l--) {
                if (city.startsWith(target.substring(target.length - l))) {
                    city = city.substring(l);
                    break;
                }
            }
        }
    }
    if (city) city = city.replace(/^(击杀|收集|讨伐|消灭|杀|前往|去|到)/, '');
    if (city && city.length < 2) city = null;
    // 城市名归一：解析串不在 CITY_REGION（如「前往威尼斯」）→ 找出其中包含的已知城市名
    if (city && !CITY_REGION[city]) {
        const hit = Object.keys(CITY_REGION).find(c => city.includes(c));
        if (hit) {
            console.log(`[${taskName}] 城市名「${city}」→ 归一为「${hit}」`);
            city = hit;
        }
    }
    const full = x >= n || satisfiable;
    return {
        rowNo, name: taskName,
        type, target,
        city,
        area: city ? loc[2].replace(/[★☆]/g, '').replace(/(附近探索|附近|一带|周边|探索|区域).*$/, '') : null,
        x, n,
        full,
        submitted: full && !hasSubmitBtn,
    };
}

// 按行号点任务行（同名任务可有多个实例！行号是唯一标识；真实坐标点击）
async function clickRow(page, rowNo, name) {
    const pos = await page.evaluate(({ no, nm }) => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0;
        });
        const numLeaf = leaves.find(el => (el.textContent || '').trim() === `${no}.`);
        if (!numLeaf) return null;
        // 在行容器内找名字叶子（点它最稳）
        let p = numLeaf.parentElement, el = null;
        for (let i = 0; i < 5 && p && !el; i++) {
            el = [...p.querySelectorAll('*')].find(c => {
                const r = c.getBoundingClientRect();
                return c.children.length === 0 && r.width > 0 && r.height > 0 &&
                    (c.textContent || '').includes(`每日·${nm}`);
            }) || null;
            if (!el) p = p.parentElement;
        }
        const target = el || numLeaf;
        target.scrollIntoViewIfNeeded ? target.scrollIntoViewIfNeeded() : null;
        const r = target.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, { no: rowNo, nm: name });
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y).catch(() => {});
    return true;
}

// 从列表文本按行解析全部每日任务（行号唯一标识；同名可多实例）
// 行标签采信：已完成→跳过；可提交→直接进提交队列；进行中→开详情解析
// （列表行进度数字不可信——材料类显示bug，但状态标签可靠）
async function parseDailyTasks(page) {
    const txt = await openDailyList(page);
    const segs = txt.split(/(?<![0-9])(?=\d+\.\s*\(每日\))/).filter(s => /\(每日\)/.test(s));
    if (!segs.length) {
        console.log('未解析到每日任务列表，页面:', txt.substring(0, 150).replace(/\s+/g, ' '));
        return [];
    }
    const tasks = [];
    for (const seg of segs) {
        const m = seg.match(/^(\d+)\.\s*\(每日\)每日[·・]([\u4e00-\u9fa5]{2,8})/);
        if (!m) continue;
        const rowNo = m[1], name = m[2];
        const tag = (seg.match(/已完成|进行中|可提交/) || [])[0];
        if (tag === '已完成') {
            tasks.push({ rowNo, name, type: null, target: null, city: null, area: null, x: 0, n: Infinity, full: true, submitted: true });
            continue;
        }
        if (tag === '可提交') {
            tasks.push({ rowNo, name, type: null, target: null, city: null, area: null, x: 0, n: Infinity, full: true, submitted: false });
            continue;
        }
        const t = await readTaskDetail(page, rowNo, name);
        if (t) tasks.push(t);
    }
    return tasks;
}

// 野区“你看到”区块（到 当前城市 或 【聊天】 为止）
function wildSeg(txt) {
    const i = txt.indexOf('你看到：');
    if (i < 0) return '';
    let j = txt.indexOf('当前城市', i);
    const k = txt.indexOf('【聊天】', i);
    if (k > i && (j < 0 || k < j)) j = k;
    return txt.substring(i, j > i ? j : txt.length);
}

// 点击“你看到”之后的怪物链接（叶子全等匹配）
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

// 列出野区“你看到”区块的怪名（导路后可能不止一种怪；页面文本无空格，
// 必须截断在 当前城市/城内地图/聊天 之前，否则会把 UI 链接当怪点——点城内地图会直接跳页！）
async function listMonsters(page) {
    return await page.evaluate(() => {
        const leaves = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect();
            return el.children.length === 0 && r.width > 0 && r.height > 0;
        });
        const seen = leaves.findIndex(el => (el.textContent || '').includes('你看到'));
        if (seen < 0) return [];
        const UI_WORDS = ['当前城市', '城内地图', '聊天', '地面掉落', '附近玩家'];
        const out = [];
        for (let i = seen + 1; i < leaves.length; i++) {
            const s = (leaves[i].textContent || '').trim();
            if (UI_WORDS.some(w => s.includes(w))) break;
            if (/^[\u4e00-\u9fa5]{2,6}$/.test(s) && !out.includes(s)) out.push(s);
        }
        return out;
    });
}

// 查看怪物掉落预览：点怪 → 查看 → 读“掉落预览”段 → 关闭
async function monsterDrops(page, name) {
    if (!(await clickMonster(page, name))) return null;
    await sleep(800);
    if (!(await clickExact(page, '查看', 2000))) {
        await closePopup(page);
        return null;
    }
    await sleep(800);
    const txt = await getPageText(page);
    const i = txt.indexOf('掉落预览');
    const drops = i >= 0 ? txt.substring(i + 4, i + 100) : '';
    // 查看信息页没有按钮，点空白区域关闭 → 回到怪物操作弹窗
    await page.mouse.click(15, 400).catch(() => {});
    await sleep(800);
    // 怪物操作弹窗（攻击/自动攻击/查看/撤退）→ 点撤退收尾
    if (!(await clickExact(page, '撤退', 2000))) {
        await closePopup(page);
    }
    await sleep(600);
    if ((await getPageText(page)).includes('掉落预览')) await closePopup(page);
    return drops;
}

// 与指定怪打一场：点怪 → 攻击到结算 → 关闭；返回结算文本（含掉落信息）或 null
async function fightMonster(page, name) {
    if (!(await clickMonster(page, name))) return null;
    await sleep(500);
    let resultTxt = '';
    for (let a = 0; a < 12; a++) {
        const txt = await getPageText(page);
        if (txt.includes('关闭')) {
            // 结算弹窗：截取弹窗文本
            const i = txt.indexOf('你战胜了');
            const j = txt.lastIndexOf('关闭');
            resultTxt = i >= 0 ? txt.substring(Math.max(0, i - 20), j > i ? j + 10 : i + 200) : '';
            await page.locator('text=关闭').first().click({ force: true, timeout: 1000 }).catch(() => {});
            await sleep(500);
            return resultTxt || `战斗:${name}`;
        }
        if (txt.includes('攻击')) {
            await page.locator('text=攻击').first().click({ force: true, timeout: 500 }).catch(() => {});
            await sleep(300);
            continue;
        }
        await sleep(300);
    }
    await page.locator('text=关闭').first().click({ force: true, timeout: 500 }).catch(() => {});
    return null;
}

// 按任务类型选怪打一场：
// 杀怪任务 → 打与任务目标同名的怪（如 每日·地藏士兵 打 地藏士兵）
// 材料任务 → 逐怪点「查看」读掉落预览，只打掉目标材料的怪（如 铁矿石 打偷矿者、不打白虎王）
// 都不合适返回 null（外层负责刷新/走相邻房间）
async function pickAndFight(page, task) {
    const monsters = await listMonsters(page);
    if (!monsters.length) return null;
    if (task.type === 'kill' && task.target) {
        const hit = monsters.find(m => m === task.target || m.includes(task.target) || task.target.includes(m));
        if (!hit) return null;
        return await fightMonster(page, hit);
    }
    for (const m of monsters) {
        const drops = await monsterDrops(page, m);
        if (drops && drops.includes(task.target)) {
            console.log(`  [选怪] ${m} 掉落含「${task.target}」，开打`);
            return await fightMonster(page, m);
        }
        console.log(`  [选怪] ${m} 不掉「${task.target}」，跳过`);
    }
    return null;
}

// ── 用户告知的固定走法（MANUAL_HINTS.walk）────────────────────────────
// 读页面方位出口「北：矿山」→ [{dir, place, text, x, y}]
async function readDirExits(page) {
    return await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length) continue;
            const s = (el.textContent || '').trim();
            const m = s.match(/^([东西南北])[：:]\s*(.{2,10})$/);
            if (!m) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            out.push({ dir: m[1], place: m[2].trim(), text: s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
        return out;
    }).catch(() => []);
}

// 只按 hint.walk.dir 一个方向走，直到看见 hint.monster。
// 不做任何出口筛选或分支判断 —— 路径是用户告知的，不是脚本推的。
async function walkByHint(page, hint, taskName) {
    const dir = hint.walk.dir;
    const maxSteps = hint.walk.maxSteps || 14;
    for (let s = 1; s <= maxSteps; s++) {
        const txt = await getPageText(page);
        const ms = txt.includes('你看到') ? await listMonsters(page) : [];
        if (ms.some(m => m.includes(hint.monster))) {
            console.log(`[${taskName}] 第${s}步见到${hint.monster}（${ms.join('/')}）`);
            return true;
        }
        const e = (await readDirExits(page)).find(x => x.dir === dir);
        if (!e) { console.log(`[${taskName}] 第${s}步没有「${dir}」出口，停`); break; }
        const okLeaf = await clickLeaf(page, e.text);
        await sleep(2500);
        let after = await getPageText(page);
        if (after === txt) {   // 合成事件点不动 → 补真实坐标点击（空层那一格就是这样）
            await page.mouse.click(e.x, e.y).catch(() => {});
            await sleep(2500);
            after = await getPageText(page);
        }
        if (after === txt) { console.log(`[${taskName}] 第${s}步「${e.text}」走不动，停`); break; }
        console.log(`[${taskName}] 第${s}步 → ${e.text}（${okLeaf ? '合成' : '坐标'}点击）`);
    }
    const t = await getPageText(page);
    if (!t.includes('你看到')) return false;
    return (await listMonsters(page)).some(m => m.includes(hint.monster));
}

// 走图 → 杀到满 → 提交。返回 'done' | 'full-但未提交成功' | 'fail'
async function runTaskByWalk(page, task, hint) {
    const name = task.name;
    const drop = task.target || name;
    console.log(`[${name}] 按你告知的走法执行：${hint.city} 一路「${hint.walk.dir}」找 ${hint.monster}`);
    await backToMain(page);
    if ((await currentCity(page)) !== hint.city) {
        if (!(await sailTo(page, hint.city))) { console.log(`[${name}] 到不了${hint.city}，跳过`); return 'fail'; }
    }
    if (!(await getPageText(page)).includes('你看到')) await backToMain(page);
    if (!(await walkByHint(page, hint, name))) {
        await page.screenshot({ path: `daily-walk-${name}.png` }).catch(() => {});
        return 'fail';
    }
    const cap = task.n === Infinity ? 24 : task.n * 8 + 8;
    let kills = 0;
    while (kills < cap) {
        const r = await pickAndFight(page, { type: task.type, target: drop, name });
        if (!r) { console.log(`[${name}] 这层没有掉${drop}的怪，停`); break; }
        kills++;
        if (kills % 4 === 0) {
            const lt = await openDailyList(page);
            const tag = (lt.match(new RegExp(`\\d+\\.\\s*[\\s\\S]{0,40}?${name}[\\s\\S]{0,60}?(已完成|可提交|进行中)`)) || [])[1];
            await backToMain(page);
            if (tag === '可提交' || tag === '已完成') { console.log(`[${name}] 列表已「${tag}」（${kills}杀）`); break; }
        }
    }
    console.log(`[${name}] 走图击杀 ${kills} 只`);
    await backToMain(page);
    await openDailyList(page);
    const fresh = await parseDailyTasks(page);
    const f = fresh.find(t => t.name === name);
    if (!f || (!f.full && !f.submitted)) { console.log(`[${name}] 走完仍未满，留到下轮`); return 'fail'; }
    if (f.submitted) { console.log(`[${name}] 已提交`); return 'done'; }
    const ok = await tryClaim(page, f);
    console.log(`[${name}] 提交${ok ? '成功' : '失败'}`);
    return ok ? 'done' : 'full-但未提交成功';
}

// 执行一条任务：导路 → 杀怪直到进度满（每杀1只查一次详情），带3倍保险上限
// 返回: 'done' | 'cap' | 'fail'
async function runTask(page, task) {
    // 你告知过固定走法的任务（铁矿石）：直接走图，不点寻路（游戏没给这条配目标地图，点了也弹提示白等）
    if (task.hint && task.hint.walk) return await runTaskByWalk(page, task, task.hint);
    const where = task.city ? `${task.city}·${task.area}` : '（无地点）';
    console.log(`[${task.name}] ${where} ${task.x}/${task.n}，点寻路...`);
    // 点任务行开详情（按行号，重试3次），确认出现「任务进度」再点寻路
    let opened = false;
    for (let r = 0; r < 3 && !opened; r++) {
        await clickRow(page, task.rowNo, task.name);
        await sleep(1500);
        opened = (await getPageText(page)).includes('任务进度');
    }
    if (!opened) {
        console.log(`[${task.name}] 点不开任务详情`);
        return 'fail';
    }
    // 寻路按钮在野区也能点（10-26 用户指出 + 真机复验：野区点寻路能正常弹提示/导航），
    // 所以「找不到寻路按钮」不是位置问题，而是详情页状态/坐标点击打偏 → 先合成事件再点，最后才回城兜底
    if (!(await clickExact(page, '寻路', 3000))) {
        // 满进度的详情页只有「提交」没有「寻路」→ 以前在这白试四轮（坐标点击/合成事件/重开详情/回城），
        // 每条浪费 30-60 秒（10-27 实证 boss2 偷盐贼·铁皮人、boss4 流浪犬·鸦片贩子各 2 条）。
        // 先查列表行标签：已经可提交就直接提交，已经完成就直接算完成。
        const tag0 = await listRowTag(page, task.rowNo, task.name).catch(() => null);
        if (tag0 === '已完成' || tag0 === '可提交') {
            console.log(`[${task.name}] 详情里没有寻路按钮，列表状态「${tag0}」→ 直接提交`);
            const ok0 = tag0 === '已完成' ? true : await tryClaim(page, task);
            return ok0 ? 'done' : 'full-但未提交成功';
        }
        console.log(`[${task.name}] 坐标点击没点到寻路（列表状态「${tag0 || '?'}」），改用合成事件重试...`);
        let clicked = await clickLeaf(page, '寻路');
        if (!clicked) {
            await page.screenshot({ path: `daily-xunlu-${task.name}.png` }).catch(() => {});
            await clickExact(page, '取消', 1500);
            await backToMain(page);
            await openDailyList(page);
            for (let r = 0; r < 3; r++) {
                await clickRow(page, task.rowNo, task.name);
                await sleep(1500);
                if ((await getPageText(page)).includes('任务进度')) break;
            }
            clicked = (await clickExact(page, '寻路', 3000)) || (await clickLeaf(page, '寻路'));
            // 最后兜底：回城（出航/传送只在城内，回到城内页面最干净）
            if (!clicked) {
                console.log(`[${task.name}] 重开详情仍点不到寻路，回城再试一次`);
                await clickExact(page, '取消', 1500);
                await backToMain(page);
                await backToCity(page);
                await openDailyList(page);
                for (let r = 0; r < 3; r++) {
                    await clickRow(page, task.rowNo, task.name);
                    await sleep(1500);
                    if ((await getPageText(page)).includes('任务进度')) break;
                }
                clicked = (await clickExact(page, '寻路', 3000)) || (await clickLeaf(page, '寻路'));
            }
        }
        if (!clicked) {
            console.log(`[${task.name}] 找不到寻路按钮（已试坐标点击/合成事件/重开详情/回城）`);
            await page.screenshot({ path: `daily-xunlu-fail-${task.name}.png` }).catch(() => {});
            await clickExact(page, '取消', 1500);
            return 'fail';
        }
        console.log(`[${task.name}] 寻路已触发`);
    }
    // 等自动走到野区：详情弹窗消失且页面有“你看到”
    // 城市不对会弹「只能寻路当前城市,请去再寻路吧」→ 点确定放弃该条（按城市聚合正常不会触发）
    let arrived = false;
    for (let w = 0; w < 15; w++) {
        await sleep(1000);
        const t = await getPageText(page);
        if (t.includes('只能寻路当前城市')) {
            console.log(`[${task.name}] 导路被拒（不在${task.city}），点确定跳过`);
            await clickExact(page, '确定', 2000);
            await sleep(800);
            await clickExact(page, '取消', 1500);
            return 'fail';
        }
        // 「当前任务条件没有目标地图，无法自动寻路」= 人不在任务所属的那座城（用户确认 + 任务.txt：
        // 「每日任务每个城市都可以点开，但任务条件可能分散在不同城市」），不是"任务做不了"
        if (t.includes('没有目标地图')) {
            console.log(`[${task.name}] 「没有目标地图」→ 当前城市不是它的任务城市，换城市再寻路`);
            await clickExact(page, '确定', 2000);
            await sleep(800);
            await clickExact(page, '取消', 1500);
            // 不做任何自动走图/自动推断：查不到城市就如实返回 nomap 交给上层换城，全试完就记下来放着，
            // 等用户告知该去哪座城打哪只怪（用户 10-26 定）。
            return 'nomap';
        }
        // 到达野区判据：只看「你看到：」到「当前城市/【聊天】」之间那段（wildSeg，天然屏蔽聊天刷屏）。
        // 城里那段是「你看到：传送出航」，野区那段是「你看到：经验妖灵」之类 → 用「不含出航」区分。
        // 不能用「当前城市」或「【城内地图】」判断：野区页面同样有这两个（farm-m4 实证）。
        const seg = wildSeg(t);
        // 补充判据（2026-10-28 coldwind2「泉州·码头 神秘人」实证）：
        // 有些任务点在**城内落点**（码头），出航到达后人物本身就在那儿，页面仍是城内视图、带「传送/出航」，
        // 靠「seg 不含出航」永远判不到（白等 15 秒）。所以「你看到」段里直接出现任务名 = 已到达。
        const nameInView = !!task.name && seg.includes(task.name);
        if ((seg && !t.includes('任务进度') && !seg.includes('出航')) || nameInView) {
            arrived = true;
            break;
        }
    }
    if (!arrived) {
        console.log(`[${task.name}] 导路后未到达野区`);
        return 'fail';
    }
    console.log(`[${task.name}] 已到${task.area}`);

    // 保险上限：杀怪类 3倍+3；材料类掉率约10%（盐矿实测18杀掉2），给8倍+8
    const cap = task.type === 'mat' ? task.n * 8 + 8 : task.n * 3 + 3;
    let kills = 0;
    let hopNo = 0; // 本层找不到目标怪时换相邻房间的次数（怪常驻，不靠刷新）
    while (kills < cap) {
        // 注意：这里**不再**用「页面出现任务已完成」直接收工。
        // toast 会滞留（且上一条任务的成功提示可能还在），是 10-27 boss2 劫匪 0 杀收工、
        // boss4 盐矿 2 杀收工的直接原因。完成与否只认「每杀一只查详情进度」和「列表行标签」。
        const result = await pickAndFight(page, task);
        if (!result) {
            // 野区的怪是**固定常驻、可无限打**的（用户 10-26 纠正：不是随机刷新、不会消失；
            // 只有副本才是杀一只少一只）→ 站在原地反复点「刷新」没有意义（反而会让页面短暂空白，
            // 被误判成"无怪"）→ 直接换相邻房间找目标怪，同片野区的房间来回轮换，走 8 次还没有就放弃。
            const t = await getPageText(page);
            const all = [...t.matchAll(/([东西南北])：([\u4e00-\u9fa5]{2,8})/g)]
                .map(m => ({ dir: m[1], place: m[2] }));
            const same = all.filter(e => e.place === task.area);
            const cands = same.length ? same : all;
            if (cands.length && hopNo < 8) {
                const e = cands[hopNo % cands.length];
                hopNo++;
                console.log(`[${task.name}] 本层没有目标怪（第${hopNo}次换房），往${e.dir}：${e.place}`);
                if (!(await clickLeaf(page, `${e.dir}：${e.place}`))) {
                    await clickLeaf(page, e.place);
                }
                await sleep(2200);
                continue;
            }
            console.log(`[${task.name}] 换房${hopNo}次仍无目标怪，页面快照:`, t.substring(0, 260).replace(/\s+/g, ' '));
            await page.screenshot({ path: `daily-nowild-${task.name}.png` }).catch(() => {});
            break;
        }
        kills++;
        const dropped = result.includes('已自动拾取');
        console.log(`[${task.name}] 第${kills}杀${dropped ? '（有掉落）' : ''}`);
        // 每杀1只查进度（收集类必须查；击杀类通常此时 toast 已出）
        // 查进度会进任务页，查完必须回野区，否则后续杀怪全空转（第10轮实测教训）
        const t = await openDailyList(page);
        let prog = await readTaskDetail(page, task.rowNo, task.name);
        if (!prog) {
            // 进度读不出来时，用列表行标签兜一层（标签才是权威判据）
            const tagSeg = (t.split(/(?<![0-9])(?=\d+\.\s*\(每日\))/).find(s => s.includes(`每日·${task.name}`) || s.includes(`每日・${task.name}`)) || '');
            const tg = (tagSeg.match(/已完成|可提交|进行中/) || [])[0];
            if (tg === '可提交' || tg === '已完成') prog = { x: task.n, n: task.n, full: true, tag: tg };
        }
        await backToMain(page);
        await sleep(800);
        if (prog) {
            if (prog.full) {
                console.log(`[${task.name}] 进度 ${prog.x}/${prog.n} 满，击杀${kills}只`);
                // 提交结果按列表标签核对（toast 不可信），没交上要如实记进汇总
                const ok = await tryClaim(page, task);
                return ok ? 'done' : `full-但未提交成功(${prog.x}/${prog.n})`;
            }
            task.x = prog.x;
        } else {
            // 查不到进度时只能靠击杀数兜底，**不再看「任务已完成」字样**（toast 会滞留）
            if (kills >= task.n) {
                console.log(`[${task.name}] 详情不可读，击杀${kills}只 ≥ 需求${task.n}，按列表标签核对后提交`);
                const ok = await tryClaim(page, task);
                return ok ? 'done' : 'full-但未提交成功(详情不可读)';
            }
        }
    }
    console.log(`[${task.name}] 达到保险上限${cap}杀仍未完成（掉率过低或解析异常）`);
    return 'cap';
}

// 进度满后提交任务：详情里点「提交」→ toast「提交成功获得：...」
// 提交后每日任务区会自动折叠（下次操作前 openDailyList 会重新展开）
// 详情页「提交」按钮的真实坐标（元素级检测，页面文本里的「可提交」标签会假阳性）
async function submitBtnPos(page) {
    return await page.evaluate(() => {
        for (const el of document.querySelectorAll('body *')) {
            const s = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (el.children.length === 0 && s === '提交' && r.width > 0 && r.height > 0) {
                return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            }
        }
        return null;
    }).catch(() => null);
}

// 读列表某行右列状态标签（已完成/可提交/进行中）—— 「提交到底成没成功」的唯一可靠判据
async function listRowTag(page, rowNo, name) {
    const txt = await openDailyList(page);
    const segs = txt.split(/(?<![0-9])(?=\d+\.\s*\(每日\))/).filter(s => /\(每日\)/.test(s));
    let byName = null;
    for (const seg of segs) {
        const m = seg.match(/^(\d+)\.\s*\(每日\)每日[·・]([\u4e00-\u9fa5]{2,8})/);
        if (!m) continue;
        const tag = (seg.match(/已完成|进行中|可提交/) || [null])[0];
        if (m[1] === rowNo && m[2] === name) return tag;
        if (m[2] === name && byName === null) byName = tag;   // 行号可能被滚动池改动，按名字兜底
    }
    return byName;
}

// 提交单个任务。成功判据 = 提交后列表行右列变「已完成」。
// 绝不能靠「提交成功获得：」toast 判断 —— 实测会读到上一个任务残留的 toast：
// 10-26 CI master：地魔卫士 16:28:05 提交成功 → 10 秒后鸦片贩子也「提交成功」，
// 但那个周期（开列表+点行+点提交+确认）最快也要 12 秒以上，且当天列表始终显示「可提交」。
async function tryClaim(page, task) {
    for (let att = 1; att <= 3; att++) {
        // 可能在野区/主页面（杀完怪回野区了），先开任务页再按行号点任务行
        await openDailyList(page);
        if (!(await clickRow(page, task.rowNo, task.name)) && !(await clickLeaf(page, task.name))) {
            console.log(`[${task.name}] 提交时点不开任务行`);
            return false;
        }
        await sleep(1400);
        const pos = await submitBtnPos(page);
        if (!pos) {
            const tag = await listRowTag(page, task.rowNo, task.name);
            console.log(`[${task.name}] 详情里没有提交按钮，列表状态: ${tag}`);
            return tag === '已完成';
        }
        await clickLeaf(page, '提交'); // 实测提交按钮真机点击无响应，只吃合成事件（探针实证）
        await sleep(1200);
        if (await submitBtnPos(page)) {
            // 合成事件没生效 → 真实坐标再点一次
            await page.mouse.click(pos.x, pos.y);
            await sleep(1400);
        }
        // 确认框（「确定」两法都试）
        for (let c = 0; c < 3; c++) {
            const t = await getPageText(page);
            if (!t.includes('确定')) break;
            await clickLeaf(page, '确定');
            await sleep(700);
            await clickExact(page, '确定', 1200);
            await sleep(600);
        }
        // 关详情弹窗（取消只吃合成事件的概率高，两法都试）
        await clickLeaf(page, '取消');
        await clickExact(page, '取消', 1500);
        await clickExact(page, '关闭', 1500);
        await sleep(1200);
        const tag = await listRowTag(page, task.rowNo, task.name);
        if (tag === '已完成') {
            console.log(`[${task.name}] 提交成功（列表已变「已完成」）`);
            return true;
        }
        console.log(`[${task.name}] 提交后列表仍是「${tag}」（第${att}次尝试），重开详情重试...`);
    }
    console.log(`[${task.name}] 提交失败：连续3次列表都没变「已完成」，截图存证`);
    await page.screenshot({ path: `daily-claim-${task.rowNo}.png` }).catch(() => {});
    return false;
}

// ---------- 寻路蜂补给 ----------
// 导路每次消耗寻路蜂×1（[绑]寻路蜂 与 寻路蜂 两种都可用）；不足会直接导路失败。
// 开跑前查包裹-道具，总量<20 就进商城热卖买 50 个（快速购买档）。

// 读包裹-道具页里寻路蜂总数量（两种求和）
async function beeCount(page) {
    if (!(await clickText(page, '包裹', 3000))) {
        console.log('找不到包裹入口');
        return -1;
    }
    await sleep(1500);
    await clickExact(page, '道具', 2000); // 包裹内页签：装备/药水/道具/宝盒/材料...
    await sleep(1500);
    const txt = await getPageText(page);
    let total = 0, m;
    const re = /寻路蜂\s*\(1级\)\s*数量：(\d+)/g;
    while ((m = re.exec(txt)) !== null) total += parseInt(m[1], 10);
    // 退出包裹页
    if (!(await clickExact(page, '返回', 1500))) await closePopup(page);
    await sleep(800);
    return total;
}

// 商城热卖页买 50 个寻路蜂
// 退出商城回主界面（**所有**失败分支都必须调用）
// 2026-10-29 coldwind8 实证：buyBees 在「没找到确认购买按钮」处直接 return false，
// 商城页留在原地 → 随后 beeCount 找不到「包裹」入口 → parseDailyTasks 折叠区打不开
// → 「没有可解析的每日任务」整轮 68 秒退出。前置步骤自己开的页面必须自己关。
async function leaveMall(page) {
    await clickExact(page, '取消', 1200);           // 关商品详情/二次确认，没弹窗时无所谓
    await sleep(500);
    if (!(await clickExact(page, '返回', 1500))) await closePopup(page);
    await sleep(800);
    let t = await getPageText(page);
    if (t.includes('商城') || t.includes('立即购买') || t.includes('确认购买')) {
        await page.keyboard.press('Escape');
        await sleep(600);
        t = await getPageText(page);
    }
    console.log(t.includes('当前城市') || t.includes('你看到')
        ? '已退出商城'
        : '退出商城未确认，页面: ' + t.replace(/\s+/g, ' ').substring(0, 80));
}

async function buyBees(page) {
    console.log('寻路蜂不足20，商城购买50个...');
    if (!(await clickText(page, '商城', 3000))) {
        console.log('找不到商城入口');
        return false;
    }
    await sleep(2000);
    // 热卖网格里点寻路蜂卡片（叶子按文本短者优先，会命中最内层「寻路蜂」）
    if (!(await clickLeaf(page, '寻路蜂'))) {
        console.log('商城热卖里没找到寻路蜂卡片');
        await leaveMall(page);
        return false;
    }
    await sleep(1000);
    if (!(await clickExact(page, '立即购买', 3000))) {
        console.log('没找到立即购买按钮');
        await leaveMall(page);
        return false;
    }
    await sleep(1000);
    // 商品详情弹窗：快速购买档「50个」→「确认购买」
    if (!(await clickExact(page, '50个', 3000))) {
        console.log('快速购买没找到「50个」档位');
        await leaveMall(page);
        return false;
    }
    await sleep(500);
    if (!(await clickExact(page, '确认购买', 3000))) {
        console.log('没找到确认购买按钮');
        await leaveMall(page);
        return false;
    }
    await sleep(500);
    if (!(await clickExact(page, '确认购买', 3000))) {
        console.log('没找到确认购买按钮');
        await leaveMall(page);
        return false;
    }
    await sleep(1200);
    // 成功信号：页面中间短暂弹「购买成功」toast（无确认框）
    const ok = (await getPageText(page)).includes('购买成功');
    console.log(ok ? '购买成功（toast确认）' : '已点确认购买但未见「购买成功」toast，以包裹复核为准');
    // 退出商城回主页（成功路径同样要走，否则后面读包裹/任务页全塌）
    await leaveMall(page);
    await sleep(1000);
    return ok;
}

// 主流程准备步：确保寻路蜂 ≥20；买完复核一遍
async function ensureBee(page) {
    let n = await beeCount(page);
    console.log(`包裹寻路蜂数量: ${n < 0 ? '读取失败' : n}`);
    if (n >= 20) return true;
    if (n >= 0) await buyBees(page);
    const n2 = await beeCount(page);
    console.log(`复核寻路蜂数量: ${n2 < 0 ? '读取失败' : n2}${n2 >= 20 ? '（充足）' : '（仍不足，导路可能失败，人工检查）'}`);
    return n2 >= 20;
}

// 页面是否已在主界面（城内/野外）
async function onMainPage(page) {
    const t = await getPageText(page);
    return t.includes('当前城市') || /你看到：/.test(t);
}

// 硬复位到主界面：任何前置步骤（商城/任务页/副本/玩法弹窗）留下的页面都会让后面整条链塌掉。
// 2026-10-29 coldwind8 就是停在商城页里一直往下跑。这里逐轮尝试，失败就如实报错退出，
// 不再「假装没事继续跑」——那样只会产出一堆看不懂的假失败。
async function ensureMainPage(page, maxTry = 4) {
    for (let i = 1; i <= maxTry; i++) {
        const t = await getPageText(page);
        if (t.includes('当前城市') || /你看到：/.test(t) || t.includes('你看到')) return true;

        // 人在副本里：先走统一恢复（能扫荡就扫荡、能领奖就领奖，没得领才退本）
        if (t.includes('副本条件') || (t.includes('退出副本') && t.includes('回到起点'))) {
            console.log('复位：人在副本里，先尝试把副本做完...');
            const r = await drain.recoverDungeon(page, { tag: '复位', screenshot: 'daily-dungeon-recover-fail.png' });
            if (!r.exited) console.log('复位：副本未能退出（', r.kind, '）');
            await sleep(2000);
            continue;
        }

        console.log(`复位：不在主界面（第${i}/${maxTry}次），当前页面: ${t.replace(/\s+/g, ' ').substring(0, 100)}`);
        // 商城/商品详情：先取消再返回
        if (t.includes('商城') || t.includes('立即购买') || t.includes('确认购买')) await leaveMall(page);
        else { await clickExact(page, '返回', 1500); await closePopup(page); }
        await page.keyboard.press('Escape');
        await sleep(1200);
    }
    return await onMainPage(page);
}

// 回到「城内主界面」（页面带「出航」「传送」链接的那一页）。
// 坑（2026-10-26 真机实证）：点「城内地图」只会弹出「选择目的地」列表，人不会移动！
//   正确做法是点页面自带的方位出口「南：★码头」；点完页面重新出现「出航」才算回城成功。
// 影响：10-26 CI 里 boss4 去泉州连续 3 次「海域标签东亚没点到」→ 走传送兜底，就是这里只做了半截。
async function backToCity(page, maxTry = 4) {
    for (let i = 0; i < maxTry; i++) {
        let t = await getPageText(page);
        if (t.includes('出航')) return true;
        // 目的地列表弹窗会吃掉坐标点击，先关掉
        if (t.includes('选择目的地')) {
            await page.mouse.click(10, 10);
            await page.keyboard.press('Escape');
            await sleep(800);
        }
        // 优先点带方位的码头出口（页面自带出口，点了真的会移动）
        const p = await page.evaluate(() => {
            const cands = [];
            for (const el of document.querySelectorAll('body *')) {
                if (el.children.length) continue;
                const s = (el.textContent || '').trim();
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height || !s || s.length > 10) continue;
                if (!/码头/.test(s)) continue;
                cands.push({
                    s, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                    directed: /^[东西南北][：:]/.test(s),
                });
            }
            cands.sort((a, b) => (b.directed ? 1 : 0) - (a.directed ? 1 : 0));
            return cands[0] || null;
        }).catch(() => null);
        if (p) {
            await page.mouse.click(p.x, p.y);
            await sleep(2500);
            t = await getPageText(page);
            if (t.includes('出航')) return true;
        }
        // 兜底：城内地图 → 目的地列表里的★码头（有概率生效，故放最后）
        if (await clickLeaf(page, '城内地图')) {
            await sleep(2000);
            await clickLeaf(page, '★码头');
            await sleep(2200);
            if ((await getPageText(page)).includes('出航')) return true;
        } else {
            await page.keyboard.press('Escape');
            await sleep(900);
        }
    }
    const ok = (await getPageText(page)).includes('出航');
    if (!ok) console.log('回城失败：多次尝试后仍无「出航」入口（后续出航大概率失败）');
    return ok;
}

// 关掉任务页等二级页面回主界面（二级页左上角是 uni-page-head 返回箭头图标，无文本；
// 探针实证：DIV.uni-page-head-hd > I.uni-btn-icon @ (5,7,27x27)。Escape/遮罩无效）
async function backToMain(page) {
    for (let i = 0; i < 5; i++) {
        if (await onMainPage(page)) return true;
        const box = await page.evaluate(() => {
            const el = document.querySelector('.uni-page-head .uni-btn-icon') ||
                       document.querySelector('.uni-page-head-hd');
            if (el) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
            return null;
        });
        if (box) await page.mouse.click(box.x, box.y).catch(() => {});
        else await page.keyboard.press('Escape');
        await sleep(1200);
    }
    return await onMainPage(page);
}

// 自检：重开任务列表逐行核对状态标签与进度（完成后必须自检，防漏做/漏提交）
async function selfCheck(page) {
    await sleep(3000);   // 提交后列表状态有延迟刷新，先等一会儿再核对
    const txt = await openDailyList(page);
    const segs = txt.split(/(?<![0-9])(?=\d+\.\s*\(每日\))/).filter(s => /\(每日\)/.test(s));
    let done = 0, total = 0;
    const unfinished = [];
    console.log('==== 每日任务自检 ====');
    for (const seg of segs) {
        const m = seg.match(/^(\d+)\.\s*\(每日\)每日[·・]([\u4e00-\u9fa5]{2,8})/);
        if (!m) continue;
        total++;
        const cnt = seg.match(/(\d+\s*\/\s*\d+)/);
        let tag = (seg.match(/已完成|进行中|可提交/) || ['?'])[0];
        // 补救提交：仍显示「可提交」= 汇总阶段没交上（10-26 用户截图实证：master 鸦片贩子跑完仍是
        // 「可提交」9/10，之前误以为是「列表刷新滞后的自检误报」，实际是根本没提交成功）
        if (tag === '可提交') {
            console.log(`  [自检补救] ${m[1]}.${m[2]} 仍显示可提交，补提交一次...`);
            const claimed = await tryClaim(page, { rowNo: Number(m[1]), name: m[2] }).catch(() => false);
            if (claimed) {
                await sleep(2500);
                const t2 = await openDailyList(page);
                const seg2 = t2.split(/(?<![0-9])(?=\d+\.\s*\(每日\))/)
                    .find(s => s.startsWith(`${m[1]}.`) && s.includes(m[2]));
                if (seg2) tag = (seg2.match(/已完成|进行中|可提交/) || ['?'])[0];
            }
        }
        if (tag === '已完成') done++;
        else unfinished.push(`${m[1]}.${m[2]}(${cnt ? cnt[1].replace(/\s/g, '') : '/'} ${tag})`);
        console.log(`  ${m[1]}. ${m[2]} | ${cnt ? cnt[1].replace(/\s/g, '') : '/'} | ${tag}`);
    }
    console.log(`自检结果: ${done}/${total} 已完成${unfinished.length ? '，未完成: ' + unfinished.join('、') : '，全部完成 ✅'}`);
    return { done, total };
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
                continue;
            }
            await inputs[0].fill(ACCOUNT);
            await inputs[1].fill(PASSWORD);
            await page.getByText('登录').first().click();
            await sleep(3000);
            console.log(`登录尝试${attempt + 1}`);
            const pageText = await getPageText(page);
            if (pageText.includes('进入游戏') || pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('登录成功');
                break;
            }
            await sleep(2000);
        }

        for (let i = 0; i < 10; i++) {
            await clickText(page, '进入游戏');
            await sleep(5000);
            const pageText = await getPageText(page);
            if (pageText.includes('你看到') || pageText.includes('当前城市')) {
                console.log('进入游戏成功');
                break;
            }
            await sleep(2000);
        }

        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);

        // 0. 寻路蜂补给（导路消耗品，<20 买50个；DRY 模式只查不买）
        const beeN = await beeCount(page);
        if (DRY) {
            console.log(`[DRY] 包裹寻路蜂数量: ${beeN < 0 ? '读取失败' : beeN}`);
        } else if (beeN < 20) {
            await ensureBee(page);
        } else {
            console.log(`寻路蜂充足: ${beeN}`);
        }

        // 0.5 硬复位到主界面：寻路蜂检查/购买可能把页面留在商城，
        // 后面 parseDailyTasks 要在主界面点「任务」入口，页面不对就必然失败（10-29 coldwind8）。
        if (!(await ensureMainPage(page))) {
            console.log('页面无法回到主界面，退出避免假失败');
            await page.screenshot({ path: 'daily-mainpage-fail.png' }).catch(() => {});
            await browser.close();
            return;
        }

        // 1. 解析每日任务
        const tasks = await parseDailyTasks(page);
        if (!tasks.length) {
            console.log('没有可解析的每日任务，退出');
            await browser.close();
            return;
        }
        // 关闭任务页回主界面再读当前城市（任务页上没有「当前城市」文本）
        await closePopup(page);
        await sleep(1000);
        const here = await currentCity(page);
        console.log('每日任务解析结果:');
        for (const t of tasks) {
            const prog = t.n === Infinity ? `${t.x}/?` : `${t.x}/${t.n}`;
            const tag = t.submitted ? '✓已提交' : t.full ? '✓可提交' : '□';
            console.log(`  ${tag} ${t.name} | ${t.city ? `${t.city}·${t.area}` : '（无地点）'} | ${prog}`);
        }

        // DRY 只读模式在此收尾：解析、计划、可提交清单都打印，绝不提交/杀怪/出航/购买
        if (DRY) {
            const willSubmit = tasks.filter(t => t.full && !t.submitted).map(t => t.name);
            console.log(`[DRY] 可提交清单: ${willSubmit.join('、') || '（无）'}`);
            console.log('DRY 模式：只解析不执行');
            await browser.close();
            return;
        }

        // 2-4. 提交与执行循环：提交后列表会滚出新任务实例，循环处理直到无新任务（最多3轮）
        // attempted 按 行号+名字 记录已尝试的进行中任务：cap 后不在本轮内反复死磕
        const attempted = new Set();
        const results = [];
        // 无地点任务 逐城试探记录：key = 行号+名字@城市，避免同一座城反复试
        const noCityTried = new Set();
        const unmatchedCities = new Map(); // 任务key -> [试过的城市]
        for (let round = 1; round <= 3; round++) {
            const curTasks = round === 1 ? tasks : await parseDailyTasks(page);
            if (!curTasks.length) break;
            if (round > 1) {
                console.log(`---- 第${round}轮（滚动池新实例）----`);
                for (const t of curTasks) {
                    const prog = t.n === Infinity ? `${t.x}/?` : `${t.x}/${t.n}`;
                    const tag = t.submitted ? '✓已提交' : t.full ? '✓可提交' : '□';
                    console.log(`  ${tag} ${t.rowNo}.${t.name} | ${t.city ? `${t.city}·${t.area}` : '（无地点）'} | ${prog}`);
                }
            }
            // 集中提交「可提交」态
            for (const t of curTasks.filter(t => t.full && !t.submitted)) {
                await openDailyList(page);
                const claimed = await tryClaim(page, t);
                // 前面 runTask 可能把这行判成 fail（如「找不到寻路按钮」），但这里提交成功就应改记为成功，
                // 否则汇总里留个 fail 误导排查
                const key = `${t.rowNo}.${t.name}`;
                const idx = results.findIndex(r => r.startsWith(key + ':'));
                if (claimed) {
                    if (idx >= 0) results[idx] = `${key}: 提交成功（收尾补交）`;
                    else results.push(`${key}: 提交成功（收尾补交）`);
                }
            }
            // 执行「进行中」且未尝试过的
            const pending = curTasks.filter(t => !t.full && !attempted.has(t.rowNo + t.name));
            if (!pending.length) break;
            // 无「城市·野区」信息的任务（铁矿石这类收集类）：详情文本里没有城市，但游戏是靠
            // 「你当前所在城市」决定能不能寻路的（用户：弹「没有目标地图」只说明不在任务所属城市）。
            // 只认用户口头告知过的城市（MANUAL_HINTS），没告知过的就在当前城试一次，仍不通就记下来放着。
            const noCity = pending.filter(t => !t.city);
            const hereNow = round === 1 ? here : await currentCity(page);
            const noCityCity = new Map(); // 任务key -> 用户告知的城市
            for (const t of noCity) {
                const prog = t.n === Infinity ? `${t.x}/?` : `${t.x}/${t.n}`;
                const hit = locateTask(t);
                if (hit) {
                    noCityCity.set(t.rowNo + t.name, hit.city);
                    t.hint = hit;   // 带 walk 的走图执行；不带的仍只是去该城再试一次寻路
                    console.log(`  [无地点] ${t.rowNo}.${t.name} ${prog}：你告知过「${hit.monster}掉落」→ ${hit.walk ? '按告知的走法走图' : '去' + hit.city + '再点寻路'}`);
                } else {
                    console.log(`  [无地点] ${t.rowNo}.${t.name} ${prog}：无「城市·野区」，也没告知过任务城市 → 只在当前城试一次寻路，不通就记着等你告知`);
                }
            }
            const routable = pending.filter(t => t.city);
            const cityOrder = [];
            // 表里定位到的城市优先（别再一座座试——出航烧铜贝、传送烧银币）
            for (const c of noCityCity.values()) {
                if (!cityOrder.includes(c)) cityOrder.push(c);
            }
            for (const t of routable) {
                if (!cityOrder.includes(t.city)) cityOrder.push(t.city);
            }
            cityOrder.sort((a, b) => (a === hereNow ? -1 : 0) - (b === hereNow ? -1 : 0));
            // 只有无地点任务时 cityOrder 为空 → 把当前城市排进去，好在本地试一次寻路
            if (noCity.length && hereNow && !cityOrder.includes(hereNow)) cityOrder.push(hereNow);
            if (cityOrder.length) {
                console.log(`第${round}轮执行计划（城市顺序）:`, cityOrder.join(' → '), `| 当前所在: ${hereNow}`);
            }
            // 逐城逐任务执行
            for (const city of cityOrder) {
                // 当前城市判断带重试：任务页/弹窗残留会吃掉「当前城市」文本，先关页再读
                let cur = await currentCity(page);
                if (cur !== city) {
                    await backToMain(page);
                    cur = await currentCity(page);
                }
                if (cur !== city) {
                    let ok = await sailTo(page, city);
                    if (!ok && sailFailReason() === 'nomap') {
                        console.log(`${city} 暂无地图（该号没有这张图），跳过该城任务，不传送`);
                    } else if (!ok) {
                        ok = await teleportToDest(page, city);
                    }
                    if (!ok || (await currentCity(page)) !== city) {
                        console.log(`到不了${city}，该城任务跳过`);
                        for (const t of routable.filter(t => t.city === city)) {
                            results.push(`${t.rowNo}.${t.name}: 到不了城市`);
                            attempted.add(t.rowNo + t.name);
                        }
                        // 无地点任务如果被告知的就是这座城，也要如实记账，别在汇总里静默消失
                        for (const t of noCity) {
                            if (noCityCity.get(`${t.rowNo}.${t.name}`) === city) {
                                results.push(`${t.rowNo}.${t.name}: 到不了城市(${city})，等你告知`);
                                attempted.add(t.rowNo + t.name);
                            }
                        }
                        continue;
                    }
                }
                for (const t of routable.filter(t => t.city === city)) {
                    // 只关掉二级页，不用回城 —— 寻路在野区照样能点（用户确认 + 真机复验）
                    await backToMain(page);
                    await openDailyList(page);
                    const r = await runTask(page, t);
                    if (r === 'nomap') {
                        // 已按城市聚合还弹这个 = 城市状态没对齐（航行中/页面残留），本轮不判死，留到下一轮
                        console.log(`${t.name}: ${city} 下仍提示没有目标地图，本轮跳过，下轮再看`);
                        results.push(`${t.rowNo}.${t.name}: 城市未对齐(${city})`);
                        continue;
                    }
                    results.push(`${t.rowNo}.${t.name}: ${r}`);
                    attempted.add(t.rowNo + t.name);
                }
                // 无地点任务：告知过城市 → 只在那座城试；没告知过 → 只在当前城试一次（不乱跑，省铜贝）
                for (const t of noCity) {
                    if (attempted.has(t.rowNo + t.name)) continue;
                    if ((await currentCity(page)) !== city) break;
                    // key 必须和 noCityCity / attempted 保持一致（都是 rowNo+name，不带点）：
                    // 原来这里写成 `${rowNo}.${name}`，导致 tellCity 永远取不到、attempted 判断也永远不命中，
                    // 收尾还会把已经完成的任务误报成「未完成·等你告知城市」（2026-10-28 铁矿石走图成功后才暴露）。
                    const tk = t.rowNo + t.name;
                    const tellCity = noCityCity.get(tk);
                    if (tellCity && tellCity !== city) continue;
                    // 没告知过城市的任务只在当前城试一次，不通就放着，不跨城空跑（出航烧铜贝）
                    if (!tellCity && [...noCityTried].some(k => k.startsWith(tk + '@'))) continue;
                    if (noCityTried.has(`${tk}@${city}`)) continue;
                    noCityTried.add(`${tk}@${city}`);
                    if (!unmatchedCities.has(tk)) unmatchedCities.set(tk, []);
                    unmatchedCities.get(tk).push(city);
                    await backToMain(page);
                    await openDailyList(page);
                    const r = await runTask(page, t);
                    if (r === 'nomap') {
                        console.log(`  ${t.name}: ${city} 不是它的任务城市（试过 ${unmatchedCities.get(tk).join('/')}），换下一城`);
                        continue;
                    }
                    results.push(`${t.rowNo}.${t.name}: ${r}(在${city}寻路)`);
                    attempted.add(t.rowNo + t.name);
                }
            }
        }
        // 无地点任务收尾：寻路全不通 → 如实记录放着，等用户告知去哪座城打哪只怪
        for (const [tk, cities] of unmatchedCities) {
            if (attempted.has(tk)) continue;
            console.log(`  ${tk}: 试过 ${cities.length} 座城均无目标地图（${cities.join('/')}），跳过——等你告知该去哪座城打哪只怪`);
            results.push(`${tk}: 未完成·寻路无目标地图（试过 ${cities.join('/')}），等你告知城市`);
        }

        console.log('==== 每日任务执行汇总 ====');
        for (const r of results) console.log(' ', r);
        // 自检：逐行核对任务列表状态（防漏做/漏提交）
        await selfCheck(page);
    } catch (e) {
        console.error('错误:', e.message);
        await page.screenshot({ path: 'daily-error.png' }).catch(() => {});
    } finally {
        await browser.close();
    }
}

// 独立运行（CI/命令行）走完整流程；被 probe require 时只取函数
if (require.main === module) run();

module.exports = {
    sleep, gotoGame, getPageText, clickText, clickLeaf, clickExact,
    selectRegion, sailTo, sailFailReason, currentCity,
    openDailyList, parseDailyTasks, clickRow, atCity, onMainPage, backToMain, backToCity,
    selfCheck, tryClaim, runTask, listRowTag, submitBtnPos,
    locateTask, MANUAL_HINTS,
    // 下面几个只为探针/手动补跑导出（daily.js 自身流程不依赖外部调用）
    readTaskDetail, listMonsters, monsterDrops, fightMonster, pickAndFight, wildSeg,
};
