// job-gate.js 的单测（纯逻辑，不联网）
//
// 为什么值得单独测：这个闸门是「两个分支共用一个账号」唯一的隔离手段，判错一次就是
// 「情侣副本次数被扣、奖没领」——一天只有 1 次。所以不测「能不能跑通」，而测三类东西：
//   ① 决策表：对方 done / running / absent / error 四种状态 × 窗口内外 × 兜底/硬顶前后
//   ② 不变量：只要对方还在跑，任何时刻都不放行（除非到了硬顶）；只要观测失效，兜底前不放行
//   ③ ★ 配置漂移：直接读两个仓库真实的 boss.yml，把 JOB_GATE 串解析出来断言字段
//      （写错一个字符 → 闸门失效 → 撞号，而人眼看不出，必须让测试看）
//
// 用法：node job-gate-test.js
const assert = require('assert');
const fs = require('fs');
const gate = require('./job-gate.js');

let n = 0;
let bad = 0;
function t(name, fn) {
    n++;
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (e) { bad++; console.log(`  ✗ ${name}\n      ${e && e.message}`); }
}

const bj = (hhmm, date = '2026-11-23') => new Date(`${date}T${hhmm}:00+08:00`).getTime();
const min = (hhmm) => gate.parseHm(hhmm);

console.log('[job-gate-test] 规格解析');
t('标准写法：账号=分支/job@兜底..硬顶#窗口', () => {
    const m = gate.parseGateSpec('coldwind6=master/couple@06:55..07:05#06:00-07:10');
    const e = m.get('coldwind6');
    assert.ok(e, 'coldwind6 没解析出来');
    assert.strictEqual(e.branch, 'master');
    assert.strictEqual(e.job, 'couple');
    assert.strictEqual(e.fallbackMin, min('06:55'));
    assert.strictEqual(e.ceilingMin, min('07:05'));
    assert.strictEqual(e.windowStartMin, min('06:00'));
    assert.strictEqual(e.windowEndMin, min('07:10'));
});
t('* 表示 job 内所有号（单号 job 用，不必写死账号名）', () => {
    const m = gate.parseGateSpec('*=multi-boss/form@11:50..11:55#11:25-11:59');
    assert.ok(m.get('*'));
    assert.strictEqual(m.get('*').job, 'form');
});
t('账号名大小写不敏感（GAME_ACCOUNT 来自账号表，别因大小写失效）', () => {
    const m = gate.parseGateSpec('ColdWind6=master/couple@06:55..07:05');
    assert.ok(m.get('coldwind6'));
});
t('缺 #窗口 → 全天生效（但那样每趟都会等，慎用）', () => {
    const m = gate.parseGateSpec('a=master/couple@06:55..07:05');
    assert.strictEqual(m.get('a').windowStartMin, 0);
    assert.strictEqual(m.get('a').windowEndMin, 24 * 60);
});
t('写坏的项丢弃但收集错误（不静默失效）', () => {
    const errs = [];
    const m = gate.parseGateSpec('bad,also=bad@x..y,c=master/couple@06:55..07:05#06:00-07:10', errs);
    assert.strictEqual(m.size, 1);
    assert.ok(errs.length >= 2, `应至少报 2 条错误，实际 ${errs.length}`);
});
t('硬顶必须晚于兜底，写反丢弃', () => {
    const errs = [];
    const m = gate.parseGateSpec('a=master/couple@07:05..06:55', errs);
    assert.strictEqual(m.size, 0);
    assert.ok(errs.some((e) => e.includes('硬顶')));
});
t('分钟换算是对的（06:55 = 415）', () => {
    assert.strictEqual(gate.parseHm('06:55'), 415);
    assert.strictEqual(gate.hhmm(415), '06:55');
});

console.log('\n[job-gate-test] 北京时间换算');
t('UTC 22:00 = 北京 06:00 → 第 360 分钟', () => {
    assert.strictEqual(Math.round(gate.minutesOfDayBJ(bj('06:00'))), 360);
});
t('UTC 16:00 = 北京 0:00 → 第 0 分钟', () => {
    assert.strictEqual(Math.round(gate.minutesOfDayBJ(bj('00:00'))), 0);
});
t('北京 23:30 不会被算成负数或跨天错位', () => {
    assert.strictEqual(Math.round(gate.minutesOfDayBJ(bj('23:30'))), 1410);
});

console.log('\n[job-gate-test] 决策表');
const E = gate.parseGateSpec('coldwind6=master/couple@06:55..07:05#06:00-07:10').get('coldwind6');
const ctx = (nowMin, state, absentSinceMin = null) => ({ nowMin, state, absentSinceMin });

t('窗口外（0:00）→ 立刻放行，一次 API 都不用调', () => {
    const d = gate.decide(ctx(0, 'error'), E);
    assert.strictEqual(d.action, 'release');
});
t('窗口外（11:30 那趟）→ 立刻放行', () => {
    assert.strictEqual(gate.decide(ctx(690, 'running'), E).action, 'release');
});
t('窗口外（18:00 那趟）→ 立刻放行', () => {
    assert.strictEqual(gate.decide(ctx(1080, 'running'), E).action, 'release');
});
t('★ 对方已结束 → 立刻放行（不白等到兜底钟点）', () => {
    const d = gate.decide(ctx(365, 'done'), E);
    assert.strictEqual(d.action, 'release');
});
t('对方还在跑 → 继续等（不是按钟点放行）', () => {
    const d = gate.decide(ctx(400, 'running'), E);
    assert.strictEqual(d.action, 'wait');
    assert.strictEqual(d.waitMs, gate.POLL_MS);
});
t('对方还在跑但已过硬顶 → 告警放行', () => {
    const d = gate.decide(ctx(426, 'running'), E);   // 07:06
    assert.strictEqual(d.action, 'release');
    assert.strictEqual(d.warn, true);
});
t('run 里没有这个 job → 先观察，不立刻放行（躲 job 创建延迟）', () => {
    const d = gate.decide(ctx(365, 'absent', null), E);
    assert.strictEqual(d.action, 'wait');
});
t('观察满 3 分钟仍没有这个 job → 判定对方这趟不跑，放行', () => {
    const d = gate.decide(ctx(369, 'absent', 366), E);
    assert.strictEqual(d.action, 'release');
});
t('观测失效（没 token）→ 等到兜底钟点，不提前放行', () => {
    const d = gate.decide(ctx(400, 'error'), E);
    assert.strictEqual(d.action, 'wait');
});
t('观测失效且已到兜底钟点 → 告警放行', () => {
    const d = gate.decide(ctx(416, 'error'), E);
    assert.strictEqual(d.action, 'release');
    assert.strictEqual(d.warn, true);
});

console.log('\n[job-gate-test] 不变量（证伪：改坏逻辑必须被这些断言抓住）');
t('★ 对方 running 时，窗口内任何一分钟都不放行（除非 ≥ 硬顶）', () => {
    for (let m = E.windowStartMin; m < E.windowEndMin; m++) {
        const d = gate.decide(ctx(m, 'running'), E);
        if (m >= E.ceilingMin) assert.strictEqual(d.action, 'release', `${gate.hhmm(m)} 过了硬顶却还在等`);
        else assert.strictEqual(d.action, 'wait', `${gate.hhmm(m)} 对方还在跑却放行了 —— 会撞号`);
    }
});
t('★ 观测失效时，兜底钟点前任何一分钟都不放行', () => {
    for (let m = E.windowStartMin; m < E.fallbackMin; m++) {
        assert.strictEqual(gate.decide(ctx(m, 'error'), E).action, 'wait', `${gate.hhmm(m)} 提前放行了`);
    }
});
t('★ 兜底留了足够余量：兜底 ≥ 对方 job 硬超时 + 20 分钟排队余量', () => {
    // master 那对 timeout-minutes: 25（清怪预算 20 + Setup 3 + 领奖 2）
    const MASTER_COUPLE_CAP = 25;
    assert.ok(E.fallbackMin - E.windowStartMin >= MASTER_COUPLE_CAP + 20,
        `兜底只比窗口起点晚 ${E.fallbackMin - E.windowStartMin} 分钟，不够 ${MASTER_COUPLE_CAP}+20`);
    assert.ok(E.ceilingMin >= E.fallbackMin + 5, '硬顶离兜底太近，观测失效时没有二次缓冲');
});

console.log('\n[job-gate-test] ★ 真实配置（防止 yml 改坏而单测全绿）');
function specFromYml(file) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/^\s*JOB_GATE:\s*'([^']+)'/m);
    return m ? m[1] : null;
}
// 两个仓库各持一条闸门（multi-boss 等 master 的 couple、master 等 multi-boss 的 form），
// 本文件两个目录各有一份，所以按「本目录 + 兄弟目录」一起收，不写死谁是谁。
const path = require('path');
const sibling = path.basename(process.cwd()) === 'boss-auto-master' ? '../boss-auto' : '../boss-auto-master';
const specs = [
    specFromYml('.github/workflows/boss.yml'),
    specFromYml(path.join(sibling, '.github/workflows/boss.yml')),
].filter(Boolean);
const parsed = new Map();
for (const sp of specs) for (const [k, v] of gate.parseGateSpec(sp)) parsed.set(`${k}@${v.branch}/${v.job}`, { spec: sp, entry: v });

t('两份 boss.yml 都配了 JOB_GATE（任一缺失都说明闸门被删掉了）', () => {
    assert.strictEqual(specs.length, 2, `只找到 ${specs.length} 份 JOB_GATE`);
});
t('冷6 → master/couple，窗口覆盖 06:00（情侣副本已挪到 06:00 趟）', () => {
    const hit = [...parsed.entries()].find(([k]) => k.startsWith('coldwind6@master/couple'));
    assert.ok(hit, `没找到 coldwind6→master/couple 的闸门，现有：${[...parsed.keys()].join(' / ')}`);
    const e = hit[1].entry;
    assert.ok(e.windowStartMin <= min('06:00') && e.windowEndMin > min('06:30'), '窗口必须罩住 06:00~06:30');
    assert.ok(e.fallbackMin - e.windowStartMin >= 45, '兜底离窗口起点不足 45 分钟（25 分钟硬顶 + 20 分钟排队余量）');
});
t('* → multi-boss/form，窗口覆盖 11:30', () => {
    const hit = [...parsed.entries()].find(([k]) => k.startsWith('*@multi-boss/form'));
    assert.ok(hit, `没找到 *→multi-boss/form 的闸门，现有：${[...parsed.keys()].join(' / ')}`);
    const e = hit[1].entry;
    assert.ok(e.windowStartMin <= min('11:30') && e.windowEndMin > min('11:30'), '窗口必须罩住 11:30 那趟');
});

console.log(`\n[job-gate-test] ${n - bad}/${n} 通过${bad ? `，${bad} 项失败` : ''}`);
process.exit(bad ? 1 : 0);
