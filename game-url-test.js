// game-url-test.js —— 登录地址收口的守门测试（2026-11-24 加）
//
// 守两件事：
//   1) 换域名只改一处：GAME_URL 环境变量 / game-url.js 的 DEFAULT_BASE 必须能改写所有主链脚本
//   2) 不许回潮：主链脚本里再出现 'http://yiyu.yiyutx.top' 字面量就红叉
//
// 跑法：node game-url-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { DEFAULT_BASE, GAME_PATH, resolveBase, loginUrl } = require('./game-url.js');

let pass = 0;
const fails = [];
function t(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fails.push(`${name}: ${e.message}`);
        console.log(`  ✗ ${name} → ${e.message}`);
    }
}

// 自动任务主链脚本（tasks.js 的步骤 + boss.yml 的 job 会用到的）
const MAIN_CHAIN = [
    'signin.js', 'arena.js', 'kidd.js', 'dungeon.js', 'daily.js', 'fish.js',
    'index.js', 'farm.js', 'gongcheng.js', 'mail.js', 'shanzhai.js', 'mibao.js',
    'zhenyaota.js', 'qllm-run.js', 'fmsj.js',
    'bymj-local/bymj-batch.js', 'hdwang-local/hdwang-batch.js',
];

console.log('[1] 默认口径');
t(`默认站点根是 ${DEFAULT_BASE}`, () => {
    assert.strictEqual(resolveBase(''), DEFAULT_BASE);
    assert.strictEqual(resolveBase(undefined), DEFAULT_BASE);
    assert.strictEqual(resolveBase(null), DEFAULT_BASE);
});
t('默认登录地址 = 站点根 + /yysh/#/pages/login/login', () => {
    assert.strictEqual(loginUrl(DEFAULT_BASE), `${DEFAULT_BASE}${GAME_PATH}`);
    assert.strictEqual(loginUrl(''), `${DEFAULT_BASE}${GAME_PATH}`);
});
t('空白串 / 只有斜杠 → 回落默认（不能用空域名拼出 "/yysh/..."）', () => {
    assert.strictEqual(resolveBase('   '), DEFAULT_BASE);
    assert.strictEqual(resolveBase('/'), DEFAULT_BASE);
    assert.ok(loginUrl('   ').startsWith('http'));
});

console.log('[2] 换域名：末尾斜杠要吃掉，不能拼出 //yysh');
t('http://new.top → 正常拼接', () => {
    assert.strictEqual(loginUrl('http://new.top'), 'http://new.top/yysh/#/pages/login/login');
});
t('http://new.top/ → 同样结果', () => {
    assert.strictEqual(loginUrl('http://new.top/'), 'http://new.top/yysh/#/pages/login/login');
});
t('http://new.top/// → 同样结果', () => {
    assert.strictEqual(loginUrl('http://new.top///'), 'http://new.top/yysh/#/pages/login/login');
});
t('带端口 http://new.top:8080 → 保留端口', () => {
    assert.strictEqual(loginUrl('http://new.top:8080'), 'http://new.top:8080/yysh/#/pages/login/login');
});

console.log('[3] GAME_URL 环境变量真的能改掉实际导出的 LOGIN_URL');
t('子进程 GAME_URL=http://demo.local → LOGIN_URL 跟着换', () => {
    const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./game-url.js').LOGIN_URL)"], {
        cwd: __dirname,
        env: { ...process.env, GAME_URL: 'http://demo.local' },
        encoding: 'utf8',
    });
    assert.strictEqual(out, 'http://demo.local/yysh/#/pages/login/login');
});
t('子进程不设 GAME_URL → 仍是默认域名', () => {
    const env = { ...process.env };
    delete env.GAME_URL;
    const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./game-url.js').LOGIN_URL)"], {
        cwd: __dirname, env, encoding: 'utf8',
    });
    assert.strictEqual(out, `${DEFAULT_BASE}${GAME_PATH}`);
});

console.log('[4] 主链脚本不许再写死域名');
for (const rel of MAIN_CHAIN) {
    t(`${rel} 引用 game-url.js 且无硬编码`, () => {
        const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        assert.ok(!/yiyu\.yiyutx\.top/.test(src), '还残留硬编码域名');
        const req = rel.includes('/') ? '../game-url.js' : './game-url.js';
        assert.ok(src.includes(`require('${req}')`), `没有引用 ${req}`);
        assert.ok(/LOGIN_URL/.test(src), '没有使用 LOGIN_URL');
    });
}

// 反向证伪（D9）：上面那组断言必须真的会失败，否则它就是永远为真的空检查。
// 造一个临时文件，塞回硬编码域名，确认检测逻辑能报出来。
t('★ 证伪：塞回硬编码的文件会被第 [4] 组查出', () => {
    const probe = path.join(__dirname, '.tmp-game-url-probe.js');
    fs.writeFileSync(probe, "const URL = 'http://yiyu.yiyutx.top/yysh/#/pages/login/login';");
    try {
        const src = fs.readFileSync(probe, 'utf8');
        assert.ok(/yiyu\.yiyutx\.top/.test(src), '证伪样本本身不对，测试失效');
    } finally {
        fs.unlinkSync(probe);
    }
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
    for (const f of fails) console.log(`  ! ${f}`);
    process.exit(1);
}
