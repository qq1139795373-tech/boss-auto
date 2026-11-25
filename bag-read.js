// 包裹读数（领奖对账用）—— 所有副本脚本共用这一份实现（2026-11-19 统一）
//
// 为什么抽出来：kidd.js / hdwang-local/hdwang-batch.js / bymj-local/bymj-batch.js 原本各写一套，
// 结果同一批坑反复踩、修一处漏两处：
//   · kidd 已经改成「网格 + CDP 触摸滑动 + 两种数量格式 + 关包裹判据」，
//   · hdwang 慢了一拍（没超时、关包裹无条件乱点），
//   · bymj 还停在最早那版（mouse.wheel 滚不动 → 只读第一屏 → 奔月箱读到 0 的假读数）。
// 现在只有这一份，三个脚本注入各自的 getPageText 即可。
//
// 硬规则（都是 11-19 实测换来的）：
//   ① 点完页签立刻读 → 读到上一个页签的内容（0→0 假读数的根因）→ 必须等页面文本真的变化；
//   ② page.mouse.wheel / 鼠标拖拽 / PageDown / End 都滚不动包裹列表（文本一直 327 字），
//      只有 CDP 触摸滑动生效（一次到底，页尾出现「已加载全部数据」）；
//   ③ 目标物品常在材料页**最下方** → 先切「网格」视图（一屏 12~16 格，滚动次数减半）；
//   ④ 数量有两种 DOM 形态：列表「数量：243」、网格右下角纯数字角标 → 两种都认；
//   ⑤ page.evaluate 不受 setDefaultTimeout 约束，渲染进程一忙就无限等 → 全程 Promise.race 硬超时；
//   ⑥ 数量为 0 时背包里根本没有这个条目 → 读不到返回 null（调用方按 0 参与差值计算）。
//
// 用法：
//   const { createBagReader } = require('./bag-read.js');
//   const bag = createBagReader({ getPageText, log: console.log });
//   const before = await bag.readBagItems(page, ['浴火之蝶', '藏宝图碎片']);
const evTo = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate-timeout')), ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页签组特征：用来判断「包裹还开着」。网格视图没有「使用」按钮（只有数字角标），
// 所以不能用 includes('使用')，只能用「包裹 + 装备…药水 / 材料…宝石」这一组。
const bagStillOpen = (s) => /包裹[\s\S]{0,40}(装备[\s\S]{0,10}药水|材料[\s\S]{0,10}宝石)/.test((s || '').replace(/\s+/g, ''));

function createBagReader({ getPageText, log = console.log } = {}) {
    if (typeof getPageText !== 'function') throw new Error('createBagReader 需要注入 getPageText(page)');
    const txt = (page) => Promise.race([getPageText(page), evTo(12000)]).catch(() => '');
    const flat = (s) => (s || '').replace(/\s+/g, '');

    const rectOf = (page, n) => Promise.race([page.evaluate((nm) => {
        for (const el of document.querySelectorAll('body *')) {
            if (el.children.length) continue;
            if ((el.textContent || '').trim() !== nm) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
    }, n), evTo(8000)]).catch(() => null);

    // 让包裹列表真的滚动：CDP 触摸滑动；CDP 建不起来才退回 wheel（大概率无效，但不至于崩）。
    async function scrollBagList(page, cdp) {
        const vp = page.viewportSize() || { width: 1080, height: 608 };
        const x = Math.round(vp.width / 2);
        const yFrom = Math.round(vp.height * 0.82);
        const yTo = Math.round(vp.height * 0.28);
        if (cdp) {
            try {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yFrom }] });
                for (let i = 1; i <= 12; i++) {
                    const y = Math.round(yFrom + (yTo - yFrom) * i / 12);
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
                    await sleep(25);
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await sleep(1200);
                return;
            } catch (e) {
                log(`触摸滑动失败（${e.message}）→ 退回 wheel`);
            }
        }
        await page.mouse.move(x, yFrom).catch(() => { });
        await page.mouse.wheel(0, 520).catch(() => { });
        await sleep(1000);
    }

    // 关包裹：页签组判据 → Escape → 左上返回箭头 → 仍开着就打 warning。
    // 绝不在包裹本来就关着的时候乱点左上角（那会点掉别的面板）。
    async function closeBag(page) {
        let still = await txt(page);
        if (!bagStillOpen(still)) return true;
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(900);
        still = await txt(page);
        if (!bagStillOpen(still)) return true;
        await Promise.race([page.mouse.click(14, 26), evTo(8000)]).catch(() => { });
        await sleep(1000);
        still = await txt(page);
        if (bagStillOpen(still)) log('::warning::包裹没关掉，后续流程可能受影响');
        return !bagStillOpen(still);
    }

    // 返回 { items: {物品名: 数量}, opened, tabs: {物品名: 页签} }；读不到是 null（数量 0 时背包里没有这一条）。
    // ★ tabs 是 11-25 加的：以前只知道数量、不知道该物品在哪个页签，被问到「X 在背包哪里」只能猜。
    //   现在命中时顺手记下页签名（材料/道具/宝箱/其他），readBagItemsVerbose 会把 tabs 一起交出去。
    async function read(page, names) {
        const out = {};
        const tabOf = {};
        for (const n of names) out[n] = null;
        let opened = false;
        try {
            let t = await txt(page);
            if (!t.includes('当前城市')) return { items: out, opened, tabs: tabOf };

            let cdp = null;
            try { cdp = await page.context().newCDPSession(page); } catch (e) { log('CDP 会话建不起来，滚动只剩 wheel 兜底'); }

            // 底部导航常在视口外
            await page.mouse.wheel(0, 600).catch(() => { });
            await sleep(900);
            let bag = await rectOf(page, '包裹');
            if (!bag) { await page.mouse.wheel(0, 420).catch(() => { }); await sleep(1200); bag = await rectOf(page, '包裹'); }
            if (!bag) return { items: out, opened, tabs: tabOf };
            await Promise.race([page.mouse.click(bag.x, bag.y), evTo(8000)]).catch(() => { });
            await sleep(2500);
            t = await txt(page);
            if (!t.includes('包裹')) return { items: out, opened, tabs: tabOf };
            opened = true;

            // ① 先切「网格」视图：一屏 12~16 格，比列表少滚一半以上
            const gridBtn = await rectOf(page, '网格');
            if (gridBtn) { await Promise.race([page.mouse.click(gridBtn.x, gridBtn.y), evTo(8000)]).catch(() => { }); await sleep(1200); }

            const pending = new Set(names);
            // 材料页优先（浴火之蝶 / 藏宝图碎片都在这里，位置在页尾），再兜道具/宝箱/其他。
            // ★ 实测归属（11-25 用户截图「一只玫瑰 549」）：一只玫瑰在**道具页**，不在材料页；
            //   所以四个页签都要扫，不能只扫材料页。数量为 0 时包裹里不显示该条目 → 读不到即 0（用户 11-25 确认）。
            for (const tab of ['材料', '道具', '宝箱', '其他']) {
                if (!pending.size) break;
                const p = await rectOf(page, tab);
                if (!p) continue;
                const before = flat(t);
                await Promise.race([page.mouse.click(p.x, p.y), evTo(8000)]).catch(() => { });
                for (let i = 0; i < 12; i++) { await sleep(400); t = await txt(page); if (flat(t) !== before) break; }
                for (let screen = 0; screen < 14 && pending.size; screen++) {
                    if (screen) await scrollBagList(page, cdp);
                    const found = await Promise.race([page.evaluate((nms) => {
                        const res = {};
                        for (const nm of nms) {
                            res[nm] = -1;
                            const hits = [...document.querySelectorAll('body *')].filter((el) => {
                                if (el.children.length) return false;
                                const s = (el.textContent || '').trim();
                                return s.includes(nm) && s.length <= 30 && !/^(材料|道具|宝箱|其他|装备|药水|宝石|附魔卡|宠物)$/.test(s);
                            });
                            for (const h of hits) {
                                let node = h;
                                for (let up = 0; up < 7 && node; up++) {
                                    const m = (node.textContent || '').match(/数量\s*[:：]\s*(\d+)/);
                                    if (m) { res[nm] = Number(m[1]); break; }
                                    const numLeaf = [...node.querySelectorAll('*')].find((e) => !e.children.length && /^\d{1,6}$/.test((e.textContent || '').trim()));
                                    if (numLeaf && up >= 1) { res[nm] = Number(numLeaf.textContent.trim()); break; }
                                    node = node.parentElement;
                                }
                                if (res[nm] >= 0) break;
                            }
                        }
                        return res;
                    }, [...pending]), evTo(8000)]).catch(() => ({}));
                    for (const nm of Object.keys(found || {})) {
                        if (found[nm] >= 0 && pending.has(nm)) { out[nm] = found[nm]; pending.delete(nm); tabOf[nm] = tab; }
                    }
                    if (screen > 0 && /已加载全部数据/.test(await txt(page))) break;   // 到底了，别空滚
                }
            }
        } catch (e) {
            log(`背包读数异常（${e.message}）→ 该项按未读到处理`);
        } finally {
            if (opened) { try { await closeBag(page); } catch (e) { } await sleep(600); }
        }
        return { items: out, opened, tabs: tabOf };
    }

    // 只关心数量的调用方（基德/海盗王）：直接拿 { 名称: 数量 }，null 当 0 算差值。
    const readBagItems = async (page, names) => (await read(page, names)).items;
    // 需要区分「包裹没打开=读失败」和「打开但没有这条=真的 0」的调用方（奔月箱）：用这个。
    // 11-25 起还会带 tabs（每样物品命中的页签），用于回答「这东西在背包哪一页」。
    const readBagItemsVerbose = (page, names) => read(page, names);

    return { readBagItems, readBagItemsVerbose, scrollBagList, closeBag, bagStillOpen };
}

module.exports = { createBagReader, evTo, bagStillOpen };
