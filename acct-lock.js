// 同账号互斥锁 —— 所有「会登录某个账号」的脚本共用这一份实现（2026-11-19）
//
// 铁律：同一账号同一时间只能有一个会话。两条实例同时登录同一个号会互相顶号下线
// （10-27 实证：自己起的探查把用户顶下线两次）。
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

module.exports = { acquire, release, state, guard, describe, lockFile, DEFAULT_TTL };
