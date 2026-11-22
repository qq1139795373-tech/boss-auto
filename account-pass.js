// account-pass.js —— 账号 / 密码的唯一解析入口
//
// ★ 铁律（2026-11-22 用户提醒「大号小号密码不一样的，不要弄错了」）
//   大号 coldwind 与小号 coldwind0/1/2/6/8 的密码**不同**（权威源：zhsh/账号.txt）。
//   因此本模块**故意不写任何密码字面量**：在本文件里写死任何一个密码，都会让另一半账号登错。
//   密码只能来自环境变量：
//     CI  · multi-boss：GAME_ACCOUNTS_JSON 里每个账号自带 password，workflow 逐号写入 GAME_PASSWORD
//         · master    ：secrets.GAME_ACCOUNT / secrets.GAME_PASSWORD（只有大号一条线）
//     本机 · GAME_ACCOUNT=x GAME_PASSWORD=y node xxx.js
//   同进程要同时登两类账号时（情侣迷宫 大号+冷6），用 GAME_PASSWORD_<ROLE> 分开给。
//
// 三条硬规则：
//   1. 缺密码 → 抛错 / exit 2，**绝不回落到任何默认值**（回落到任一边都是登错号）；
//   2. 空串、纯空格、字面量 "null"/"undefined" 一律算「没有密码」——
//      workflow 里 `jq -r '.[i].password'` 取不到键时会吐出字符串 "null"，
//      不拦就会拿 "null" 去登录，报错信息还完全看不出原因；
//   3. 一次运行共用一份密码时，账号列表里不许同时出现大号和小号（一份密码不可能对两类都成立）。

const MAIN_ACCOUNT = 'coldwind';

/** 账号类别：main（大号）/ sub（小号）/ other（认不出）/ unknown（空） */
function kindOf(acc) {
    const a = String(acc === undefined || acc === null ? '' : acc).trim();
    if (!a) return 'unknown';
    const low = a.toLowerCase();
    if (low === MAIN_ACCOUNT) return 'main';
    if (/^coldwind\d+$/.test(low)) return 'sub';
    return 'other';
}

/** 中文标签，只用于日志与报错 */
function label(acc) {
    const k = kindOf(acc);
    if (k === 'main') return '大号';
    if (k === 'sub') return '小号';
    if (k === 'other') return '未登记账号';
    return '空账号';
}

const BAD_TOKENS = new Set(['', 'null', 'undefined', 'nil', 'none', 'nan']);

/** 把环境变量里的密码洗成「真密码」或空串；不猜、不补 */
function sanitize(v) {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    return BAD_TOKENS.has(s.toLowerCase()) ? '' : s;
}

function missingMessage(acc, from) {
    return `账号 ${acc}（${label(acc)}）没有可用密码${from ? '（来源 ' + from + '）' : ''}：`
        + 'GAME_PASSWORD 缺失 / 为空 / 为字面量 null。'
        + '大号 coldwind 与小号 coldwindN 密码不同，本模块不做任何默认值兜底，'
        + '请按账号给对应的 GAME_PASSWORD（multi-boss 用 GAME_ACCOUNTS_JSON 里的 password 字段）。';
}

/**
 * 解析单个账号的密码。
 * @param {string} acc 账号名
 * @param {object} [env] 默认 process.env
 * @param {string} [role] 角色名（LEADER / MEMBER）：给了就先读 GAME_PASSWORD_<ROLE>
 * @returns {{account:string, password:string, kind:string, source:string}}
 */
function resolve(acc, env = process.env, role = '') {
    const name = String(acc === undefined || acc === null ? '' : acc).trim();
    if (!name) throw new Error('没有账号名（GAME_ACCOUNT / ACCOUNT / ACCOUNTS 都为空）');

    // 优先级：角色专属（GAME_PASSWORD_LEADER）→ 账号专属（GAME_PASSWORD_COLDWIND6）→ 公用（GAME_PASSWORD）
    const roleKey = role ? `GAME_PASSWORD_${String(role).toUpperCase()}` : '';
    const roleVal = roleKey ? sanitize(env[roleKey]) : '';
    if (roleVal) return { account: name, password: roleVal, kind: kindOf(name), source: roleKey };

    const accKey = `GAME_PASSWORD_${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    const accVal = sanitize(env[accKey]);
    if (accVal) return { account: name, password: accVal, kind: kindOf(name), source: accKey };

    const common = sanitize(env.GAME_PASSWORD);
    if (common) return { account: name, password: common, kind: kindOf(name), source: 'GAME_PASSWORD' };

    const tried = [roleKey, accKey, 'GAME_PASSWORD'].filter(Boolean).join('、');
    const msg = missingMessage(name, tried);
    const err = new Error(msg);
    err.code = 'NO_PASSWORD';
    throw err;
}

/** resolve 的进程版：出错直接 exit 2（交给 CI 变成红叉，别静默空转） */
function resolveOrExit(acc, env = process.env, role = '') {
    try {
        return resolve(acc, env, role);
    } catch (e) {
        console.log('::error::' + e.message);
        process.exit(2);
    }
}

/** 从 GAME_ACCOUNT / ACCOUNT 取当前进程的账号（都不在就是空） */
function currentAccount(env = process.env) {
    return String(env.GAME_ACCOUNT || env.ACCOUNT || '').trim();
}

/**
 * 一次运行共用一份密码时，账号列表必须同类。
 * @throws 列表里同时有大号与小号（或含未登记账号）
 */
function assertSameClass(accounts) {
    const list = (accounts || []).map((s) => String(s).trim()).filter(Boolean);
    const kinds = [...new Set(list.map(kindOf))];
    if (kinds.length > 1) {
        throw new Error(
            `本次运行的账号混了不同类别：${list.map((a) => `${a}(${label(a)})`).join('、')}。`
            + '它们密码不同，一份 GAME_PASSWORD 只能服务同一类账号，请拆成两次运行（或用 GAME_PASSWORD_<ROLE> 分开给）。'
        );
    }
    if (kinds.length === 1 && kinds[0] === 'other') {
        throw new Error(`账号 ${list.join(',')} 不在已知名单（大号 coldwind / 小号 coldwindN），请确认账号名没写错。`);
    }
    return true;
}

/**
 * 同进程登多个账号时，检查「不同类别却用了同一份密码」这种必错组合。
 * @param {Array<{account:string,password:string,source:string}>} infos
 */
function assertDistinctPasswords(infos) {
    const list = (infos || []).filter(Boolean);
    const byKind = new Map();
    for (const it of list) {
        if (!byKind.has(it.kind)) byKind.set(it.kind, []);
        byKind.get(it.kind).push(it);
    }
    const kinds = [...byKind.keys()].filter((k) => k !== 'unknown');
    if (kinds.length > 1) {
        const srcs = new Set(list.map((i) => i.source));
        if (srcs.size === 1 && srcs.has('GAME_PASSWORD')) {
            throw new Error(
                '本次同时登录了大号与小号，但两个号用的是同一份 GAME_PASSWORD —— 必然有一个登不上。'
                + '请分开给：GAME_PASSWORD_LEADER / GAME_PASSWORD_MEMBER（或按角色对应的环境变量名）。'
            );
        }
    }
    return true;
}

/** 一行身份摘要，给日志用（不含密码本身，只报来源） */
function describe(info) {
    if (!info) return '(未解析)';
    return `${info.account}（${label(info.account)}，密码来源 ${info.source}）`;
}

module.exports = {
    MAIN_ACCOUNT,
    kindOf,
    label,
    sanitize,
    resolve,
    resolveOrExit,
    currentAccount,
    assertSameClass,
    assertDistinctPasswords,
    describe,
};
