/**
 * 内容页与后台共用的样式基底。
 *
 * 抽这一层的原因很具体：后台的表格、图标、空状态、面包屑以前是**另写一份**的，
 * 于是同一个东西两处长得不一样（后台表格没有固定布局、没有行 hover、没有手机端
 * 列折叠；`.crumbs` 只在内容页定义，后台用了类名却没有样式）。两份定义迟早漂移，
 * 而漂移的方向一定是「后台那半截忘了跟着改」。
 *
 * ★ 移动规则进这里**不能改变内容页的外观**。这不是靠小心，而是靠
 *   `test/css.test.ts` 冻结的基线：那里按「选择器 → 声明」比对，
 *   少一条、改一个值都会当场炸。要动内容页的样式必须**有意识**地更新基线。
 *   顺序变化不炸（重构本来就会重排），但规则集合必须一致。
 */

import { COLOR_SCHEME_CSS, THEME_SWITCH_CSS, safeHexColor } from './styles.ts';

/** 深浅两套共有的变量。取两边的并集 —— 多出来的变量没人引用就没有效果 */
const LIGHT_VARS = (accent: string, folder: string, rowLine: string): string => `  --bg: #f6f7f9;
  --card: #ffffff;
  --fg: #1f2328;
  --muted: #6b7280;
  --line: #e6e8eb;
  --accent: ${accent};
  --hover: #f2f4f7;
  --shadow: 0 1px 2px rgba(16, 24, 40, .06);
  --dir: ${folder};
  --file: #9aa4b2;
  --row-line: ${rowLine};
  --danger: #dc2626;
  --ok: #16a34a;
  --warn: #d97706;
  --radius: 10px;`;

const DARK_VARS = `  --bg: #0f1115;
  --card: #171a1f;
  --fg: #e7e9ec;
  --muted: #98a1ad;
  --line: #272c34;
  --hover: #1d222a;
  --shadow: none;
  --file: #6b7684;
  --danger: #f87171;
  --ok: #4ade80;
  --warn: #fbbf24;`;

export type BaseCssOptions = {
  accentColor: string;
  folderColor: string;
  /** 表格单元格的纵向内边距。内容页跟着「紧凑 / 舒适」走，后台用一个固定值 */
  cellPadY: string;
  /** 正文行高。同上，跟着密度走 */
  rowLine: string;
};

/**
 * 返回共用的那段 CSS。**放在调用者自己那一段之前。**
 *
 * 注意这里没有 `a` —— 三个页面对链接的处理各不相同（内容页继承颜色、
 * 后台用强调色、居中页靠默认样式），放进基底反而要处处覆盖。
 */
export function baseCss(options: BaseCssOptions): string {
  const accent = safeHexColor(options.accentColor, '#2563eb');
  const folder = safeHexColor(options.folderColor, '#f59e0b');

  return `
:root {
${LIGHT_VARS(accent, folder, options.rowLine)}
}
${COLOR_SCHEME_CSS}
/* ★ 深色变量写两遍，对应两种来源：
     [data-theme="dark"] —— 访客（或站点配置）明确选了黑暗；
     [data-theme="auto"] + 系统偏好为暗 —— 跟随系统。
   html 标签上永远带 data-theme，取值 auto/light/dark，
   所以这两条规则互斥、不会打架。 */
:root[data-theme="dark"] {
${DARK_VARS}
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
${DARK_VARS}
  }
}
${THEME_SWITCH_CSS}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }

.crumbs { font-size: 13px; color: var(--muted); margin-bottom: 10px; word-break: break-all; }
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--accent); }
.crumbs .sep { margin: 0 6px; opacity: .55; }

.panel {
  background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden; box-shadow: var(--shadow);
}
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead th {
  font-size: 12px; font-weight: 600; color: var(--muted); text-align: left;
  padding: 11px 16px; border-bottom: 1px solid var(--line);
  background: var(--bg); white-space: nowrap;
}
thead th a { color: var(--muted); }
thead th a:hover { color: var(--accent); }
tbody td { padding: ${options.cellPadY} 16px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--hover); }

.ic { flex: 0 0 22px; width: 22px; height: 22px; position: relative; display: inline-block; }
.ic.dir { background: var(--dir); border-radius: 3px; height: 16px; margin-top: 3px; }
.ic.dir::before {
  content: ""; position: absolute; left: 0; top: -4px; width: 10px; height: 5px;
  background: var(--dir); border-radius: 2px 2px 0 0;
}
.ic.file {
  background: var(--hover); border: 1px solid var(--line); border-radius: 4px;
  height: 20px; width: 26px; flex: 0 0 26px; margin-top: 1px;
}
.ic.file::after {
  content: attr(data-ext); position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 8px; font-weight: 700; letter-spacing: .2px;
  color: var(--file); text-transform: uppercase;
}
.label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 「名称 / 大小 / 修改时间」这套列在内容页和后台文件管理页是同一套。
   放在共用层里不是图省事：后台那边以前是自己另写的，于是同一个东西两处
   长得不一样，而「用了 td.c-name 却没有对应规则」这种错在宽屏上根本看不出来。 */
td.c-name a { display: flex; align-items: center; gap: 11px; min-width: 0; }
td.c-name a:hover .label { color: var(--accent); }
td.c-size { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
td.c-time { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
th.c-size, td.c-size { width: 110px; text-align: right; }
th.c-time, td.c-time { width: 170px; }

.up td { padding: ${options.cellPadY} 16px; }
.up a { display: inline-flex; align-items: center; gap: 9px; color: var(--muted); font-size: 14px; }
.up a:hover { color: var(--accent); }

.empty { padding: 44px 16px; text-align: center; color: var(--muted); font-size: 14px; }
.empty.hide { display: none; }
.notice {
  margin: 12px 0 0; padding: 10px 14px; border-radius: 8px; font-size: 13px;
  background: var(--hover); color: var(--muted); border: 1px solid var(--line);
}

/* 窄屏上折叠次要列。
   内容页是按列名（.c-size / .c-time）单独写规则的，后台每张表的列都不一样，
   逐个列名去写会越写越散 —— 所以共用的这一层给一个通用标记：
   哪一列「没有也不影响看懂」，就给它加 class="col-opt"。 */
@media (max-width: 640px) {
  .col-opt { display: none; }
}`.trim();
}
