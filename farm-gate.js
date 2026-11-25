// 刷怪闸门：决定这一趟 Job 要不要跑 `Run Farm`。
//
// 起因（用户 2026-11-25 19:49）：「本地没有内存了，0:00及06:00推到Git临时跑一下，Run Farm不跑」
//   —— 这两趟只做任务 / 情侣副本，不占 6 小时 runner 刷怪。
//
// 开关放在仓库变量里，不改代码、也不用等合并：
//   Settings → Secrets and variables → Actions → Variables 加一条
//   SKIP_FARM_HOURS = "0,1,2,5,6,7"      （逗号分隔的北京小时）
//   清空或删掉这条 → 每趟都刷怪（就是原来一直以来的行为）。
//
// 为什么按「Job 启动那一刻的北京小时」判断，而不是按 farm 真正开始的时刻：
//   00:00 趟的 dawn 要跑 60 分钟，farm 01:0x 才开始；按那时判断，这一趟就漏掉了。
//   所以这一步必须放在 Job 最前面（checkout 之后立刻跑），把结果写进 GITHUB_ENV 传给后面的
//   `Run Farm`。
// 为什么按区间而不是点：
//   00:00 趟 = 0~2（dawn 窗口本来就算到 02:59）；06:00 趟 = 5~7（等 master 的情侣副本跑完、
//   叠加 runner 排队，Job 实际启动可能落到 07:xx）。
//
// 输出两种都写，双保险（boss.yml 里两处都判）：
//   1) GITHUB_ENV 的 FARM_SKIP=1    —— 给后续 step 的 if 用
//   2) 工作区标记文件 .farm-skip    —— hashFiles() 判断，不依赖 GITHUB_ENV 在 if 里是否可见

const fs = require('fs');
const path = require('path');

// 纯函数：解析 "0,1,2,5,6,7" → [0,1,2,5,6,7]；非法项（空、文字、越界）直接丢掉
function parseSkipHours(spec) {
    return String(spec === undefined || spec === null ? '' : spec)
        .split(',')
        .map((x) => x.trim())
        .filter((x) => /^\d{1,2}$/.test(x))
        .map((x) => Number(x))
        .filter((h) => h >= 0 && h <= 23);
}

// 纯函数：给定北京小时与开关，判断这一趟是否跳过刷怪
function shouldSkipFarm(hour, spec) {
    return parseSkipHours(spec).includes(hour);
}

// 纯函数：给定时间戳，返回北京小时（0-23）
function bjHour(nowMs) {
    return new Date((nowMs === undefined ? Date.now() : nowMs) + 8 * 3600 * 1000).getUTCHours();
}

function main() {
    const spec = process.env.SKIP_FARM_HOURS;
    const hours = parseSkipHours(spec);
    const hour = bjHour();
    const skip = shouldSkipFarm(hour, spec);

    console.log(`[farm-gate] 北京时间 ${hour} 点；SKIP_FARM_HOURS=${JSON.stringify(spec === undefined ? '' : spec)}`
        + ` → 解析 ${hours.length ? hours.join(',') : '(空)'} 点 → ${skip ? '本趟不刷怪' : '本趟照常刷怪'}`);

    if (!skip) return;

    if (process.env.GITHUB_ENV) {
        try { fs.appendFileSync(process.env.GITHUB_ENV, 'FARM_SKIP=1\n'); } catch (e) { }
    }
    try { fs.writeFileSync(path.join(__dirname, '.farm-skip'), String(Date.now())); } catch (e) { }
}

if (require.main === module) main();

module.exports = { parseSkipHours, shouldSkipFarm, bjHour };
