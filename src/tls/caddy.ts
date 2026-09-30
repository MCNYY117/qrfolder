/**
 * 驱动 Caddy：把生成的 Caddyfile 变成正在运行的配置。
 *
 * ★ 为什么是「先 /adapt、再 /load、最后回读复核」三步，而不是一次 POST /load 了事：
 *
 *   Caddy v2.11.4 的 `/load` 存在一个**会谎报成功**的缺陷。当适配阶段产生了警告
 *   （最常见的就是「Caddyfile 没格式化」），它会在调用 `caddy.Load()` **之前**
 *   就把警告写进响应体 —— 此时 HTTP 200 已经发出去了；等 Load 失败再想把状态码
 *   改成 400 已经来不及，错误信息也丢了。
 *
 *   这不是从文档推的，是在本机对着 v2.11.4 实测出来的：一份**既带格式警告、
 *   又绑定不了端口**的配置，`/load` 返回 `200 OK`、响应体里只有那条格式警告，
 *   而配置**根本没有生效**。只看状态码就会向用户报「保存成功」，属于最难排查的
 *   那类静默失败。
 *
 *   所以这里不信任任何单一信号：
 *     1. `POST /adapt` —— 语法错误在这里拿到干净的 400，带文件名与行号
 *     2. `POST /load` 投**适配后的 JSON** —— 没有适配阶段就没有警告，也就绕开了那个缺陷
 *     3. `GET /config/` 回读正在运行的配置，确认域名真的在里面
 *
 *   第 3 步是唯一可信的「成功」判据。多花一次往返，换掉一整类静默失败，值。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 找到 Caddy 可执行文件：先用配置里的路径，没有就在 PATH 里找。
 *
 * 找不到要能**在页面上说出来**。否则现象是「保存成功、Caddy 却怎么都不启动」，
 * 而真正的原因只是一个空配置项 —— 这类问题查起来最费劲。
 */
export function resolveCaddyBinary(configured: string): string | null {
  if (configured !== '') return existsSync(configured) ? configured : null;

  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((dir) => dir !== '');
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `caddy${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export type ApplyResult =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string };

/** 适配结果：Caddy 把 Caddyfile 编译成它内部的 JSON 配置 */
type AdaptResult =
  | { ok: true; config: unknown; warnings: string[] }
  | { ok: false; error: string };

/**
 * 发请求给 Caddy 管理接口。
 *
 * ★ 必须显式带上 Origin，否则会被 Caddy 以
 *   `client is not allowed to access from origin ''` 拒绝（403）。
 *
 *   原因是 Caddy 管理接口有来源保护，而 Node 的 fetch 在发出非简单请求时会
 *   自动附加一个**空的** Origin 头 —— 空值不在允许列表里。curl 不发这个头，
 *   所以命令行测得好好的，一搬到代码里就失败，属于很难第一眼看出来的坑。
 *
 *   取请求地址自身的 origin 最稳妥：它必然等于管理接口监听的那个地址，
 *   也就是 Caddy 默认允许的来源。
 */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init.headers);
  try {
    headers.set('Origin', new URL(url).origin);
  } catch {
    // 地址解析不了就交给 Caddy 去拒绝，这里不额外抛错
  }
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
}

/** 从 Caddy 的错误响应里取出可读信息；取不到就退回原始文本 */
async function errorTextFrom(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text.trim() === '') return `Caddy 返回 HTTP ${response.status}，没有附错误信息`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const message = (parsed as { error: unknown }).error;
      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    // 不是 JSON，原样返回
  }
  return text.trim();
}

/** 管理接口是否可达。用于在页面上区分「Caddy 没跑」和「配置有问题」 */
export async function probeAdminApi(adminApi: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await request(`${adminApi}/config/`, { method: 'GET' }, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

/** 读回正在运行的配置；失败返回 null */
export async function readRunningConfig(adminApi: string): Promise<unknown | null> {
  try {
    const response = await request(`${adminApi}/config/`, { method: 'GET' });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function adapt(adminApi: string, caddyfile: string): Promise<AdaptResult> {
  let response: Response;
  try {
    response = await request(`${adminApi}/adapt`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/caddyfile' },
      body: caddyfile,
    });
  } catch (error) {
    return { ok: false, error: `连不上 Caddy 管理接口：${String(error)}` };
  }

  if (!response.ok) return { ok: false, error: await errorTextFrom(response) };

  const payload = (await response.json()) as { result?: unknown; warnings?: unknown };
  if (payload.result === undefined) {
    return { ok: false, error: 'Caddy 适配成功但没有返回配置内容' };
  }

  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.map((w) => describeWarning(w))
    : [];
  return { ok: true, config: payload.result, warnings };
}

/** Caddy 的警告是 [{file,line,message}]，拼成一行给人看 */
function describeWarning(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const w = raw as { file?: unknown; line?: unknown; message?: unknown };
    const where = typeof w.line === 'number' ? `${String(w.file ?? 'Caddyfile')}:${w.line}: ` : '';
    if (typeof w.message === 'string') return `${where}${w.message}`;
  }
  return String(raw);
}

async function load(adminApi: string, config: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await request(`${adminApi}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ★ 不能带 BOM。实测 Caddy 会直接以
      //   `invalid character 'ï' looking for beginning of value` 拒绝。
      body: JSON.stringify(config),
    });
  } catch (error) {
    return { ok: false, error: `连不上 Caddy 管理接口：${String(error)}` };
  }

  if (!response.ok) return { ok: false, error: await errorTextFrom(response) };
  return { ok: true };
}

/** 正在运行的配置里是否已经包含这些域名 */
function configMentionsDomains(running: unknown, domains: readonly string[]): boolean {
  if (running === null || domains.length === 0) return false;
  let text: string;
  try {
    text = JSON.stringify(running);
  } catch {
    return false;
  }
  return domains.every((domain) => text.includes(`"${domain}"`));
}

export type ApplyOptions = {
  adminApi: string;
  caddyfile: string;
  /** 用于回读复核：这些域名必须出现在生效后的配置里 */
  domains: readonly string[];
};

/**
 * 把 Caddyfile 应用到正在运行的 Caddy。
 *
 * 返回 ok 的前提是**回读确认过**，而不是 Caddy 说了句「好」。
 */
export async function applyCaddyfile(options: ApplyOptions): Promise<ApplyResult> {
  const adapted = await adapt(options.adminApi, options.caddyfile);
  if (!adapted.ok) return { ok: false, error: adapted.error };

  const loaded = await load(options.adminApi, adapted.config);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  // 复核：Caddy 说加载完了，但配置真的换过来了吗？
  const running = await readRunningConfig(options.adminApi);
  if (running === null) {
    return { ok: false, error: '配置已提交，但回读运行中的配置失败，无法确认是否生效' };
  }
  if (options.domains.length > 0 && !configMentionsDomains(running, options.domains)) {
    return {
      ok: false,
      error:
        '配置提交后回读，运行中的配置里没有找到你填的域名 —— 这次加载很可能没有真正生效。' +
        '请检查 Caddy 的日志（logs\\caddy.err.log）后重试。',
    };
  }

  return { ok: true, warnings: adapted.warnings };
}
