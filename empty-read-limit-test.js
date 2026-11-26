// 单测：clearRoom 的「读不到怪」上限按「本房杀没杀过怪」分档（2026-11-26）。
//
// 背景（用户提问）：基德日志里每间房都是「3 只打完 → 连读 4 次空 → 才收工」，看着像渲染慢，
//   实际是收工判据写死 5 次：清完最后一只后页面当然是空的，但代码没法知道「空了 = 清完了」，
//   只能连读空 5 次来确认 → 每间房固定白等 (5-1)×2s = 8 秒，基德 17 间房 = 136 秒。
// 改法：刚进房（kills===0）仍 5 次（防 10-29「首读 0 只当空房」漏 27 只那种）；
//   本房已杀过怪（kills>0）→ 2 次（2 秒），足够排除结算后重绘的那一下抖动。
//
// 用法：node empty-read-limit-test.js   —— 不联网、不登号
const fs = require('fs');

const read = (f) => fs.readFileSync(f, 'utf8');
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');

// 从源码里抠出 function emptyReadLimit(...) { ... } 的完整文本
function extractFn(src, name = 'emptyReadLimit') {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`找不到 ${name}`);
    const m = src.slice(i).match(/\n\}/);
    if (!m) throw new Error(`${name} 未闭合`);
    return src.slice(i, i + m.index + 2);
}

// 抠出 clearRoom 全文（用于检查分支是否真的用了分档函数）
function extractClearRoom(src) {
    const i = src.indexOf('async function clearRoom(');
    if (i < 0) throw new Error('找不到 clearRoom');
    const m = src.slice(i).match(/\n\}/);
    return src.slice(i, i + m.index + 2);
}

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✔ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };

const kidd = read('kidd.js');
const dun = read('dungeon.js');

console.log('=== 1. 两个副本的分档函数逐字同源 ===');
const fk = extractFn(kidd);
const fd = extractFn(dun);
if (norm(fk) === norm(fd)) ok(`kidd.js 与 dungeon.js 的 emptyReadLimit 完全一致（${norm(fk).length} 字符）`);
else {
    bad('两处 emptyReadLimit 不一致');
    console.log(`    kidd   : ${norm(fk)}`);
    console.log(`    dungeon: ${norm(fd)}`);
}

console.log('\n=== 2. 分档行为（直接执行源码里的函数） ===');
// eslint-disable-next-line no-new-func
const fn = new Function(`${fk}; return emptyReadLimit;`)();
const cases = [
    [0, 5, '刚进房没杀过怪 → 留足 5 次（防首读空误判空房）'],
    [1, 2, '本房杀过 1 只 → 2 次确认'],
    [3, 2, '本房清完 3 只 → 2 次确认'],
    [51, 2, '累计击杀再大也只按本房算 → 2 次'],
];
for (const [kills, want, why] of cases) {
    const got = fn(kills);
    if (got === want) ok(`emptyReadLimit(${kills}) = ${got}｜${why}`);
    else bad(`emptyReadLimit(${kills}) = ${got}，期望 ${want}`);
}

console.log('\n=== 3. clearRoom 真的用了分档，而不是又写死 5 ===');
for (const [label, src] of [['kidd.js', kidd], ['dungeon.js', dun]]) {
    const cr = extractClearRoom(src);
    if (/emptyReads\+\+;\s*const limit = emptyReadLimit\(kills\);/.test(cr)) ok(`${label} clearRoom 先算 limit 再判上限`);
    else bad(`${label} clearRoom 没接 emptyReadLimit`);
    if (/if \(emptyReads >= limit\) return kills;/.test(cr)) ok(`${label} 用 limit 判收工`);
    else bad(`${label} 收工判据没换成 limit`);
    if (/第\$\{emptyReads\}\/\$\{limit\}次/.test(cr)) ok(`${label} 日志打印的是动态上限（不再固定 /5）`);
    else bad(`${label} 日志仍写死 /5，看日志会误判档位`);
    if (/emptyReads >= 5\) return kills/.test(cr)) bad(`${label} 仍残留写死的 5 次上限`);
    else ok(`${label} 没有残留写死的 5 次`);
}

console.log('\n=== 4. 证伪：把旧写法塞回去必须被判出 ===');
const oldSnippet = `
async function clearRoom(page, tag) {
    let kills = 0, emptyReads = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
        emptyReads++;
        if (emptyReads >= 5) return kills;
        console.log(\`[\${tag}] 房间没读到怪，等渲染（第\${emptyReads}/5次）...\`);
        await sleep(2000);
    }
}`;
const looksOld = (src) => /emptyReads\+\+;\s*if \(emptyReads >= 5\) return kills;/.test(src);
if (looksOld(oldSnippet)) ok('旧写法（写死 5 次、日志固定 /5）被扫出');
else bad('证伪失败：旧写法没被扫出');

const newSnippet = extractClearRoom(kidd);
if (!looksOld(newSnippet)) ok('新写法不误报');
else bad('误报：新写法被当成旧写法');

console.log('\n=== 5. 省下的时间（按 11-22 实测 17 间房、2 秒档折算） ===');
const ROOMS = 17, SLEEP = 2000;
const deadPerRoom = (limit) => (limit - 1) * SLEEP;      // 收工确认要等的次数 × 间隔
const before = ROOMS * deadPerRoom(fn(0));               // 改前：每间都按 5 次档
const after = ROOMS * deadPerRoom(fn(1));                // 改后：清完的房按 2 次档
const saved = before - after;
ok(`改前每间 ${deadPerRoom(fn(0)) / 1000}s → 改后 ${deadPerRoom(fn(1)) / 1000}s；17 间共省 ${saved / 1000}s`);
if (saved > 0 && after < before) ok('收工等待确实下降（不是等价改写）');
else bad(`没有省下时间：before=${before} after=${after}`);

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
