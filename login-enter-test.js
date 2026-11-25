// 登录判定回归（2026-11-25 事故）
//
// 事故：bymj-batch / fmsj / hdwang-batch 的 login() 里有一支「无表单」分支，
//   写法是 `if (t.includes('进入游戏') || t.includes('你看到') || ...) return true;`
//   ——「进入游戏」只是**选角页**上的按钮，人根本还没进主界面。
//   结果：return true 交差 → 奔月的背包基线（要求页面有「当前城市」）连挂 5 次，
//   基线丢了 → 领奖只能靠 toast（这游戏不弹）→ 一律「到账未证实」。
//
// 本测试是静态闸门，两条硬规则：
//   ① 正式脚本里，「进入游戏」不能和 `return true` 出现在同一行（必须再走 enterMain 点进去）；
//   ② 这三个脚本的 login 必须调用 daily.enterMain（选角页兜底）。
// 附证伪用例：把旧写法塞进去必须被扫出来，否则测试本身是假的。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// 生产入口（探针/一次性脚本不算）
const FILES = [
    'index.js', 'arena.js', 'dungeon.js', 'kidd.js', 'fish.js', 'gongcheng.js',
    'mail.js', 'mibao.js', 'signin.js', 'fmsj.js', 'team5-form.js', 'farm.js', 'shanzhai.js',
    'qllm-run.js',
    'bymj-local/bymj-batch.js', 'hdwang-local/hdwang-batch.js',
];
// 必须保留 enterMain 兜底的脚本（都有一段独立 login）
// ★ 11-25 补 qllm-run.js：它同样有一支「无表单」分支，21:19 情侣补跑就栽在这里
//   （冷8 停在选角页被当登录成功 → 判「不在副本内」→ return 0 → 上层报「两段完成」）。
const NEED_ENTER_MAIN = ['fmsj.js', 'bymj-local/bymj-batch.js', 'hdwang-local/hdwang-batch.js', 'qllm-run.js'];

// 规则①：同一行同时出现「进入游戏」和 return true → 假成功
function offenders(src) {
    const out = [];
    src.split(/\r?\n/).forEach((line, i) => {
        const s = line.trim();
        if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return;   // 注释里提到旧写法不算
        if (!line.includes('进入游戏')) return;
        if (!/return\s+true/.test(line)) return;
        // 「进入游戏 && enterMain(...) → true」是正确写法（先点进去再算成功），不算假成功
        if (/enterMain\s*\(|clickEnterGame\s*\(/.test(line)) return;
        out.push({ line: i + 1, text: s.slice(0, 120) });
    });
    return out;
}

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

console.log('[1] 证伪：旧写法必须被扫出来');
{
    const fake = "if (t.includes('进入游戏') || t.includes('你看到')) return true;";
    const r = offenders(fake);
    r.length === 1 ? ok('注入旧写法 → 命中 1 行') : bad(`注入旧写法 → 命中 ${r.length} 行（检测器失效）`);
    const good = "if (t.includes('进入游戏')) {\n  return await daily.enterMain(page);\n}";
    offenders(good).length === 0 ? ok('正确写法（走 enterMain）→ 不误报') : bad('正确写法被误报');
}

console.log('[2] 正式脚本里不允许「进入游戏 = 登录成功」');
{
    let hit = 0;
    for (const f of FILES) {
        const p = path.join(ROOT, f);
        if (!fs.existsSync(p)) { console.log(`  - ${f} 本分支没有（跳过）`); continue; }
        const r = offenders(fs.readFileSync(p, 'utf8'));
        if (!r.length) { ok(`${f} 干净`); continue; }
        hit++;
        bad(`${f} 第 ${r.map((x) => x.line).join('/')} 行仍把「进入游戏」当成功：${r[0].text}`);
    }
    if (!hit) ok('全部生产脚本 0 命中');
}

console.log('[3] 各脚本的 login 必须保留 enterMain（选角页兜底）');
{
    for (const f of NEED_ENTER_MAIN) {
        const p = path.join(ROOT, f);
        const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        /daily\.enterMain\s*\(/.test(src) ? ok(`${f} 有 daily.enterMain`) : bad(`${f} 缺 daily.enterMain`);
    }
}

console.log('[4] 情侣第二段不许把「没领到」洗成成功（21:19 冷8 事故）');
{
    // 规则③：qllm-run.js 的「不在副本内 / 已出本」那支不能 return 0
    const q1 = path.join(ROOT, 'qllm-run.js');
    const src1 = fs.existsSync(q1) ? fs.readFileSync(q1, 'utf8') : '';
    const badLine = src1.split(/\r?\n/).find((l) => /不在副本内|已出本/.test(l) && /return\s+0/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    badLine ? bad('qllm-run.js 仍把「不在副本内」当成功：' + badLine.trim().slice(0, 100))
        : ok('qllm-run.js 的「不在副本内」不再 return 0');
    // 规则④：qllm-daily.js 必须区分第二段返回码，并保留队长领奖失败分支
    const q2 = path.join(ROOT, 'qllm-daily.js');
    const src2 = fs.existsSync(q2) ? fs.readFileSync(q2, 'utf8') : '';
    if (!src2) { console.log('  - qllm-daily.js 不存在（跳过）'); }
    else {
        /c2\s*===\s*5/.test(src2) ? ok('qllm-daily.js 有「已出本」分支') : bad('qllm-daily.js 缺 c2 === 5 分支');
        /leader-claim-fail/.test(src2) ? ok('qllm-daily.js 有「队长领奖失败」分支') : bad('qllm-daily.js 缺 leader-claim-fail');
    }
    // 证伪：把旧写法塞回去必须被扫出
    const fakeOld = "if (!inDungeon(t)) { log('队员', '不在副本内（可能已退出）'); return 0; }";
    const hit = fakeOld.split(/\r?\n/).some((l) => /不在副本内|已出本/.test(l) && /return\s+0/.test(l));
    hit ? ok('证伪：旧写法「不在副本内 → return 0」会被扫出') : bad('证伪失败：旧写法没被扫出');
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
