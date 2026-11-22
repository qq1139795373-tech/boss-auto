// account-pass.js 的离线单测：钉住「大号小号密码不一样，不要弄错」这条铁律
// 跑法：node account-pass-test.js
//
// 重点覆盖三类必错场景：
//   1. 缺密码时**绝不回落默认值**（回落到任一边都是登错号）；
//   2. `jq -r` 取不到键吐出字面量 "null" → 必须当「没有密码」，不能拿 "null" 去登录；
//   3. 一次运行共用一份密码时混入大号+小号 → 必须报错，而不是硬登。
const assert = require('assert');
const pass = require('./account-pass.js');

let n = 0; let bad = 0;
function t(name, fn) {
    n++;
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (e) { bad++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function throws(fn, re) {
    let msg = '';
    try { fn(); } catch (e) { msg = e.message; }
    assert.ok(msg, '预期抛错，但没有抛');
    if (re) assert.ok(re.test(msg), `报错信息不含 ${re}：${msg}`);
}

console.log('[1] 账号分类（大号 / 小号 / 认不出）');
t('coldwind = 大号', () => assert.equal(pass.kindOf('coldwind'), 'main'));
t('coldwind0/1/2/6/8 = 小号', () => {
    for (const a of ['coldwind0', 'coldwind1', 'coldwind2', 'coldwind6', 'coldwind8']) assert.equal(pass.kindOf(a), 'sub');
});
t('大小写不敏感（COLDWIND6 仍是小号）', () => assert.equal(pass.kindOf(' COLDWIND6 '), 'sub'));
t('空账号 → unknown', () => assert.equal(pass.kindOf(''), 'unknown'));
t('陌生账号 → other', () => assert.equal(pass.kindOf('coldwindx'), 'other'));

console.log('\n[2] 密码取值：只认环境变量，绝不给默认值');
t('大号密码原样使用', () => {
    const r = pass.resolve('coldwind', { GAME_ACCOUNT: 'coldwind', GAME_PASSWORD: 'P_MAIN' });
    assert.equal(r.password, 'P_MAIN');
    assert.equal(r.kind, 'main');
    assert.equal(r.source, 'GAME_PASSWORD');
});
t('小号密码原样使用（与大号互不干扰）', () => {
    const r = pass.resolve('coldwind6', { GAME_PASSWORD: 'P_SUB' });
    assert.equal(r.password, 'P_SUB');
    assert.equal(r.kind, 'sub');
});
t('两个号各自解析出各自的密码', () => {
    const env = { GAME_PASSWORD_COLDWIND: 'P_MAIN', GAME_PASSWORD_COLDWIND6: 'P_SUB' };
    assert.equal(pass.resolve('coldwind', env).password, 'P_MAIN');
    assert.equal(pass.resolve('coldwind6', env).password, 'P_SUB');
});
t('缺密码 → 抛错且点名账号类别', () => {
    throws(() => pass.resolve('coldwind', {}), /大号/);
    throws(() => pass.resolve('coldwind2', {}), /小号/);
});
t('字面量 null / undefined / 空串 / 纯空格 → 都算没有密码', () => {
    for (const v of ['null', 'NULL', 'undefined', '', '   ']) {
        throws(() => pass.resolve('coldwind0', { GAME_PASSWORD: v }), /没有可用密码/);
    }
});
t('密码首尾空格被裁掉（不把空格填进密码框）', () => {
    assert.equal(pass.resolve('coldwind0', { GAME_PASSWORD: '  P_SUB  ' }).password, 'P_SUB');
});
t('角色专属变量优先于公用变量', () => {
    const env = { GAME_PASSWORD: 'COMMON', GAME_PASSWORD_LEADER: 'L' };
    assert.equal(pass.resolve('coldwind', env, 'LEADER').password, 'L');
    assert.equal(pass.resolve('coldwind8', env, 'MEMBER').password, 'COMMON');
});

console.log('\n[3] 同进程登多个号：混类必须拦，同类放行');
t('同类（小号+小号）用一份密码 → 放行', () => {
    assert.doesNotThrow(() => pass.assertSameClass(['coldwind0', 'coldwind8']));
});
t('混类（大号+小号）用一份密码 → 报错并说明拆开跑', () => {
    throws(() => pass.assertSameClass(['coldwind', 'coldwind6']), /密码不同/);
});
t('陌生账号名 → 报错（防手滑写错账号）', () => {
    throws(() => pass.assertSameClass(['coldwindx']), /不在已知名单/);
});
t('两个号都吃公用 GAME_PASSWORD 且混类 → 报错', () => {
    const env = { GAME_PASSWORD: 'P' };
    const a = pass.resolve('coldwind', env, 'LEADER');
    const b = pass.resolve('coldwind6', env, 'MEMBER');
    throws(() => pass.assertDistinctPasswords([a, b]), /同一份 GAME_PASSWORD/);
});
t('两个号分别给了角色专属密码 → 放行（情侣迷宫 大号+冷6 的正确姿势）', () => {
    const env = { GAME_PASSWORD_LEADER: 'P_MAIN', GAME_PASSWORD_MEMBER: 'P_SUB' };
    const a = pass.resolve('coldwind', env, 'LEADER');
    const b = pass.resolve('coldwind6', env, 'MEMBER');
    assert.equal(a.password, 'P_MAIN');
    assert.equal(b.password, 'P_SUB');
    assert.doesNotThrow(() => pass.assertDistinctPasswords([a, b]));
});
t('memberclaim 只登队员：队长为 null 时不该被拦', () => {
    const b = pass.resolve('coldwind2', { GAME_PASSWORD: 'P_SUB' }, 'MEMBER');
    assert.doesNotThrow(() => pass.assertDistinctPasswords([null, b]));
});

console.log('\n[4] 日志摘要不泄露密码');
t('describe 只报账号+来源', () => {
    const r = pass.resolve('coldwind', { GAME_PASSWORD: 'P_SECRET' });
    const s = pass.describe(r);
    assert.ok(s.includes('coldwind') && s.includes('大号') && s.includes('GAME_PASSWORD'), s);
    assert.ok(!s.includes('P_SECRET'), '摘要里出现了密码明文：' + s);
});

console.log(`\n结果: ${n - bad} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
