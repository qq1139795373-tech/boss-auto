// team5-form.js 的离线单测：时间窗口 + 密码来源拆分
// 跑法：node team5-schedule-test.js
const assert = require('assert');
const { shouldFormTeam, buildEnv, bjNow, envInt, TEAM5_ATTEMPTS } = require('./team5-form.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
// 北京 2026-11-22 某时某分 → 对应 UTC 时间戳
const bj = (h, m) => Date.UTC(2026, 10, 22, h - 8, m, 0);

console.log('[1] 组队时间窗口（11:15~11:55，boss 时段 11:30-12:30 共 60 分钟）');
t('11:14 不组（差 1 分钟）', () => assert.strictEqual(shouldFormTeam(bj(11, 14)), false));
t('11:15 组（窗口起点）', () => assert.strictEqual(shouldFormTeam(bj(11, 15)), true));
t('11:40 组（推荐派发时刻，余量充足）', () => assert.strictEqual(shouldFormTeam(bj(11, 40)), true));
t('11:45 组（旧上限已作废，仍然放行）', () => assert.strictEqual(shouldFormTeam(bj(11, 45)), true));
t('11:50 组（迟到派发也救：约 11:53 组完，仍有 37 分钟打 boss）', () => assert.strictEqual(shouldFormTeam(bj(11, 50)), true));
t('11:55 组（窗口终点：约 11:58 组完，剩 30 分钟）', () => assert.strictEqual(shouldFormTeam(bj(11, 55)), true));
t('11:56 不组（再启动，加成只剩半小时不到）', () => assert.strictEqual(shouldFormTeam(bj(11, 56)), false));
t('12:00 不组（boss 只剩 30 分钟，组队没意义）', () => assert.strictEqual(shouldFormTeam(bj(12, 0)), false));

console.log('\n[2] 其他派发时刻一律不组（0:00 副本会拆队）');
t('00:00 不组', () => assert.strictEqual(shouldFormTeam(bj(0, 0)), false));
t('06:00 不组', () => assert.strictEqual(shouldFormTeam(bj(6, 0)), false));
t('18:00 不组', () => assert.strictEqual(shouldFormTeam(bj(18, 0)), false));
t('20:00 不组', () => assert.strictEqual(shouldFormTeam(bj(20, 0)), false));

console.log('\n[3] 全天逐分扫描：只在窗口内为 true');
t('全天 1440 分钟只有 41 分钟为 true（11:15~11:55）', () => {
    let hits = [];
    for (let m = 0; m < 1440; m++) {
        const h = Math.floor(m / 60), mm = m % 60;
        if (shouldFormTeam(bj(h, mm))) hits.push(m);
    }
    assert.strictEqual(hits.length, 41, `实际 ${hits.length} 分钟`);
    assert.strictEqual(hits[0], 11 * 60 + 15);
    assert.strictEqual(hits[hits.length - 1], 11 * 60 + 55);
});
t('窗口内没有任何一分钟落在 11:56 之后（给 boss 至少留 34 分钟）', () => {
    for (let m = 11 * 60 + 56; m < 12 * 60; m++) {
        const h = Math.floor(m / 60), mm = m % 60;
        assert.strictEqual(shouldFormTeam(bj(h, mm)), false, `${h}:${mm} 不该放行`);
    }
});

console.log('\n[3b] 组队重试轮数（失败重试四次 = 共 5 轮，非法值回退默认）');
t('默认 5 轮', () => assert.strictEqual(envInt(undefined, 5, 1, 5), 5));
t('空串 / 非数字 → 回退默认 5', () => {
    assert.strictEqual(envInt('', 5, 1, 5), 5);
    assert.strictEqual(envInt('abc', 5, 1, 5), 5);
    assert.strictEqual(envInt('null', 5, 1, 5), 5);
});
t('越界（0 / 6 / 负数）→ 回退默认 5', () => {
    assert.strictEqual(envInt('0', 5, 1, 5), 5);
    assert.strictEqual(envInt('6', 5, 1, 5), 5);
    assert.strictEqual(envInt('-2', 5, 1, 5), 5);
});
t('合法值 1 / 5 原样生效', () => {
    assert.strictEqual(envInt('1', 5, 1, 5), 1);
    assert.strictEqual(envInt('5', 5, 1, 5), 5);
});
t('★ 默认必须是 5（用户 11-24：只有三次重试的统一加到 5 次）', () => assert.strictEqual(TEAM5_ATTEMPTS, 5));

console.log('\n[3c] 登录必须真进主界面（11-25 冷1 卡选角页 → 组队死锁 4/5）');
{
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(path.join(__dirname, 'team5-form.js'), 'utf8');
    t('点击「进入游戏」走 daily.clickEnterGame（坐标/合成事件/force 三层），不再用 clickText', () => {
        assert.ok(/daily\.clickEnterGame\(page\)/.test(SRC), '没有用强点击');
        assert.ok(!/daily\.clickText\(page, '进入游戏'/.test(SRC), '仍在用会静默失效的 clickText');
    });
    t('enterMain 存在且失败时返回 false（不许假装成功）', () => {
        const m = SRC.match(/async function enterMain\(page\)[\s\S]*?\n}\n/);
        assert.ok(m, '没有 enterMain 函数');
        assert.ok(/return false;/.test(m[0]), 'enterMain 不会返回 false');
    });
    t('login 里旧的「点 8 次 clickText 然后 return true」已移除', () => {
        const m = SRC.match(/async function login\(page, acc, pwd\)[\s\S]*?\n}\n/);
        assert.ok(m, '没有 login 函数');
        assert.ok(!/for \(let i = 0; i < 8; i\+\+\)/.test(m[0]), '旧的 8 次循环还在（点不进去也当成功）');
        assert.ok(/enterMain\(page\)/.test(m[0]), 'login 没有调到 enterMain');
    });
    t('登录失败的号要从 P 里剔除（不留着空点邀请）', () => {
        assert.ok(/if \(!ok\) \{[\s\S]{0,200}delete P\[a\]/.test(SRC), '登录失败没有清掉页面');
    });
}

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
