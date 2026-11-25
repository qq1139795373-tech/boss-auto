// qllm-daily.js 的离线单测（不登录、不开浏览器、不联网）
//
// 覆盖三件最容易错的事：
//   ① 时间窗口：06:00-08:59 才跑，0:00 / 11:30 / 18:00 必须跳过（否则会撞号或拆 5 人队）
//   ② 配对解析：格式写错要「少跑一对」，绝不能拿空账号去登录
//   ③ 次数判据：入口页「剩余 N 次」读不到时必须返回 null，绝不能当 0
//      （当成 0 = 以为今天做完了 → 白丢当天这一次，这是最贵的假阴性）
//
// 用法：node qllm-daily-test.js
const assert = require('assert');

// qllm-run.js 顶层会解析密码（缺密码直接 exit 2），require 前先垫两个假的。
// 两个都是小号（同类），account-pass 的「混类才能同密码」检查不会拦。
process.env.GAME_PASSWORD_LEADER = 'test-only';
process.env.GAME_PASSWORD_MEMBER = 'test-only';
const daily = require('./qllm-daily.js');
const runner = require('./qllm-run.js');

let n = 0;
let bad = 0;
function t(name, fn) {
    n++;
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (e) { bad++; console.log(`  ✗ ${name}\n      ${e && e.message}`); }
}

// 用带时区偏移的字符串构造北京时刻，避免依赖本机时区
const bj = (hhmm, date = '2026-11-23') => new Date(`${date}T${hhmm}:00+08:00`).getTime();

console.log('[qllm-daily-test] 时间窗口');
t('06:00 在窗口内（用户 11-23 23:39 把情侣副本挪到 06:00 趟）', () => assert.strictEqual(daily.shouldRunCouple(bj('06:00')), true));
t('06:30 在窗口内（runner 排队后最常见的实际启动时刻）', () => assert.strictEqual(daily.shouldRunCouple(bj('06:30')), true));
t('08:59 是窗口最后一分钟', () => assert.strictEqual(daily.shouldRunCouple(bj('08:59')), true));
t('09:00 已出窗口', () => assert.strictEqual(daily.shouldRunCouple(bj('09:00')), false));
t('★ 0:00 那趟必须跳过（两个分支都在跑副本，情侣双人本会在那里撞号）', () => assert.strictEqual(daily.shouldRunCouple(bj('00:00')), false));
t('02:59 也不许跑（0:00 趟的尾巴同样在跑 dawn）', () => assert.strictEqual(daily.shouldRunCouple(bj('02:59')), false));
t('11:30 那趟必须跳过（5 人队不能被拆）', () => assert.strictEqual(daily.shouldRunCouple(bj('11:30')), false));
t('18:00 那趟必须跳过', () => assert.strictEqual(daily.shouldRunCouple(bj('18:00')), false));
t('23:59 不在窗口（等到次日 06:00 再跑）', () => assert.strictEqual(daily.shouldRunCouple(bj('23:59')), false));
t('WINDOW_START_HOUR 导出为 6、WINDOW_END_HOUR 导出为 9（防止有人只改一边）', () => {
    assert.strictEqual(daily.WINDOW_START_HOUR, 6);
    assert.strictEqual(daily.WINDOW_END_HOUR, 9);
});

console.log('[qllm-daily-test] 配对解析');
t('★ 默认串必须是本分支那两对（4 个号；冷6 归 master，不能出现在这里）', () => {
    const p = daily.parseCouples(daily.DEFAULT_COUPLES);
    assert.strictEqual(p.length, 2);
    assert.deepStrictEqual(p.map((x) => `${x.leader}+${x.member}`), ['coldwind0+coldwind8', 'coldwind1+coldwind2']);
    assert.strictEqual(p[0].partnerNick, '笑嘻嘻');
    assert.strictEqual(p[1].partnerNick, '笑哈哈');
    // ★ 默认配对里绝不能出现大号或冷6：那两个号由 master 的 couple job 负责，
    //   两边同时登会互顶（QLLM_RESERVED 会拦，但默认值本来就不该写错）
    assert.ok(!p.some((x) => x.leader === 'coldwind6' || x.member === 'coldwind6'));
    assert.ok(!p.some((x) => x.leader === 'coldwind' || x.member === 'coldwind'));
});
t('多对按逗号拆开', () => {
    const p = daily.parseCouples('coldwind0:coldwind8:笑嘻嘻,coldwind1:coldwind2:笑哈哈');
    assert.strictEqual(p.length, 2);
    assert.strictEqual(p[1].partnerNick, '笑哈哈');
});
t('缺昵称仍可用（PARTNER_NICK 由脚本默认值兜底）', () => {
    const p = daily.parseCouples('coldwind1:coldwind2');
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].partnerNick, '');
});
t('只有队长、没有队员的项被丢弃（不拿空成员登录）', () => {
    assert.strictEqual(daily.parseCouples('coldwind0').length, 0);
    assert.strictEqual(daily.parseCouples('coldwind0:').length, 0);
    assert.strictEqual(daily.parseCouples(':coldwind8').length, 0);
});
t('空串/空白返回空数组', () => {
    assert.strictEqual(daily.parseCouples('').length, 0);
    assert.strictEqual(daily.parseCouples('   ').length, 0);
    assert.strictEqual(daily.parseCouples(undefined).length, 0);
});
t('坏项与好项混排时只丢坏项', () => {
    const p = daily.parseCouples('bad,coldwind0:coldwind8:笑嘻嘻');
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].leader, 'coldwind0');
});

console.log('[qllm-daily-test] 密码表');
t('正常账号表映射到小写键', () => {
    const m = daily.passwordTableFromEnv({ GAME_ACCOUNTS_JSON: '[{"account":"coldwind0","password":"p0"},{"account":"coldwind8","password":"p8"}]' });
    assert.strictEqual(m.get('coldwind0'), 'p0');
    assert.strictEqual(m.get('coldwind8'), 'p8');
});
t('字面量 null 密码被过滤（jq 取不到键会吐 "null"）', () => {
    const m = daily.passwordTableFromEnv({ GAME_ACCOUNTS_JSON: '[{"account":"coldwind0","password":"null"}]' });
    assert.strictEqual(m.size, 0);
});
t('非法 JSON 不抛异常，返回空表', () => {
    assert.strictEqual(daily.passwordTableFromEnv({ GAME_ACCOUNTS_JSON: 'not json' }).size, 0);
});
t('没有环境变量时返回空表', () => {
    assert.strictEqual(daily.passwordTableFromEnv({}).size, 0);
});
t('envKeyFor 与 account-pass 的读取键一致', () => {
    assert.strictEqual(daily.envKeyFor('coldwind0'), 'GAME_PASSWORD_COLDWIND0');
    assert.strictEqual(daily.envKeyFor('coldwind'), 'GAME_PASSWORD_COLDWIND');
});

console.log('[qllm-daily-test] 次数判据（入口页原文）');
// 真实原文（qllm-run-full*.log 里抓的）：
const REAL = '副本 情侣迷宫情侣副本 · 情侣副本：需与交往/已婚伴侣2人组队 · 1-999级开放请先创建或加入队伍进入副本（剩余1次）重置副本奖励兑换当前副本队伍（2）';
// 用完时的真实原文（2026-11-23 22:21 实跑抓的）：
const REAL_DONE = '副本 情侣迷宫情侣副本 · 情侣副本：需与交往/已婚伴侣2人组队 · 1-999级开放请先创建或加入队伍进入副本（次数已用尽）重置副本奖励兑换当前副本队伍（2）';
t('剩余 1 次 → 1（今天还能做）', () => assert.strictEqual(runner.runsLeftOf(REAL), 1));
t('剩余 0 次 → 0（今日已完成）', () => assert.strictEqual(runner.runsLeftOf(REAL.replace('剩余1次', '剩余0次')), 0));
t('★「次数已用尽」→ 0（页面真实文案，不是「剩余0次」）', () => assert.strictEqual(runner.runsLeftOf(REAL_DONE), 0));
t('半角括号也认', () => {
    assert.strictEqual(runner.runsLeftOf('进入副本(剩余0次)'), 0);
    assert.strictEqual(runner.runsLeftOf('进入副本(次数已用尽)'), 0);
});
t('★ 读不到必须返回 null，不能返回 0', () => {
    assert.strictEqual(runner.runsLeftOf('副本地图加载中'), null);
    assert.strictEqual(runner.runsLeftOf(''), null);
    assert.strictEqual(runner.runsLeftOf(undefined), null);
});
t('★ null 不等于 0（防止误判成今日已完成）', () => {
    assert.notStrictEqual(runner.runsLeftOf('页面还没加载出来'), 0);
});

console.log('[qllm-daily-test] 第一段退出码的去向');
t('0 → ok（要接着跑第二段）', () => assert.strictEqual(daily.classifyFirstStage(0), 'ok'));
t('3 → already-done（今日已完成，跳过第二段）', () => assert.strictEqual(daily.classifyFirstStage(3), 'already-done'));
t('1 / 2 / null / 负数 → fail（不跑第二段）', () => {
    assert.strictEqual(daily.classifyFirstStage(1), 'fail');
    assert.strictEqual(daily.classifyFirstStage(2), 'fail');
    assert.strictEqual(daily.classifyFirstStage(null), 'fail');
    assert.strictEqual(daily.classifyFirstStage(-1), 'fail');
});
t('★ 7 → leader-claim-fail（怪清完但队长没领到：要报错，但仍跑第二段）', () => {
    assert.strictEqual(daily.classifyFirstStage(7), 'leader-claim-fail');
    assert.notStrictEqual(daily.classifyFirstStage(7), 'fail', '不能当普通失败跳过第二段（队员那侧可能还能领）');
    assert.notStrictEqual(daily.classifyFirstStage(7), 'ok', '不能当成功（队长确实没领到）');
});
t('★ already-done 不能被当成失败（否则每天红叉）', () => {
    assert.notStrictEqual(daily.classifyFirstStage(3), 'fail');
});
t('★ fail 不能被当成 already-done（否则真失败被静默吞掉）', () => {
    assert.notStrictEqual(daily.classifyFirstStage(1), 'already-done');
});

console.log('[qllm-daily-test] 密码来源（两个分支凭据不同：master 只有大号 GAME_PASSWORD）');
{
    const table = new Map([['coldwind6', 'sub-pwd'], ['coldwind0', 'p0'], ['coldwind8', 'p8']]);
    t('账号表里有 → 用表里的（multi-boss 两个号都在表里）', () => {
        assert.deepStrictEqual(daily.passwordFor('coldwind0', table, {}), { password: 'p0', source: '账号表' });
    });
    t('表里没有且是大号 → 回落到 GAME_PASSWORD', () => {
        assert.strictEqual(daily.passwordFor('coldwind', table, { GAME_PASSWORD: 'main-pwd' }).password, 'main-pwd');
    });
    t('★ 表里没有且是小号 → 必须为空，绝不拿大号密码去登小号', () => {
        assert.strictEqual(daily.passwordFor('coldwind2', table, { GAME_PASSWORD: 'main-pwd' }).password, '');
    });
    t('大号的 GAME_PASSWORD 是字面量 null → 视为没有密码', () => {
        assert.strictEqual(daily.passwordFor('coldwind', table, { GAME_PASSWORD: 'null' }).password, '');
    });
    t('表 key 大小写不敏感（Coldwind6 也能命中）', () => {
        assert.strictEqual(daily.passwordFor('Coldwind6', table, {}).password, 'sub-pwd');
    });
    t('大号+冷6 跨类配对：两个号各自取到不同的密码', () => {
        const a = daily.passwordFor('coldwind', table, { GAME_PASSWORD: 'main-pwd' });
        const b = daily.passwordFor('coldwind6', table, { GAME_PASSWORD: 'main-pwd' });
        assert.strictEqual(a.password, 'main-pwd');
        assert.strictEqual(b.password, 'sub-pwd');
        assert.notStrictEqual(a.password, b.password);
    });
}

console.log('[qllm-daily-test] 跨分支保留账号（用户 11-23 23:14/23:17 两次点名的冲突点）');
{
    const mk = (leader, member) => ({ leader, member, partnerNick: '' });

    t('★ multi-boss 配到「大号+冷6」必须被拦（冷6 归 master 的 couple）', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: 'coldwind,coldwind6' });
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind', 'coldwind6'), res), ['coldwind', 'coldwind6']);
    });
    t('★ master 配到「冷0+冷8」必须被拦（这两个归 multi-boss）', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: 'coldwind0,coldwind1,coldwind2,coldwind8' });
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind0', 'coldwind8'), res), ['coldwind0', 'coldwind8']);
    });
    t('本分支自己那一对不该被拦（multi-boss: 冷0+冷8）', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: 'coldwind,coldwind6' });
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind0', 'coldwind8'), res), []);
    });
    t('本分支自己那一对不该被拦（master: 大号+冷6）', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: 'coldwind0,coldwind1,coldwind2,coldwind8' });
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind', 'coldwind6'), res), []);
    });
    t('只撞一个号也要拦（不能因为「有一半是自己的」就放行）', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: 'coldwind6' });
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind1', 'coldwind6'), res), ['coldwind6']);
    });
    t('大小写不敏感（COUPLES 里写成 ColdWind6 也拦得住）', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: 'COLDWIND6' });
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind', 'ColdWind6'), res), ['ColdWind6']);
    });
    t('未设 QLLM_RESERVED → 空集，任何对都放行（本地验证场景）', () => {
        assert.strictEqual(daily.reservedFromEnv({}).size, 0);
        assert.deepStrictEqual(daily.reservedHits(mk('coldwind', 'coldwind6'), daily.reservedFromEnv({})), []);
    });
    t('规格里有空项 / 多余逗号不产生空字符串账号', () => {
        const res = daily.reservedFromEnv({ QLLM_RESERVED: ' coldwind6 , , coldwind ' });
        assert.strictEqual(res.size, 2);
        assert.ok(!res.has(''));
    });
}

console.log('[qllm-daily-test] ★ 谁清怪（用户 11-23 23:24：大号那一对必须由大号刷怪）');
{
    const mk = (leader, member) => ({ leader, member, partnerNick: '' });

    t('★ 大号在队长位 → 正常（清怪由大号做，396s）', () => {
        assert.strictEqual(daily.mainInMemberSlot(mk('coldwind', 'coldwind6')), false);
    });
    t('★ 大号被放到队员位 → 必须报警（清怪会落到 132 级小号身上，约翻倍）', () => {
        assert.strictEqual(daily.mainInMemberSlot(mk('coldwind6', 'coldwind')), true);
    });
    t('两个都是小号 → 不报警（multi-boss 的两对本来就该这样）', () => {
        assert.strictEqual(daily.mainInMemberSlot(mk('coldwind0', 'coldwind8')), false);
        assert.strictEqual(daily.mainInMemberSlot(mk('coldwind1', 'coldwind2')), false);
    });
}

console.log(`\n[qllm-daily-test] ${n - bad}/${n} 通过${bad ? `，${bad} 项失败` : ''}`);
process.exit(bad ? 1 : 0);
