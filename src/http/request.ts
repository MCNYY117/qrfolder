/**
 * 请求侧的基础设施：Cookie、表单、客户端 IP、协议判定。
 */

import type { IncomingMessage } from 'node:http';

import { ipInAny, normalizeIp, type Cidr } from '../access/cidr.ts';
import { payloadTooLarge, unsupportedMedia } from './errors.ts';

/** 单个表单字段的长度上限，防止有人塞 64KB 的「目录名」 */
const MAX_FIELD_LENGTH = 512;

/** 默认请求体上限（后台表单都是短文本，64KB 绰绰有余） */
const DEFAULT_BODY_LIMIT = 64 * 1024;

/**
 * 解析 Cookie 头。
 *
 * 注意：值里含裸 `%` 时 decodeURIComponent 会抛 URIError，
 * 绝不能因此返回 400 —— 退回原始值即可。
 */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;

  const joined = Array.isArray(header) ? header.join('; ') : header;
  for (const part of joined.split(';')) {
    // 只切第一个 '='，值里可以含 '='
    const i = part.indexOf('=');
    if (i < 0) continue;

    const key = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    if (key === '' || key in out) continue;

    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * 解析 application/x-www-form-urlencoded 请求体。
 *
 * 刻意不支持 multipart/form-data（直接 415）：本项目没有文件上传，
 * 而 multipart 解析器是零依赖下最易出错的部分。后台选择目录改用
 * 「服务端目录浏览器」——功能等价，代码量少一个数量级。
 */
export async function parseFormBody(
  req: IncomingMessage,
  limit: number = DEFAULT_BODY_LIMIT,
): Promise<Record<string, string>> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!/^application\/x-www-form-urlencoded(;|$)/i.test(contentType)) {
    throw unsupportedMedia('expected application/x-www-form-urlencoded');
  }

  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      // 按实际字节数限流，不信任 Content-Length（chunked 请求没有它，且可伪造）
      if (total > limit) {
        // 必须 destroy：只 break 的话连接里剩余数据会阻塞 keep-alive 复用
        req.destroy();
        throw payloadTooLarge('request body too large');
      }
      chunks.push(buf);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    // 客户端中途断开
    throw payloadTooLarge('request aborted');
  }

  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key.length > MAX_FIELD_LENGTH) continue;
    // 同名键后写覆盖前写，与浏览器表单行为一致
    out[key] = value.slice(0, MAX_FIELD_LENGTH);
  }
  return out;
}

/**
 * 求客户端真实 IP。
 *
 * ★ 必须从右往左剥离可信代理。取最左边那个是错的 ——
 *   客户端可以自行伪造 `X-Forwarded-For: 1.2.3.4` 发过来，
 *   伪造值恰好落在最左边，等于给了攻击者一个绕过 IP 白名单
 *   与限流的开关。
 */
export function clientIp(
  req: IncomingMessage,
  trustProxy: boolean,
  trustedProxies: readonly Cidr[],
): string {
  const socketIp = normalizeIp(req.socket.remoteAddress ?? '');
  if (!trustProxy) return socketIp;

  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part) => part !== '');

  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const candidate = chain[i];
    if (candidate === undefined) continue;
    if (!ipInAny(trustedProxies, candidate)) return candidate;
  }

  // 整条链都是可信代理（或链为空）→ 用 socket 地址
  return socketIp;
}

/** 本次请求是否经由 HTTPS（决定要不要加 Secure 与 HSTS） */
export function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;

  if (trustProxy) {
    const header = req.headers['x-forwarded-proto'];
    const value = Array.isArray(header) ? header[0] : header;
    const first = typeof value === 'string' ? value.split(',')[0]?.trim().toLowerCase() : undefined;
    if (first === 'https') return true;
  }
  return false;
}

/**
 * 校验站内跳转目标，防止开放重定向。
 * 只接受单斜杠开头的路径，拒绝 `//evil.com` 与 `/\evil.com`。
 */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value === '') return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // 去掉可能的 CR/LF，防止响应头注入
  return value.replace(/[\r\n]/g, '');
}
