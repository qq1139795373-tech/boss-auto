// 农场刷怪时长预算（纯函数，2026-11-22）
//
// 由来：原来 `FARM_MAX_MIN` 固定 300 分钟。11:30 派发这趟，farm 是 boss 一结束立刻起跑
//   （boss.yml 里 Run Farm 就是紧接 Run Boss 的下一个 step，没有固定等待），
//   按 300 分钟算会跑到「起跑+5小时」，而下一个派发是 18:00 —— 中间白空着几十分钟。
//
// ★ 预算不是固定值，是 farm **启动那一刻现场算**的（farm.js 的 loopStart）。
//   起跑得越早，预算越长，收尾恒为「下一个节点前 5 分钟」= 17:55。
//   所以 boss 打得快反而多刷，不需要为「起跑时刻」另设常量。
//   用户 23:34：「完全可以刷满野怪啊，下一个节点会自动触发下一个任务，之前的任务流就算怪没杀完也没关系。」
//
// 但「完全不限时」有两个实际代价（不是理论）：
//   ① job 的 timeout-minutes 到点会 kill 进程 → 整个 run 标 failure，红叉与真故障混在一起
//      （2026-10-29 00:00 波 4 个 job 全被砍成红就是这么来的）；
//   ② farm.js 检测到被顶回登录页后只让位 30 分钟就会重登（RELOGIN_WAIT_MS），
//      于是旧 run 会和下一个节点的新 run 交替抢号，两边的有效刷怪时间都被切碎。
//
// 所以取中间方案：刷到「下一个派发节点前 5 分钟」自动收尾 —— 刷满两个节点之间的时间，
//   又能在新 run 上来之前干干净净退出。
//
// 节点表与实际派发（cron-job.org）一致：00:00 / 06:00 / 11:30 / 18:00（北京时间）。
// 改派发时刻时这张表必须一起改，否则预算算错。
const NODE_MINUTES = [0, 6 * 60, 11 * 60 + 30, 18 * 60];
const FORWARD_GAP_MIN = 5;

/** 某一时刻对应的北京时间「当日第几分钟」（0~1439） */
function bjMinuteOf(ms) {
    const d = new Date((typeof ms === 'number' ? ms : Date.now()) + 8 * 3600 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * 从 startMs 起跑，还能刷多少分钟。
 * 规则：取「严格晚于当前时刻」的下一个节点，减去 5 分钟接手间隔。
 * 已经没有下一个节点（23:55 之后）→ 视作次日 00:00，结果可能为 0（表示别刷了，马上就到点）。
 */
function farmBudgetMin(startMs) {
    const cur = bjMinuteOf(startMs);
    let next = NODE_MINUTES.find((n) => n > cur);
    if (next === undefined) next = 24 * 60;
    return Math.max(0, next - cur - FORWARD_GAP_MIN);
}

module.exports = { farmBudgetMin, bjMinuteOf, NODE_MINUTES, FORWARD_GAP_MIN };
