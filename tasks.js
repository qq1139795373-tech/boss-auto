const { spawn } = require('child_process');
const { existsSync, appendFileSync, writeFileSync } = require('fs');
// 同账号互斥锁统一在 ./acct-lock.js（kidd / 海盗王 / 奔月三个副本脚本也接同一把锁，
// 否则「任务流程在跑」和「副本脚本在跑」会同时登录同一个号互相顶号）。
const acct = require('./acct-lock.js');

// 同账号互斥（2026-11-06 加，11-19 并入公共锁模块）：
//   本地可能同时有两条入口在跑同一个号（排队的批量脚本 + 手动补跑），两条都登录会互相顶号下线，
//   这正是「同账号单会话」那条铁律要防的情况。用临时目录里的锁文件挡住后启动的那条：
//   · 45 分钟内已有实例（正在跑 / 刚跑完都算）→ 后来的直接退出，一次都不登录
//   · 想强行重跑：TASKS_NO_LOCK=1（或通用开关 NO_ACCT_LOCK=1）
//   CI 里每个号一个独立 runner，临时目录各自独立，锁不会互相影响。
function acquireAccountLock() {
    const a = process.env.GAME_ACCOUNT || '';
    if (!a || process.env.TASKS_NO_LOCK === '1') return true;
    // keepAfterExit：跑完不删锁，45 分钟内再派一次直接跳过（避免同一波被重复派）；
    // legacyFormat：仍写纯时间戳，和旧版任务流程/历史锁文件保持兼容。
    const r = acct.acquire(a, { tag: 'tasks.js', keepAfterExit: true, legacyFormat: true });
    if (!r.ok) {
        const mins = Math.round((r.st.age || 0) / 60000);
        console.log(`[tasks] ${a} 锁未过期（${mins} 分钟前由「${r.st.tag}」启动，锁文件 ${acct.lockFile(a)}），本次跳过：避免两条实例登录同一账号互相顶号`);
        console.log('[tasks] 确认没有实例在跑、就是要重跑时，加 TASKS_NO_LOCK=1');
        return false;
    }
    return true;
}

// 任务闸门（和 index.js 打boss同一套逻辑，按北京时间判断）：
//   00:00-02:59 → 每日签到（signin.js，已签自动跳过）→ 竞技场（不限地点，先打省一次移动）
//                 → 奔月秘境（长安，bymj-batch.js，57 间房 DFS 全图，大号打月神/小号跳）
//                 → 镇妖塔（泉州，zhenyaota.js，每天 1 次）
//                 → 海盗王的诅咒（马六甲，hdwang-batch.js，四项条件各 3 只）
//                 → 钓鱼（威尼斯码头，顺路补体力宝）
//                 → 附魔秘境（fmsj.js，威尼斯铁匠铺→附魔师，只跑大号）
//                 → 秘宝抽奖（mibao.js，免费银贝箱，同在威尼斯）
//                 → 基德宝藏（阿姆斯特丹）+ 炼器窟（伦敦）——同属北海，连着跑省一次出航
//                 → 每日任务（daily.js，内部自己串子任务）
//                 ★ 这条线是「一路向西不回头」：东亚 → 东南亚 → 地中海 → 北海。
//                   11-22 加入奔月/海盗王后重排过，别再把炼器窟挪回开头，否则每天多跑两三趟船。
//                 ★ 窗口 0:00-2:59 只管「能不能起跑」，运行本身没有时长上限，会一路跑完。
//   18:00-18:30 → 山寨农场 → 邮件领取（mail.js，领取所有+确定+返回）
//                  ★ 周二/周六：这两步做完后原地等到 19:55 提前出发，在同一趟里打怪物攻城
//                    （用户 11-22 要求：这两天牺牲 18:00-20:00 的刷怪时间；
//                      11-24 追加：19:55 就走，别等 20:00 才开始登录出航，否则 20:02 才到城门）
//                    代价是本进程不退出 → 后面的 Run Boss / Run Farm 顺延到攻城结束（约 20:30）才开始。
//                    关闭等待：GONGCHENG_WAIT=false（派发时传参，别去页面上取消 run——
//                    取消会把同一趟的刷怪一起砍掉；11-19~11-22 那 4 次 cancelled 就是这么没的）
//   20:00-20:30 → 怪物攻城（只在周二/六；现在由 18:00 那趟等过来，独立派发已不使用）
//   其他时间    → 跳过（中午 11:30 那趟由 index.js 自己的闸门打 boss；boss.yml 里另有一道
//                  form job 先组 5 人队，所以本流程不用管组队）
// 任务跑完正常退出，交给 boss.yml 后面的 Run Boss / Run Farm（刷怪到6小时上限）
// TASKS_MODE=dawn|dusk|gongcheng|skip 可强制指定，auto(默认)=按时间

const MODE = (process.env.TASKS_MODE || 'auto').toLowerCase();
// 账号/密码唯一解析入口（大号 coldwind 与小号 coldwindN 密码不同，见 account-pass.js）
const pass = require('./account-pass.js');

// 失败步骤汇总：只要有一个脚本非 0 退出，tasks.js 最后也非 0（不再静默绿）
const FAILED_STEPS = [];

// 小号判定（coldwind0 / coldwind1 / coldwind2 / coldwind6 / coldwind8 …；大号是裸 coldwind）。
// 目前只用来决定「附魔秘境」要不要启动：131 级小号在里面满血一刀被秒，进去也是白耗当天次数。
function isSubAccount(acc) {
    // 判定口径统一放在 account-pass.js，避免这里与登录密码的账号分类各写一套、判得不一致
    return pass.kindOf(acc) === 'sub';
}

function bjNow() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return { hour: d.getUTCHours(), min: d.getUTCMinutes(), day: d.getUTCDay() };
}

function resolveMode(hour, min, day) {
    if (MODE !== 'auto') return MODE;
    if (hour < 3) return 'dawn';   // 00:00-02:59（11-22 从「只算 0 点这一小时」延长到 3 小时）
    // dusk 窗口从「18:00-18:30」放宽到「18:00-19:55」（11-22 改）：
    //   派发本身就带 0~5 分钟随机错峰（boss.yml 的 sleep $((RANDOM % 300))），实测 tasks.js
    //   最晚 18:06 才启动；再叠上 runner 排队（高峰期几十分钟不奇怪），卡死 18:30 就等于
    //   某天排队久了整趟山寨+邮件+攻城全丢。放宽到 19:55 后，晚到也能接上并赶上 20:00 攻城。
    if (hour === 18 || (hour === 19 && min <= 55)) return 'dusk';
    if (hour === 20 && min <= 30 && (day === 2 || day === 6)) return 'gongcheng';
    return 'skip';
}

// ── 周二/六 18:00 这一趟：山寨+邮件跑完后原地等到 20:00 打攻城 ───────────────────
// 用户 11-22 的要求：这两天牺牲 18:00-20:00 的两小时刷怪时间，把攻城接在同一条派发里跑完。
// 之所以能这么接：外部派发（cron-job.org）只有 00:00 / 06:00 / 11:30 / 18:00 四个时刻，
// 没有 20:00 那条，所以这一个进程等下去不会跟别的派发撞同一个号。
// 代价：本进程不退出 → boss.yml 后面的 Run Boss / Run Farm 要等它结束才启动，
//   18:00 那趟的刷怪窗口从 6 小时缩到约 3.5 小时，这是用户明确接受的部分。
const GC_DAYS = [2, 6];                    // 周二、周六
const GC_START_MIN = 20 * 60;              // 20:00 开打
// ★ 提前出发（用户 11-24 20:37「20:00 准时开放，你 20:02 才到，错失先机」）
//   原来 tasks 等到 20:00 才启动 gongcheng.js，而「启动 → 登录 → 出航 → 航行 → 走到城门」
//   实测要 70 秒（今天 5 个号并发：20:01:00 启动，20:02:0x 才点第一只怪），
//   等于把最抢手的第一批怪整段让掉。现在 19:55 就启动，脚本提前站到城门。
//   gongcheng.js 的 eventPhase()='wait' 分支本来就支持这个场景：20:00 前在城门每 15 秒刷新，
//   最后 90 秒压到 3 秒刷一次，20:00 一到立刻点怪。5 分钟 = 实测 70 秒的 4 倍余量。
const GC_LEAD_MIN = GC_START_MIN - 5;      // 19:55 提前出发（不是提前开打）
const GC_DEADLINE_MIN = 20 * 60 + 30;      // 20:30 之后不再起（攻城只到 20:30）
const GC_WAIT_HEARTBEAT_MS = 10 * 60 * 1000;

// 纯函数：给定时刻，决定攻城这一步该干什么。抽出来是为了能离线单测（tasks-schedule-test.js）。
// 返回 { action: 'run' | 'wait' | 'skip', waitMs, reason }
function gongchengPlan(nowMs = Date.now()) {
    const bj = new Date(nowMs + 8 * 3600 * 1000);
    const day = bj.getUTCDay();
    const hour = bj.getUTCHours();
    const min = bj.getUTCMinutes();
    const sec = bj.getUTCSeconds();
    const hhmm = `${hour}:${String(min).padStart(2, '0')}`;
    if (!GC_DAYS.includes(day)) {
        return { action: 'skip', waitMs: 0, reason: `周${'日一二三四五六'[day]}不攻城（只在周二/周六）` };
    }
    const cur = hour * 60 + min;
    if (cur >= GC_DEADLINE_MIN) {
        return { action: 'skip', waitMs: 0, reason: `现在 ${hhmm} 已过 20:30，今天的攻城窗口过去了` };
    }
    if (cur >= GC_START_MIN) {
        return { action: 'run', waitMs: 0, reason: `现在 ${hhmm} 已在攻城窗口内，直接开打` };
    }
    if (cur >= GC_LEAD_MIN) {
        // 提前出发：脚本会自己站到城门刷新等 20:00，不会提前点怪
        return { action: 'run', waitMs: 0, reason: `现在 ${hhmm}，提前出发到城门等 20:00 开怪` };
    }
    const waitMs = ((GC_LEAD_MIN - cur) * 60 - sec) * 1000;
    return { action: 'wait', waitMs: Math.max(0, waitMs), reason: `现在 ${hhmm}，等到 19:55 提前出发（20:00 开怪，还有 ${Math.ceil(waitMs / 60000)} 分钟）` };
}

// 攻城等待开关（11-22 加，起因：用户手动取消了连续 4 天的 18:00 run）：
//   不打算等那两小时时，不需要点「取消运行」——取消会把同一趟的刷怪一起砍掉。
//   改成派发时传参数即可：GONGCHENG_WAIT=false → 山寨+邮件跑完就收工，后面照常 Run Boss / Run Farm。
// 为什么不能只认 '0'：workflow_dispatch 的 boolean 输入落到 env 里是 "true"/"false" 字符串，
//   只判 '0' 的话传 false 也照样等满两小时，开关等于没接上。
function gongchengWaitEnabled(v) {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    return !['0', 'false', 'no', 'off', 'skip'].includes(s);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 阻塞等待 + 每 10 分钟续一次账号锁（否则 45 分钟 TTL 一过，锁就形同虚设）
async function waitWithKeepAlive(waitMs, acc) {
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
        const left = end - Date.now();
        const step = Math.min(GC_WAIT_HEARTBEAT_MS, left);
        await sleep(Math.max(1000, step));
        const leftMin = Math.round(Math.max(0, end - Date.now()) / 60000);
        if (leftMin > 0) console.log(`[tasks] 等待攻城… 还剩约 ${leftMin} 分钟`);
        if (acc) acct.refresh(acc);
    }
}

// 步骤序号（11-22 加）：日志里每行都带上「第几步/共几步」，
// 面版/CI 里多个号的输出交错时也能一眼看出是同一套计划的第几步，不会看得像乱序。
let STEP_NO = 0;
let STEP_TOTAL = 0;

function plan(steps) {
    STEP_TOTAL = steps.length;
    STEP_NO = 0;
    console.log(`[tasks] 本次计划(共${STEP_TOTAL}步): ${steps.map((s, i) => `${i + 1}.${s[0]}`).join(' → ')}`);
    // TASKS_DRYRUN=1：只打印计划就退出，不登录、不启动任何脚本（本地核对顺序用）。
    // 注意配套 NO_ACCT_LOCK=1，否则会留下一把 45 分钟的空锁挡住真跑。
    if (process.env.TASKS_DRYRUN === '1') {
        console.log('[tasks] TASKS_DRYRUN=1 → 只打印计划，未启动任何脚本');
        process.exit(0);
    }
    return steps;
}

// 步内续锁间隔（11-22 加）：锁 TTL 45 分钟，dawn 现在有 11 步、其中奔月单步 17~20 分钟，
// 整趟叠加后必然跨过 TTL。不续期就等于没锁 —— 中途任何实例都能取锁登录把当前号顶下线。
// 5 分钟续一次，留足余量。
const LOCK_REFRESH_MS = Number(process.env.LOCK_REFRESH_MS || 5 * 60 * 1000);

// ★ 改成异步 + 步内续锁（11-22）：原来用 spawnSync 是阻塞的，等待期间无法做任何事，
//   自然也没法续锁。dawn 延长到 3 小时窗口后这条必须修，否则跑到第 45 分钟锁就失效了。
// extraEnv：给个别脚本补环境变量（奔月 / 海盗王两个批量脚本要的是 ACCOUNTS，不是 GAME_ACCOUNT）。
function runStep(name, script, extraEnv = {}) {
    STEP_NO++;
    const tag = STEP_TOTAL ? `(${STEP_NO}/${STEP_TOTAL})` : '';
    // 脚本可能只在本机存在（例如某步还在本地验证、没提交）：
    // 直接 spawn 一个不存在的文件只会刷一行 Node 报错，还会让这一步显示 exit=1。
    // 缺文件就跳过并说清楚，别让 CI 日志里出现假故障。
    if (!existsSync(script)) {
        console.log(`[tasks] --- ${tag} ${name} (${script}) 本机没有这个脚本，跳过`);
        return Promise.resolve();
    }
    console.log(`[tasks] >>> ${tag} ${name} (${script}) 开始`);
    const t0 = Date.now();
    // ★ NO_ACCT_LOCK=1 必须传给子脚本（11-22 实证）：
    //   本进程开头已经用 legacy 格式（只有时间戳、没有 pid）持了这把锁，而子脚本（kidd.js 用
    //   acct.guard）再取同一把锁时，acct-lock 的判活顺序里「无 pid 的旧格式锁 → 只按 TTL 判」，
    //   于是它把自己的父进程当成占用者 → guard 直接 exit(0)，整步**静默什么都不做**（日志还显示 exit=0）。
    //   账号在本进程整个生命周期内已被独占，子脚本不需要重复取锁；别的进程/manual 补跑照样会被挡。
    const childEnv = { ...process.env, NO_ACCT_LOCK: '1', ...extraEnv };
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script], { stdio: 'inherit', env: childEnv });
        const acc = process.env.GAME_ACCOUNT || '';
        const hb = acc ? setInterval(() => acct.refresh(acc), LOCK_REFRESH_MS) : null;
        let finished = false;
        const done = (code) => {
            if (finished) return;
            finished = true;
            if (hb) clearInterval(hb);
            const sec = Math.round((Date.now() - t0) / 1000);
            const c = code === null ? 'signal' : code;
            console.log(`[tasks] <<< ${name} 结束 exit=${c} 耗时${sec}s`);
            // 非 0 必须让整条 run 变红：11-10 coldwind1 山寨农场异常被吞掉，
            // 日志里没有「山寨农场完成」，run 却显示成功，白丢一整天。
            if (c !== 0) {
                FAILED_STEPS.push(name);
                console.log(`::error::${name} 失败（exit=${c}），详见上方日志`);
            }
            resolve();
        };
        child.on('close', done);
        child.on('error', (e) => {
            console.log(`[tasks] ${name} 启动失败: ${e && e.message}`);
            done(-1);
        });
    });
}

async function main() {
    if (!acquireAccountLock()) {
        // ★ 被别的实例挡下时，不光这一趟不跑，还得让 workflow 后面的 Run Boss / Run Farm 也别跑
        //   （11-22 发现：index.js 和 farm.js 都没接 acct-lock，tasks.js 退了它们照样登录同一个号，
        //    等于白挡）。往 GITHUB_ENV 写标记，boss.yml 里据此跳过后面两步。
        if (process.env.GITHUB_ENV) {
            try { appendFileSync(process.env.GITHUB_ENV, 'BOSS_SKIP_RUN=1\n'); } catch (e) { }
        }
        // 同时落一个工作区标记文件：boss.yml 用 hashFiles('.skip-run') 判断，
        // 不依赖 GITHUB_ENV 在 step if 里是否可见，双保险。
        try { writeFileSync(__dirname + '/.skip-run', String(Date.now())); } catch (e) { }
        process.exit(0);
        return;
    }
    const { hour, min, day } = bjNow();
    const mode = resolveMode(hour, min, day);
    console.log(`[tasks] 北京时间 ${hour}:${String(min).padStart(2, '0')}(周${'日一二三四五六'[day]}) → mode=${mode} (TASKS_MODE=${MODE})`);

    // ★ 开工前先把「我是哪个号、密码从哪来」打出来（11-22 用户提醒大号小号密码不同）：
    //   缺密码在这里就 exit 2，不会连登 11 步脚本、每步都失败一次才看出来。
    //   密码本身绝不打印，只报来源（GAME_PASSWORD / GAME_PASSWORD_<账号>）。
    if (process.env.TASKS_DRYRUN === '1') {
        // dryrun 只核顺序，不强制要密码，但把账号和「有没有密码」打出来便于核对
        let a = null;
        try { a = pass.resolve(pass.currentAccount()); } catch (e) { }
        console.log(`[tasks] 本次身份：${a ? pass.describe(a) : pass.currentAccount() + '（dryrun，未校验密码）'}`);
    } else {
        const auth = pass.resolveOrExit(pass.currentAccount());
        console.log(`[tasks] 本次身份：${pass.describe(auth)}`);
    }

    // 每日签到（幂等：已显示"今日已签到"直接跳过；只在dawn窗口登录，其他时间不登录）
    if (mode === 'dawn') {
        // ★ dawn 的顺序按「一条不回头的地理环线」排，不按任务大小排：
        //   东亚（长安·奔月 → 泉州·镇妖塔）→ 东南亚（马六甲·海盗王）
        //   → 地中海（威尼斯：钓鱼 → 附魔秘境 → 秘宝抽奖）
        //   → 北海（阿姆斯特丹·基德 → 伦敦·炼器窟）→ 收尾（每日任务，daily.js 内部还会串子任务）。
        //   11-22 重排过一次：原来炼器窟排在开头（与竞技场同在伦敦），加入长安/马六甲两个副本后，
        //   那样会变成「伦敦→东亚→东南亚→地中海→北海」的来回折返，每天多跑两三趟船。
        //   现在一路向西推进，全程不回头。
        const acc = process.env.GAME_ACCOUNT || '';
        // 奔月 / 海盗王两个是批量脚本（内部按 ACCOUNTS 逐号登录），吃的不是 GAME_ACCOUNT。
        // CI 每个 runner 只管一个号，所以只传当前这一个。
        const batchEnv = { ACCOUNTS: acc };
        const steps = [
            // 签到不限地点，登录即可（幂等：已签会自动跳过）
            ['每日签到', 'signin.js'],
            // 竞技场不限地点，登录后先打，省一次跨城移动
            ['竞技场', 'arena.js'],
            // 奔月秘境：长安 → 广场 → 嫦娥仙子，57 间房 DFS 全图。
            //   实测大号 13~17 分钟（打 boss 月神）、小号 19~20 分钟（skipBoss 跳月神）。
            //   skipBoss 按账号名自动判定，不改代码；小号战力够了用 BYMJ_FIGHT_BOSS=1 放开。
            ['奔月秘境', 'bymj-local/bymj-batch.js', batchEnv],
            // 镇妖塔：泉州 ★守塔武僧，每天 1 次，一局打到死为止（约 3 分钟）。长安 → 泉州同属中国区域
            ['镇妖塔', 'zhenyaota.js'],
            // 海盗王的诅咒：马六甲 → 渔村 → NPC 玛拉玛，四项条件各 3 只，实测 3~5 分钟
            ['海盗王的诅咒', 'hdwang-local/hdwang-batch.js', batchEnv],
            // 钓鱼：到威尼斯码头（饵料在此购买，0:00 顺路查背包补体力宝）
            ['钓鱼', 'fish.js'],
        ];
        // 附魔秘境（威尼斯）：与钓鱼同一张图，收竿后直接城内地图→铁匠铺→附魔师→附魔秘境，不用出航。
        // ★ 只给大号跑，小号连脚本都不启动：131 级小号满血被一刀秒（11-22 冷2 实测 dead/1 刀），
        //   打不过就别空耗当天那一次机会。fmsj.js 内部还有一道同样的账号拦截作为双保险。
        if (isSubAccount(acc)) {
            console.log('[tasks] 附魔秘境：小号跳过（打不过，不启动本副本）');
        } else {
            steps.push(['附魔秘境', 'fmsj.js']);
        }
        steps.push(['秘宝抽奖', 'mibao.js']);
        // 基德宝藏（阿姆斯特丹）与炼器窟（伦敦）同属北海区域，连着跑省一次出航
        steps.push(['基德宝藏', 'kidd.js']);
        steps.push(['炼器窟副本', 'dungeon.js']);
        steps.push(['每日任务', 'daily.js']);
        for (const [n, s, e] of plan(steps)) await runStep(n, s, e);
    } else if (mode === 'dusk') {
        // 攻城判定要在 plan() 之前做完：决定这一趟到底几步（周二/六是 3 步，其余 2 步）
        const gc = !gongchengWaitEnabled(process.env.GONGCHENG_WAIT)
            ? { action: 'off', waitMs: 0, reason: 'GONGCHENG_WAIT 已显式关闭，本次不等攻城' }
            : gongchengPlan();
        // 攻城脚本没入库时（CI 上没有 gongcheng.js）就别等这 2 小时了：
        // 白占 2 小时 runner、又刷不了怪，最后还打印一句「本机没有这个脚本，跳过」，双输。
        const gcReady = existsSync('gongcheng.js');
        const doGc = (gc.action === 'wait' || gc.action === 'run') && gcReady;
        if (!gcReady && (gc.action === 'wait' || gc.action === 'run')) {
            console.log('[tasks] 攻城脚本 gongcheng.js 不在本机 → 不等 20:00，直接结束本趟任务');
        }
        const steps = [['山寨农场', 'shanzhai.js'], ['邮件领取', 'mail.js']];
        if (doGc) steps.push(['怪物攻城', 'gongcheng.js']);
        plan(steps);
        await runStep('山寨农场', 'shanzhai.js');
        await runStep('邮件领取', 'mail.js');
        if (doGc) {
            if (gc.action === 'wait') {
                console.log(`[tasks] 攻城判定：${gc.reason} —— 这段时间不打怪，等它`);
                await waitWithKeepAlive(gc.waitMs, process.env.GAME_ACCOUNT || '');
                console.log('[tasks] 到 19:55，提前出发：先登录出航站到城门，20:00 开怪立刻点');
            } else {
                console.log(`[tasks] 攻城判定：${gc.reason}`);
            }
            await runStep('怪物攻城', 'gongcheng.js');
        } else {
            console.log(`[tasks] 本次不打攻城：${gc.reason}`);
        }
    } else if (mode === 'gongcheng') {
        for (const [n, s] of plan([['怪物攻城', 'gongcheng.js']])) await runStep(n, s);
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

if (require.main === module) {
    main().catch((e) => {
        console.error('[tasks] tasks.js自身异常(不阻塞后续刷怪):', e && e.message);
        process.exit(0);
    });
}
// 只导出给小测用（`node fmsj-test.js` / `node tasks-schedule-test.js`），被 require 时不会跑主流程
module.exports = { isSubAccount, resolveMode, gongchengPlan, gongchengWaitEnabled, runStep, plan };
