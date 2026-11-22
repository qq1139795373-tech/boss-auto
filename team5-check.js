// 只读复核：登录指定号 → 队伍面板全文（用来验证「队员离线/重登后，5 人队还在不在」）
// 用法：ACCS=coldwind8,coldwind0 node team5-check.js
const { chromium } = require('playwright');
const daily = require('./daily.js');
const acct = require('./acct-lock.js');
const pass = require('./account-pass.js');

const URL = 'http://yiyu.yiyutx.top/yysh/#/pages/login/login';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (p) => daily.getPageText(p);
const flat = (s) => (s || '').replace(/\s+/g, ' ').trim();
const ACCS = (process.env.ACCS || 'coldwind8').split(',').map((s) => s.trim()).filter(Boolean);

async function login(page, acc, pwd) {
    for (let a = 1; a <= 10; a++) {
        const ins = await page.$$('input');
        if (ins.length < 2) {
            const t = await txt(page);
            if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) return true;
            await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
            await sleep(3000); continue;
        }
        await ins[0].fill(acc); await ins[1].fill(pwd);
        await page.getByText('登录').first().click().catch(() => { });
        await sleep(3000);
        let t = await txt(page);
        if (t.includes('进入游戏') || t.includes('你看到') || t.includes('当前城市')) {
            for (let i = 0; i < 8; i++) {
                await daily.clickText(page, '进入游戏', 2000).catch(() => { });
                await sleep(4000);
                t = await txt(page);
                if (t.includes('你看到') || t.includes('当前城市')) return true;
            }
            return true;
        }
    }
    return false;
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    for (const a of ACCS) {
        const auth = pass.resolveOrExit(a);
        const lk = acct.acquire(a, { tag: 'team5-check.js' });
        if (!lk.ok) { console.log(`[${a}] 被占用 → 跳过`); continue; }
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
            await sleep(2600);
            const ok = await login(page, a, auth.password);
            if (!ok) { console.log(`[${a}] 登录失败`); continue; }
            await sleep(2500);
            await page.keyboard.press('Escape').catch(() => { });
            await sleep(800);
            await page.mouse.wheel(0, 700).catch(() => { });
            await sleep(500);
            await daily.clickText(page, '队伍', 3000).catch(() => { });
            await sleep(2800);
            let f = flat(await txt(page));
            // 若落在「我的队伍」以外的页签，点一下「我的队伍」
            if (!/队伍名称|创建队伍/.test(f)) {
                await daily.clickText(page, '我的队伍', 2500).catch(() => { });
                await sleep(2200);
                f = flat(await txt(page));
            }
            console.log(`[${a}] 队伍面板: ${f.slice(0, 400)}`);
            const n = (f.match(/\d+\s*级/g) || []).length;
            console.log(`[${a}] 人数: ${n}/5`);
        } finally {
            await ctx.close().catch(() => { });
            acct.release(a);
        }
    }
    await browser.close();
})().catch((e) => { console.log('::error::' + (e && e.message)); process.exit(2); });
