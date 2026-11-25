// game-url.js —— 游戏站点入口的**唯一定义处**（2026-11-24 加）
//
// 起因（用户 11-24 21:05 转达群通告）：京东云把当前域名直接拦截，站点进不去，
//   之后要换一个域名。改之前，登录地址被硬编码在 100 多个脚本里（每个都写着同一串
//   'http://yiyu.yiyutx.top/yysh/#/pages/login/login'），换域名等于全仓搜索替换，
//   漏一处就是那一步任务连不上、整条流程红叉。
//
// 现在的口径：**自动任务主链的脚本一律从这里取登录地址**，不再写字面量。
// 换域名的两种方式（任选其一，都不用改业务脚本）：
//   1) 临时/快速：GitHub 仓库变量（Settings → Variables）设 GAME_URL=http://新域名，
//      下次派发即生效，不用提交、不用等 CI 重新检出旧代码。
//   2) 长期：改下面的 DEFAULT_BASE 一行并提交。
//
// GAME_URL 只写站点根（协议 + 主机 + 可选端口），路径部分由本文件拼：
//   末尾多余的 '/' 会被去掉，所以 'http://x.top' 与 'http://x.top/' 等价。
// 若换了服务商后游戏路径也变了（不再是 /yysh/#/pages/login/login），改 GAME_PATH。

const DEFAULT_BASE = 'http://yiyu.yiyutx.top';
const GAME_PATH = '/yysh/#/pages/login/login';

// 纯函数：规范化站点根。空值 / 空白 / 只写斜杠 → 回退默认域名。
function resolveBase(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s || s === '/') return DEFAULT_BASE;
    return s.replace(/\/+$/, '');
}

// 纯函数：站点根 + 登录路径。抽出来是为了能离线单测（game-url-test.js）。
function loginUrl(base) {
    const b = resolveBase(base);
    return `${b}${GAME_PATH}`;
}

const base = resolveBase(process.env.GAME_URL);

module.exports = {
    DEFAULT_BASE,
    GAME_PATH,
    base,
    LOGIN_URL: loginUrl(base),
    resolveBase,
    loginUrl,
};
