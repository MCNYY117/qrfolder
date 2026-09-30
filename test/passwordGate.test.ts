/**
 * 内容面密码闸门的集成测试。
 *
 * 覆盖站点级密码、目录级密码、以及两者与后台会话的关系。
 * 存在的理由：这些配置项和界面早就做好了，但校验曾经**完全没接进请求路径**，
 * 后台点了「需要密码」前台却照样直接放行。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../src/admin/auth.ts';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE_PASSWORD = 'site-level-password';
const DIR_PASSWORD = 'directory-level-password';

/** 设置页 / 密码页独有的标记 */
const GATE_MARKER = 'type="password"';

let workDir = '';
let child: ChildProcess | null = null;
let baseUrl = '';

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/robots.txt`)).status === 200) return;
    } catch {
      // 继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start on port ${port}`);
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'accept-language': 'zh-CN', ...(init.headers ?? {}) },
  });
}

function postForm(url: string, fields: Record<string, string>, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return request(url, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

function cookieOf(response: Response, name: string): string | null {
  for (const entry of response.headers.getSetCookie()) {
    const pair = entry.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

/** 取出列表页里条目的顺序 */
function itemOrder(html: string): string[] {
  return [...html.matchAll(/<span class="label">([^<]*)<\/span>/g)].map((m) => m[1] ?? '');
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'qrfolder-gate-'));
  const content = path.join(workDir, 'content');
  const openDir = path.join(content, 'Open');
  const secretDir = path.join(content, 'Secret');
  await mkdir(openDir, { recursive: true });
  await mkdir(secretDir, { recursive: true });

  // 大小刻意拉开，便于验证按大小排序确实改变了顺序
  await writeFile(path.join(openDir, 'a-small.txt'), 'tiny\n', 'utf8');
  await writeFile(path.join(openDir, 'b-large.txt'), 'x'.repeat(4096), 'utf8');
  await writeFile(path.join(secretDir, 'confidential.txt'), 'secret\n', 'utf8');

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  await writeFile(
    path.join(workDir, 'config.json'),
    JSON.stringify({
      version: 1,
      system: { host: '127.0.0.1', port, accessLog: { enabled: false } },
      appearance: { rootBehavior: 'welcome', welcomeMessage: '' },
      access: {
        siteMode: 'password',
        sitePassword: await hashPassword(SITE_PASSWORD),
      },
      directories: [
        { name: 'Open', path: openDir },
        {
          name: 'Secret',
          path: secretDir,
          access: 'password',
          password: await hashPassword(DIR_PASSWORD),
        },
      ],
    }),
    'utf8',
  );

  child = spawn(
    process.execPath,
    [path.join(APP_DIR, 'src', 'main.ts'), '--config', path.join(workDir, 'config.json'), '--port', String(port)],
    { cwd: APP_DIR, stdio: 'ignore' },
  );

  await waitForPort(port);
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

describe('站点密码', () => {
  test('未通过时，所有内容路径都显示闸门', async () => {
    for (const pathname of ['/', '/Open/', '/Secret/', '/Open/a-small.txt']) {
      const response = await request(`${baseUrl}${pathname}`);
      assert.equal(response.status, 401, `${pathname} 应当要求密码`);
      assert.match(await response.text(), new RegExp(GATE_MARKER));
    }
  });

  test('★ 不存在的路径也显示闸门而非 404（否则可枚举出有效目录名）', async () => {
    const nonexistent = await request(`${baseUrl}/NoSuchDirectory/`);
    assert.equal(nonexistent.status, 401);

    const listing = await request(`${baseUrl}/Open/`);
    assert.equal(listing.status, 401, '真实存在的目录也应是同一个响应');
  });

  test('后台不受站点密码影响', async () => {
    const response = await request(`${baseUrl}/admin`);
    const html = await response.text();
    // 测试配置未设管理员密码，所以这里是首次设置页；关键是**不能**被站点密码拦下
    assert.notEqual(response.status, 401, '后台不应被站点密码拦截');
    assert.match(html, /action="\/admin\/setup"/, '后台应走自己的认证流程');
  });

  test('错误密码被拒绝', async () => {
    const response = await postForm(`${baseUrl}/`, { password: 'wrong-password' });
    assert.equal(response.status, 401);
    assert.equal(cookieOf(response, 'qrfolder_session'), null);
  });

  test('正确密码通过并种下会话', async () => {
    const response = await postForm(`${baseUrl}/`, { password: SITE_PASSWORD });
    assert.equal(response.status, 302);
    assert.ok(cookieOf(response, 'qrfolder_session') !== null);
  });
});

describe('通过站点闸门之后', () => {
  let cookie = '';

  test('先通过站点密码', async () => {
    const response = await postForm(`${baseUrl}/`, { password: SITE_PASSWORD });
    const session = cookieOf(response, 'qrfolder_session');
    assert.ok(session !== null);
    cookie = `qrfolder_session=${session}`;
  });

  test('★ 根路径显示欢迎页，且不列出任何目录名', async () => {
    const response = await request(`${baseUrl}/`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /class="label"/, '欢迎页不应有目录列表');
    // 关键：不能泄露有哪些目录
    assert.doesNotMatch(html, /Open|Secret/);
  });

  test('★ 排序参数生效（此前渲染了链接但服务端从不读取）', async () => {
    const defaultOrder = itemOrder(await (await request(`${baseUrl}/Open/`, { headers: { cookie } })).text());
    assert.deepEqual(defaultOrder, ['a-small.txt', 'b-large.txt']);

    const bySizeDesc = itemOrder(
      await (await request(`${baseUrl}/Open/?sort=size&order=desc`, { headers: { cookie } })).text(),
    );
    assert.deepEqual(bySizeDesc, ['b-large.txt', 'a-small.txt'], '按大小降序应把大文件排在前面');

    const byNameDesc = itemOrder(
      await (await request(`${baseUrl}/Open/?sort=name&order=desc`, { headers: { cookie } })).text(),
    );
    assert.deepEqual(byNameDesc, ['b-large.txt', 'a-small.txt'], '按名称降序');

    const byNameAsc = itemOrder(
      await (await request(`${baseUrl}/Open/?sort=name&order=asc`, { headers: { cookie } })).text(),
    );
    assert.deepEqual(byNameAsc, ['a-small.txt', 'b-large.txt']);
  });

  test('语言切换链接存在，且切换后排序链接保留语言', async () => {
    const html = await (await request(`${baseUrl}/Open/`, { headers: { cookie } })).text();
    assert.match(html, /class="lang-switch"/);

    // 切到英文后，排序链接必须带上 lang，否则一点排序语言就丢了
    const english = await (
      await request(`${baseUrl}/Open/?lang=en-US`, { headers: { cookie } })
    ).text();
    const sortHref = /href="\?sort=size[^"]*"/.exec(english)?.[0] ?? '';
    assert.match(sortHref, /lang=en-US/, '排序链接应保留语言参数');
  });

  test('目录级密码仍然独立生效', async () => {
    const gated = await request(`${baseUrl}/Secret/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(gated.status, 401, '仅通过站点密码不足以进入有独立密码的目录');
  });
});

describe('目录级密码（站点密码是硬性外层闸门，需先通过）', () => {
  /** 取一个通过站点闸门的会话 */
  async function siteSession(): Promise<string> {
    const response = await postForm(`${baseUrl}/`, { password: SITE_PASSWORD });
    const session = cookieOf(response, 'qrfolder_session');
    assert.ok(session !== null, '站点密码应能通过');
    return `qrfolder_session=${session}`;
  }

  test('★ 只有站点会话不足以进入有独立密码的目录', async () => {
    const response = await request(`${baseUrl}/Secret/`, {
      headers: { cookie: await siteSession() },
      redirect: 'manual',
    });
    assert.equal(response.status, 401);
  });

  test('提交目录密码后可以进入', async () => {
    const cookie = await siteSession();
    const response = await postForm(`${baseUrl}/Secret/`, { password: DIR_PASSWORD }, cookie);
    assert.equal(response.status, 302);

    // 目录会话用独立 cookie 名，不会覆盖站点会话
    const names = response.headers.getSetCookie().map((c) => (c.split('=')[0] ?? ''));
    const dirCookieName = names.find((n) => n.startsWith('qrfolder_session_dir_'));
    assert.ok(dirCookieName !== undefined, '目录会话应当有自己的 cookie');

    const dirCookie = `${dirCookieName}=${cookieOf(response, dirCookieName) ?? ''}`;
    const html = await (
      await request(`${baseUrl}/Secret/`, { headers: { cookie: `${cookie}; ${dirCookie}` } })
    ).text();
    assert.match(html, /confidential\.txt/);
  });

  test('错误密码被拒绝', async () => {
    const response = await postForm(`${baseUrl}/Secret/`, { password: 'nope' }, await siteSession());
    assert.equal(response.status, 401);
  });
});
