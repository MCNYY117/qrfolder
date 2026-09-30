/**
 * 页面中可安全使用的资源地址校验。
 *
 * 配置里的图片地址、链接地址都会进 `<img src>` / `<a href>`。
 * 只放行两类：
 *   - 站内绝对路径（`/` 开头）
 *   - http / https 的绝对地址
 *
 * 其余一律拒绝，尤其是 `javascript:`、`data:`、`vbscript:` 这类伪协议 ——
 * 它们是从配置面通往 XSS 的经典通路。
 *
 * 刻意不接受 `logo.png` 这种相对路径：它会相对于当前页面地址解析，
 * 在不同层级下指向不同资源，属于难以排查的坑。
 */

export function isSafeResourceUrl(value: string): boolean {
  const raw = value.trim();
  if (raw === '') return false;

  // 协议相对地址（//evil.com/x.png）会跟随页面协议，容易被误用，拒绝
  if (raw.startsWith('//')) return false;

  // 站内绝对路径
  if (raw.startsWith('/')) return raw.length > 1;

  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 规范化后返回可用于 src/href 的值；不安全则返回 ''。
 * 渲染层再调一次，作为配置被绕过时的第二道防线。
 */
export function safeResourceUrl(value: string): string {
  return isSafeResourceUrl(value) ? value.trim() : '';
}

/**
 * 取该地址的源（scheme://host），用于把它加进 CSP 的 img-src。
 * 站内路径或非法地址返回 null。
 */
export function originOf(value: string): string | null {
  const raw = safeResourceUrl(value);
  if (raw === '' || raw.startsWith('/')) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
