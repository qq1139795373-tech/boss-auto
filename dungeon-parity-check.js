// 离线一致性验证：炼器窟（dungeon.js）的战斗段是否与已验证跑通的基德（kidd.js）逐字等价
// 用法：node dungeon-parity-check.js   —— 不联网、不登号，纯源码比对
const fs = require('fs');

const read = (f) => fs.readFileSync(f, 'utf8');

// 从 "async function NAME" 开始截到下一个顶格 "}"（这两个函数体内没有顶格 }）
function extract(src, name) {
    const i = src.indexOf(`async function ${name}(`);
    if (i < 0) throw new Error(`找不到 ${name}`);
    const m = src.slice(i).match(/\n\}/);
    if (!m) throw new Error(`${name} 未闭合`);
    return src.slice(i, i + m.index + 2);
}

// 规范化：去行注释 / 块注释 / log 前缀差异 / 全部空白
function norm(s) {
    return s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, '');
}

let fail = 0;
const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✔ ${label}`);
    else { console.log(`  ✖ ${label} ${extra}`); fail++; }
};

const dun = read('dungeon.js');
const kidd = read('kidd.js');

console.log('=== 1. fightOne 逐字等价（炼器窟 vs 基德） ===');
const fd = norm(extract(dun, 'fightOne'));
const fk = norm(extract(kidd, 'fightOne'));
if (fd === fk) {
    console.log(`  ✔ fightOne 完全一致（${fd.length} 字符）`);
} else {
    fail++;
    console.log('  ✖ fightOne 不一致');
    let p = 0;
    while (p < Math.min(fd.length, fk.length) && fd[p] === fk[p]) p++;
    console.log(`    首个差异位置 ${p}:`);
    console.log(`    dungeon: ...${fd.slice(Math.max(0, p - 60), p + 60)}`);
    console.log(`    kidd   : ...${fk.slice(Math.max(0, p - 60), p + 60)}`);
}

console.log('\n=== 2. reviveOnce 逐字等价 ===');
const rd = norm(extract(dun, 'reviveOnce'));
const rk = norm(extract(kidd, 'reviveOnce'));
ok(rd === rk, `reviveOnce 一致（${rd.length} 字符）`, rd.slice(0, 80));

console.log('\n=== 3. clearRoom 关键不变量 ===');
const cd = extract(dun, 'clearRoom');
ok(!/throw new Error/.test(cd), 'clearRoom 内不再 throw（否则会跳过领奖）');
ok(/if \(STOP_WALK\) return kills;/.test(cd), 'clearRoom 读 STOP_WALK 立刻收手');
ok(/reviveOnce\(page\)/.test(cd), 'clearRoom 有战死复活处理');
ok(/bag\.bagStillOpen/.test(cd) && /bag\.closeBag/.test(cd), 'clearRoom 有包裹浮层兜底');
ok(/stuckHits/.test(cd) && /skip\.add/.test(cd), 'clearRoom 打不死的怪跳过而不是中断');
ok(/带回缺口继续，不中断副本/.test(cd), '清不完只告警带回缺口');

console.log('\n=== 4. 战斗参数 ===');
ok(/a < 18/.test(dun), '单只怪上限 18 刀');
ok(!/a < 12/.test(dun), '无 12 刀残留');
ok(/drain\.bloodAction\(/.test(dun), '血池 0 走 bloodAction 决策');
ok(/BLOOD_HARD = true/.test(dun), '补药不成 → 转硬打（不放弃这只怪）');
ok(/return 'dead'/.test(dun), '死亡态 return dead');

console.log('\n=== 5. 主线不中断 ===');
ok(/四线遍历异常/.test(dun) && /不中断，继续对账与领奖/.test(dun), '四线遍历包 try/catch');
ok(/回扫异常/.test(dun) && /不阻断领奖/.test(dun), '补扫包 try/catch');
ok(/人物战死并已复活 → 停止走图，直接去领奖/.test(dun), '主线读 STOP_WALK 收手');
ok(/STOP_WALK\) break;/.test(dun), 'runArm 房间循环读 STOP_WALK');

console.log('\n=== 6. 镇妖塔：主判据是页面终态，不是秒数 ===');
const zt = read('zhenyaota.js');
const lim = zt.match(/const RUN_LIMIT_MS = (\d+) \* 60 \* 1000;/);
ok(!!lim, 'RUN_LIMIT_MS 存在');
ok(lim && Number(lim[1]) >= 90, `整轮上限 ≥ 90 分钟（当前 ${lim ? lim[1] : '?'}）`);
ok(/挑战结束，请领取结算/.test(zt), '主判据 = 页面「挑战结束，请领取结算」');
ok(/result = 'top'/.test(zt) && /MAX_FLOOR/.test(zt), '到 100 层收工');
ok(/硬兜底（正常应先由页面/.test(zt), '兜底触发日志与正常收工可区分');

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
