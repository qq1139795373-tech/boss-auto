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
//     ② BLOOD_HEAL_MAX=1 把「体力宝覆盖式恢复不能叠加」误解成「一波只能补一次」。
//
// ★ 不变量（用户 11-20、11-28 两次强调）：补血失败也要先打怪。
//   所以「血池 0」永远只能导致 heal / wait / hard（硬打），**绝不允许**导致收工放弃。
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
    heals: 0, fails: 0, hard: false, dead: false,
};
const g = (patch) => bloodGate({ ...base, ...patch });

console.log('=== 1. 不归本函数管的情形（一律 fight，不许误触发补药） ===');
eq('血池 18353（正常）', g({ blood: 18353 }).act, 'fight');
eq('血池读不到（null）', g({ blood: null }).act, 'fight');
eq('不在战斗面板（即使读到 0）', g({ inBattle: false }).act, 'fight');
eq('已转硬打模式（不再碰血池）', g({ hard: true }).act, 'fight');

console.log('\n=== 2. 残影面板：血池 0 但还没有怪物体力行 → 先等，不许判 ===');
eq('补药后 0.1 秒（真实事故帧）', g({ hasMonsterHp: false, elapsedMs: 100 }).act, 'wait');
eq('宽限 1499ms（仍在宽限内）', g({ hasMonsterHp: false, elapsedMs: 1499 }).act, 'wait');
eq('宽限 1500ms 到点', g({ hasMonsterHp: false, elapsedMs: 1500 }).act, 'heal');
eq('读到怪物体力行（真面板）立即处理', g({ hasMonsterHp: true, elapsedMs: 80 }).act, 'heal');
// 证伪：把宽限关掉（旧行为 grace=0），同一个残影帧就会直接动手 → 事故可复现
eq('证伪·宽限置 0 时残影帧直接 heal（旧行为）', g({ hasMonsterHp: false, elapsedMs: 100, graceMs: 0 }).act, 'heal');

console.log('\n=== 3. 补药额度：补过又归零要能再补，到顶转「硬打」而不是收工 ===');
const first = g({});
eq('第一次补药', first.act, 'heal');
eq('第一次补药 retry=false', first.retry, false);
const again = g({ heals: 1, fails: 0 });
eq('补过 1 次又归零 → 再补', again.act, 'heal');
eq('再补时 retry=true（调用方记一次无效）', again.retry, true);
eq('补 2 次后又归零（fails=1）仍再补', g({ heals: 2, fails: 1 }).act, 'heal');
eq('连续 2 次无效（fails=2）→ 转硬打', g({ heals: 2, fails: 2 }).act, 'hard');
eq('本波补到上限 3 次 → 转硬打', g({ heals: 3, fails: 0 }).act, 'hard');

console.log('\n=== 4. 铁律不变量：血池 0 永不许导致「收工放弃」 ===');
let leaked = 0;
for (const heals of [0, 1, 2, 3, 4, 9]) {
    for (const fails of [0, 1, 2, 3, 9]) {
        for (const hard of [false, true]) {
            for (const hasMonsterHp of [false, true]) {
                for (const elapsedMs of [0, 800, 1500, 9000]) {
                    const r = bloodGate({ ...base, heals, fails, hard, hasMonsterHp, elapsedMs });
                    if (r.act === 'giveup') { leaked++; console.log(`    HIT heals=${heals} fails=${fails} hard=${hard} hp=${hasMonsterHp} ms=${elapsedMs}`); }
                }
            }
        }
    }
}
leaked === 0 ? ok(`穷举 ${6 * 5 * 2 * 2 * 4} 种组合，无一种因血池 0 判收工`) : bad(`${leaked} 种组合仍会放弃`);
eq('只有整波已判死（dead）才允许 giveup', g({ dead: true }).act, 'giveup');
ok('dead 时残影帧仍先 wait（不被别只状态带跑）'
    ? g({ dead: true, hasMonsterHp: false, elapsedMs: 0 }).act === 'wait' : false);

console.log('\n=== 5. 复盘 11-28 大号真实时序（按日志逐步喂状态） ===');
let st = { heals: 0, fails: 0, hard: false, dead: false };
const step = (label, patch) => {
    const r = bloodGate({ ...base, ...st, ...patch });
    if (r.act === 'giveup') st.dead = true;
    if (r.act === 'hard') st.hard = true;
    if (r.act === 'heal') {
        if (r.retry) st.fails++;
        st.heals++;          // 假定包里还有药（真实日志：剩 73 个）
    }
    console.log(`  · ${label} → ${r.act}${r.retry ? '(retry)' : ''}`);
    return r.act;
};
const a1 = step('20:00:03 第一只，真面板血池 0', { blood: 0, hasMonsterHp: true, elapsedMs: 900 });
const a2 = step('20:00:11 第二只，补完 0.1s，残影无怪物行', { blood: 0, hasMonsterHp: false, elapsedMs: 100 });
const a3 = step('20:00:12 第二只，真面板血池 0', { blood: 0, hasMonsterHp: true, elapsedMs: 1400 });
a1 === 'heal' ? ok('第一只判补药（与日志一致）') : bad(`第一只应为 heal，实际 ${a1}`);
a2 === 'wait' ? ok('第二只 0.1s 残影帧不再误判（事故在此被拦住）') : bad(`第二只残影帧应为 wait，实际 ${a2}`);
a3 === 'heal' ? ok('第二只真面板仍 0 → 再补一次，不封盘') : bad(`第二只真面板应为 heal，实际 ${a3}`);
st.dead ? bad('整条时序不应被判死') : ok('整条时序未被判死（旧代码在第 2 步就 giveup）');

// 再往后：药真的没了 / 补到上限 / 连续无效 → 必须 hard（继续打），不是收工
let st2 = { heals: 3, fails: 0, hard: false, dead: false };
const b1 = bloodGate({ ...base, ...st2 });
b1.act === 'hard' ? ok('补到上限仍 0 → 硬打（不回退、不收工）') : bad(`应 hard，实际 ${b1.act}`);
let st3 = { heals: 0, fails: 0, hard: true, dead: false };
eq('已硬打模式，再遇血池 0 也照打', bloodGate({ ...base, ...st3, blood: 0 }).act, 'fight');

console.log('\n=== 6. 同类位置守卫：三处「补血失败也要先打怪」不许被改回放弃 ===');
const fs = require('fs');
const src = (f) => fs.readFileSync(require('path').join(__dirname, f), 'utf8');
const has = (f, re, what) => (re.test(src(f)) ? ok(`${f}：${what}`) : bad(`${f}：缺 ${what}`));
has('gongcheng.js', /GC_BLOOD_GRACE_MS/, '攻城宽限常量');
has('gongcheng.js', /\{ act: 'hard', why:/, 'bloodGate 转硬打分支');
has('gongcheng.js', /按「没有体力宝」硬打这只，不撤不收工/, '补药失败转硬打');
has('daily.js', /Date\.now\(\) - healAt < 1800/, '每日任务补药后宽限');
has('daily.js', /按「没有体力宝」硬打这只/, '每日任务补不上药转硬打');
has('fmsj.js', /Date\.now\(\) - healAt < 1800/, '附魔秘境补药后宽限');
has('fmsj.js', /按「没有体力宝」硬打这只/, '附魔秘境补不上药转硬打');
const before = (f, a, b) => src(f).indexOf(a) > 0 && src(f).indexOf(a) < src(f).indexOf(b);
before('daily.js', 'Date.now() - healAt < 1800', 'if (!BLOOD_DEAD && heals < 1)')
    ? ok('daily.js：宽限在判死/硬打之前') : bad('daily.js：宽限写在了判定之后（等于没加）');
before('fmsj.js', 'Date.now() - healAt < 1800', 'if (!bloodHard && heals < 1)')
    ? ok('fmsj.js：宽限在判死/硬打之前') : bad('fmsj.js：宽限写在了判定之后（等于没加）');
// 证伪：这三处不许再出现「补药失败就 break / 判打不动 / 放弃这只」的老写法
const forbid = [
    ['daily.js', /补药失败（\$\{h\.reason\}）→ 本波不再尝试补药/, '旧的「补药失败即放弃」分支'],
    ['fmsj.js', /判打不动，按既有铁律继续硬打的场景这里不适用/, '旧的「补药失败即判打不动」分支'],
    ['daily.js', /，放弃这只/, '旧的「放弃这只」日志'],
];
for (const [f, re, what] of forbid) (re.test(src(f)) ? bad(`${f}：仍残留 ${what}`) : ok(`${f}：已无 ${what}`));

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
