// team5-form.js 的离线单测：时间窗口 + 密码来源拆分
// 跑法：node team5-schedule-test.js
const assert = require('assert');
const { shouldFormTeam, buildEnv, bjNow } = require('./team5-form.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
// 北京 2026-11-22 某时某分 → 对应 UTC 时间戳
const bj = (h, m) => Date.UTC(2026, 10, 22, h - 8, m, 0);

console.log('[1] 组队时间窗口（11:15~11:45）');
t('11:14 不组（差 1 分钟）', () => assert.strictEqual(shouldFormTeam(bj(11, 14)), false));
t('11:15 组（窗口起点）', () => assert.strictEqual(shouldFormTeam(bj(11, 15)), true));
t('11:40 组（推荐派发时刻，余量 6 分钟以上）', () => assert.strictEqual(shouldFormTeam(bj(11, 40)), true));
t('11:45 组（能启动的极限：最坏 5.75 分钟组完，boss 那边刚好要开打）', () => assert.strictEqual(shouldFormTeam(bj(11, 45)), true));
t('11:46 不组（再启动就赶不上了）', () => assert.strictEqual(shouldFormTeam(bj(11, 46)), false));
t('11:50 不组（boss 已开打，组完前面几分钟的加成吃不到）', () => assert.strictEqual(shouldFormTeam(bj(11, 50)), false));
t('11:55 不组（旧窗口终点，已作废）', () => assert.strictEqual(shouldFormTeam(bj(11, 55)), false));
t('12:00 不组', () => assert.strictEqual(shouldFormTeam(bj(12, 0)), false));

console.log('\n[2] 其他派发时刻一律不组（0:00 副本会拆队）');
t('00:00 不组', () => assert.strictEqual(shouldFormTeam(bj(0, 0)), false));
t('06:00 不组', () => assert.strictEqual(shouldFormTeam(bj(6, 0)), false));
t('18:00 不组', () => assert.strictEqual(shouldFormTeam(bj(18, 0)), false));
t('20:00 不组', () => assert.strictEqual(shouldFormTeam(bj(20, 0)), false));

console.log('\n[3] 全天逐分扫描：只在窗口内为 true');
t('全天 1440 分钟只有 31 分钟为 true（11:15~11:45）', () => {
    let hits = [];
    for (let m = 0; m < 1440; m++) {
        const h = Math.floor(m / 60), mm = m % 60;
        if (shouldFormTeam(bj(h, mm))) hits.push(m);
    }
    assert.strictEqual(hits.length, 31, `实际 ${hits.length} 分钟`);
    assert.strictEqual(hits[0], 11 * 60 + 15);
    assert.strictEqual(hits[hits.length - 1], 11 * 60 + 45);
});
t('窗口内没有任何一分钟落在 11:46 之后（不与 boss 派发时刻重叠）', () => {
    for (let m = 11 * 60 + 46; m < 12 * 60; m++) {
        const h = Math.floor(m / 60), mm = m % 60;
        assert.strictEqual(shouldFormTeam(bj(h, mm)), false, `${h}:${mm} 不该放行`);
    }
});

console.log('\n[4] bjNow 时区换算');
t('UTC 03:40 → 北京 11:40', () => {
    const { hour, min } = bjNow(Date.UTC(2026, 10, 22, 3, 40, 0));
    assert.deepStrictEqual({ hour, min }, { hour: 11, min: 40 });
});
t('UTC 16:00 → 北京次日 00:00', () => {
    const { hour, min } = bjNow(Date.UTC(2026, 10, 22, 16, 0, 0));
    assert.deepStrictEqual({ hour, min }, { hour: 0, min: 0 });
});

console.log('\n[5] buildEnv：账号表拆成每号一份密码');
t('JSON 里两个号的密码各自拆开', () => {
    const env = buildEnv({ GAME_ACCOUNTS_JSON: JSON.stringify([
        { account: 'coldwind0', password: 'S0' },
        { account: 'coldwind8', password: 'S8' },
    ]) });
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND0, 'S0');
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND8, 'S8');
});
t('secrets.GAME_ACCOUNT/GAME_PASSWORD 注入大号', () => {
    const env = buildEnv({ GAME_ACCOUNT: 'coldwind', GAME_PASSWORD: 'MAIN' });
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND, 'MAIN');
});
t('大号密码不会被小号的公用值覆盖（JSON 有该号时以 JSON 为准）', () => {
    const env = buildEnv({
        GAME_ACCOUNT: 'coldwind', GAME_PASSWORD: 'MAIN',
        GAME_ACCOUNTS_JSON: JSON.stringify([{ account: 'coldwind', password: 'FROM_JSON' }]),
    });
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND, 'FROM_JSON');
});
t('缺 password / 空串 / "null" 的项跳过', () => {
    const env = buildEnv({ GAME_ACCOUNTS_JSON: JSON.stringify([
        { account: 'coldwind0' },
        { account: 'coldwind1', password: '' },
        { account: 'coldwind2', password: 'null' },
        { account: 'coldwind8', password: 'OK' },
    ]) });
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND0, undefined);
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND1, undefined);
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND2, undefined);
    assert.strictEqual(env.GAME_PASSWORD_COLDWIND8, 'OK');
});
t('JSON 非法不崩，返回原 env', () => {
    const env = buildEnv({ GAME_ACCOUNTS_JSON: '{oops' });
    assert.strictEqual(env.GAME_ACCOUNTS_JSON, '{oops');
});
t('账号名带连字符/小写也规范化成大写下划线', () => {
    const env = buildEnv({ GAME_ACCOUNTS_JSON: JSON.stringify([{ account: 'ab-cd', password: 'X' }]) });
    assert.strictEqual(env.GAME_PASSWORD_AB_CD, 'X');
});
t('空账号名不产生垃圾键', () => {
    const env = buildEnv({ GAME_ACCOUNTS_JSON: JSON.stringify([{ password: 'X' }]) });
    assert.strictEqual(Object.keys(env).filter((k) => k.startsWith('GAME_PASSWORD_') && k !== 'GAME_PASSWORD').length, 0);
});

console.log('\n[6] 与 account-pass 联动：大号小号互不串');
t('拆完之后大号取大号密码、小号取小号密码', () => {
    const pass = require('./account-pass.js');
    const env = buildEnv({
        GAME_ACCOUNT: 'coldwind', GAME_PASSWORD: 'MAIN123',
        GAME_ACCOUNTS_JSON: JSON.stringify([
            { account: 'coldwind0', password: 'SUB123' },
            { account: 'coldwind1', password: 'SUB123' },
            { account: 'coldwind2', password: 'SUB123' },
            { account: 'coldwind8', password: 'SUB123' },
        ]),
    });
    assert.strictEqual(pass.resolve('coldwind', env).password, 'MAIN123');
    assert.strictEqual(pass.resolve('coldwind8', env).password, 'SUB123');
    assert.strictEqual(pass.resolve('coldwind0', env).kind, 'sub');
    assert.strictEqual(pass.resolve('coldwind', env).kind, 'main');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
