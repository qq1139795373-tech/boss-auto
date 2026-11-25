// 静态闸门：禁止再出现「等 1.5 秒重读、最多 4 次以内」的重试循环。
//
// 背景（2026-11-25 用户要求）：游戏页面经常半渲染，等 1.5 秒读一次就判定失败会误杀
// （组队 4/5、冷8 奔月队伍面板「加载中」、读怪只有 3 轮都是这么丢的）。
// 统一口径：**等渲染 / 重读** 类重试一律「每次 2 秒、最多 5 次」。
//
// 判定方式（纯静态，不联网）：
//   1. 扫正式脚本里的 for 循环；
//   2. 轮数上限 ≤ 4；
//   3. 循环体内既读页面文本（getPageText / visibleText / txt / readText）又出现 sleep(1500)；
//   → 判为「未放宽的重读循环」。
// 例外：循环体里点的是业务按钮（一键浇水最多浇两次），轮数本身就是业务上限，不是重试上限。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FILES = [
    'index.js', 'arena.js', 'dungeon.js', 'dungeon-recover.js', 'kidd.js', 'fish.js',
    'gongcheng.js', 'mail.js', 'mibao.js', 'signin.js', 'fmsj.js', 'daily.js',
    'farm.js', 'shanzhai.js', 'team5-form.js',
    'bymj-local/bymj-batch.js', 'hdwang-local/hdwang-batch.js', 'qllm-run.js', 'bag-read.js',
];
// 业务轮次白名单：这些循环的轮数含义是「最多做几次业务动作」，不是「重试读几次」
const BUSINESS_ROUNDS = ['一键浇水'];

const LOOP_RE = /for\s*\(\s*let\s+(\w+)\s*=\s*[^;]+;\s*\1\s*(<=|<)\s*(\d+)/;
const READ_RE = /(getPageText|visibleText|txt\(page|readText|await txt)/;

function findOffenders(src, file = '(inline)') {
    const L = String(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    L.forEach((line, i) => {
        const m = line.match(LOOP_RE);
        if (!m) return;
        const attempts = Number(m[3]);
        if (attempts > 4) return;                      // 已经是 5 次及以上
        const body = L.slice(i, i + 18).join('\n');
        if (!/sleep\(1500\)/.test(body)) return;       // 不是 1.5 秒的等待
        if (!READ_RE.test(body)) return;               // 不是「读页面再判断」
        if (BUSINESS_ROUNDS.some((k) => body.includes(k))) return;   // 业务轮次，放行
        out.push({ file, line: i + 1, loop: m[0].trim() });
    });
    return out;
}

let pass = 0, fail = 0;
const ok = (msg) => { pass++; console.log(`  ✔ ${msg}`); };
const bad = (msg) => { fail++; console.log(`  ✗ ${msg}`); };

console.log('=== 1. 正式脚本里不得残留 1.5 秒 × ≤4 次的重读循环 ===');
let total = 0;
for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const hits = findOffenders(fs.readFileSync(p, 'utf8'), f);
    total += hits.length;
    for (const h of hits) bad(`${h.file}:${h.line} ${h.loop}`);
}
if (total === 0) ok(`19 个正式脚本全部干净（0 处残留）`);
else bad(`共 ${total} 处未放宽`);

console.log('\n=== 2. 证伪：把旧写法塞回去必须被扫出 ===');
const oldStyle = `
async function demo(page) {
    for (let i = 0; i < 4; i++) {
        await sleep(1500);
        const t = await getPageText(page);
        if (t.includes('好')) return true;
    }
}`;
if (findOffenders(oldStyle).length === 1) ok('旧写法（1.5 秒 × 4 次）被扫出');
else bad('证伪失败：旧写法居然没被扫出');

const newStyle = `
async function demo(page) {
    for (let i = 0; i < 5; i++) {
        await sleep(2000);
        const t = await getPageText(page);
        if (t.includes('好')) return true;
    }
}`;
if (findOffenders(newStyle).length === 0) ok('新写法（2 秒 × 5 次）不误报');
else bad('误报：新写法被当成问题');

console.log('\n=== 3. 白名单不误报 ===');
const water = `
    for (let round = 1; round <= 2; round++) {
        await clickLeaf(page, '一键浇水');
        await sleep(1500);
        const t = await getPageText(page);
    }`;
if (findOffenders(water).length === 0) ok('浇水 2 轮（业务上限）不误报');
else bad('误报：业务轮次被当成重读循环');

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
