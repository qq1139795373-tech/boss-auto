// backToCityView 的 txt 契约单测（11-26）
//
// 背景：炼器窟/基德领奖后都会调 drain.backToCityView(page, { txt: getPageText })，然后读背包对账。
// 旧实现 `const txt = opts.txt || (() => visibleText(page))` 按**零参**调用 txt，
// 于是 getPageText(undefined) → page.evaluate 崩 → 「领奖对账异常（Cannot read properties of
// undefined (reading 'evaluate')）」，整段背包对账被 try 吞掉，从来没真正跑过。
//
// 这里用 fake page 真跑一遍 backToCityView，验证 page 确实被带进 txt；并回放旧写法证明判据有效。
const drain = require('./dungeon-recover.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✖ ' + m); } };

// 按顺序返回页面文本的假页面；evaluate 一旦被 undefined 调用就会像真 puppeteer 那样抛错。
function fakePage(seq) {
    let i = 0;
    return {
        calls: 0,
        evaluate: async function () { this.calls++; return seq[Math.min(i++, seq.length - 1)]; },
        keyboard: { press: async () => { } },
        mouse: { click: async () => { } },
    };
}

// 与 dungeon.js / kidd.js 里同名函数同形态：page 是必需参数。
async function getPageText(page) {
    return await drain.visibleText(page);
}

const OLD_ERR = /Cannot read properties of undefined \(reading 'evaluate'\)/;

(async () => {
    console.log('[1] 传 getPageText（page→text 形态）：已在主视图，必须直接判定回城');
    {
        const page = fakePage(['当前城市 苏州']);
        let err = null;
        let r;
        try {
            r = await drain.backToCityView(page, { txt: getPageText, log: () => { } });
        } catch (e) { err = e; }
        ok(!err, '不抛异常' + (err ? `（实际: ${err.message}）` : ''));
        ok(r === true, '返回 true');
        ok(page.calls >= 1, 'page.evaluate 真被调用（说明 page 传进去了）');
    }

    console.log('[2] 传 getPageText：需按一次 Escape 才回城，必须读到第二次');
    {
        const page = fakePage(['副本内 矿洞', '当前城市 苏州']);
        let err = null;
        let r;
        try {
            r = await drain.backToCityView(page, { txt: getPageText, log: () => { } });
        } catch (e) { err = e; }
        ok(!err, '不抛异常' + (err ? `（实际: ${err.message}）` : ''));
        ok(r === true, '返回 true（读到了 Escape 之后的页面）');
        ok(page.calls >= 2, '至少读了两次页面（不是只看第一屏就放过）');
    }

    console.log('[3] 零参闭包仍然兼容（老的调用形态不能被这次改动搞坏）');
    {
        let r;
        try {
            r = await drain.backToCityView(fakePage(['当前城市 苏州']), { txt: () => Promise.resolve('当前城市 苏州'), log: () => { } });
        } catch (e) { r = e.message; }
        ok(r === true, '返回 true');
    }

    console.log('[4] 不传 txt：仍走默认 visibleText(page)');
    {
        const page = fakePage(['当前城市 苏州']);
        let r;
        try {
            r = await drain.backToCityView(page);
        } catch (e) { r = e.message; }
        ok(r === true, '返回 true');
    }

    console.log('[5] 证伪：旧写法（opts.txt 直接当零参函数）必须崩，否则本测试抓不到这个 bug');
    {
        const oldTxt = (page, opts) => (opts.txt || (() => drain.visibleText(page)));
        let msg = '';
        try {
            await oldTxt(fakePage(['当前城市 苏州']), { txt: getPageText })();
        } catch (e) { msg = e.message; }
        ok(OLD_ERR.test(msg), '旧写法确实抛「reading evaluate」' + (msg ? `（实际: ${msg}）` : '（没抛错，判据失效）'));
    }

    console.log('[6] 真实调用形态：dungeon.js / kidd.js 都传 getPageText，且 backToCityView 补了 page');
    {
        const src = fs.readFileSync(__dirname + '/dungeon-recover.js', 'utf8');
        ok(/const txt = \(\) => \(opts\.txt \? opts\.txt\(page\)/.test(src), 'dungeon-recover.js 用 opts.txt(page) 调用');
        ok(!/opts\.txt \|\| \(\(\) => visibleText\(page\)\)/.test(src), '已不存在「opts.txt 当零参」的旧写法');
        for (const f of ['dungeon.js', 'kidd.js']) {
            const s = fs.readFileSync(__dirname + '/' + f, 'utf8');
            ok(/backToCityView\(page, \{ txt: getPageText/.test(s), `${f} 的对账调用点形态未变（txt: getPageText）`);
            ok(!/async function getPageText\(\)/.test(s), `${f} 的 getPageText 仍要求 page 参数（说明必须补 page）`);
        }
    }

    console.log('');
    console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
})();
