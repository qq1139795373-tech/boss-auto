// dispatch-window.js 单测：判定「被顶号时是否处在本趟之外的另一趟 CI 派发窗口」
// 运行：node dispatch-window-test.js
const assert = require('assert');
const {
    isNearDispatch, bjMinuteOf, minutesToNearestAnchor,
    DISPATCH_ANCHORS_MIN, DISPATCH_WINDOW_MIN,
} = require('./dispatch-window.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✘ ${name}\n      ${e.message}`); fail++; }
}

// 北京时间 → epoch ms（不受运行环境 TZ 影响）
function bj(y, m, d, hh, mm) {
    return Date.UTC(y, m - 1, d, hh, mm) - 8 * 3600 * 1000;
}

console.log('\n[1] 四个派发点本身都落在窗口内');
for (const [hh, mm] of [[0, 0], [6, 0], [11, 30], [18, 0]]) {
    t(`北京 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} → 窗口内`, () => {
        assert.strictEqual(isNearDispatch(bj(2026, 11, 23, hh, mm)), true);
    });
}

console.log('\n[2] 窗口边界（±40 分钟含、±41 分钟不含）');
t('11:30 派发：10:50 含、10:49 不含', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 10, 50)), true);
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 10, 49)), false);
});
t('11:30 派发：12:10 含、12:11 不含', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 12, 10)), true);
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 12, 11)), false);
});
t('18:00 派发：17:20 含、17:19 不含', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 17, 20)), true);
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 17, 19)), false);
});

console.log('\n[3] 跨 0 点环绕（23:30 距 00:00 是 30 分钟，不是 1410）');
t('23:30 → 窗口内', () => assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 23, 30)), true));
t('23:19 → 窗口外', () => assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 23, 19)), false));
t('00:40 → 窗口内', () => assert.strictEqual(isNearDispatch(bj(2026, 11, 24, 0, 40)), true));
t('00:41 → 窗口外', () => assert.strictEqual(isNearDispatch(bj(2026, 11, 24, 0, 41)), false));
t('minutesToNearestAnchor(1430=23:50) = 10', () => assert.strictEqual(minutesToNearestAnchor(1430), 10));

console.log('\n[4] 真实场景（这几条是改动的理由，不能回归）');
t('★ 06:00 趟的 farm 在 11:30 被组队顶掉 → 判 CI 交接（必须退场，不能重登抢号）', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 11, 31)), true);
});
t('★ 用户 20:11 手动登录把 farm 顶掉 → 判手动占用（必须等，不能退场）', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 20, 11)), false);
});
t('用户 15:00 手动玩 → 判手动占用', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 15, 0)), false);
});
t('用户 21:30 手动玩 → 判手动占用', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 21, 30)), false);
});
t('11:30 趟自己的 farm 约 12:30 起跑，此时不算派发窗口（否则用户 12:40 玩会被误判）', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 12, 30)), false);
});
t('18:00 趟自己的 farm 约 18:35 起跑，19:00 之后不算派发窗口', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 19, 0)), false);
});
t('0:00 趟的 farm 在 06:00 被下一趟顶掉 → 判 CI 交接', () => {
    assert.strictEqual(isNearDispatch(bj(2026, 11, 23, 6, 0)), true);
});

console.log('\n[5] 全天不变量');
t('一天 1440 分钟里落在窗口内的正好 4×(40×2+1)=324 分钟', () => {
    let inside = 0;
    for (let m = 0; m < 1440; m++) {
        // 用一个北京时间的当天分钟数换回 epoch：取 2026-11-23 00:00 北京为基准
        const ms = bj(2026, 11, 23, 0, 0) + m * 60000;
        if (isNearDispatch(ms)) inside++;
    }
    assert.strictEqual(inside, DISPATCH_ANCHORS_MIN.length * (DISPATCH_WINDOW_MIN * 2 + 1));
    assert.strictEqual(inside, 324);
});
t('窗口之间彼此不重叠（最密的相邻锚点是 0:00 与 6:00，相隔 360 分钟）', () => {
    const gaps = [];
    for (let i = 0; i < DISPATCH_ANCHORS_MIN.length; i++) {
        const a = DISPATCH_ANCHORS_MIN[i];
        const b = i + 1 < DISPATCH_ANCHORS_MIN.length ? DISPATCH_ANCHORS_MIN[i + 1] : DISPATCH_ANCHORS_MIN[0] + 1440;
        gaps.push(b - a);
    }
    for (const g of gaps) assert.ok(g > DISPATCH_WINDOW_MIN * 2, `相邻锚点只隔 ${g} 分钟，窗口会重叠`);
});
t('窗口只覆盖全天的 22.5%（324/1440），不会把大半天都当成 CI 占用', () => {
    assert.ok(324 / 1440 < 0.23);
});

console.log('\n[6] bjMinuteOf 时区换算');
t('UTC 04:15 → 北京 12:15 → 第 735 分钟', () => {
    assert.strictEqual(bjMinuteOf(Date.UTC(2026, 10, 23, 4, 15)), 735);
});
t('UTC 16:00 → 北京次日 00:00 → 第 0 分钟', () => {
    assert.strictEqual(bjMinuteOf(Date.UTC(2026, 10, 23, 16, 0)), 0);
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
