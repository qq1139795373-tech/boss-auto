// 派发时刻表与「是否处在派发窗口」判定（纯函数，无副作用，供 farm.js 与单测共用）
//
// 为什么需要它（2026-11-23 用户提问）：
//   farm 刷怪被顶号时，只能观察到「页面退回登录页」，看不出是谁占的号。
//   占用方只有两类：
//     a) 另一趟 CI run 刚起跑并登录了同一个号（例如 06:00 趟刷到 11:30 被 11:30 趟的组队顶掉）
//     b) 用户手动登录在玩（玩一会儿就下线）
//   两类要采取相反的动作：
//     a) 必须立刻退场 —— 否则本趟重登会把对方顶掉，双方来回抢，两趟都被切碎
//     b) 必须等一等再重登 —— 否则用户玩 30 分钟就把整趟 5~6 小时的刷怪废掉（用户 11-23 20:11 指出）
//   区分依据：CI 只在派发点登录，用户是随机时刻登录。所以「被顶时刻距最近派发点 ≤ 40 分钟」
//   就判为 CI 交接，否则判为用户手动占用。

// 派发时刻（北京时间的一天内分钟数）：00:00、06:00、11:30、18:00
const DISPATCH_ANCHORS_MIN = [0, 360, 690, 1080];

// 窗口半径（分钟）。取 40 的理由：
//   - 派发起跑后 prepare/校验账号/组队/错峰都在 10 分钟内登录完，40 分钟足够覆盖写慢的情况；
//   - 又不能太大：18:00 趟的 farm 约 18:35 起跑，11:30 趟的 farm 约 12:30 起跑，
//     都要落在窗口之外，否则用户在那个时段手动玩会被误判成 CI 交配而白白退场。
const DISPATCH_WINDOW_MIN = 40;
const MINUTES_PER_DAY = 1440;

// 北京时间的一天内分钟数（0..1439）。用 UTC+8 手工换算，不依赖运行环境的 TZ。
function bjMinuteOf(ms) {
    const d = new Date(ms + 8 * 3600 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 距最近派发点的分钟数（0..720）。跨 0 点按 24 小时环绕算：
// 23:30 距 00:00 是 30 分钟，不是 1410 分钟。
function minutesToNearestAnchor(minuteOfDay) {
    let best = Infinity;
    for (const a of DISPATCH_ANCHORS_MIN) {
        const raw = Math.abs(minuteOfDay - a);
        const wrapped = Math.min(raw, MINUTES_PER_DAY - raw);
        if (wrapped < best) best = wrapped;
    }
    return best;
}

// 是否处在派发窗口内（判据见文件头）
function isNearDispatch(ms, windowMin = DISPATCH_WINDOW_MIN) {
    return minutesToNearestAnchor(bjMinuteOf(ms)) <= windowMin;
}

module.exports = {
    isNearDispatch,
    bjMinuteOf,
    minutesToNearestAnchor,
    DISPATCH_ANCHORS_MIN,
    DISPATCH_WINDOW_MIN,
};
