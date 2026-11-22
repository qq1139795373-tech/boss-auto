// 同账号互斥锁 —— 所有「会登录某个账号」的脚本共用这一份实现（2026-11-19）
//
// 铁律：同一账号同一时间只能有一个会话。两条实例同时登录同一个号会互相顶号下线
// （10-27 实证：自己起的探查把用户顶下线两次）。
//
// ★ 作用域（11-22 用户判断后写清，别再误当成「防并发的主力」）：
//   任务本身是一个接一个串行的，正常情况下根本不会并发登录，所以这把锁**日常从不触发**。
//   · CI：每个 runner 的临时目录各自独立，锁文件不在同一块盘 → **对跨 runner 完全无效**，
//     别指望它挡住两个 workflow 同时登一个号（boss.yml 的 matrix 就是各号各 runner）。
//   · 本机：同一台机器上两条入口（批量脚本 + 手动补跑）共用同一份锁文件，这时它才是有效的安全网；
//     10-27 那次顶号就是本机场景。
//   特殊情况下的顶号是偶发事件，不构成任何排期/闸门的理由；本模块只保留「本机误开两个进程」这一道拦截。
// 之前 tasks.js 内联了一份、kidd.js / hdwang-batch.js / bymj-batch.js 各自没有，
// 于是「锁只保护了任务流程，没保护副本脚本」—— 这就是脚本间的真冲突。
//
// 锁文件：<系统临时目录>/boss-acct-<账号>.lock，内容 `时间戳|pid|脚本名`。
// 判活顺序：
//   ① 同一个 pid 已持锁 → 视为自己（可重入，orchestrator 串行调子脚本不会自杀）；
//   ② 持锁 pid 的进程还活着 → 占用；
//   ③ 持锁 pid 的进程已退出 → 立刻算过期（不必等 TTL）；
//   ④ 老格式（只有时间戳、没有 pid，tasks.js 早期写法）→ 只按 TTL 判。
// 锁不可写时不阻断业务（宁可跑，也别因为临时目录权限把任务卡死）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL = 45 * 60 * 1000;

function lockFile(acc) {
    return path.join(os.tmpdir(), `boss-acct-${acc}.lock`);
}

function raw(acc) {
    try { return fs.readFileSync(lockFile(acc), 'utf8').trim(); } catch (e) { return null; }
}

function parse(text) {
    if (!text) return null;
    const parts = String(text).split('|');
    const ts = Number(parts[0]) || 0;
    if (!ts) return null;
    return {
        ts,
        pid: Number(parts[1]) || 0,
        tag: (parts.slice(2).join('|') || '').trim() || (parts[1] ? '未知脚本' : '旧版锁'),
    };
}

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return !!e && e.code === 'EPERM'; }   // 没权限杀说明进程在
}

// { locked, mine, stale, pid, tag, age }
function state(acc, ttl = DEFAULT_TTL) {
    const cur = parse(raw(acc));
    if (!cur) return { locked: false };
    const age = Date.now() - cur.ts;
    if (cur.pid === process.pid) return { locked: true, mine: true, age, ...cur };
    if (cur.pid) {
        if (pidAlive(cur.pid)) return { locked: true, mine: false, age, ...cur };
        return { locked: false, stale: true, age, ...cur };    // 进程已退出 → 死锁可接管
    }
    if (age < ttl) return { locked: true, mine: false, age, ...cur };
    return { locked: false, stale: true, age, ...cur };
}

function write(acc, tag, legacyFormat) {
    const body = legacyFormat
        ? String(Date.now())
        : `${Date.now()}|${process.pid}|${tag || path.basename(process.argv[1] || 'node')}`;
    try { fs.writeFileSync(lockFile(acc), body); } catch (e) { /* 锁不可用不阻断业务 */ }
}

function release(acc) {
    const cur = parse(raw(acc));
    if (!cur || cur.pid !== process.pid) return false;      // 不是自己的锁绝不动
    try { fs.unlinkSync(lockFile(acc)); } catch (e) { }
    return true;
}

// 续期（11-22 加）：tasks.js 在周二/六会阻塞等到 20:00 打攻城，最长要占着账号接近 2 小时，
// 而默认 TTL 只有 45 分钟 —— 不续期的话等待途中锁就"过期"了，此时任何别的实例（手动补跑、
// 别的派发）都能取到锁并登录，直接把这个号的攻城会话顶掉。
// 只续自己的锁：pid 对得上（或本来就是无 pid 的旧格式）才重写时间戳，别人的锁一律不碰。
// 保持原格式不升级成 pid 格式：tasks.js 的语义是"跑完后 45 分钟内重复派发直接跳过"，
// 换成 pid 格式会变成"进程一退出立刻可接管"，反而把防重复派发的效果弄丢。
function refresh(acc) {
    if (!acc) return false;
    const cur = parse(raw(acc));
    if (!cur) return false;
    if (cur.pid && cur.pid !== process.pid) return false;
    // ★ 必须保留原有格式（11-22 修）：原实现无条件写纯时间戳，会把 pid 格式的锁**降级成 legacy**，
    //   之后 release() 判 `cur.pid !== process.pid`（pid 变成了 0）直接不删，
    //   锁要白等到 45 分钟 TTL 才过期，期间谁也登不上这个号。legacy 锁（pid=0）继续写纯时间戳。
    const body = cur.pid ? `${Date.now()}|${cur.pid}|${cur.tag}` : String(Date.now());
    try { fs.writeFileSync(lockFile(acc), body); } catch (e) { return false; }
    return true;
}

// 取锁。返回 { ok, st }；ok=false 时调用方自己决定跳过还是退出。
function acquire(acc, { ttl = DEFAULT_TTL, tag = '', keepAfterExit = false, legacyFormat = false } = {}) {
    if (!acc) return { ok: true, skipped: '无账号' };
    if (process.env.NO_ACCT_LOCK === '1') return { ok: true, skipped: 'NO_ACCT_LOCK=1' };
    const st = state(acc, ttl);
    if (st.locked && !st.mine) return { ok: false, st };
    write(acc, tag, legacyFormat);
    if (!keepAfterExit) process.once('exit', () => release(acc));
    return { ok: true, st };
}

function describe(st) {
    const mins = Math.round((st.age || 0) / 60000);
    return `「${st.tag}」pid ${st.pid || '?'}，${mins} 分钟前启动`;
}

// 交互/单号脚本专用：被占就打印原因直接退出，绝不硬登。
function guard(acc, opts = {}) {
    const r = acquire(acc, opts);
    if (r.ok) return true;
    console.log(`::warning::${acc} 正被${describe(r.st)}占用 → 本次不登录（同账号两个会话会互相顶号）`);
    console.log(`[锁] 确认没有实例在跑时可删 ${lockFile(acc)}，或临时加 NO_ACCT_LOCK=1`);
    process.exit(opts.exitCode || 0);
}

module.exports = { acquire, release, state, guard, describe, lockFile, refresh, DEFAULT_TTL };
