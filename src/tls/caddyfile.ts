/**
 * 由 QRFolder 的配置生成 Caddyfile。
 *
 * 为什么生成 Caddyfile 而不是 Caddy 的 JSON：这段文本要**原样显示在后台**让人过目。
 * 改的是公网暴露面，看不见就等于闭着眼睛改；而 Caddy 的 JSON 配置没人读得下去。
 *
 * ★ 四条实测得出的硬约束，改动本文件前请先看懂：
 *
 *   1. **只能用 LF 换行。** 写成 CRLF 会让 Caddy 判定
 *      「Caddyfile input is not formatted」，每次应用都带一条警告 —— 明明成功了
 *      却像出了问题。所以在 Windows 上也不能用 os.EOL。
 *
 *   2. **`header_down` 只在 reverse_proxy 块内合法。** 写在站点块里 Caddy 会直接
 *      `unrecognized directive: header_down` 拒绝加载。要删掉 Caddy 自己产生的
 *      `Server: Caddy`，站点级得用 `header -Server`（实测有效）。
 *      本项目 README 与部署文档里那份示例正是错的写法，已一并修正。
 *
 *   3. **被代理的响应本来就不带 `Server` 头** —— Caddy 只给自己产生的响应加。
 *      所以真正需要 `header -Server` 兜的是重定向与错误页这类 Caddy 自己生成的响应。
 *
 *   4. 站点块里**不能**写通配符域名：标准版 Caddy 不带 DNS 验证插件，
 *      通配符证书签不下来。校验层已经先把它挡掉了。
 */

import type { Config } from '../config/schema.ts';

/** Let's Encrypt 测试环境的 ACME 目录 */
export const STAGING_ACME_CA = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/**
 * Caddy 反向代理要连的本机地址。
 *
 * `0.0.0.0` / `::` 是「监听所有网卡」的写法，不是一个能连接的地址 ——
 * 直接拿去当 upstream，Caddy 会在启动时报解析失败。
 */
export function proxyTarget(config: Config): string {
  const host = config.system.host;
  const connectHost = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
  return `${connectHost}:${config.system.port}`;
}

/** 从管理接口地址里取 host:port，供 Caddyfile 的 admin 全局选项使用 */
function adminAddress(adminApi: string): string {
  try {
    return new URL(adminApi).host;
  } catch {
    return '127.0.0.1:2019';
  }
}

/** Caddy 的缩进是制表符，不是空格 */
const TAB = '\t';

/**
 * 上游挂掉时给访客看的页面。
 *
 * 存在的理由：Caddy 默认的 502 **响应体是空的** —— 手机上就是一片白，
 * 访客完全不知道发生了什么，只会以为「网站坏了」。给一句话，至少知道是暂时的。
 *
 * 写作上的三个约束（改之前先看清楚）：
 *   - 整页压成一行：它在 Caddyfile 里是一个双引号字符串，换行会把它截断
 *   - **一个双引号都不能有**：HTML 属性与 CSS 一律用单引号，
 *     否则会提前结束这个 Caddyfile 字符串（实测报
 *     「wrong argument count or unexpected line ending」）
 *   - 不出现反引号（模板字符串的边界）与 `${`（模板插值）
 * 用到的占位符 `{http.error.status_code}` 由 Caddy 在响应时替换成真实状态码。
 */
const ERROR_PAGE =
  "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>" +
  "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
  "<meta name='robots' content='noindex'>" +
  '<title>{http.error.status_code}</title>' +
  '<style>html,body{margin:0;height:100%}' +
  'body{display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328;' +
  "font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}" +
  'main{text-align:center;padding:24px}h1{margin:0;font-size:38px;font-weight:600;letter-spacing:-1px}' +
  'p{margin:10px 0 0;color:#6b7280;font-size:14px}' +
  '@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e7e9ec}p{color:#98a1ad}}' +
  '</style></head><body><main><h1>{http.error.status_code}</h1>' +
  '<p>服务暂时不可用，请稍后再试 · Service temporarily unavailable</p>' +
  '</main></body></html>';

export function buildCaddyfile(config: Config): string {
  const tls = config.system.tls;
  if (tls.domains.length === 0) {
    throw new Error('没有配置任何域名，无法生成 Caddyfile');
  }

  const lines: string[] = [];

  // ---- 全局选项 ----
  lines.push('{');
  if (tls.email !== '') lines.push(`${TAB}email ${tls.email}`);
  lines.push(`${TAB}admin ${adminAddress(tls.adminApi)}`);
  // ★ 关掉 Caddy 自动生成的 HTTP→HTTPS 跳转，改由下面的 :80 块自己接管。
  //   原因是自动跳转是 Caddy 内部插的路由，**站点块里的 header -Server 管不到它** ——
  //   实测 http://files.example.com/ 的 308 响应里带着 `Server: Caddy`。
  //   而 80 是绝大多数人（和扫描器）默认会撞的入口，不能漏。
  lines.push(`${TAB}auto_https disable_redirects`);
  if (tls.staging) {
    lines.push(`${TAB}# 测试环境：签出来的证书浏览器不认，只用于验证流程本身`);
    lines.push(`${TAB}acme_ca ${STAGING_ACME_CA}`);
  }
  lines.push('}');
  lines.push('');

  // ---- 站点 ----
  // 站点地址不带协议前缀，Caddy 就会自动申请证书并在 80 上做跳转
  lines.push(`${tls.domains.join(', ')} {`);
  lines.push(`${TAB}encode gzip`);
  lines.push(`${TAB}reverse_proxy ${proxyTarget(config)}`);
  lines.push('');
  // ★ 刻意**不写** header_up X-Forwarded-For。
  //   有一条看似稳妥、实则多余的直觉是「显式覆盖 XFF，免得客户端伪造的留在链里」。
  //   实测下来 Caddy 的默认行为已经是**替换**而不是追加：带
  //   `X-Forwarded-For: 1.2.3.4` 请求，上游收到的是 `127.0.0.1`，伪造值被整个丢掉。
  //   X-Forwarded-Proto / -Host 同样是默认就设好的（QRFolder 判断协议正是靠前者）。
  //   写上它反而会让 Caddy 每次适配都回一句「Unnecessary header_up」的警告 ——
  //   让使用者习惯性忽略警告，比省下这点代码危险得多。
  // 删掉 Caddy 自己产生的 Server 头（重定向、错误页这类响应会带）
  lines.push(`${TAB}header -Server`);
  lines.push(`${TAB}header -X-Powered-By`);
  lines.push('');

  // ---- Caddy 自己产生的错误响应 ----
  // 上游挂掉时 Caddy 会自己回一个 502，而那种响应：① 带 `Server: Caddy`；
  // ② **响应体是空的** —— 手机上看到的就是一片白，完全不知道发生了什么。
  //
  // ★ handle_errors 必须写在**站点块内部**。放到顶层 Caddy 会报
  //   「parsed 'handle_errors' as a site address, but it is a known directive」。
  // 实测它不会劫持上游自己的错误页（QRFolder 的 404 原样透传），只有 Caddy 自己产生的错误才走这里。
  lines.push(`${TAB}handle_errors {`);
  lines.push(`${TAB}${TAB}header -Server`);
  lines.push(`${TAB}${TAB}header -X-Powered-By`);
  lines.push(`${TAB}${TAB}header Content-Type "text/html; charset=utf-8"`);
  lines.push(`${TAB}${TAB}respond "${ERROR_PAGE}" {http.error.status_code}`);
  lines.push(`${TAB}}`);
  lines.push('}');
  lines.push('');

  // ---- 80 端口：统一跳到 HTTPS ----
  // 不写具体域名，任何 Host 打进来都接住 —— 否则别的 Host 会落到 Caddy 的默认处理上，
  // 而那种响应一定带 `Server: Caddy`（实测过）。
  lines.push(':80 {');
  lines.push(`${TAB}header -Server`);
  lines.push(`${TAB}header -X-Powered-By`);
  lines.push(`${TAB}redir https://{host}{uri} permanent`);
  lines.push('}');

  return `${lines.join('\n')}\n`;
}
