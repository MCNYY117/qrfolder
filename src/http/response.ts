/**
 * 响应侧的统一下发口与安全响应头。
 *
 * ★ 所有响应（含错误响应）都必须经过 applySecurityHeaders。
 *   既有 Caddy 实现里 200/206 就漏了 X-Content-Type-Options: nosniff，
 *   而 404 还漏了 Server 头清理 —— 新实现把这件事收敛到唯一入口。
 */

import type { ServerResponse } from 'node:http';

export type FrameAncestors = "'none'" | "'self'";

export type SecurityHeaderOptions = {
  nonce: string;
  frameAncestors: FrameAncestors;
  /** HTTPS 下才下发 HSTS */
  isHttps?: boolean;
  /** 允许被跨源引用（如客户在自己站内嵌 PDF），默认同源 */
  crossOriginResourcePolicy?: 'same-origin' | 'cross-origin';
  /**
   * 额外放行的图片来源。
   *
   * 主界面可以配外链图片，而本站 CSP 的 img-src 只有 'self' data: ——
   * 不把它加进来，用户配的图片会被自己的策略拦掉，且控制台只报一句
   * 「Refused to load the image」，很难联想到是 CSP。
   */
  extraImgSrc?: readonly string[];
};

export function buildCsp(
  nonce: string,
  frameAncestors: FrameAncestors,
  extraImgSrc: readonly string[] = [],
): string {
  const imgSrc = ["'self'", 'data:', ...extraImgSrc].join(' ');
  return [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    // ★ frame-src 必须显式声明。
    //   CSP 的 frame-src 会回退到 child-src、再回退到 default-src，
    //   而这里是 'none' —— 不写这一行，后台的「实时预览」iframe
    //   会被浏览器直接拒绝，报 "Refused to frame ... default-src 'none'"。
    "frame-src 'self'",
    // ★ connect-src 同理，而且更隐蔽：它管的是 fetch / XHR / WebSocket。
    //   漏了这一行，后台那两个走 fetch 的功能（目录浏览器的逐层展开、
    //   文件上传）在浏览器里**全都不通**，控制台只报一句
    //   "Refused to connect ... default-src 'none'"。
    //   麻烦的是端到端测试发现不了：测试用的是 Node 的 fetch，
    //   不经过浏览器，CSP 根本不参与。
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
  ].join('; ');
}

/**
 * 应用安全响应头。
 *
 * 显式不设置 Server / X-Powered-By —— Node 的 http 模块默认就不发这两个头，
 * 只要没人手动加上，指纹就是干净的（这一点比 Caddy 省心：Caddy 总要
 * 额外配 header_down 才能删掉自己的 Server）。
 */
export function applySecurityHeaders(res: ServerResponse, options: SecurityHeaderOptions): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', options.frameAncestors === "'none'" ? 'DENY' : 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    buildCsp(options.nonce, options.frameAncestors, options.extraImgSrc ?? []),
  );
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cross-Origin-Resource-Policy', options.crossOriginResourcePolicy ?? 'same-origin');

  if (options.isHttps === true) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

export function sendHtml(res: ServerResponse, html: string, status = 200): void {
  const body = Buffer.from(html, 'utf8');
  // ★ 必须显式声明 charset，否则浏览器可能按 latin-1 解析导致中文乱码
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  // HTML 是动态生成的，不缓存（否则后台改配置后前台看不到效果）
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status);
  res.end(body);
}

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status);
  res.end(body);
}

export function sendText(res: ServerResponse, text: string, status = 200): void {
  const body = Buffer.from(text, 'utf8');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.writeHead(status);
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.setHeader('Content-Length', '0');
  res.writeHead(status);
  res.end();
}

/**
 * 重定向。调用方必须先经 safeRedirectPath 校验目标，
 * 否则就是一个开放重定向漏洞。
 */
export function sendRedirect(res: ServerResponse, location: string, status = 302): void {
  res.setHeader('Location', location);
  res.setHeader('Content-Length', '0');
  res.writeHead(status);
  res.end();
}

/** 追加一个 Set-Cookie（必须用数组，用对象 map 会被合并成畸形头） */
export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const list = Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

export type CookieOptions = {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  path?: string;
  sameSite?: 'Lax' | 'Strict' | 'None';
};

export function buildCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure === true) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
