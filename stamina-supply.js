// 体力宝补给（2026-11-20 用户要求）
//
// 用户原话：「每天 0:00 的任务在威尼斯钓鱼的时候可以顺便检查背包，
//   小体力宝及体力宝总数是否为 10 个，不足就按照我截图的位置去购买补足到 10 个，
//   因为买小体力宝城市和钓鱼城市都在威尼斯，不绕路」
//
// 路线（截图实证，2026-11-20 冷8 探针跑通）：
//   码头 →「城内地图」→ 目的地列表「商店」→ 走到商店 →「你看到：商人 / 商人李 / 威尼斯商人 / 杂货商人」
//   → 点「商人」→ 商店页（格子 + 底部「[绑]小体力宝 (1级) 价格：50 银贝 / 立即购买」）
//   → 点格子 →「立即购买」→「商品详情」弹窗（快速购买 1/3/5/10/50 个 + 数字输入框 + 确认购买）
//   → 填差额 →「确认购买」
//
// 读数（背包药水页，列表视图）：
//   `[绑]体力宝(1级) 数量：41` / `[绑]小体力宝(1级) 数量：45` / `体力宝(1级) 数量：9`
//   总数 = 所有含「体力宝」的条目之和（含 [绑] 与非绑，体力宝 + 小体力宝）。
//   网格视图没有「数量：N」→ 必须先点「列表」。
//
// 铁律：
//   · 只买「小体力宝」（50 银贝/个），不碰其他商品；
//   · 总数已 ≥ 10 → 一个都不买（这是每天 0:00 固定检查，买多了纯浪费银贝）；
//   · 任何一步失败只告警，绝不拦钓鱼（钓鱼是主任务，补给是顺路）；
//   · 数量读不到 → 按 0 处理买满 10 个（用户 22:45：「就算没读到请假设就没有药水了」），
//     同时打 ::warning:: 说明是读数失败，别把 bug 当常态。
const drain = require('./dungeon-recover.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAMINA_TARGET = 10;
const STAMINA_ITEM = '小体力宝';
const SHOP_CITY = '威尼斯';

function createStaminaSupply({ log = console.log } = {}) {
    const txt = async (page) => drain.visibleText(page);
    const flat = (s) => (s || '').replace(/\s+/g, '');
    // 测试/临时调整用：STAMINA_TARGET_OVERRIDE=98 可把目标改成 98（验证购买路径，不花大钱）
    const target = Number(process.env.STAMINA_TARGET_OVERRIDE) > 0
        ? Number(process.env.STAMINA_TARGET_OVERRIDE) : STAMINA_TARGET;
    const targetSrc = target === STAMINA_TARGET ? '' : `（STAMINA_TARGET_OVERRIDE=${target}）`;

    // 精确点一个文本叶子（合成事件，能穿透残留遮罩）
    async function tapLeaf(page, label, { exact = true, yMin = 0, yMax = 99999 } = {}) {
        const hit = await page.evaluate(({ l, ex, y0, y1 }) => {
            const out = [];
            for (const el of document.querySelectorAll('body *')) {
                if (el.children.length) continue;
                const s = (el.textContent || '').trim();
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                if (r.y < Math.max(0, y0) || r.y > Math.min(window.innerHeight, y1)) continue;
                if (ex ? s !== l : !s.includes(l)) continue;
                out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), s });
            }
            return out[0] || null;
        }, { l: label, ex: exact, y0: yMin, y1: yMax }).catch(() => null);
        if (!hit) { log(`  [补给] 没有「${label}」可点`); return false; }
        await page.mouse.click(hit.x, hit.y).catch(() => { });
        log(`  [补给] 点「${label}」(${hit.x},${hit.y})`);
        return true;
    }

    // 背包还开着？（网格/列表都认：页签组 包裹 + 装备…药水 / 材料…宝石）
    const bagOpen = (s) => /包裹[\s\S]{0,40}(装备[\s\S]{0,10}药水|材料[\s\S]{0,10}宝石)/.test(flat(s));

    // 读「体力宝 + 小体力宝」总数。返回 { total, rows } 或 null（没打开包裹/读不到数量）
    async function readStock(page) {
        let opened = false;
        try {
            // 底部导航常在视口外：先滚到中部（bag-read 同款坑）
            await page.mouse.wheel(0, 800).catch(() => { });
            await sleep(1000);
            const bagPos = await page.evaluate(() => {
                for (const el of document.querySelectorAll('body *')) {
                    if (el.children.length) continue;
                    if ((el.textContent || '').trim() !== '包裹' && (el.textContent || '').trim() !== '背包') continue;
                    const r = el.getBoundingClientRect();
                    if (!r.width || !r.height || r.y < 0 || r.y > window.innerHeight) continue;
                    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
                }
                return null;
            }).catch(() => null);
            if (!bagPos) { log('  [补给] 底部找不到「包裹」，读不到药量'); return null; }
            await page.mouse.click(bagPos.x, bagPos.y).catch(() => { });
            await sleep(2600);
            let t = await txt(page);
            if (!bagOpen(t)) { log('  [补给] 包裹没打开'); return null; }
            opened = true;

            // 药水页
            await tapLeaf(page, '药水', { exact: true });
            await sleep(1600);
            t = await txt(page);
            if (!/体力宝|万能药|奶瓶/.test(t)) {
                log('  [补给] 没切到药水页，重试点一次');
                await tapLeaf(page, '药水', { exact: true });
                await sleep(1600);
            }
            // 列表视图：网格没有「数量：N」（11-19 那次就是被网格坑了）
            if (!/数量\s*[:：]\s*\d/.test(t)) {
                await tapLeaf(page, '列表', { exact: true });
                await sleep(1400);
                t = await txt(page);
            }

            const rows = await page.evaluate(() => {
                const out = [];
                for (const el of document.querySelectorAll('body *')) {
                    if (el.children.length) continue;
                    const s = (el.textContent || '').trim();
                    if (!s.includes('体力宝') || s.length > 30) continue;
                    let node = el, q = null;
                    for (let up = 0; up < 7 && node; up++) {
                        const m = (node.textContent || '').match(/数量\s*[:：]\s*(\d+)/);
                        if (m) { q = Number(m[1]); break; }
                        node = node.parentElement;
                    }
                    if (q !== null) out.push({ name: s, qty: q });
                }
                return out;
            }).catch(() => []);
            if (!rows.length) {
                log('  [补给] 列表里读不到任何「体力宝」条目（可能是空背包或视图仍不对）');
                return null;
            }
            const total = rows.reduce((a, r) => a + r.qty, 0);
            log(`  [补给] 背包：${rows.map((r) => `${r.name}=${r.qty}`).join(' / ')} → 合计 ${total}`);
            return { total, rows };
        } catch (e) {
            log(`  [补给] 读数异常（${e.message}）`);
            return null;
        } finally {
            if (opened) {
                await page.keyboard.press('Escape').catch(() => { });
                await sleep(1200);
                let t2 = await txt(page);
                if (bagOpen(t2)) {
                    await page.mouse.click(14, 26).catch(() => { });
                    await sleep(1000);
                    t2 = await txt(page);
                    if (bagOpen(t2)) log('  [补给] ::warning::包裹没关掉');
                }
            }
        }
    }

    // 码头/主视图 → 城内地图 → 商店 → 商人 → 商店页
    async function gotoShop(page) {
        let t = await txt(page);
        if (!t.includes(`当前城市：${SHOP_CITY}`)) {
            log(`  [补给] 当前不在${SHOP_CITY}，跳过购买`);
            return false;
        }
        // 已在商店页（出现「商人：欢迎光临」/「立即购买」）就不用重走
        if (/商人[：:]\s*欢迎光临/.test(t) || /立即购买/.test(t)) return true;

        // 商人 NPC 已经在当前视图（商店门口）→ 直接点商人
        if (/你看到[\s\S]{0,80}商人/.test(t)) {
            await tapLeaf(page, '商人', { exact: true, yMin: 80 });
            for (let i = 0; i < 8; i++) {
                await sleep(1000);
                if (/商人[：:]\s*欢迎光临|立即购买/.test(await txt(page))) return true;
            }
        }

        // 城内地图：点开后必须出现「选择目的地」，否则重试（页面半渲染时点了没反应）
        for (let round = 1; round <= 3; round++) {
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
            await sleep(700);
            await tapLeaf(page, '城内地图', { exact: false });
            let opened = false;
            for (let w = 0; w < 6; w++) {
                await sleep(800);
                if ((await txt(page)).includes('选择目的地')) { opened = true; break; }
            }
            if (!opened) { log(`  [补给] 城内地图没打开（第${round}次），重试`); continue; }

            // 目的地列表 → 商店
            await tapLeaf(page, '商店', { exact: true });
            for (let w = 0; w < 10; w++) {
                await sleep(1000);
                if (/你看到[\s\S]{0,80}商人/.test(await txt(page))) break;
            }
            t = await txt(page);
            // 走到商店后点商人开商店 UI
            if (/你看到[\s\S]{0,80}商人/.test(t)) {
                await tapLeaf(page, '商人', { exact: true, yMin: 80 });
                for (let w = 0; w < 8; w++) {
                    await sleep(1000);
                    if (/商人[：:]\s*欢迎光临|立即购买/.test(await txt(page))) return true;
                }
                // 兜底：部分城市商人叫「杂货商人」
                await tapLeaf(page, '杂货商人', { exact: true, yMin: 80 });
                await sleep(2000);
                if (/商人[：:]\s*欢迎光临|立即购买/.test(await txt(page))) return true;
            }
            log(`  [补给] 第${round}次没走到商店（页面文本：${(await txt(page)).replace(/\s+/g, ' ').slice(0, 100)}）`);
        }
        return false;
    }

    // 在商店页点「小体力宝」格子 → 底部出现「立即购买」
    async function pickStaminaCell(page) {
        const cell = await page.evaluate(() => {
            let best = null;
            for (const el of document.querySelectorAll('body *')) {
                const s = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!s.includes('体力宝') || s.length > 24) continue;
                let node = el;
                for (let up = 0; up < 5 && node; up++) {
                    const r = node.getBoundingClientRect();
                    if (r.width > 120 && r.height > 100) {
                        const area = r.width * r.height;
                        if (!best || area < best.area) {
                            best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area, s };
                        }
                        break;
                    }
                    node = node.parentElement;
                }
            }
            return best;
        }).catch(() => null);
        if (!cell) { log('  [补给] 商店里没找到「小体力宝」格子'); return false; }
        await page.mouse.click(cell.x, cell.y).catch(() => { });
        await sleep(1800);
        log(`  [补给] 选中格子「${cell.s}」(${cell.x},${cell.y})`);
        return /立即购买/.test(await txt(page));
    }

    // 立即购买 → 商品详情 → 填数量 → 确认购买
    async function buy(page, need) {
        if (!(await tapLeaf(page, '立即购买', { exact: true }))) return { ok: false, reason: 'no-buy-btn' };
        let t = '';
        for (let i = 0; i < 6; i++) {
            await sleep(1000);
            t = await txt(page);
            if (t.includes('商品详情') && t.includes('确认购买')) break;
        }
        if (!t.includes('确认购买')) {
            log('  [补给] 「立即购买」点了但商品详情弹窗没出来');
            return { ok: false, reason: 'no-dialog' };
        }
        // 填数量（弹窗里唯一的数字输入框）
        const inputs = await page.$$('input');
        let filled = false;
        for (const inp of inputs) {
            if (await inp.isVisible().catch(() => false)) {
                await inp.fill(String(need)).catch(() => { });
                filled = true;
            }
        }
        log(`  [补给] 购买数量填 ${need} → ${filled ? 'ok' : '未找到输入框'}`);
        if (!(await tapLeaf(page, '确认购买', { exact: true }))) return { ok: false, reason: 'no-confirm-btn' };
        await sleep(2200);
        t = await txt(page);
        if (t.includes('确认购买') || t.includes('商品详情')) {
            log('  [补给] 确认购买后弹窗仍在（可能银贝不足）');
            return { ok: false, reason: 'dialog-still-open' };
        }
        return { ok: true, reason: '' };
    }

    // 退出商店页回城内视图（左上返回箭头 / 类名返回 / Escape 逐级兜底）
    async function exitShop(page) {
        for (let i = 0; i < 5; i++) {
            const t = await txt(page);
            if (t.includes('当前城市') && t.includes('城内地图')) return true;
            await page.mouse.click(24, 30).catch(() => { });
            await sleep(1200);
            let t2 = await txt(page);
            if (t2.includes('当前城市') && t2.includes('城内地图')) return true;
            await page.evaluate(() => {
                const c = document.querySelector('.van-nav-bar__arrow, .van-icon-arrow-left, [class*="back"]');
                if (c) c.click();
            }).catch(() => { });
            await sleep(1200);
            t2 = await txt(page);
            if (t2.includes('当前城市') && t2.includes('城内地图')) return true;
            await page.keyboard.press('Escape').catch(() => { });
            await sleep(900);
        }
        return /当前城市/.test(await txt(page));
    }

    // 回码头（先退商店页 → 城内地图 → ★码头）
    async function backToDockByMap(page) {
        await exitShop(page);
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
        await sleep(700);
        if (!(await tapLeaf(page, '城内地图', { exact: false }))) return false;
        let okMap = false;
        for (let w = 0; w < 6; w++) {
            await sleep(800);
            if ((await txt(page)).includes('选择目的地')) { okMap = true; break; }
        }
        if (!okMap) return false;
        await tapLeaf(page, '码头', { exact: false });
        for (let w = 0; w < 10; w++) {
            await sleep(1000);
            if (/鱼老板/.test(await txt(page))) return true;
        }
        return false;
    }

    // 主入口：不足 10 个就买，返回 { totalBefore, totalAfter, need, bought, ok, reason }
    async function ensureStaminaStock(page) {
        const r = { totalBefore: null, totalAfter: null, need: 0, bought: 0, ok: false, reason: '' };
        try {
            const before = await readStock(page);
            if (before) r.totalBefore = before.total;
            else log('  [补给] ::warning::体力宝数量读取失败 → 按 0 处理（用户 22:45：就算没读到请假设就没有药水了）');
            const total = before ? before.total : 0;
            if (total >= target) {
                log(`  [补给] 体力宝共 ${total} 个 ≥ ${target}${targetSrc}，不购买`);
                r.totalAfter = total;      // 没买，前后一致（别在日志里显示 null 让人以为没读到）
                r.ok = true; r.reason = 'enough';
                return r;
            }
            r.need = target - total;
            log(`  [补给] 体力宝共 ${total} 个，差 ${r.need} 个 → 去${SHOP_CITY}商店买${STAMINA_ITEM}`);

            if (!(await gotoShop(page))) { r.reason = 'no-shop'; return r; }
            if (!(await pickStaminaCell(page))) { r.reason = 'no-item-cell'; return r; }
            const b = await buy(page, r.need);
            if (!b.ok) { r.reason = b.reason; return r; }
            r.bought = r.need;
            log(`  [补给] 已购买 ${STAMINA_ITEM} ×${r.need}（${r.need * 50} 银贝）`);
            await sleep(1500);

            // 回码头 + 复核数量（买了没到账 = 白买，必须看见）
            if (!(await backToDockByMap(page))) log('  [补给] 城内地图回码头失败，交给上层 ensureDock');
            const after = await readStock(page);
            r.totalAfter = after ? after.total : null;
            if (after && after.total >= target) {
                log(`  [补给] 复核：体力宝合计 ${after.total} 个 ✔`);
                r.ok = true;
            } else if (after) {
                log(`  [补给] ::warning::买完复核仍是 ${after.total} 个（期望 ≥ ${target}）`);
                r.reason = 'verify-low';
            } else {
                log('  [补给] ::warning::买完读不到数量，无法复核');
                r.reason = 'verify-unreadable';
            }
            return r;
        } catch (e) {
            log(`  [补给] 异常（${e.message}）→ 交给钓鱼流程继续`);
            r.reason = 'exception';
            return r;
        }
    }

    return { ensureStaminaStock, readStock, gotoShop, pickStaminaCell, buy, backToDockByMap, exitShop };
}

module.exports = { createStaminaSupply, STAMINA_TARGET, STAMINA_ITEM, SHOP_CITY };
