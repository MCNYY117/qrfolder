/**
 * 内容页（目录列表 / 错误页 / 密码页）的样式。
 *
 * 视觉基线来自既有的 Caddy 版列表页：深色模式自动切换、纯 CSS 文件夹图标、
 * 扩展名徽章、响应式窄屏适配。
 */

import type { Density } from '../config/schema.ts';
import { baseCss } from './baseCss.ts';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * ★ 配置里的颜色值不能直接拼进 <style>。
 * 一个恶意/手滑的配置值（如 `#fff}</style><script>…`）就是一条
 * 从配置面通往 XSS 的通路 —— 而后台会话 cookie 就在同源。
 * 只放行严格的 #rrggbb。
 */
export function safeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

/**
 * 声明本页自己处理明暗 —— 内容页、主界面、后台三处共用，必须跟着 data-theme 走。
 *
 * ★ 不写这段，Edge / Chrome 的「强制深色模式」（Auto Dark Theme）会把页面
 *   当成浅色站再反转一遍。后果非常难查：**我们自己的深色页面会被反转成浅色**，
 *   于是「点黑暗 → 闪一下黑 → 又变白」，而按钮（我们自己的 CSS 画的）状态
 *   和页面实际颜色对不上，看上去就是「切换完全没作用」。
 *   `color-scheme` 是浏览器官方给的退出机制，声明了就不会被自动反转。
 *   见 https://developer.chrome.com/blog/auto-dark-theme
 *
 * 顺带解决第二个问题：不声明时浏览器默认按浅色画**画布**和原生控件 ——
 * 深色页面导航途中会闪白，滚动条、下拉列表、日期选择器也是亮的。
 * auto 用 `light dark`，意思是「两种都支持，按系统偏好挑」。
 */
export const COLOR_SCHEME_CSS = `:root { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="auto"] { color-scheme: light dark; }`;

/**
 * 主题切换按钮的显隐规则 —— 内容页、主界面、后台三处共用。
 *
 * ★ 两个链接（切到明亮 / 切到黑暗）都在 DOM 里，靠这里决定显示哪一个。
 *   服务端不知道「跟随系统」时访客的系统偏好，CSS 的媒体查询知道 ——
 *   把判断放在样式表里，就不用为了一个按钮引入脚本，也没有首屏闪烁。
 *
 * 三处共用一份，是因为这段规则一旦分叉，就会出现「后台切得动、前台切不动」
 * 这类只看一处的代码根本查不出来的问题。
 */
export const THEME_SWITCH_CSS = `/* 默认都藏起来，再按当前主题放行其中一个。
   隐藏用的是 display:none，被藏的那个不会进入键盘 Tab 顺序。

   ★ 选择器必须是 :root .theme-switch 而不是 .theme-switch。
   各处给按钮补版式时会顺手写 .switch a { display:inline-flex } 这类规则
   （权重 0,1,1），而单独的 .theme-switch 只有 0,1,0 —— 会被它盖掉，
   结果是两个按钮同时显示。加一层 :root 把权重抬到 0,2,0，
   既压得住那些版式规则，又仍然低于下面按主题放行的 0,3,0。 */
:root .theme-switch { display: none; }
[data-theme="light"] .theme-switch.to-dark,
[data-theme="dark"] .theme-switch.to-light,
[data-theme="auto"] .theme-switch.to-dark { display: inline-flex; }
@media (prefers-color-scheme: dark) {
  [data-theme="auto"] .theme-switch.to-dark { display: none; }
  [data-theme="auto"] .theme-switch.to-light { display: inline-flex; }
}`;

export type StyleOptions = {
  accentColor: string;
  folderColor: string;
  density: Density;
  /** 来自配置的附加 CSS，原样追加（后台已提示风险） */
  customCss?: string;
};

export function listingCss(options: StyleOptions): string {
  const compact = options.density === 'compact';

  const cellPadY = compact ? '6px' : '10px';
  const rowLine = compact ? '1.4' : '1.6';

  // 变量、重置、面包屑、表格、图标、空状态这些与后台共用的部分在 baseCss 里，
  // 这里只留内容页专有的版式。共用那一层由 test/css.test.ts 的基线钉住不变。
  const base = baseCss({
    accentColor: options.accentColor,
    folderColor: options.folderColor,
    cellPadY,
    rowLine,
  });

  return `${base}
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
    "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
  font-size: 15px;
  line-height: var(--row-line);
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
a { color: inherit; text-decoration: none; }

h1 { font-size: 24px; font-weight: 600; letter-spacing: -.2px; word-break: break-all; }
.summary { font-size: 13px; color: var(--muted); margin-top: 6px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.head-main { min-width: 0; }
.head-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.lang-switch, .theme-switch {
  font-size: 12px; color: var(--muted);
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px;
  white-space: nowrap;
}
.theme-switch { align-items: center; gap: 5px; }
.theme-switch svg { display: block; }
.lang-switch:hover, .theme-switch:hover {
  color: var(--accent); border-color: var(--accent); text-decoration: none;
}

.toolbar { margin: 22px 0 12px; }
.toolbar input {
  width: 100%; max-width: 320px; padding: 9px 13px; font-size: 14px;
  color: var(--fg); background: var(--card); border: 1px solid var(--line);
  border-radius: 8px; outline: none; font-family: inherit;
}
.toolbar input:focus { border-color: var(--accent); }

/* 「名称 / 大小 / 时间」那几列的规则在 baseCss 里 —— 后台文件管理页用的是同一套 */

tr.hide { display: none; }

@media (max-width: 640px) {
  .wrap { padding: 20px 12px 48px; }
  h1 { font-size: 20px; }
  th.c-size, td.c-size { display: none; }
  th.c-time, td.c-time { width: 118px; font-size: 12px; }
  tbody td { padding: 9px 12px; }
  tbody td.c-time { font-size: 12px; }
}
${options.customCss ?? ''}`.trim();
}

/**
 * 错误页、密码页与主界面共用的极简居中样式。
 *
 * 同样按 data-theme 走（见 listingCss 里的说明）：深色变量写两遍，
 * 一份对应访客明确选了黑暗，一份对应「跟随系统」。
 */
export function centeredCss(options: Pick<StyleOptions, 'accentColor'>): string {
  const accent = safeHexColor(options.accentColor, '#2563eb');
  return `
:root {
  --accent: ${accent};
  --bg: #f6f7f9;
  --fg: #1f2328;
  --muted: #6b7280;
  --field: #ffffff;
  --line: #d8dce1;
  --danger: #dc2626;
}
${COLOR_SCHEME_CSS}
:root[data-theme="dark"] {
${CENTERED_DARK_VARS}
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
${CENTERED_DARK_VARS}
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
    "PingFang SC", sans-serif;
  font-size: 15px;
}
main { text-align: center; padding: 24px; max-width: 420px; }
h1 { margin: 0; font-size: 38px; font-weight: 600; letter-spacing: -1px; }
p { margin: 10px 0 0; color: var(--muted); font-size: 14px; }
form { margin-top: 22px; display: flex; flex-direction: column; gap: 10px; }
input[type="password"] {
  padding: 10px 13px; font-size: 15px; font-family: inherit;
  border: 1px solid var(--line); border-radius: 8px; outline: none;
  background: var(--field); color: inherit;
}
input[type="password"]:focus { border-color: var(--accent); }
button {
  padding: 10px 16px; font-size: 15px; font-family: inherit; cursor: pointer;
  border: none; border-radius: 8px; background: var(--accent); color: #fff;
}
button:disabled { opacity: .55; cursor: not-allowed; }
.error { color: var(--danger); font-size: 13px; margin-top: 4px; }
`.trim();
}

const CENTERED_DARK_VARS = `  --bg: #0f1115;
  --fg: #e7e9ec;
  --muted: #98a1ad;
  --field: #171a1f;
  --line: #272c34;
  --danger: #f87171;`;
