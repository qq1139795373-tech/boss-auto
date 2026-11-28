// 单测：攻城「血池 0」决策 bloodGate()（2026-11-28）。
//
// 背景（用户提问「为什么大号攻城失败了」）：11-28 20:00 大号攻城击杀 0，20:00:15 就收工。
//   真实日志序列：
//     20:00:03 点第一只怪 → 真战斗面板，血池 0
//     20:00:04 撤退补药 → 20:00:07 用掉 1 个「小体力宝」（背包 74 → 73）
//     20:00:11 回列表点第二只 → **0.1 秒**后判「血池为 0 且本波已补 1 次到上限」→ 整波判死
//   两个缺陷：
//     ① 补完药后的第一帧可能还是上一场战斗面板的残影（只有「撤退/攻击」+ 旧的「血池：0」，
//        没有怪物体力行「体力：X/Y」）。原代码一读到 0 就动手，0.1 秒误杀。
//     ② BLOOD_HEAL_MAX=1 把「体力宝覆盖式恢复不能叠加」误解成「一波只能补一次」，
//        包里还有 73 个药却直接封盘。
//
// 用法：node blood-gate-test.js   —— 不联网、不登号
const { bloodGate } = require('./gongcheng.js');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const eq = (name, got, want) => (got === want ? ok(`${name} → ${got}`) : bad(`${name}：期望 ${want}，实际 ${got}`));

// 基准状态：真战斗面板、血池 0、已过宽限、什么都没补过
const base = {
    inBattle: true, blood: 0, hasMonsterHp: true, elapsedMs: 3000,
    heals: 0, fails: 0, dryStreak: 0, dead: false,
};
const g = (patch) => bloodGate({ ...base, ...patch });

console.log('=== 1. 不归本函数管的情形（一律 fight，不许误触发补药） ===');
eq('血池 18353（正常）', g({ blood: 18353 }).act, 'fight');
eq('血池读不到（null）', g({ blood: null }).act, 'fight');
eq('不在战斗面板（即使读到 0）', g({ inBattle: false }).act, 'fight');

console.log('\n=== 2. 残影面板：血池 0 但还没有怪物体力行 → 先等，不许判 ===');
eq('补药后 0.1 秒（真实事故帧）', g({ hasMonsterHp: false, elapsedMs: 100 }).act, 'wait');
eq('宽限 1499ms（仍在宽限内）', g({ hasMonsterHp: false, elapsedMs: 1499 }).act, 'wait');
eq('宽限 1500ms 到点', g({ hasMonsterHp: false, elapsedMs: 1500 }).act, 'heal');
eq('读到怪物体力行（真面板）立即处理', g({ hasMonsterHp: true, elapsedMs: 80 }).act, 'heal');
// 证伪：把宽限关掉（旧行为 grace=0），同一个残影帧就会直接动手 → 事故可复现
eq('证伪·宽限置 0 时残影帧直接 heal（旧行为）', g({ hasMonsterHp: false, elapsedMs: 100, graceMs: 0 }).act, 'heal');

console.log('\n=== 3. 补药额度：补过又归零要能再补，不许一封到底 ===');
const first = g({});
eq('第一次补药', first.act, 'heal');
eq('第一次补药 retry=false', first.retry, false);
const again = g({ heals: 1, fails: 0 });
eq('补过 1 次又归零 → 再补', again.act, 'heal');
eq('再补时 retry=true（调用方记一次无效）', again.retry, true);
eq('补 2 次后又归零（fails=1）仍再补', g({ heals: 2, fails: 1 }).act, 'heal');
eq('连续 2 次无效（fails=2）→ 判打不动', g({ heals: 2, fails: 2 }).act, 'giveup');
eq('本波补到上限 3 次 → 判打不动', g({ heals: 3, fails: 0 }).act, 'giveup');

console.log('\n=== 4. 无药 / 已判死 ===');
eq('连续 4 只无药 → 还接着抢', g({ dryStreak: 4, heals: 0 }).act, 'heal');
eq('连续 5 只无药 → 收工', g({ dryStreak: 5, heals: 0 }).act, 'giveup');
eq('已判死（dead）→ giveup 且不再开包裹', g({ dead: true }).act, 'giveup');
ok('wait 优先于 giveup：残影帧即使 dead 也先等真面板（避免把别只的状态算进来）'
    ? g({ dead: true, hasMonsterHp: false, elapsedMs: 0 }).act === 'wait'
    : false);

console.log('\n=== 5. 复盘 11-28 大号真实时序（按日志逐步喂状态） ===');
// 状态机：heals/fails/dryStreak/dead 由调用方按 resolveBattle 的规则维护
let st = { heals: 0, fails: 0, dryStreak: 0, dead: false };
const step = (label, patch) => {
    const r = bloodGate({ ...base, ...st, ...patch });
    if (r.act === 'giveup') st.dead = true;
    if (r.act === 'heal') {
        if (r.retry) st.fails++;
        st.heals++;          // 假定包里还有药（- 真实日志：剩 73 个）
        st.dryStreak = 0;
    }
    console.log(`  · ${label} → ${r.act}${r.retry ? '(retry)' : ''}`);
    return r.act;
};
const a1 = step('20:00:03 第一只，真面板血池 0', { blood: 0, hasMonsterHp: true, elapsedMs: 900 });
const a2 = step('20:00:11 第二只，补完 0.1s，残影无怪物行', { blood: 0, hasMonsterHp: false, elapsedMs: 100 });
const a3 = step('20:00:12 第二只，真面板血池 0', { blood: 0, hasMonsterHp: true, elapsedMs: 1400 });
const a4 = step('下一只，补完真面板血池 165000（补药生效）', { blood: 165000, hasMonsterHp: true, elapsedMs: 800 });
a1 === 'heal' ? ok('第一只判补药（与日志一致）') : bad(`第一只应为 heal，实际 ${a1}`);
a2 === 'wait' ? ok('第二只 0.1s 残影帧不再误判（事故在此被拦住）') : bad(`第二只残影帧应为 wait，实际 ${a2}`);
a3 === 'heal' ? ok('第二只真面板仍 0 → 再补一次，不封盘') : bad(`第二只真面板应为 heal，实际 ${a3}`);
a4 === 'fight' ? ok('补药生效后正常打怪') : bad(`补药生效后应为 fight，实际 ${a4}`);
st.dead ? bad('整条时序不应被判死') : ok('整条时序未被判死（旧代码在第 2 步就 giveup）');

console.log('\n=== 6. 同类位置守卫：三处「补药后残影」都必须有宽限（防止以后被改回去） ===');
const fs = require('fs');
const src = (f) => fs.readFileSync(require('path').join(__dirname, f), 'utf8');
const has = (f, re, what) => (re.test(src(f)) ? ok(`${f}：${what}`) : bad(`${f}：缺 ${what}`));
has('gongcheng.js', /GC_BLOOD_GRACE_MS/, '攻城宽限常量');
has('gongcheng.js', /if \(!s\.hasMonsterHp && s\.elapsedMs < pick\(s\.graceMs, BLOOD_GRACE_MS\)\) return \{ act: 'wait' \}/, 'bloodGate 残影等待分支');
has('daily.js', /Date\.now\(\) - healAt < 1800/, '每日任务补药后宽限');
has('fmsj.js', /Date\.now\(\) - healAt < 1800/, '附魔秘境补药后宽限');
// 证伪：宽限必须在「heals>=1 判打不动」之前，否则等于没加
const before = (f, a, b) => src(f).indexOf(a) > 0 && src(f).indexOf(a) < src(f).indexOf(b);
before('daily.js', 'Date.now() - healAt < 1800', 'BLOOD_DEAD || heals >= 1')
    ? ok('daily.js：宽限在判死之前') : bad('daily.js：宽限写在了判死之后（等于没加）');
before('fmsj.js', 'Date.now() - healAt < 1800', "if (heals >= 1)")
    ? ok('fmsj.js：宽限在判死之前') : bad('fmsj.js：宽限写在了判死之后（等于没加）');

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
