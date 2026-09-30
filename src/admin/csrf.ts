/**
 * CSRF 防护。
 *
 * 两层：
 *   1. 会话 cookie 用 SameSite=Lax —— 浏览器不会在跨站 POST 上携带它，
 *      已能覆盖绝大多数场景。
 *   2. 双提交令牌：令牌由会话令牌派生，攻击者拿不到会话就伪造不出，
 *      且不依赖任何服务端存储。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function csrfToken(secret: string, sessionToken: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('base64url');
}

export function verifyCsrf(secret: string, sessionToken: string, given: unknown): boolean {
  if (typeof given !== 'string' || given === '' || sessionToken === '') return false;

  const expected = Buffer.from(csrfToken(secret, sessionToken), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  // 先比长度，否则 timingSafeEqual 抛 RangeError
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
