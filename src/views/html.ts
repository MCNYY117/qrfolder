/**
 * HTML 转义与页面级工具。
 *
 * 文件名是不可信输入（用户放进内容目录的任何东西），
 * 所有插值到 HTML 的位置都必须先转义。
 */

import { randomBytes } from 'node:crypto';

import type { Lang, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * 生成 CSP nonce。
 *
 * ★ 必须每次响应重新生成。若在进程启动时生成一次并复用，
 *   等于没有 CSP —— 攻击者只要读一次页面就知道了。
 */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/** 内联 SVG favicon，避免浏览器请求 /favicon.ico 产生 404 噪音 */
export function faviconDataUri(accentHex: string): string {
  const color = accentHex.replace('#', '%23');
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<rect width='32' height='32' rx='7' fill='${color}'/>` +
    `<path d='M7 11h7l2 3h9v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z' fill='white' opacity='.92'/>` +
    `</svg>`;
  return `data:image/svg+xml,${svg}`;
}

/**
 * 生成语言切换链接。
 *
 * 保留当前路径与查询参数（排序、筛选等），只替换 lang —— 否则用户切一次语言，
 * 排序就回到默认了。
 */
export function langSwitchHref(url: URL, current: string): string {
  const other = current === 'zh-CN' ? 'en-US' : 'zh-CN';
  const params = new URLSearchParams(url.search);
  params.set('lang', other);
  return `${url.pathname}?${params.toString()}`;
}

// ---------------------------------------------------------------- 主题

/** 访客主题偏好的 cookie 名 */
export const THEME_COOKIE = 'theme';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/**
 * 决定这次请求用哪种主题。
 *
 * 优先级：URL 上的 ?theme= → cookie（访客点过切换按钮）→ 站点配置 → 跟随系统。
 * cookie 必须排在配置前面，否则访客的选择会被站点设置盖掉 —— 那个按钮就成了摆设。
 */
export function resolveTheme(
  requested: string | null | undefined,
  fromCookie: string | undefined,
  configured: ThemeMode,
): ThemeMode {
  if (isThemeMode(requested)) return requested;
  if (isThemeMode(fromCookie)) return fromCookie;
  return configured;
}

/** 主题切换链接：保留当前路径与查询参数，只替换 theme */
export function themeSwitchHref(url: URL, target: 'light' | 'dark'): string {
  const params = new URLSearchParams(url.search);
  params.set('theme', target);
  return `${url.pathname}?${params.toString()}`;
}

const SUN_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>';
const MOON_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

export type ThemeSwitchOptions = {
  lang: Lang;
  /** 切到明亮模式的链接（点击后种下 cookie） */
  toLightHref: string;
  /** 切到黑暗模式的链接 */
  toDarkHref: string;
  /** 额外的 class，用于在不同版式里微调位置 */
  extraClass?: string;
};

/**
 * 明亮 / 黑暗切换按钮。
 *
 * ★ 这里渲染**两个**链接，由 CSS 按当前主题决定显示哪一个，而不是只渲染一个。
 *   原因是「跟随系统」（auto）下服务端根本不知道访客的系统偏好，无法决定
 *   该显示「切到明亮」还是「切到黑暗」；而 CSS 的 prefers-color-scheme
 *   恰好知道。于是判断交给样式表，服务端只负责把两个选项都放上去。
 *   被隐藏的那个是 display:none，不会进入键盘 Tab 顺序。
 *
 * 另一个好处：不需要任何 JavaScript，也不存在首屏闪烁。
 */
export function themeSwitchHtml(options: ThemeSwitchOptions): string {
  const { lang } = options;
  const cls = options.extraClass === undefined ? 'theme-switch' : `theme-switch ${options.extraClass}`;
  const titleToLight = escapeHtml(t(lang, 'theme.switchToLight'));
  const titleToDark = escapeHtml(t(lang, 'theme.switchToDark'));

  return (
    `<a class="${cls} to-dark" href="${escapeHtml(options.toDarkHref)}" title="${titleToDark}">` +
    `${MOON_ICON}<span>${escapeHtml(t(lang, 'theme.dark'))}</span></a>` +
    `<a class="${cls} to-light" href="${escapeHtml(options.toLightHref)}" title="${titleToLight}">` +
    `${SUN_ICON}<span>${escapeHtml(t(lang, 'theme.light'))}</span></a>`
  );
}

/** 拼 <head> 里重复出现的部分 */
export function headMeta(options: {
  title: string;
  css: string;
  nonce: string;
  accentColor: string;
  lang: string;
  /** 后台页面禁止被 iframe 嵌入，内容页允许自站预览 */
  frameAncestors?: "'none'" | "'self'";
}): string {
  const fa = options.frameAncestors ?? "'none'";
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<link rel="icon" href="${faviconDataUri(options.accentColor)}">`,
    `<style nonce="${options.nonce}">${options.css}</style>`,
    // CSP 由响应头下发（见 http/headers.ts），这里只补页面级的 frame-ancestors 说明
    `<!-- frame-ancestors ${fa} -->`,
  ].join('\n');
}
