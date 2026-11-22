// accounts-json-check.js —— 启动前校验 GAME_ACCOUNTS_JSON（multi-boss 的账号表）
//
// 为什么要有这一步（2026-11-22 用户提醒「大号小号密码不一样的，不要弄错了」）：
//   workflow 用 `jq -r '.[i].password'` 取密码，**取不到键时吐出字面量 "null"**，
//   于是会拿 "null" 去登录 → 页面只报「密码错误」，配上「大号冷wind / 小号冷windN 密码不同」
//   这个背景，根本看不出到底是缺字段还是密码写错。宁可在 prepare 阶段直接红叉。
//
// 校验项：
//   1. 非空、合法 JSON、非空数组
//   2. 每项都有非空 account 与 password（"null"/"undefined" 不算）
//   3. account 不重复（大小写不敏感）
// 用法：JSON='[...]' node accounts-json-check.js
const raw = process.env.JSON || '';

function die(msg) {
    console.log('::error::' + msg);
    process.exit(1);
}

if (!raw.trim()) die('仓库 secret GAME_ACCOUNTS_JSON 未配置（为空）');

let list;
try {
    list = JSON.parse(raw);
} catch (e) {
    die('GAME_ACCOUNTS_JSON 不是合法 JSON：' + e.message);
}

if (!Array.isArray(list) || list.length === 0) die('GAME_ACCOUNTS_JSON 应为非空 JSON 数组');

const BAD = new Set(['', 'null', 'undefined', 'nil', 'none']);
const clean = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    return BAD.has(s.toLowerCase()) ? '' : s;
};

const problems = [];
const seen = new Map();
list.forEach((it, i) => {
    const acc = clean(it && it.account);
    const pw = clean(it && it.password);
    if (!acc) problems.push(`第 ${i} 项缺 account`);
    if (!pw) problems.push(`第 ${i} 项（${acc || '无账号名'}）缺 password —— 不能靠别的号的密码顶替`);
    if (acc) {
        const key = acc.toLowerCase();
        if (seen.has(key)) problems.push(`账号 ${acc} 重复出现（第 ${seen.get(key)} 项和第 ${i} 项）`);
        else seen.set(key, i);
    }
});

if (problems.length) {
    problems.forEach((p) => console.log('  ✗ ' + p));
    die('账号表校验失败，拒绝启动（大号 coldwind 与小号 coldwindN 密码不同，不能共用一个）');
}

// 只报「有没有密码」，绝不打印密码本身
console.log(`账号表校验通过，共 ${list.length} 项：`);
list.forEach((it, i) => {
    const acc = clean(it.account);
    console.log(`  ${i}. ${acc}（密码已配置）`);
});
