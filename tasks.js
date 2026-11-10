const { spawnSync } = require('child_process');
const { existsSync } = require('fs');

// 任务闸门（和 index.js 打boss同一套逻辑，按北京时间判断）：
//   00:00-00:59 → 每日签到（signin.js，已签自动跳过）→ 竞技场 → 炼器窟副本 → 钓鱼 → 秘宝抽奖（mibao.js，免费银贝箱，同在威尼斯）→ 镇妖塔（zhenyaota.js，泉州守塔武僧，每天1次）→ 每日任务（daily.js）（签到仅此窗口跑；竞技场不限地点先打，再去伦敦，最后威尼斯钓鱼）
//   18:00-18:30 → 山寨农场 → 邮件领取（mail.js，领取所有+确定+返回）
//   其他时间    → 跳过（中午11:50那趟由 index.js 自己的闸门打boss）
// 任务跑完正常退出，交给 boss.yml 后面的 Run Boss / Run Farm（刷怪到6小时上限）
// TASKS_MODE=dawn|dusk|skip 可强制指定，auto(默认)=按时间

const MODE = (process.env.TASKS_MODE || 'auto').toLowerCase();

// 失败步骤汇总：只要有一个脚本非 0 退出，tasks.js 最后也非 0（不再静默绿）
const FAILED_STEPS = [];

function bjNow() {
    const now = new Date();
    return { hour: (now.getUTCHours() + 8) % 24, min: now.getUTCMinutes() };
}

function resolveMode(hour, min) {
    if (MODE !== 'auto') return MODE;
    if (hour === 0) return 'dawn';   // 00:00-00:59 一整个小时
    if (hour === 18 && min <= 30) return 'dusk';
    return 'skip';
}

function runStep(name, script) {
    // 脚本可能只在本机存在（例如某步还在本地验证、没提交）：
    // 直接 spawn 一个不存在的文件只会刷一行 Node 报错，还会让这一步显示 exit=1。
    // 缺文件就跳过并说清楚，别让 CI 日志里出现假故障。
    if (!existsSync(script)) {
        console.log(`[tasks] --- ${name} (${script}) 本机没有这个脚本，跳过`);
        return;
    }
    console.log(`[tasks] >>> ${name} (${script}) 开始`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    const sec = Math.round((Date.now() - t0) / 1000);
    const code = r.status === null ? 'signal' : r.status;
    console.log(`[tasks] <<< ${name} 结束 exit=${code} 耗时${sec}s`);
    // 非 0 必须让整条 run 变红：11-10 coldwind1 山寨农场异常被吞掉，
    // 日志里没有「山寨农场完成」，run 却显示成功，白丢一整天。
    if (code !== 0) {
        FAILED_STEPS.push(name);
        console.log(`::error::${name} 失败（exit=${code}），详见上方日志`);
    }
}

function main() {
    const { hour, min } = bjNow();
    const mode = resolveMode(hour, min);
    console.log(`[tasks] 北京时间 ${hour}:${String(min).padStart(2, '0')} → mode=${mode} (TASKS_MODE=${MODE})`);

    // 每日签到（幂等：已显示"今日已签到"直接跳过；只在dawn窗口登录，其他时间不登录）
    if (mode === 'dawn') {
        runStep('每日签到', 'signin.js');
    }

    if (mode === 'dawn') {
        runStep('竞技场', 'arena.js');
        runStep('炼器窟副本', 'dungeon.js');
        runStep('钓鱼', 'fish.js');
        runStep('秘宝抽奖', 'mibao.js');
        // 镇妖塔：泉州 ★守塔武僧 → 进入镇妖塔，每天 1 次，一局打到死为止（约 3 分钟）
        runStep('镇妖塔', 'zhenyaota.js');
        runStep('每日任务', 'daily.js');
    } else if (mode === 'dusk') {
        runStep('山寨农场', 'shanzhai.js');
        runStep('邮件领取', 'mail.js');
    } else if (MODE === 'skip') {
        console.log('[tasks] 强制跳过任务(TASKS_MODE=skip)');
    } else {
        console.log('[tasks] 非任务时间段，跳过');
    }

    console.log('[tasks] 任务阶段结束（无论成败都继续后面的刷怪）');
    if (FAILED_STEPS.length) {
        console.log(`[tasks] 失败步骤 ${FAILED_STEPS.length} 个: ${FAILED_STEPS.join(' / ')}`);
        process.exit(1);
    }
    process.exit(0);
}

try {
    main();
} catch (e) {
    console.error('[tasks] tasks.js自身异常(不阻塞后续刷怪):', e && e.message);
    process.exit(0);
}
