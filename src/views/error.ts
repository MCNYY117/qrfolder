/**
 * 统一错误页。
 *
 * ★ 必须显式设置 Content-Type: text/html。
 *   既有 Caddy 实现里 respond 未指定类型，导致这段 HTML 被当纯文本源码
 *   显示，样式从未生效 —— 这是本次重写要修的缺陷之一。
 *
 * 页面不含任何第三方标识，也不回显请求路径（避免反射用户输入）。
 */

import type { Lang, ThemeMode } from '../config/schema.ts';
import { t, type MsgKey } from '../i18n/index.ts';
import { escapeHtml, headMeta, newNonce } from './html.ts';
import { centeredCss, safeHexColor } from './styles.ts';

type StatusCopy = { title: MsgKey; message: MsgKey };

const STATUS_COPY: Record<number, StatusCopy> = {
  403: { title: 'error.403.title', message: 'error.403.message' },
  404: { title: 'error.404.title', message: 'error.404.message' },
  416: { title: 'error.416.title', message: 'error.416.message' },
  500: { title: 'error.500.title', message: 'error.500.message' },
};

const FALLBACK: StatusCopy = { title: 'error.404.title', message: 'error.404.message' };

export type ErrorPageOptions = {
  status: number;
  lang: Lang;
  accentColor: string;
  /** 复用调用方已生成的 nonce，避免一次响应出现两个 nonce */
  nonce?: string;
  /** 覆盖默认文案 */
  title?: string;
  message?: string;
  /** 访客主题。错误页也要跟着，否则深色站点上突然弹出一张白页 */
  theme?: ThemeMode;
};

export function renderErrorPage(options: ErrorPageOptions): string {
  const copy = STATUS_COPY[options.status] ?? FALLBACK;
  const accent = safeHexColor(options.accentColor, '#2563eb');
  const nonce = options.nonce ?? newNonce();

  const title = options.title ?? t(options.lang, copy.title);
  const message = options.message ?? t(options.lang, copy.message);

  return `<!DOCTYPE html>
<html lang="${options.lang}" data-theme="${options.theme ?? 'auto'}">
<head>
${headMeta({
    title,
    css: centeredCss({ accentColor: accent }),
    nonce,
    accentColor: accent,
    lang: options.lang,
  })}
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}
