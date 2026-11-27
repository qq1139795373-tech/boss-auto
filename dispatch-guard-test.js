// dispatch-guard.js 单测（2026-11-26）
// 盯的是「补发判定」这一层：什么时候该查、什么算已经派发过、边界卡在哪。
// 时间全部是硬编码的 UTC 毫秒，不依赖跑测机器的时区。

'use strict';

const assert = require('assert');
const g = require('./dispatch-guard.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}
// 北京 2026-11-26 HH:MM 对应的 Date（UTC = 北京 - 8h，可能落到 11-25）
const bj = (h, m) => new Date(Date.UTC(2026, 10, 26, h - 8, m));

console.log('[1] 波次表');
t('四条波次：00:00 / 06:00 / 11:30 / 18:00', () =>
    assert.deepStrictEqual(g.WAVES.map(w => w.hm), ['00:00', '06:00', '11:30', '18:00']));
t('两条分支：master + multi-boss', () =>
    assert.deepStrictEqual(g.REFS, ['master', 'multi-boss']));
t('hm 转分钟', () => {
    assert.strictEqual(g.hmToMin('00:00'), 0);
    assert.strictEqual(g.hmToMin('11:30'), 690);
    assert.strictEqual(g.hmToMin('18:00'), 1080);
});
t('hm 格式错要报错，不许静默当 0 点', () =>
    assert.throws(() => g.hmToMin('18点')));

console.log('[2] 北京时间换算');
t('UTC 16:12 = 北京 00:12', () => assert.strictEqual(g.bjMinuteOfDay(bj(0, 12)), 12));
t('UTC 22:00 = 北京 06:00', () => assert.strictEqual(g.bjMinuteOfDay(bj(6, 0)), 360));
t('UTC 10:00 = 北京 18:00（不是 UTC 18 点）', () => assert.strictEqual(g.bjMinuteOfDay(bj(18, 0)), 1080));

console.log('[3] 该不该查（波次后 12 分钟才怀疑丢了）');
t('00:11 → 还不查（刚过 11 分钟，先信派发）', () =>
    assert.deepStrictEqual(g.dueWaves(bj(0, 11)), []));
t('00:12 → 查 dawn', () =>
    assert.deepStrictEqual(g.dueWaves(bj(0, 12)).map(w => w.hm), ['00:00']));
t('02:30 → 仍查 dawn（dawn 窗口到 02:59，补发还判得回 dawn）', () =>
    assert.deepStrictEqual(g.dueWaves(bj(2, 30)).map(w => w.hm), ['00:00']));
t('02:31 → 不查了（超 150 分钟，补一个 mode 会滑成 skip 的 run 没意义）', () =>
    assert.deepStrictEqual(g.dueWaves(bj(2, 31)), []));
t('13:00 → 落在 11:30 波次的窗口里（150 分钟，晚补无副作用）', () =>
    assert.deepStrictEqual(g.dueWaves(bj(13, 0)).map(w => w.hm), ['11:30']));
t('14:01 → 11:30 波次也过了窗口', () =>
    assert.deepStrictEqual(g.dueWaves(bj(14, 1)), []));
t('18:00 波次窗口只有 100 分钟：19:40 还查', () =>
    assert.deepStrictEqual(g.dueWaves(bj(19, 40)).map(w => w.hm), ['18:00']));
t('18:00 波次窗口只有 100 分钟：19:41 就不查了', () =>
    assert.deepStrictEqual(g.dueWaves(bj(19, 41)), []));
t('05:00 → 不在任何窗口，守卫空转退出', () =>
    assert.deepStrictEqual(g.dueWaves(bj(5, 0)), []));

console.log('[4] 「已经派发过」的判定');
const target = g.waveEpoch(0, bj(0, 30));
const nowAt = (h, m) => bj(h, m).getTime();
t('波次 00:00 的绝对时刻 = 北京当天 00:00', () =>
    assert.strictEqual(target, Date.UTC(2026, 10, 25, 16, 0)));
t('00:00:30 派发的 run → 算已派发', () =>
    assert.strictEqual(g.hasRunSince(['2026-11-25T16:00:30Z'], target, nowAt(0, 12)), true));
t('23:58 前一天的 run → 不算（绝对时间比较，不跨日误判）', () =>
    assert.strictEqual(g.hasRunSince(['2026-11-25T15:58:00Z'], target, nowAt(0, 12)), true)); // -2 分钟边界
t('23:57 前一天的 run → 不算', () =>
    assert.strictEqual(g.hasRunSince(['2026-11-25T15:57:00Z'], target, nowAt(0, 12)), false));
t('00:40 派发的 run → 算已派发（排队延后也算）', () =>
    assert.strictEqual(g.hasRunSince(['2026-11-25T16:40:00Z'], target, nowAt(0, 45)), true));
t('空列表 → 没派发过', () => assert.strictEqual(g.hasRunSince([], target, nowAt(0, 12)), false));
t('null → 没派发过', () => assert.strictEqual(g.hasRunSince(null, target, nowAt(0, 12)), false));
t('坏时间戳跳过，不抛异常', () =>
    assert.strictEqual(g.hasRunSince(['not-a-date', '2026-11-25T16:01:00Z'], target, nowAt(0, 12)), true));
t('未来时间的 run 不算（时钟偏差时也不抢跑）', () =>
    assert.strictEqual(g.hasRunSince(['2026-11-25T17:00:00Z'], target, nowAt(0, 12)), false));

console.log('[5] 幂等：守卫自己补的 run 必须能被下一轮认出来');
t('00:12 补发的 run，00:42 再检查 → 认作已派发，不再补（这是窄窗版本的真实缺陷）', () => {
    const afterDispatch = ['2026-11-25T16:12:00Z'];
    assert.strictEqual(g.hasRunSince(afterDispatch, target, nowAt(0, 42)), true);
});
t('同一批 runs 连判三次结果一致', () => {
    const runs = ['2026-11-25T16:03:00Z'];
    const r = [g.hasRunSince(runs, target, nowAt(0, 12)), g.hasRunSince(runs, target, nowAt(0, 42)), g.hasRunSince(runs, target, nowAt(2, 30))];
    assert.deepStrictEqual(r, [true, true, true]);
});
t('60 分钟后（01:12）仍认作已派发，不会因为窗口滑走而重复补', () =>
    assert.strictEqual(g.hasRunSince(['2026-11-25T16:12:00Z'], target, nowAt(1, 12)), true));

console.log('[6] 今天这次事故的回放');
t('00:00:30 与 00:00:35 两次 500 → 没有 run → 00:12 判为缺失并补发', () => {
    const runsToday = ['2026-11-25T22:00:29Z']; // 只有 06:00 那趟（UTC 22:00 = 北京 06:00）
    assert.strictEqual(g.hasRunSince(runsToday, target, nowAt(0, 12)), false, '应当判定为缺失');
    assert.deepStrictEqual(g.dueWaves(bj(0, 12)).map(w => w.hm), ['00:00'], '应当在 00:12 检查');
});
t('两条分支各自判定：master 缺、multi-boss 在，只补 master', () => {
    const masterRuns = [];
    const multiRuns = ['2026-11-25T16:00:31Z'];
    assert.strictEqual(g.hasRunSince(masterRuns, target, nowAt(0, 12)), false);
    assert.strictEqual(g.hasRunSince(multiRuns, target, nowAt(0, 12)), true);
});

console.log('[7] 取数口径（11-27 线上事故：单测全绿但线上永远认不出已有 run）');
// 事故：listCreatedAts 原来写 '--jq', '.workflow_runs[] | "\(.created_at)"'
// JS 单引号串吃掉 \( 的反斜杠 → gh 收到 "(.created_at)" → 输出字面量 → 全 NaN → 恒 false。
// 那 30 项单测只喂 hasRunSince 干净 ISO，压根没走取数这一层，所以没兜住。
function fakeGh(stdout) {
    const calls = [];
    g.__setExec((cmd, args) => { calls.push({ cmd, args }); return stdout; });
    return calls;
}
t('传给 gh 的 jq 里不许有反斜杠转义（它会被 JS 吃掉）', () => {
    const calls = fakeGh('2026-11-26T16:00:32Z');
    g.listCreatedAts('o/r', 'master');
    const jq = calls[0].args[calls[0].args.indexOf('--jq') + 1];
    assert.ok(!jq.includes('\\'), `jq 不该含反斜杠：${jq}`);
    assert.ok(jq.includes('.workflow_runs'), 'jq 应当取 workflow_runs');
    assert.ok(jq.includes('created_at'), 'jq 应当取 created_at');
});
t('正常 ISO 输出 → 原样返回', () => {
    fakeGh('2026-11-26T16:00:32Z\n2026-11-26T22:00:28Z');
    assert.deepStrictEqual(g.listCreatedAts('o/r', 'master'),
        ['2026-11-26T16:00:32Z', '2026-11-26T22:00:28Z']);
});
t('空输出 → 空数组（真的没 run，允许补发）', () => {
    fakeGh('');
    assert.deepStrictEqual(g.listCreatedAts('o/r', 'master'), []);
});
// ★ 证伪：把事故输出塞回去，必须抛错而不是静默当「没有 run」
t('事故输出 "(.created_at)" ×5 → 必须抛错，不许当成没派发', () => {
    fakeGh('(.created_at)\n(.created_at)\n(.created_at)\n(.created_at)\n(.created_at)');
    assert.throws(() => g.listCreatedAts('o/r', 'master'), /无可解析时间/);
});
t('部分坏行 + 一条好行 → 只返回好的（不因个别脏行误判）', () => {
    fakeGh('(.created_at)\n2026-11-26T16:00:32Z\n');
    assert.deepStrictEqual(g.listCreatedAts('o/r', 'master'), ['2026-11-26T16:00:32Z']);
});
t('坏取数必须走「本轮跳过」而不是补发：抛错可被 main 的 try/catch 接住', () => {
    fakeGh('(.created_at)');
    let caught = null;
    try { g.listCreatedAts('o/r', 'multi-boss'); } catch (e) { caught = e; }
    assert.ok(caught, '必须抛错');
    // 若上层吞掉这个错并当作空列表，hasRunSince 会返回 false → 误补发。断言错误不被当成数据。
    assert.strictEqual(g.hasRunSince([], target, nowAt(0, 12)), false);
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
