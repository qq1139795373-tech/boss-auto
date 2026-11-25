// 领奖对账静态闸门（2026-11-25）
//
// 为什么要这个测试：领奖到账是「看不见」的——toast 只活 1~2 秒，背包读数又依赖页面状态。
// 三份脚本各自演化，很容易出现「看着有对账、其实永远跑不到」的假对账：
//   · 对账被 `!toastConfirmed` 掐掉 → toast 一确认就跳过，日志里从来没有 `[对账]` 行；
//   · 对账前没回城市主视图 → 包裹按钮不在，读到全 null，拿基线去减 0 = 负数假告警；
//   · 领奖明细轮询挂在点「领取奖励」之后 → toast 早没了，永远抓不到。
// 这三条都是「代码在、功能不在」，跑起来不报错，所以只能靠静态闸门盯住。
//
// 用法：node claim-reconcile-test.js
// 证伪用例：把旧写法塞回源码字符串，audit 必须报出问题；正确写法必须零问题。

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

const here = __dirname;
const read = (f) => {
    const p = path.join(here, f);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// 位置比较：a 必须出现在 b 之前（都找不到也算不合格）
function before(src, a, b) {
    const i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0) return null;
    return i < j;
}

function auditDungeon(src) {
    const out = [];
    if (!/const DUNGEON_REWARDS = \{[^}]*炼器窟补给箱[^}]*\}/.test(src)) {
        out.push('没有 DUNGEON_REWARDS（炼器窟补给箱）常量 → 对账不知道要比对什么');
    }
    if (!/readRewardToast\(page,\s*9000\)/.test(src)) {
        out.push('领奖前没挂 readRewardToast 轮询 → 明细 toast 抓不到');
    } else {
        const r = before(src, 'readRewardToast(page, 9000)', "clickByText(page, '领取奖励')");
        if (r === null) out.push('找不到「领取奖励」点击点，无法校验轮询顺序');
        else if (!r) out.push('readRewardToast 挂在点「领取奖励」之后 → toast 已消失，必然抓空');
    }
    if (!/\[基线\]/.test(src)) out.push('进本前没读背包基线 → 领奖后没有可比的值');
    if (!/async function reconcileClaim\(page, bagBefore, toastConfirmed\)/.test(src)) {
        out.push('没有 reconcileClaim() → 没有背包增量对账');
    }
    if (!/\[对账\]/.test(src)) out.push('没有 `[对账]` 打印 → 日志里看不出箱数变化');
    if (!/delta\[n\] >= need\[n\]/.test(src)) out.push('没有「增量 ≥ 期望值」判据');
    if (!/drain\.backToCityView\(page/.test(src)) {
        out.push('对账前没回城市主视图 → 包裹读不到，会出假告警');
    } else {
        const r = before(src, 'drain.backToCityView(page', 'await reconcileClaim(page');
        if (r === null) out.push('找不到 reconcileClaim 调用点');
        else if (!r) out.push('backToCityView 在 reconcileClaim 之后 → 顺序反了');
    }
    if (!/toastConfirmed/.test(src)) out.push('没有 toastConfirmed 变量 → 明细原文判据缺失');
    return out;
}

function auditKidd(src) {
    const out = [];
    if (!/\[基线\]/.test(src)) out.push('进本前没读背包基线');
    if (!/readRewardToast\(page,\s*9000\)/.test(src)) out.push('领奖前没挂 readRewardToast 轮询');
    // ★ 关键：对账不能再被 !toastConfirmed 掐掉，否则明细一确认就永远不打 [对账]
    if (/\bbagBefore\s*&&\s*!NO_CLAIM\s*&&\s*!toastConfirmed\b/.test(src)) {
        out.push('对账条件仍带 !toastConfirmed → 明细确认后整段跳过，等于假对账');
    }
    if (!/\bbagBefore\s*&&\s*!NO_CLAIM\s*\)/.test(src)) out.push('找不到对账门槛 `if (bagBefore && !NO_CLAIM)`');
    if (!/\[对账\]/.test(src)) out.push('没有 `[对账]` 打印');
    if (!/drain\.backToCityView\(page/.test(src)) out.push('对账前没回城市主视图');
    // ★ 11-25 用户纠正：藏宝图碎片在包裹里读得到（海盗王日志实证 528→533(+5)）。
    //   再出现「碎片不进包裹」这类断言就是把可对账的项说成不可对账，必须拦下。
    if (/碎片.{0,4}不进包裹|不进包裹.{0,8}碎片/.test(src)) {
        out.push('仍有「碎片不进包裹」的断言 → 与 11-25 海盗王实证（528→533(+5)）矛盾');
    }
    // 「两次都读不到」才允许放行；只判 delta===0 就放行 = 把没到账洗成正常
    if (!/const seen = names\.filter/.test(src)) {
        out.push('没有 seen 判定 → 无法区分「两次都没读到」与「真没增加」');
    }
    return out;
}

console.log('=== 炼器窟 dungeon.js ===');
const dSrc = read('dungeon.js');
if (dSrc === null) bad('dungeon.js 不存在');
else {
    const probs = auditDungeon(dSrc);
    if (!probs.length) ok('明细原文 + 背包增量双证据齐全，且顺序正确');
    else probs.forEach(bad);
}

console.log('=== 基德 kidd.js ===');
const kSrc = read('kidd.js');
if (kSrc === null) bad('kidd.js 不存在');
else {
    const probs = auditKidd(kSrc);
    if (!probs.length) ok('对账门槛不再被 toast 掐掉，且先回主视图再读包裹');
    else probs.forEach(bad);
}

function auditRecover(src) {
    const out = [];
    // dismissPopups 必须把抓到的明细原文交出来，否则自恢复路径（fish/mibao/farm/zhenyaota）
    // 领完奖只剩「离开副本页」这一个页面证据，永远证不了到账。
    if (!/toasts\.push\(rw\)/.test(src)) out.push('dismissPopups 没把明细原文收集起来（toasts.push(rw)）');
    if (!/return toasts;/.test(src)) out.push('dismissPopups 没返回明细数组 → 调用方拿不到证据');
    if (!/到账证据（明细原文）/.test(src)) out.push('recoverDungeon 领奖后没打印明细原文证据');
    if (!/到账未经证实/.test(src)) out.push('没抓到明细时没有明确写「到账未经证实」→ 页面证据冒充到账');
    return out;
}

function auditQllm(src) {
    const out = [];
    if (!/const QLLM_REWARDS = \{ '一只玫瑰': \d+ \}/.test(src)) {
        out.push('没有 QLLM_REWARDS（一只玫瑰）常量 → 不知道要核对什么');
    }
    if (!/drain\.readRewardToast\(page,\s*9000\)/.test(src)) out.push('领奖前没挂 readRewardToast 轮询');
    else {
        const r = before(src, 'drain.readRewardToast(page, 9000)', "clickHard(page, '领取奖励'");
        if (r === null) out.push('找不到「领取奖励」点击点，无法校验轮询顺序');
        else if (!r) out.push('readRewardToast 挂在点「领取奖励」之后 → toast 已消失，必然抓空');
    }
    if (!/一只玫瑰\[×\*x\]/.test(src)) out.push('没有解析明细里的「一只玫瑰×N」');
    if (!/领奖到账（明细原文）/.test(src)) out.push('没有「✔ 领奖到账（明细原文）」判定');
    return out;
}

console.log('=== 副本自恢复 dungeon-recover.js（fish/mibao/farm/zhenyaota 共用） ===');
const rSrc = read('dungeon-recover.js');
if (rSrc === null) bad('dungeon-recover.js 不存在');
else {
    const probs = auditRecover(rSrc);
    if (!probs.length) ok('领奖明细原文已回传给自恢复路径，无证据时明确标注「未经证实」');
    else probs.forEach(bad);
}

console.log('=== 情侣迷宫 qllm-run.js ===');
const qSrc = read('qllm-run.js');
if (qSrc === null) bad('qllm-run.js 不存在');
else {
    const probs = auditQllm(qSrc);
    if (!probs.length) ok('明细原文判据齐全（一只玫瑰），且轮询挂在点击之前');
    else probs.forEach(bad);
}

function auditBymj(src) {
    const out = [];
    if (!/const BYMJ_REWARDS = \{/.test(src)) out.push('没有 BYMJ_REWARDS 常量 → 不知道要对账哪些到账物');
    if (!/readRewardToast\(page,\s*9000\)/.test(src)) out.push('领奖前没挂 readRewardToast 轮询');
    else {
        const r = before(src, 'readRewardToast(page, 9000)', "clickLeaf(page, '领取奖励'");
        if (r === null) out.push('找不到「领取奖励」点击点，无法校验轮询顺序');
        else if (!r) out.push('readRewardToast 挂在点「领取奖励」之后 → toast 已消失，必然抓空');
    }
    if (!/领奖到账（明细原文）/.test(src)) out.push('没有「✔ 领奖到账（明细原文）」判定');
    if (!/\[对账\]/.test(src)) out.push('没有背包箱数对账');
    // ★ 11-25 补：对账不能再被 !done 掐掉（明细一确认就整段跳过 → 日志里永远没有 [对账]）
    if (/if\s*\(\s*!done\s*&&\s*backToTown\s*\)/.test(src)) {
        out.push('箱数对账被 `!done` 门槛掐掉 → 明细一确认就永远不打 [对账]（假对账）');
    }
    return out;
}

console.log('=== 奔月秘境 bymj-local/bymj-batch.js ===');
const bSrc = read('bymj-local/bymj-batch.js');
if (bSrc === null) bad('bymj-local/bymj-batch.js 不存在');
else {
    const probs = auditBymj(bSrc);
    if (!probs.length) ok('明细原文 + 背包箱数双证据齐全，轮询在点击之前');
    else probs.forEach(bad);
}

console.log('=== 证伪：把旧写法塞回去必须被扫出 ===');
{
    // ① dungeon：把 toast 轮询挪到点「领取奖励」之后
    const broken = dSrc
        .replace(/\n\s*const toastP = drain\.readRewardToast\(page, 9000\)\.catch\(\(\) => ''\);/,
            '\n            const toastP = Promise.resolve("");')
        + "\n// clickByText(page, '领取奖励') 之后才轮询\nconst toastP = drain.readRewardToast(page, 9000);\n";
    const p1 = auditDungeon(broken);
    if (p1.some((s) => s.includes('挂在点「领取奖励」之前'))) ok('挪到后面会被查出');
    else if (p1.some((s) => s.includes('readRewardToast'))) ok('移除前置轮询会被查出');
    else bad('证伪失败：去掉前置轮询居然通过了');

    // ② kidd：恢复 `&& !toastConfirmed`
    const k2 = kSrc.replace('if (bagBefore && !NO_CLAIM) {', 'if (bagBefore && !NO_CLAIM && !toastConfirmed) {');
    const p2 = auditKidd(k2);
    if (p2.some((s) => s.includes('!toastConfirmed'))) ok('恢复 !toastConfirmed 会被查出');
    else bad('证伪失败：恢复旧门槛居然通过了');

    // ③ dungeon：删掉 backToCityView
    const d3 = dSrc.replace(/await drain\.backToCityView\(page[^\n]*\n/, '');
    const p3 = auditDungeon(d3);
    if (p3.some((s) => s.includes('回城市主视图'))) ok('删掉回主视图会被查出');
    else bad('证伪失败：没有 backToCityView 居然通过了');

    // ④ kidd：把「碎片不进包裹」的旧断言塞回去（11-25 用户纠正过的那句）
    const oldLine = "console.log('[基线] 包裹里没有该条目（基德碎片实测不进包裹，属正常）→ 以领奖明细原文为准');";
    const k4 = kSrc.replace("console.log('[基线] 包裹里读不到该条目（数量为 0 时包裹不显示）→ 领奖后按增量核对');", oldLine);
    if (k4 === kSrc) bad('证伪用例构造失败：找不到基线打印行');
    else {
        const p4 = auditKidd(k4);
        if (p4.some((s) => s.includes('碎片不进包裹'))) ok('恢复「碎片不进包裹」断言会被查出');
        else bad('证伪失败：旧断言塞回去居然通过了');
    }

    // ⑤ 情侣迷宫：去掉领奖明细轮询（回到「只看领取奖励消失」的旧写法）
    if (qSrc) {
        const q5 = qSrc.replace(/\n\s*const toastP = drain\.readRewardToast\(page, 9000\)\.catch\(\(\) => ''\);/,
            '\n            const toastP = Promise.resolve(\'\');');
        if (q5 === qSrc) bad('证伪用例构造失败：找不到情侣领奖的 toast 轮询行');
        else {
            const p5 = auditQllm(q5);
            if (p5.some((s) => s.includes('readRewardToast'))) ok('情侣迷宫去掉明细轮询会被查出');
            else bad('证伪失败：没有明细轮询居然通过了');
        }
    }

    // ⑥ 自恢复：把「到账未经证实」那句警告删掉（页面证据冒充到账）
    if (rSrc) {
        const r6 = rSrc.replace(/::warning::奖励已领取，但没抓到明细原文[^\n]*\n/, '');
        const p6 = auditRecover(r6);
        if (p6.some((s) => s.includes('未经证实'))) ok('删掉「到账未经证实」会被查出');
        else bad('证伪失败：页面证据冒充到账居然通过了');
    }

    // ⑦ 奔月：去掉领奖前的明细轮询（回到「点完再读页面」的旧写法）
    if (bSrc) {
        const b7 = bSrc.replace(/\n\s*const toastP = drain\.readRewardToast\(page, 9000\)\.catch\(\(\) => ''\);/,
            "\n    const toastP = Promise.resolve('');");
        if (b7 === bSrc) bad('证伪用例构造失败：找不到奔月的 toast 轮询行');
        else {
            const p7 = auditBymj(b7);
            if (p7.some((s) => s.includes('readRewardToast'))) ok('奔月去掉明细轮询会被查出');
            else bad('证伪失败：奔月没有明细轮询居然通过了');
        }
        // ⑧ 奔月：把箱数对账重新挂回 `!done` 门槛（11-25 修掉的假对账）
        const b8 = bSrc.replace('if (backToTown) {\n        const after = await readBymjBox(page);',
            'if (!done && backToTown) {\n        const after = await readBymjBox(page);');
        if (b8 === bSrc) bad('证伪用例构造失败：找不到奔月的对账门槛行');
        else {
            const p8 = auditBymj(b8);
            if (p8.some((s) => s.includes('!done'))) ok('奔月对账挂回 !done 会被查出');
            else bad('证伪失败：假对账门槛塞回去居然通过了');
        }
    }
}

console.log('');
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
