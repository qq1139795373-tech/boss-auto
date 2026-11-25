// 情侣迷宫 · 每日任务链装配（把一个「两号同时在线」的副本挂到 06:00 那趟）
//
// ★ 为什么必须是独立 job，不能塞进 tasks.js（2026-11-23 定）
//   matrix 是「每号一个 runner」，每个 runner 只持自己那个号的锁。
//   情侣迷宫要求**两个号同时在线**（队长建队+进本+清怪，队员点准备+事后领奖），
//   塞进某个号的任务链会出现两种情况，都是错的：
//     ① 只让 A 号跑 → B 号还在自己 runner 里跑 tasks.js，A 邀请 B 时 B 已被自己的 runner 占着；
//     ② 两个号各自 runner 都跑 → 两边同时建队、互相顶号。
//   而且 acct-lock.js 的注释写明：CI 里每个 runner 临时目录各自独立，**锁对跨 runner 完全无效**，
//   它挡不住上面第 ② 种情况。唯一可靠的做法是「先把两个号在一个独立 runner 里跑完，再 fanout 到 matrix」，
//   这正是 boss.yml 里 form job（组 5 人队）已经验证过的模式，本文件照同一套做。
//
// ★ 为什么挂在 06:00 而不是 0:00（用户 2026-11-23 23:39 改的，前一版挂在 0:00）
//   · 0:00 那趟是四趟里**唯一「两个分支同时登号跑副本」**的时段：master 跑大号 11 步、
//     multi-boss 跑 5 个小号 10 步。而情侣副本的两个号横跨两个分支（冷6 在 multi-boss 的矩阵里、
//     伴侣是大号在 master 的 job 里），只能靠「等对方 job 结束」这种时间闸门错开 —— 而任何写死的
//     钟点都会被 runner 排队、游戏卡顿顶穿（用户原话「确定要卡这么死」）。
//   · 06:00 那趟 tasks_mode=skip，**没有任何副本在跑**，只有 farm；把情侣副本放这里就没有干扰：
//     两个分支各跑自己那对、账号不重叠，不需要任何时间闸门，也不需要谁等谁。
//   · 11:30 那趟不能放：情侣要建「副本队」，会把打 boss 的 5 人队拆掉。
//   · 18:00 那趟不能放：紧接 6 小时刷怪，压 20 分钟进 farm 窗口。
//
// ★ 完整流程固定两段（用户 2026-11-23 21:00 纠正过，别再试着一趟做完）
//   ① MODE=full       队长清怪 + 领奖，结束即退号
//   ② MODE=memberclaim 队员单独上号领奖（约 20 秒）
//   队长领奖不会把队员带出副本，队员侧条件仍是「银锁:1」（客户端缓存），
//   必须在队长退号后重新登录才会同步成「银锁:0」——所以第二段不能省。
//
// ★ 幂等
//   入口页「进入副本（剩余N次）」，N=0 表示今天已做过。qllm-run.js 里读到这个就 log 后 return 0，
//   不建队、不报错。所以本文件可以被重复触发（手动补派、窗口内重试）而不会刷红叉。
//
// 用法（boss-auto 目录）：
//   node qllm-daily.js                     按窗口判断（06:00-08:59 才跑）
//   QLLM_FORCE=1 node qllm-daily.js        跳过时间窗口（本地验证/补跑）
//   QLLM_DRYRUN=1 node qllm-daily.js       只打印计划和窗口判定，不登录任何账号
//   COUPLES='coldwind1:coldwind2:笑哈哈'    换一对（可多对，逗号分隔，格式 队长:队员:队员昵称）
// 退出码：0=跑完或主动跳过；1=有配对失败（CI 变红，但 boss.yml 里不阻塞 matrix）
const { spawn } = require('child_process');
const path = require('path');
const pass = require('./account-pass.js');

const TZ_OFFSET_MS = 8 * 3600 * 1000;      // 北京时间 = UTC+8
// ★ 06:00-08:59（用户 11-23 23:39 定）：把情侣副本从 0:00 挪到 06:00 那一趟。
//   理由：0:00 那趟是四趟里唯一「两个分支都在登号跑副本」的时段，情侣副本的双人机制又必须
//   队长+队员同时在同一个会话里，于是只能靠「等对方 job 结束」来避免跨分支顶号（冷6 横跨两分支）。
//   而 06:00 那趟 tasks_mode=skip，**没有任何副本在跑**（只有 farm），把情侣副本放这里就没有干扰：
//   两个分支各跑自己那对，账号不重叠（多本 冷0+冷8 / 冷1+冷2，master 大号+冷6），不需要任何时间闸门。
//   代价：多本 5 个小号在 06:00 趟晚约 30 分钟开始刷怪（0:00 趟反而提前 23 分钟），全天净少约 9 分钟。
//   换回来的是「没有一个写死的钟点会被排队/卡顿顶穿」——时间余量问题从根上消失。
const WINDOW_START_HOUR = 6;                // 06:00
const WINDOW_END_HOUR = 9;                  // 08:59

// ★ 配对的硬约束（用户 11-23 22:29 明确）：情侣迷宫是**双人本**，入口页原文
//   「情侣副本：需与交往/已婚伴侣2人组队 · 1-999级开放」——
//   这两号必须**在游戏内已结为交往/已婚伴侣**，不是随便凑两个号就能进。
//   写错了不会在建队时暴露，而是建完队点「进入副本」失败（入口页不给按钮或提示关系不符），
//   报错会落到 enterDungeon 的「队伍未满 2 人/未准备」上，看起来像人数问题，实际是关系不对。
//   所以 COUPLES 只能写实测确认过的伴侣对，别照着账号编号猜。
//
// 默认配对（本分支负责的两对，用户 11-23 23:21 明确「4 个号组成两队情侣」）：
//   冷0 笑嘻L(132) ↔ 冷8 笑嘻嘻(132)，2026-11-22 扫描确认是情侣关系
//   冷1 笑呵呵(132) ↔ 冷2 笑哈哈(132)，同一份扫描
// 冷6(笑嘻了) 的伴侣是**大号一缕寒风**，这一对归 master 的 couple job 跑，
//   本分支的 QLLM_RESERVED 会把它拦下来（见 reservedHits）。
// 已实测跑通的三对（11-23 全部成功进本+清怪+领奖）：
//   冷0+冷8 690s / 冷1+冷2 721s / 大号 coldwind+冷6 396s（160 级输出高，最快）
// 注意：这串只是「没有 COUPLES 时的本地兜底」。CI 里由 boss.yml 的 COUPLES 覆盖
//   （那边写的是两对，并允许 vars.QLLM_COUPLES 临时改写），两处要一起改。
const DEFAULT_COUPLES = 'coldwind0:coldwind8:笑嘻嘻,coldwind1:coldwind2:笑哈哈';

function bjParts(nowMs = Date.now()) {
    const d = new Date(nowMs + TZ_OFFSET_MS);
    return { hour: d.getUTCHours(), min: d.getUTCMinutes(), day: d.getUTCDay() };
}

// 纯函数：给时刻判要不要跑（供 qllm-daily-test.js 离线验证）
function shouldRunCouple(nowMs = Date.now()) {
    const { hour } = bjParts(nowMs);
    return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

// 纯函数：解析配对串。格式 "队长:队员:队员昵称"，多对用逗号分隔。
// 缺队长或队员的项直接丢弃（写错了就少跑一对，而不是拿空账号去登录）。
function parseCouples(spec) {
    return String(spec || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((item) => {
            const [leader, member, nick] = item.split(':').map((x) => String(x || '').trim());
            if (!leader || !member) return null;
            return { leader, member, partnerNick: nick || '' };
        })
        .filter(Boolean);
}

// ★ 保留账号（跨分支互斥）—— 用户 11-23 23:14「大号情侣副本两个账户在不同分支」、
//   23:17「5 个小号是并发，都跑一套会不会冲突」两次点名的问题，这里做第二道闸门。
//
//   为什么会有这个问题：三对配对的账号归属是交叉的（qllm-couple-scan.json 扫出来的）：
//     冷0(笑嘻L) ↔ 冷8(笑嘻嘻)     两个都在 multi-boss 的账号矩阵里
//     冷1(笑呵呵) ↔ 冷2(笑哈哈)     两个都在 multi-boss 的账号矩阵里
//     冷6(笑嘻了) ↔ 大号(一缕寒风)  **队员在 multi-boss 的矩阵里，队长在 master 的 job 里**
//   所以大号那一对必然横跨两个分支：master 的 couple job 要登冷6，multi-boss 的 matrix 也要登冷6。
//   两个 workflow run 之间没有 needs（跨 run 不存在依赖），concurrency 又只作用在 job 级
//   （而且两边 group 名不同），工作流层面没有任何机制能让其中一个等另一个。
//
//   ★ 11-23 23:39 起，这个问题从排期上化解了（用户「把情侣副本摘出来，加在 06:00 这个时段」）：
//     06:00 那趟 tasks_mode=skip，没有别的副本在跑，两个分支各跑自己那对、账号不重叠，
//     所以**不需要再靠「等到几点」这种钟点闸门**（那种闸门会被 runner 排队、游戏卡顿顶穿）。
//     只剩两处兜底：
//       ① job-gate.js（在 multi-boss 的 matrix 里）：冷6 起手查 API，等 master 的 couple job
//          真的 completed 才登录 —— 事件驱动，对方慢多久就等多久，不猜时间。
//       ② 配置闸门（就是下面这两个函数）：本 job 的 COUPLES 里只要出现「不属于本分支」的账号，
//          直接拒绝该对并 warning，不登录。
//   ② 为什么必须有：① 依赖「能观测到对方 job 状态」；万一有人把 multi-boss 的 COUPLES 改成
//   大号那一对（'coldwind:coldwind6'），① 观测的是 master/couple，根本不知道这边也要登大号，
//   于是两个分支同时登大号 → 顶号 → **当天次数被扣、奖没领**（最贵的失败，比报错糟得多）。
//   ② 只看账号名，能在登录之前把这种误配拦住。
//
//   为什么不能干脆让 matrix 里每个号各跑一份（用户 23:17 问的）：
//     · acct-lock.js 的锁在各自 runner 的临时目录里，跨 runner 完全无效；
//     · concurrency 是 job 级的，matrix 的 5 个副本是同一个 job，不互斥；
//     · 「剩余 N 次」的幂等只挡先后、挡不住同时 —— 5 个 runner 会同时读到「剩余 1 次」，
//       同时建队、同时邀请，互相把对方的会话顶掉，**次数已扣、清怪和领奖全落空**。
//   所以情侣副本在整个仓库里必须保持「同时只有 1 个实例」，这是矩阵不能碰它的根本原因。
function reservedFromEnv(env = process.env) {
    return new Set(
        String(env.QLLM_RESERVED || '')
            .split(',')
            .map((s) => pass.sanitize(s).toLowerCase())
            .filter(Boolean)
    );
}

// 纯函数：这一对里撞了哪些保留账号（空数组 = 可以跑）。抽出来是为了能离线单测。
function reservedHits(pair, reserved) {
    return [pair.leader, pair.member].filter((a) => reserved.has(String(a || '').toLowerCase()));
}

// 纯函数：大号是不是被放到了「队员」位。
// 为什么这是个错误：qllm-run.js 的 DFS 清怪全线走 pageA（=LEADER），队员只点「准备」和事后领奖。
// 所以清怪永远由队长做 —— 把大号放队员位，等于让 132 级小号扛全程输出。
// 实测：大号 160 级当队长 396s；冷0（132 级、攻击 991-1202）当队长 690s；冷1 721s；
// 冷6 攻击 854-1056、血池 7032，比冷0 更弱更脆，当队长只会更慢、更容易战死。
function mainInMemberSlot(pair) {
    return pass.kindOf(pair.member) === 'main' && pass.kindOf(pair.leader) !== 'main';
}

// GAME_ACCOUNTS_JSON 是 matrix 的账号来源（[{account,password}, ...]）。
// 这里自己查两个配对号的密码，注入 GAME_PASSWORD_<账号名大写>，
// 这样 qllm-run.js 走 account-pass.js 的「账号专属」优先级，不需要 workflow 里再写一遍 jq。
function passwordTableFromEnv(env = process.env) {
    const raw = env.GAME_ACCOUNTS_JSON;
    if (!raw) return new Map();
    let arr;
    try { arr = JSON.parse(raw); } catch (e) {
        console.log('[qllm-daily] ::warning::GAME_ACCOUNTS_JSON 不是合法 JSON，密码改由外部 GAME_PASSWORD* 提供');
        return new Map();
    }
    if (!Array.isArray(arr)) return new Map();
    const m = new Map();
    for (const it of arr) {
        const a = pass.sanitize(it && it.account);
        const p = pass.sanitize(it && it.password);
        if (a && p) m.set(a.toLowerCase(), p);
    }
    return m;
}

function envKeyFor(acc) {
    return 'GAME_PASSWORD_' + String(acc).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// 纯函数：把 qllm-run.js MODE=full 的退出码翻译成四种去向。
//   0 = 正常跑完（怪清完、队长领奖了）→ 必须接着跑第二段（队员单独领奖）
//   3 = 今日已完成（入口页剩余 0 次）→ 跳过第二段，白登录一次没有必要
//   7 = 怪清完了但**队长领奖失败**（11-25 新增）→ 报 error，但**仍然跑第二段**：
//       条件队伍共享，队员那一侧还有机会领到，不能因为队长没领就放弃。
//   其他 = 失败 → 不跑第二段（队员没进过本，没有奖可领）
// 抽成纯函数是为了能离线单测：真跑一次要登录两个号、耗 10 分钟，不适合每次都验证。
function classifyFirstStage(code) {
    if (code === 3) return 'already-done';
    if (code === 0) return 'ok';
    if (code === 7) return 'leader-claim-fail';
    return 'fail';
}


function runQllm(extraEnv) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'qllm-run.js')], {
            stdio: 'inherit',
            env: { ...process.env, ...extraEnv },
        });
        let settled = false;
        const done = (code) => {
            if (settled) return;
            settled = true;
            resolve(typeof code === 'number' ? code : -1);
        };
        child.on('close', (code) => done(code === null ? -1 : code));
        child.on('error', (e) => {
            console.log('[qllm-daily] ::error::启动 qllm-run.js 失败: ' + (e && e.message));
            done(-1);
        });
    });
}

// 纯函数：这一次给这个账号用哪个密码、来源是哪里。
// 为什么需要三条分支——两个分支的凭据来源不同（用户 11-23 要求情侣副本两个分支都跑）：
//   · multi-boss：冷0/冷8 的密码都在 GAME_ACCOUNTS_JSON 里 → 走账号表
//   · master    ：只有大号一条凭据 GAME_PASSWORD，队员冷6 的密码还得从账号表取
// 所以配对跨了「大号 + 小号」时，两个号的密码必须分开取；顺序是先表、后大号凭据。
// ★ 小号**绝不**回落到 GAME_PASSWORD：那是大号的密码，拿去登小号必然登错，
//   而报错会落在登录失败上，看上去像网络问题，排查方向会被带偏。
function passwordFor(acc, table, env = process.env) {
    const fromTable = table.get(String(acc).toLowerCase());
    if (fromTable) return { password: fromTable, source: '账号表' };
    if (pass.kindOf(acc) === 'main') {
        const p = pass.sanitize(env.GAME_PASSWORD);
        if (p) return { password: p, source: 'GAME_PASSWORD(大号凭据)' };
    }
    return { password: '', source: '' };
}

async function runPair(pair, pwdTable) {
    const tag = `${pair.leader}+${pair.member}`;
    const baseEnv = {};
    // ★ 清怪只由**队长**做（qllm-run.js 的 DFS 全线走 pageA=LEADER，队员只「准备」和事后领奖）。
    //   所以队长必须放输出最高的那个号（用户 11-23 23:24「大号和另一个小号的情侣副本需要由大号去刷怪」）：
    //   大号 160 级当队长 396s，冷0(132级) 当队长 690s、冷1 721s；冷6 攻击 854-1056 比冷0 还低、
    //   血池 7032 也比冷0 的 10611 脆，让它当队长既慢又容易死。
    //   这里做一道方向检查：大号被放到队员位 → 清怪实际由小号扛，耗时约翻倍，必须喊出来。
    if (mainInMemberSlot(pair)) {
        console.log(`[qllm-daily] ::warning::${tag} 把大号放在队员位了 —— 清怪由队长做，这样会由小号扛怪，耗时约翻倍、且小号血池更脆。请把大号放队长位`);
    }
    for (const acc of [pair.leader, pair.member]) {
        const got = passwordFor(acc, pwdTable);
        if (!got.password) {
            // 缺密码就整对跳过，不要带着半份凭据进流程：那会登错号，比不跑更糟
            console.log(`[qllm-daily] ::error::${tag} 的 ${acc} 没有可用密码（账号表里没有它；它不是大号、没有 GAME_PASSWORD 兜底）→ 跳过这一对`);
            return false;
        }
        baseEnv[envKeyFor(acc)] = got.password;
    }
    if (pair.partnerNick) baseEnv.PARTNER_NICK = pair.partnerNick;

    console.log(`[qllm-daily] === ${tag} 第一段：队长 ${pair.leader} 清怪 + 领奖（MODE=full，约 7~12 分钟）`);
    const c1 = await runQllm({ ...baseEnv, MODE: 'full', LEADER: pair.leader, MEMBER: pair.member });
    const verdict = classifyFirstStage(c1);
    if (verdict === 'already-done') {
        // 3 = qllm-run.js 报「入口页剩余 0 次」：今天这一对已经做完了。
        // 不算失败，也不用再跑第二段（队员侧早就领过奖了），否则白登录一次队员号。
        console.log(`[qllm-daily] ${tag} 今日已完成（剩余 0 次）→ 跳过第二段`);
        return true;
    }
    if (verdict === 'fail') {
        console.log(`[qllm-daily] ::error::${tag} 第一段失败 exit=${c1}，跳过第二段（队员侧没进本，领不了奖）`);
        return false;
    }
    if (verdict === 'leader-claim-fail') {
        // 怪清完了、队长没领到：不放弃，继续跑第二段（条件队伍共享，队员那侧可能还能领）
        console.log(`[qllm-daily] ::error::${tag} 队长领奖失败 exit=${c1}（怪已清完，继续跑第二段让队员试）`);
    }

    console.log(`[qllm-daily] === ${tag} 第二段：队员单独领奖（MODE=memberclaim，约 20~90 秒）`);
    const c2 = await runQllm({ ...baseEnv, MODE: 'memberclaim', MEMBER: pair.member });
    // ★ 11-25：第二段的返回码必须细分，否则「登录停在选角页」「没点到领取奖励」都会被
    //   原来的 `c2 !== 0` 之外的写法洗成「✓ 两段完成」（21:19 那次冷8 就是这么漏掉的）：
    //     0 = 领到    5 = 已出本（可能今天领过，不算失败但明说）
    //     4 = 登录没进主界面 / 不在副本也不在城市    6 = 在副本里但没点到「领取奖励」
    if (c2 === 5) {
        console.log(`[qllm-daily] ::warning::${tag} 第二段：队员登录后已出本，本次没有可领的奖（若今天没领过，说明副本被结算/踢出）`);
        return verdict === 'ok';
    }
    if (c2 !== 0) {
        console.log(`[qllm-daily] ::error::${tag} 第二段失败 exit=${c2}（怪已清完，这次队员的奖励没领到：4=没进游戏/不在副本，6=没点到领取奖励）`);
        return false;
    }
    if (verdict === 'leader-claim-fail') {
        // 队长没领到、队员领到了 → 这一对不算全成功，必须报出来
        console.log(`[qllm-daily] ::warning::${tag} 队员已领到奖，但队长那一侧领奖失败`);
        return false;
    }
    console.log(`[qllm-daily] ✓ ${tag} 两段完成`);
    return true;
}

async function main() {
    const { hour, min, day } = bjParts();
    const hhmm = `${hour}:${String(min).padStart(2, '0')}`;
    const force = process.env.QLLM_FORCE === '1';
    const dryrun = process.env.QLLM_DRYRUN === '1';

    const pairs = parseCouples(process.env.COUPLES || DEFAULT_COUPLES);
    if (!pairs.length) {
        console.log('[qllm-daily] ::error::COUPLES 解析后为空（格式应为 队长:队员:昵称）');
        return 1;
    }

    // 配置闸门：先把「不属于本分支」的号挑出来，全程不登录它们
    const reserved = reservedFromEnv();
    if (reserved.size) console.log(`[qllm-daily] 保留账号（由另一个分支的 job 负责）: ${[...reserved].join(', ')}`);
    const runnable = [];
    for (const p of pairs) {
        const hits = reservedHits(p, reserved);
        if (hits.length) {
            console.log(`[qllm-daily] ::warning::跳过 ${p.leader}+${p.member}：${hits.join('/')} 属另一个分支的 job（QLLM_RESERVED），同时登录会互相顶号`);
            continue;
        }
        runnable.push(p);
    }
    if (!runnable.length) {
        console.log('[qllm-daily] 配置的配对全部被保留账号过滤掉了 → 本 job 今天没有要跑的对（不是故障，exit 0）');
        return 0;
    }

    console.log(`[qllm-daily] 北京时间 ${hhmm}(周${'日一二三四五六'[day]})｜配对 ${pairs.map((p) => `${p.leader}+${p.member}(${p.partnerNick || '未指定昵称'})`).join(' / ')}`);

    const inWindow = shouldRunCouple();

    // dryrun 先于窗口判断：想在任意时刻核对计划时，不该被「现在不在窗口」挡在外面看不到计划
    if (dryrun) {
        console.log(`[qllm-daily] 窗口判定：${inWindow ? '在 06:00-08:59 内，会自动执行' : '不在窗口，自动派发时会跳过'}${force ? '（QLLM_FORCE=1 已强制）' : ''}`);
        for (const p of runnable) {
            console.log(`[qllm-daily] 计划：${p.leader}(队长) + ${p.member}(队员, 昵称 ${p.partnerNick || '?'}) → MODE=full → MODE=memberclaim`);
        }
        if (runnable.length !== pairs.length) {
            console.log(`[qllm-daily] 另有 ${pairs.length - runnable.length} 对因保留账号被跳过（见上面的 warning）`);
        }
        console.log('[qllm-daily] QLLM_DRYRUN=1 → 只打印计划，未登录任何账号');
        return 0;
    }

    if (!force && !inWindow) {
        console.log(`[qllm-daily] 不在情侣迷宫窗口 06:00-08:59 → 跳过（QLLM_FORCE=1 可强制；这趟不登录任何账号）`);
        return 0;
    }

    const pwdTable = passwordTableFromEnv();
    if (!pwdTable.size) {
        console.log('[qllm-daily] 提示：环境里没有可用的 GAME_ACCOUNTS_JSON，密码改由外部 GAME_PASSWORD / GAME_PASSWORD_<角色> 提供');
    }

    const failed = [];
    for (const p of runnable) {
        const ok = await runPair(p, pwdTable);
        if (!ok) failed.push(`${p.leader}+${p.member}`);
    }

    if (failed.length) {
        console.log(`[qllm-daily] 有 ${failed.length} 对未完成: ${failed.join(' / ')}（不影响后面的 boss / 刷怪）`);
        return 1;
    }
    console.log('[qllm-daily] 全部配对完成');
    return 0;
}

if (require.main === module) {
    main().then((c) => process.exit(c)).catch((e) => {
        // 装配层自身异常不该把整趟 run 变红：情侣迷宫只是个每日副本，失败信息留在日志里即可
        console.error('[qllm-daily] ::error::装配层异常: ' + (e && e.message));
        process.exit(1);
    });
}

module.exports = { shouldRunCouple, parseCouples, passwordTableFromEnv, passwordFor, envKeyFor, classifyFirstStage, reservedFromEnv, reservedHits, mainInMemberSlot, bjParts, WINDOW_START_HOUR, WINDOW_END_HOUR, DEFAULT_COUPLES };
