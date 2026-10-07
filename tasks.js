const { spawnSync } = require('child_process');

// 任务闸门（和 index.js 打boss同一套逻辑，按北京时间判断）：
//   00:00-00:30 → 每日签到（signin.js，已签自动跳过）→ 竞技场 → 钓鱼（签到仅此窗口跑；竞技场不限地点先打，最后威尼斯钓鱼；master不跑炼器窟）
//   18:00-18:30 → 山寨农场
//   其他时间    → 跳过（中午11:50那趟由 index.js 自己的闸门打boss）
// 任务跑完正常退出，交给 boss.yml 后面的 Run Boss / Run Farm（刷怪到6小时上限）
// TASKS_MODE=dawn|dusk|skip 可强制指定，auto(默认)=按时间

const MODE = (process.env.TASKS_MODE || 'auto').toLowerCase();

function bjNow() {
    const now = new Date();
    return { hour: (now.getUTCHours() + 8) % 24, min: now.getUTCMinutes() };
}

function resolveMode(hour, min) {
    if (MODE !== 'auto') return MODE;
    if (hour === 0 && min <= 30) return 'dawn';
    if (hour === 18 && min <= 30) return 'dusk';
    return 'skip';
}

function runStep(name, script) {
    console.log(`[tasks] >>> ${name} (${script}) 开始`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`[tasks] <<< ${name} 结束 exit=${r.status === null ? 'signal' : r.status} 耗时${sec}s`);
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
        runStep('钓鱼', 'fish.js');
    } else if (mode === 'dusk') {
        runStep('山寨农场', 'shanzhai.js');
    } else if (MODE === 'skip') {
        console.log('[tasks] 强制跳过任务(TASKS_MODE=skip)');
    } else {
        console.log('[tasks] 非任务时间段，跳过');
    }

    console.log('[tasks] 任务阶段结束（无论成败都继续后面的刷怪）');
    process.exit(0);
}

try {
    main();
} catch (e) {
    console.error('[tasks] tasks.js自身异常(不阻塞后续刷怪):', e && e.message);
    process.exit(0);
}
