/**
 * 后台流程的集成测试。
 *
 * 存在的理由：曾经修「子路径不该吐设置表单」时，把表单的提交地址
 * `/admin/setup` 也一起重定向掉了，导致用户填完密码「点了没反应」。
 * 当时的验证只测了 `GET` 子路径，没测**提交本身**，所以放过了。
 *
 * 这个文件按真实浏览器的行为走完整流程：跟随重定向、携带 cookie。
 *
 * 断言刻意使用**与界面语言无关**的标记（如表单 action），
 * 否则改一次文案或换一种语言就会误报。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'integration-test-password';

/** 设置页独有的标记 */
const SETUP_MARKER = 'action="/admin/setup"';
/** 后台外壳独有的标记（任一后台页面都有） */
const SHELL_MARKER = 'action="/admin/logout"';

let workDir = '';
let contentDir = '';
let configPath = '';
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
      const response = await fetch(`http://127.0.0.1:${port}/robots.txt`);
      if (response.status === 200) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start on port ${port}`);
}

/** 统一带上 Accept-Language，让界面语言确定 */
function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'accept-language': 'en-US', ...(init.headers ?? {}) },
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

/** 首次设置页会建出这个用户名（缺省值就是 admin），后面所有登录都用它 */
const USERNAME = 'admin';

/**
 * 内置的默认产品名（`config/schema.ts` 里那一份）。
 *
 * ★ 断言不要把这个字面量直接塞进正则，而是**拼出转义后的形式再比**。
 *   产品名可能带 `&`，而 `&` 进 HTML 会变成 `&amp;` —— 把字面量硬编码进正则，
 *   `assert.match` 会永远失败、`assert.doesNotMatch` 会永远通过，
 *   后者是一条静默失效的覆盖。从常量拼 + 转义，换产品名就不用手工改测试。
 */
const DEFAULT_PRODUCT = 'QRFolder';

/** 只转义品牌名里可能出现的那几个字符，够用即可（与被测的 escapeHtml 同义） */
function escapeForHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 主界面在中文下的内置标题 */
function zhWelcomeTitle(): string {
  return `欢迎访问${escapeForHtml(DEFAULT_PRODUCT)}文件系统`;
}

async function login(): Promise<string> {
  const response = await postForm(`${baseUrl}/admin/login`, {
    username: USERNAME,
    password: PASSWORD,
  });
  const session = cookieOf(response, 'qrfolder_session');
  assert.ok(session !== null, '登录应当种下会话 cookie');
  return `qrfolder_session=${session}`;
}

/** 磁盘上到底有没有这个东西。新增目录会真的 mkdir，断言得落到磁盘上才算数 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'qrfolder-test-'));
  contentDir = path.join(workDir, 'content');
  configPath = path.join(workDir, 'config.json');
  await mkdir(path.join(contentDir, 'Docs'), { recursive: true });
  await writeFile(path.join(contentDir, 'Docs', 'readme.txt'), 'hello\n', 'utf8');

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      system: {
        host: '127.0.0.1',
        port,
        accessLog: { enabled: false },
        // ★ 没有父目录池就建不了目录 —— 池子是硬边界，后台连「新增」表单都不吐。
        //   这个夹具要测新增流程，所以内容根必须在池子里。
        parentRoots: [contentDir],
        // 上限设成 1MB，便于在测试里验证超限拒绝
        upload: { enabled: true, maxSizeMb: 1, allowOverwrite: false },
      },
      directories: [{ name: 'Docs', path: path.join(contentDir, 'Docs') }],
    }),
    'utf8',
  );

  child = spawn(
    process.execPath,
    [
      path.join(APP_DIR, 'src', 'main.ts'),
      '--config', configPath,
      '--port', String(port),
    ],
    { cwd: APP_DIR, stdio: 'ignore' },
  );

  await waitForPort(port);
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

describe('首次设置', () => {
  test('未设密码时根路径渲染设置表单', async () => {
    const response = await request(`${baseUrl}/admin`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(SETUP_MARKER), '应包含设置表单');
  });

  test('未设密码时其余子路径重定向回根路径（不吐表单）', async () => {
    for (const sub of ['/directories', '/access', '/system', '/appearance', '/logs']) {
      const response = await request(`${baseUrl}/admin${sub}`, { redirect: 'manual' });
      assert.equal(response.status, 302, `${sub} 应当重定向`);
      assert.equal(response.headers.get('location'), '/admin');
    }
  });

  test('★ 提交设置表单必须真正生效（回归：提交地址曾被一并重定向）', async () => {
    // 表单 action 指向 /admin/setup，这条路径必须放行，否则用户「点了没反应」
    const submit = await postForm(`${baseUrl}/admin/setup`, {
      password: PASSWORD,
      confirm: PASSWORD,
    });
    assert.equal(submit.status, 302, '提交后应当重定向');
    assert.equal(submit.headers.get('location'), '/admin/');

    const session = cookieOf(submit, 'qrfolder_session');
    assert.ok(session !== null, '设置成功后应直接登录，无需再登一次');

    // 跟随重定向，确认真的进了后台而不是又回到设置页
    const dashboard = await request(`${baseUrl}/admin/`, {
      headers: { cookie: `qrfolder_session=${session}` },
    });
    const html = await dashboard.text();
    assert.equal(dashboard.status, 200);
    assert.ok(!html.includes(SETUP_MARKER), '不应仍停在设置页');
    assert.ok(html.includes(SHELL_MARKER), '应进入后台外壳');
  });

  test('两次输入不一致被拒绝', async () => {
    // 此刻密码已设置，走的已是登录守卫分支，只需确认不会被当成设置流程
    const response = await postForm(`${baseUrl}/admin/setup`, {
      password: 'another-password',
      confirm: 'different-password',
    });
    assert.notEqual(response.status, 200);
  });
});

describe('登录与会话', () => {
  test('未认证访问后台页面重定向到登录页', async () => {
    const response = await request(`${baseUrl}/admin/directories`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/login');
  });

  test('错误密码被拒绝，且不种下会话', async () => {
    const response = await postForm(`${baseUrl}/admin/login`, { password: 'definitely-wrong' });
    assert.equal(response.status, 401);
    assert.equal(cookieOf(response, 'qrfolder_session'), null);
  });

  test('正确密码可登录并访问全部后台页面', async () => {
    const cookie = await login();
    for (const page of [
      '/admin/',
      '/admin/directories',
      '/admin/access',
      '/admin/system',
      '/admin/appearance',
      '/admin/logs',
    ]) {
      const response = await request(`${baseUrl}${page}`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 200, `${page} 应可访问`);
      assert.ok(html.includes(SHELL_MARKER), `${page} 应渲染后台外壳`);
    }
  });

  test('篡改会话签名后被当作未登录', async () => {
    const cookie = await login();
    const token = cookie.slice('qrfolder_session='.length);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat((parts[2] ?? '').length)}`;

    const response = await request(`${baseUrl}/admin/directories`, {
      redirect: 'manual',
      headers: { cookie: `qrfolder_session=${tampered}` },
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/login');
  });

  test('缺少 CSRF 令牌的 POST 被拒绝', async () => {
    const cookie = await login();
    const response = await postForm(`${baseUrl}/admin/logs/clear`, {}, cookie);
    assert.equal(response.status, 403);
  });

  test('登出后会话失效', async () => {
    const cookie = await login();
    const page = await request(`${baseUrl}/admin/directories`, { headers: { cookie } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
    assert.notEqual(csrf, '', '应能从页面提取到 CSRF 令牌');

    const logout = await postForm(`${baseUrl}/admin/logout`, { _csrf: csrf }, cookie);
    assert.equal(logout.status, 302);

    const cleared = cookieOf(logout, 'qrfolder_session') ?? '';
    assert.equal(cleared, '', '登出应当清空会话 cookie');
  });
});

describe('目录管理界面', () => {
  test('行内操作成组渲染，编辑表单以弹窗呈现', async () => {
    const cookie = await login();
    const list = await (
      await request(`${baseUrl}/admin/directories`, { headers: { cookie } })
    ).text();
    assert.match(list, /class="row-actions"/, '操作按钮应当成组');

    const editId = /href="\/admin\/directories\?edit=([^"]+)"/.exec(list)?.[1];
    assert.ok(editId !== undefined, '每行应当有编辑链接');

    const editPage = await (
      await request(`${baseUrl}/admin/directories?edit=${editId}`, { headers: { cookie } })
    ).text();
    assert.match(editPage, /id="dir-dialog"/, '编辑表单应以 <dialog> 呈现');
    assert.match(editPage, /showModal/, '应有打开弹窗的脚本');
    assert.match(editPage, /class="dialog-actions"/, '弹窗应有独立的操作区');
  });

  /**
   * ★ 两个删除类动作在**编辑弹窗**里，不在列表行里。
   *
   *   放在行里的话操作列要挤五个按钮，而表格是 table-layout: fixed ——
   *   每列只拿到「宽度 ÷ 列数」，多出来的会被 .panel 的 overflow:hidden 裁掉，
   *   表现就是「删除按钮被遮挡了」。这条用例钉住的是布局约束的成因，
   *   不只是外观：行里少两个按钮，任何宽度下都排得下。
   */
  test('★ 删除类动作在编辑弹窗的「危险操作」区，不在行里', async () => {
    const cookie = await login();
    const list = await (
      await request(`${baseUrl}/admin/directories`, { headers: { cookie } })
    ).text();
    const row = /<div class="row-actions">[\s\S]*?<\/div>/.exec(list)?.[0] ?? '';
    assert.ok(row !== '', '应当找得到一行操作区');
    assert.ok(
      !row.includes('data-purge') && !row.includes('/directories/delete'),
      '行里不该再有删除类按钮 —— 那正是被裁掉的那两个',
    );

    const editId = /href="\/admin\/directories\?edit=([^"]+)"/.exec(list)?.[1];
    const editPage = await (
      await request(`${baseUrl}/admin/directories?edit=${editId}`, { headers: { cookie } })
    ).text();
    assert.match(editPage, /class="danger-zone"/, '编辑弹窗里应当有危险操作区');
    assert.match(editPage, /formaction="\/admin\/directories\/delete"/, '取消发布应当换提交地址');
    assert.match(editPage, /data-purge=/, '删除内容应当是个打开确认弹窗的按钮');
  });

  test('新增目录时没有「危险操作」区（还没有东西可删）', async () => {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/directories?new=1`, { headers: { cookie } })
    ).text();
    assert.match(page, /id="dir-dialog"/);
    assert.doesNotMatch(page, /class="danger-zone"/, '新建表单里不该出现危险操作');
  });

  test('新增目录同样走弹窗', async () => {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/directories?new=1`, { headers: { cookie } })
    ).text();
    assert.match(page, /id="dir-dialog"/);
  });
});

describe('目录二维码', () => {
  async function firstDirectoryId(cookie: string): Promise<string> {
    const list = await (
      await request(`${baseUrl}/admin/directories`, { headers: { cookie } })
    ).text();
    const id = /data-qr="([^"]+)"/.exec(list)?.[1];
    assert.ok(id !== undefined, '每行应当有二维码按钮');
    return id;
  }

  function qrUrl(id: string, query = ''): string {
    return `${baseUrl}/admin/directories/qr?dir=${id}${query}`;
  }

  test('目录行有二维码按钮，页面带二维码弹窗', async () => {
    const cookie = await login();
    const list = await (
      await request(`${baseUrl}/admin/directories`, { headers: { cookie } })
    ).text();
    assert.match(list, /data-qr="/, '操作区应有二维码按钮');
    assert.match(list, /id="qr-dialog"/, '应有二维码弹窗');
    assert.match(list, /name="publicBaseUrl"/, '弹窗里应能填域名或 IP 和端口');
    assert.match(list, /download[^>]*>/, '应有下载入口');
  });

  test('★ 未登录取不到二维码（它等于受保护目录的钥匙）', async () => {
    const cookie = await login();
    const id = await firstDirectoryId(cookie);

    // 这条路径挂在后台之下，必须和后台其它页面一样要求会话，
    // 否则任何人都能凭目录 id 生成直达链接
    const anonymous = await request(qrUrl(id), { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), '/admin/login');
  });

  test('SVG 与 PNG 两种格式都可下载', async () => {
    const cookie = await login();
    const id = await firstDirectoryId(cookie);

    const svg = await request(qrUrl(id, '&format=svg'), { headers: { cookie } });
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
    const body = await svg.text();
    assert.match(body, /^<svg /);
    assert.match(body, /<path d="M/, '深色模块应合并成路径');

    const png = await request(qrUrl(id, '&format=png'), { headers: { cookie } });
    assert.equal(png.status, 200);
    assert.match(png.headers.get('content-type') ?? '', /image\/png/);
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  });

  test('默认内联显示，download=1 时才是附件', async () => {
    const cookie = await login();
    const id = await firstDirectoryId(cookie);

    const inline = await request(qrUrl(id, '&format=png'), { headers: { cookie } });
    assert.match(inline.headers.get('content-disposition') ?? '', /^inline;/);

    const download = await request(qrUrl(id, '&format=png&download=1'), { headers: { cookie } });
    const disposition = download.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename\*=UTF-8''/, '非 ASCII 目录名要按 RFC 5987 双写');
  });

  test('★ 二维码内容 = 域名或 IP 和端口 + 目录路径', async () => {
    const cookie = await login();
    const id = await firstDirectoryId(cookie);

    const one = await (
      await request(qrUrl(id, '&base=https://a.example.com'), { headers: { cookie } })
    ).text();
    const other = await (
      await request(qrUrl(id, '&base=https://b.example.com'), { headers: { cookie } })
    ).text();
    assert.notEqual(one, other, '换了域名，二维码图案必须跟着变');

    // 只填 IP 和端口也认，协议按当前请求补全
    const bare = await request(qrUrl(id, '&base=192.168.1.10:8080'), { headers: { cookie } });
    assert.equal(bare.status, 200);

    // 路径前缀也允许（站点挂在子路径下的情况）
    const withPrefix = await request(qrUrl(id, '&base=https://example.com/files/'), { headers: { cookie } });
    assert.equal(withPrefix.status, 200);
  });

  test('★ 非法地址返回 400，而不是生成一个扫不出正确网址的码', async () => {
    const cookie = await login();
    const id = await firstDirectoryId(cookie);

    for (const base of ['ftp://example.com', 'javascript:alert(1)', 'https://user:pw@example.com']) {
      const response = await request(qrUrl(id, `&base=${encodeURIComponent(base)}`), {
        headers: { cookie },
      });
      assert.equal(response.status, 400, `${base} 应当被拒绝`);
    }
  });

  test('不存在的目录 id 返回 404', async () => {
    const cookie = await login();
    const response = await request(qrUrl('nosuchid'), { headers: { cookie } });
    assert.equal(response.status, 404);
  });

  test('二维码响应同样不泄露服务器指纹', async () => {
    const cookie = await login();
    const id = await firstDirectoryId(cookie);
    const response = await request(qrUrl(id, '&format=png'), { headers: { cookie } });
    assert.equal(response.headers.get('server'), null);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('对外访问地址', () => {
  async function savePublicBase(
    value: string,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/system`, { headers: { cookie } })
    ).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    assert.notEqual(csrf, '', '系统设置页应有 CSRF 令牌');
    return postForm(
      `${baseUrl}/admin/system/publicbase`,
      { _csrf: csrf, publicBaseUrl: value, ...extra },
      cookie,
    );
  }

  test('★ 只填域名或 IP 和端口时，按当前请求的协议补全', async () => {
    const saved = await savePublicBase('192.168.1.10:8080');
    assert.equal(saved.status, 302);

    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { publicBaseUrl: string };
    };
    assert.equal(onDisk.system.publicBaseUrl, 'http://192.168.1.10:8080', '补全协议并去掉尾斜杠');
  });

  test('配置的地址会被二维码采用，不必每次手填', async () => {
    await savePublicBase('https://files.example.com');

    const cookie = await login();
    const list = await (
      await request(`${baseUrl}/admin/directories`, { headers: { cookie } })
    ).text();
    assert.match(list, /value="https:\/\/files\.example\.com"/, '弹窗应回填已保存的地址');

    const id = /data-qr="([^"]+)"/.exec(list)?.[1] ?? '';
    const withConfig = await (
      await request(`${baseUrl}/admin/directories/qr?dir=${id}`, { headers: { cookie } })
    ).text();
    const withOverride = await (
      await request(
        `${baseUrl}/admin/directories/qr?dir=${id}&base=${encodeURIComponent('https://files.example.com')}`,
        { headers: { cookie } },
      )
    ).text();
    assert.equal(withConfig, withOverride, '不传 base 时应当等价于用配置里的地址');
  });

  test('非法地址不写入配置，并给出可读的错误', async () => {
    await savePublicBase('https://files.example.com');
    const failed = await savePublicBase('ftp://example.com');
    // 400（输入被拒绝，就地渲染错误页），不是 500，也不是 200 ——
    // 后台各页对「输入不合法」统一用 400，这里原先返回 200 是个例外
    assert.equal(failed.status, 400, '应当就地渲染错误，而不是 500');

    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { publicBaseUrl: string };
    };
    assert.equal(onDisk.system.publicBaseUrl, 'https://files.example.com', '旧值必须保留');
  });

  test('留空表示跟随当前访问地址', async () => {
    const saved = await savePublicBase('');
    assert.equal(saved.status, 302);
    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { publicBaseUrl: string };
    };
    assert.equal(onDisk.system.publicBaseUrl, '');
  });

  test('★ return 参数经安全校验，不能被用来做开放重定向', async () => {
    const evil = await savePublicBase('https://files.example.com', {
      return: 'https://evil.example.com/',
    });
    assert.equal(evil.status, 302);
    assert.equal(evil.headers.get('location'), '/admin/system?ok=sys.publicBaseSaved');

    const ok = await savePublicBase('https://files.example.com', { return: '/admin/directories' });
    assert.equal(ok.headers.get('location'), '/admin/directories?ok=sys.publicBaseSaved');

    // 复原，避免影响后续用例
    await savePublicBase('');
  });
});

describe('明亮 / 黑暗模式', () => {
  /** 保存外观设置（只为这个套件服务，避免依赖别的 describe 里的局部函数） */
  async function saveTheme(theme: string): Promise<Response> {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/appearance`, { headers: { cookie } })
    ).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    return postForm(
      `${baseUrl}/admin/appearance`,
      { _csrf: csrf, theme, accentColor: '#2563eb', folderColor: '#f59e0b', listingLanguage: 'auto' },
      cookie,
    );
  }

  test('★ 内容页与后台都渲染切换按钮，且两个方向都在 DOM 里', async () => {
    const listing = await (await request(`${baseUrl}/Docs/`)).text();
    assert.match(listing, /data-theme="/);
    // 两个链接都在：显示哪个由 CSS 按当前主题决定 —— 「跟随系统」时
    // 服务端根本不知道访客的系统偏好，只有样式表的媒体查询知道
    assert.match(listing, /class="theme-switch to-dark"/);
    assert.match(listing, /class="theme-switch to-light"/);

    const welcome = await (await request(`${baseUrl}/`)).text();
    assert.match(welcome, /class="theme-switch to-dark"/);

    const cookie = await login();
    const admin = await (await request(`${baseUrl}/admin/`, { headers: { cookie } })).text();
    assert.match(admin, /data-theme="/);
    assert.match(admin, /class="theme-switch to-dark"/);
    assert.match(admin, /class="theme-switch to-light"/);
  });

  /**
   * ★ 回归：曾漏掉 color-scheme，导致开了 Edge/Chrome「强制深色模式」的访客
   * 看到的是被浏览器反转过的颜色 —— 我们的深色页被反转成浅色，
   * 表现成「点黑暗 → 闪一下黑 → 又变白，按钮和页面对不上」。
   * 三处页面各断言一次：任何一处漏了，那一处就会被浏览器反转。
   */
  test('★ 三处页面都声明了 color-scheme（否则会被浏览器强制深色反转）', async () => {
    const cookie = await login();
    const pages = {
      列表页: await (await request(`${baseUrl}/Docs/`)).text(),
      主界面: await (await request(`${baseUrl}/`)).text(),
      后台: await (await request(`${baseUrl}/admin/`, { headers: { cookie } })).text(),
    };
    for (const [name, html] of Object.entries(pages)) {
      assert.match(html, /:root \{ color-scheme: light; \}/, `${name}缺少 color-scheme 基础声明`);
      assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/, `${name}深色未声明`);
      assert.match(html, /:root\[data-theme="auto"\] \{ color-scheme: light dark; \}/, `${name}跟随系统未声明`);
    }
  });

  test('切换按钮就在语言切换边上', async () => {
    const listing = await (await request(`${baseUrl}/Docs/`)).text();
    assert.match(listing, /class="head-actions">.*lang-switch.*theme-switch to-dark/s, '两者应在同一个容器里');

    const cookie = await login();
    const admin = await (await request(`${baseUrl}/admin/`, { headers: { cookie } })).text();
    assert.match(admin, /admin\/lang\?set=[^"]+"[\s\S]{0,200}?theme-switch to-dark/, '后台顶栏也应相邻');
  });

  test('★ ?theme=dark 立即生效并种下 cookie', async () => {
    const response = await request(`${baseUrl}/Docs/?theme=dark`);
    assert.match(await response.text(), /data-theme="dark"/);
    assert.equal(cookieOf(response, 'theme'), 'dark', '应当种下 cookie，否则翻一页就退回默认');
  });

  test('★ cookie 让访客的选择保持住', async () => {
    const chosen = await request(`${baseUrl}/Docs/?theme=light`);
    const theme = cookieOf(chosen, 'theme');
    assert.equal(theme, 'light');

    const next = await request(`${baseUrl}/Docs/`, { headers: { cookie: `theme=${theme}` } });
    assert.match(await next.text(), /data-theme="light"/);
  });

  test('后台同样认这个 cookie（前后台是同一个选择）', async () => {
    const cookie = await login();
    const admin = await request(`${baseUrl}/admin/`, {
      headers: { cookie: `${cookie}; theme=dark` },
    });
    assert.match(await admin.text(), /data-theme="dark"/);
  });

  test('★ 站点配置为 dark 时，没做过选择的访客也是 dark', async () => {
    assert.equal((await saveTheme('dark')).status, 302);
    assert.match(await (await request(`${baseUrl}/Docs/`)).text(), /data-theme="dark"/);
    await saveTheme('auto');
  });

  test('★ 访客的 cookie 优先于站点配置（否则那个按钮就是个摆设）', async () => {
    assert.equal((await saveTheme('dark')).status, 302);

    const overridden = await request(`${baseUrl}/Docs/`, { headers: { cookie: 'theme=light' } });
    assert.match(await overridden.text(), /data-theme="light"/);

    await saveTheme('auto');
  });

  test('★ 非法的 ?theme= 被忽略，且不会被写进 cookie', async () => {
    for (const value of ['javascript:alert(1)', 'DARK', '', 'blue']) {
      const response = await request(`${baseUrl}/Docs/?theme=${encodeURIComponent(value)}`);
      assert.match(await response.text(), /data-theme="auto"/, `${value} 应当被忽略`);
      assert.equal(cookieOf(response, 'theme'), null, `${value} 不该被种进 cookie`);
    }
  });

  test('关于页也带主题，深色站点上不会闪白页', async () => {
    const response = await request(`${baseUrl}/NoSuchDir/?theme=dark`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /data-theme="dark"/);
  });
});

describe('域名与证书', () => {
  async function domainForm(cookie: string): Promise<string> {
    const page = await (
      await request(`${baseUrl}/admin/domain`, { headers: { cookie } })
    ).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    assert.notEqual(csrf, '', '应能从页面提取 CSRF 令牌');
    return csrf;
  }

  /**
   * ★ 这个测试套件曾经真的改坏过线上环境，所以这里有两道硬性约束。
   *
   * 事故经过：用例里写死了 `adminApi: http://127.0.0.1:2019`，而开发机上
   * **真实的 Caddy 恰好就跑在 2019**。于是测试把「转发到随机测试端口」的配置
   * 应用到了正在对外服务的 Caddy 上，公网访问直接变成 502。
   *
   * 两道约束：
   *   1. adminApi 永远指向一个**确定没人监听**的端口 —— 不管这台机器上
   *      有没有跑着真的 Caddy，测试都碰不到它；
   *   2. caddyConfigPath 永远落在测试自己的临时目录 —— 否则「应用」会先把
   *      Caddyfile 写进项目真实目录，把随机端口带进线上配置。
   *
   * 这两条对每个用例生效，不依赖写用例的人记得传对参数。
   */
  let deadAdminApi = '';
  let tmpCaddyfile = '';

  async function applyDomain(fields: Record<string, string>): Promise<Response> {
    if (deadAdminApi === '') {
      deadAdminApi = `http://127.0.0.1:${await findFreePort()}`;
      tmpCaddyfile = path.join(workDir, 'caddy', 'Caddyfile');
    }
    const cookie = await login();
    const csrf = await domainForm(cookie);
    return postForm(
      `${baseUrl}/admin/domain/apply`,
      // 放在 ...fields 之后：用例即便传了这两个字段也会被覆盖掉
      { _csrf: csrf, ...fields, adminApi: deadAdminApi, caddyConfigPath: tmpCaddyfile },
      cookie,
    );
  }

  test('未登录时和后台其它页面一样被挡在门外', async () => {
    const response = await request(`${baseUrl}/admin/domain`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/login');
  });

  // 断言一律走结构（class / form action）而不是界面文案 ——
  // 测试客户端的 Accept-Language 是 en-US，而文案随时会改
  test('没有域名时预览位置给出原因，填了域名才出现 Caddyfile 原文', async () => {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/domain`, { headers: { cookie } })
    ).text();

    assert.match(page, /action="\/admin\/domain\/apply"/, '应有保存表单');
    assert.match(page, /class="banner err"/, '生成不出来时应给出可见的原因');
    assert.doesNotMatch(page, /class="code-block"/, '没有域名时不该有预览');
  });

  test('★ 填好域名后，预览里能看到生成的 Caddyfile', async () => {
    const cookie = await login();
    const csrf = await domainForm(cookie);
    // 先保存（不启用，避免真的去连 Caddy）
    const saved = await postForm(
      `${baseUrl}/admin/domain/apply`,
      {
        _csrf: csrf,
        enabled: '',
        domains: 'files.example.com',
        email: 'admin@example.com',
        staging: '1',
        caddyConfigPath: 'caddy/Caddyfile',
      },
      cookie,
    );
    assert.equal(saved.status, 302);

    const page = await (
      await request(`${baseUrl}/admin/domain`, { headers: { cookie } })
    ).text();
    assert.match(page, /files\.example\.com \{/, 'Caddyfile 预览里应出现站点块');
    assert.match(page, /header -Server/, '必须带上删 Server 头的那行');
    assert.match(page, /reverse_proxy 127\.0\.0\.1:\d+/);

    // 复原
    await postForm(
      `${baseUrl}/admin/domain/apply`,
      { _csrf: csrf, domains: '', caddyConfigPath: 'caddy/Caddyfile' },
      cookie,
    );
  });

  test('★ 非法域名被拒绝，且不写进配置', async () => {
    const before = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { tls: { domains: string[] } };
    };

    const response = await applyDomain({ enabled: '1', domains: '*.example.com' });
    // 400 而不是 500：配置校验失败会带着「具体哪一项错了」渲染出来
    assert.equal(response.status, 400, '应当是带明细的 400');
    assert.match(await response.text(), /通配符/, '要指出到底哪里不对');

    const after = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { tls: { domains: string[] } };
    };
    assert.deepEqual(after.system.tls.domains, before.system.tls.domains, '旧值必须保留');
  });

  test('★ 启用 HTTPS 却没填域名 → 报错而不是保存一个用不了的配置', async () => {
    const before = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { tls: { enabled: boolean } };
    };

    const response = await applyDomain({ enabled: '1', domains: '' });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /至少要填一个域名/);

    const after = JSON.parse(await readFile(configPath, 'utf8')) as {
      system: { tls: { enabled: boolean } };
    };
    assert.equal(after.system.tls.enabled, before.system.tls.enabled, '不能写进一个用不了的配置');
  });

  test('★ Caddy 不在时给出可读错误，而不是 500', async () => {
    // adminApi / caddyConfigPath 由 applyDomain 强制指向隔离环境，见那里的注释
    const response = await applyDomain({
      enabled: '1',
      domains: 'files.example.com',
    });

    assert.equal(response.status, 200, '必须是可读的失败页，不能是 500');
    assert.match(await response.text(), /class="banner err"/, '应显示失败原因');

    // 复原成一个不会影响后续用例的状态
    await applyDomain({ domains: '' });
  });

  test('缺少 CSRF 令牌时被拒绝', async () => {
    const cookie = await login();
    const response = await postForm(
      `${baseUrl}/admin/domain/apply`,
      { domains: 'files.example.com' },
      cookie,
    );
    assert.equal(response.status, 403);
  });
});

describe('外观设置保存', () => {
  async function appearanceForm(cookie: string): Promise<string> {
    const page = await (
      await request(`${baseUrl}/admin/appearance`, { headers: { cookie } })
    ).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    assert.notEqual(csrf, '', '应能从页面提取 CSRF 令牌');
    return csrf;
  }

  const baseFields = {
    siteTitle: '',
    footerText: '',
    listingLanguage: 'auto',
    accentColor: '#16a34a',
    folderColor: '#f59e0b',
    theme: 'auto',
    density: 'comfortable',
    showBreadcrumbs: '1',
    showFileSize: '1',
    showModTime: '1',
    showFilterBox: '1',
    showSummary: '1',
    defaultSort: 'namedirfirst',
    defaultOrder: 'asc',
    previewExtensions: '.pdf\n.txt',
    forceDownloadExtensions: '.html',
    customCss: '',
  };

  test('★ timeZone=auto 能保存成功（回归：校验器未放行该保留值导致 500）', async () => {
    const cookie = await login();
    const response = await postForm(
      `${baseUrl}/admin/appearance`,
      { _csrf: await appearanceForm(cookie), ...baseFields, timeZone: 'auto' },
      cookie,
    );
    assert.equal(response.status, 302, '保存应当重定向而不是报错');

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      appearance: { timeZone: string; accentColor: string };
    };
    assert.equal(saved.appearance.timeZone, 'auto');
    assert.equal(saved.appearance.accentColor, '#16a34a');
  });

  test('★ 非法时区应给出可读的 400，而不是 500', async () => {
    const cookie = await login();
    const response = await postForm(
      `${baseUrl}/admin/appearance`,
      { _csrf: await appearanceForm(cookie), ...baseFields, timeZone: 'Not/AZone' },
      cookie,
    );

    assert.equal(response.status, 400, '应当是客户端错误，而不是服务器内部错误');
    const html = await response.text();
    assert.match(html, /timeZone/, '应当指出具体是哪个字段有问题');
  });

  test('缺少 CSRF 令牌时被拒绝', async () => {
    const cookie = await login();
    const response = await postForm(
      `${baseUrl}/admin/appearance`,
      { ...baseFields, timeZone: 'auto' },
      cookie,
    );
    assert.equal(response.status, 403);
  });
});

describe('文件上传', () => {
  let dirId = '';
  let csrf = '';

  before(async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      directories: Array<{ id: string; name: string }>;
    };
    dirId = config.directories.find((d) => d.name === 'Docs')?.id ?? '';
    assert.notEqual(dirId, '', '测试配置里应当有 Docs 目录');
  });

  async function upload(
    name: string,
    body: string,
    options: { withCsrf?: boolean; path?: string; dirId?: string } = {},
  ): Promise<Response> {
    const targetDir = options.dirId ?? dirId;
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/files?dir=${targetDir}`, { headers: { cookie } })
    ).text();
    csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? csrf;

    const headers: Record<string, string> = {
      cookie,
      'x-filename': encodeURIComponent(name),
    };
    if (options.withCsrf !== false) headers['x-csrf'] = csrf;

    const suffix = options.path === undefined ? '' : `&path=${encodeURIComponent(options.path)}`;
    return request(`${baseUrl}/admin/files/upload?dir=${targetDir}${suffix}`, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body,
    });
  }

  test('文件管理页可访问，含上传区', async () => {
    const cookie = await login();
    const response = await request(`${baseUrl}/admin/files?dir=${dirId}`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="drop-zone"/);
    assert.match(html, /id="file-input"/);
  });

  test('不存在的目录被拒绝', async () => {
    const response = await upload('x.txt', 'x', { dirId: 'deadbeef' });
    const detail = await response.text();
    assert.equal(response.status, 404, `响应体: ${detail}`);
  });

  test('★ 能真正把文件写进目录', async () => {
    const response = await upload('uploaded.txt', 'hello from upload\n');
    assert.equal(response.status, 200, await response.text().catch(() => ''));

    const onDisk = await readFile(path.join(contentDir, 'Docs', 'uploaded.txt'), 'utf8');
    assert.equal(onDisk, 'hello from upload\n');
  });

  test('中文文件名与子目录都可用', async () => {
    await mkdir(path.join(contentDir, 'Docs', 'sub'), { recursive: true });
    const response = await upload('中文 名称.txt', 'content\n', { path: 'sub' });
    assert.equal(response.status, 200);

    const onDisk = await readFile(path.join(contentDir, 'Docs', 'sub', '中文 名称.txt'), 'utf8');
    assert.equal(onDisk, 'content\n');
  });

  /**
   * ★ 空子目录必须显示「此目录为空」。
   *
   *   以前的判据是「已经推了几行」，而「返回上一级」那一行在进循环之前就被
   *   推进去了 —— 于是**子目录为空时永远走不到那个分支**，页面上只剩一行
   *   「返回上一级」，分不清是空目录还是列表没加载出来。
   *   根目录为空反而是好的（那时确实一行都没有），所以这个 bug 只在子目录里出现。
   */
  test('★ 空的子目录要显示「此目录为空」，而不是一片空白', async () => {
    await mkdir(path.join(contentDir, 'Docs', 'empty-sub'), { recursive: true });
    const cookie = await login();
    const html = await (
      await request(`${baseUrl}/admin/files?dir=${dirId}&path=empty-sub`, { headers: { cookie } })
    ).text();

    // 只钉结构不钉文案：文案随语言变，而这里要证明的是「那个分支走到了」
    assert.match(html, /<td colspan="3" class="empty">/, '空的子目录应当渲染出空状态那一行');
    assert.match(html, /class="up"/, '「返回上一级」也该在 —— 两者本来就该同时出现');
    await rm(path.join(contentDir, 'Docs', 'empty-sub'), { recursive: true, force: true });
  });

  test('缺少 CSRF 头被拒绝', async () => {
    const response = await upload('no-csrf.txt', 'x', { withCsrf: false });
    assert.equal(response.status, 403);
  });

  test('★ 文件名里的路径穿越被拒绝', async () => {
    // 刻意只用**跨平台都非法**的名字：反斜杠在 POSIX 上是合法文件名字符，
    // 拿它当用例会在非 Windows 的环境下误报。
    for (const name of ['../escape.txt', 'sub/../../escape.txt', 'a/b.txt', '..', '.', '']) {
      const response = await upload(name, 'x');
      assert.ok(
        response.status === 400 || response.status === 403,
        `${JSON.stringify(name)} 应被拒绝，实际 ${response.status}`,
      );
    }
    // 确认真的没有文件被写到上级目录
    const escaped = await readFile(path.join(workDir, 'escape.txt'), 'utf8').catch(() => null);
    assert.equal(escaped, null, '不应在内容目录之外产生文件');
  });

  test('★ 敏感文件规则同样约束上传', async () => {
    const response = await upload('.env', 'SECRET=1');
    assert.equal(response.status, 400);

    const leaked = await readFile(path.join(contentDir, 'Docs', '.env'), 'utf8').catch(() => null);
    assert.equal(leaked, null, '被规则拒绝的文件不应落盘');
  });

  test('同名文件默认拒绝覆盖', async () => {
    const first = await upload('dup.txt', 'first');
    assert.equal(first.status, 200);

    const second = await upload('dup.txt', 'second');
    assert.equal(second.status, 409, '默认不允许覆盖');

    const onDisk = await readFile(path.join(contentDir, 'Docs', 'dup.txt'), 'utf8');
    assert.equal(onDisk, 'first', '原文件不应被改动');
  });

  test('★ 超过体积上限被拒绝，且不留半截文件', async () => {
    const response = await upload('too-big.bin', 'x'.repeat(1_500_000));
    assert.equal(response.status, 413);

    const leftover = await readFile(path.join(contentDir, 'Docs', 'too-big.bin')).catch(() => null);
    assert.equal(leftover, null, '超限文件不应落盘');
  });
});

describe('主界面自定义', () => {
  /** 保存外观设置（只发关心的字段，其余沿用当前值） */
  async function saveAppearance(fields: Record<string, string>): Promise<Response> {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/appearance`, { headers: { cookie } })
    ).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    return postForm(`${baseUrl}/admin/appearance`, { _csrf: csrf, ...fields }, cookie);
  }

  // 「全部回归默认」的一组字段。双语文案必须显式送空串：
  // 保存逻辑对**缺失**的字段是「保留原值」（旧版客户端/局部提交不会误删内容），
  // 所以不写进 base 的话，上一个用例留下的自定义文案会漏到下一个用例里。
  const base = {
    productName: '',
    siteTitle: '',
    footerText: '',
    listingLanguage: 'auto',
    rootBehavior: 'welcome',
    welcomeTitleZh: '',
    welcomeTitleEn: '',
    welcomeMessageZh: '',
    welcomeMessageEn: '',
    welcomeImageAltZh: '',
    welcomeImageAltEn: '',
    welcomeHintZh: '',
    welcomeHintEn: '',
    accentColor: '#2563eb',
    folderColor: '#f59e0b',
    theme: 'auto',
    density: 'comfortable',
    defaultSort: 'namedirfirst',
    defaultOrder: 'asc',
    timeZone: 'auto',
  };

  test('★ 标题、正文、图片都会出现在主界面', async () => {
    const saved = await saveAppearance({
      ...base,
      welcomeTitleEn: 'Welcome to the demo',
      welcomeMessageEn: 'Custom body text.',
      welcomeImage: '/logo.png',
      welcomeImageAltEn: 'Site logo',
      welcomeImageWidth: '240',
    });
    assert.equal(saved.status, 302, await saved.text().catch(() => ''));

    const html = await (await request(`${baseUrl}/`)).text();
    assert.match(html, /Welcome to the demo/);
    assert.match(html, /Custom body text\./);
    assert.match(html, /src="\/logo\.png"/);
    assert.match(html, /alt="Site logo"/);
    // 宽度必须写进带 nonce 的样式块：内联 style 属性会被 CSP 拒绝
    assert.match(html, /\.hero \{ width: 240px; \}/);

    // 主界面仍然不列出任何目录
    assert.doesNotMatch(html, /class="label"/);
  });

  test('★ 危险协议的图片地址被拒绝（不写入配置）', async () => {
    const response = await saveAppearance({ ...base, welcomeImage: 'javascript:alert(1)' });
    assert.equal(response.status, 400, '应当是可读的 400，而不是静默接受');

    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as {
      appearance: { welcomeImage: string };
    };
    assert.notEqual(onDisk.appearance.welcomeImage, 'javascript:alert(1)');
  });

  test('★ 外链图片的源会被加进 CSP（否则会被自己的策略拦掉）', async () => {
    const saved = await saveAppearance({
      ...base,
      welcomeImage: 'https://cdn.example.com/logo.png',
    });
    assert.equal(saved.status, 302);

    const csp = (await request(`${baseUrl}/`)).headers.get('content-security-policy') ?? '';
    assert.match(csp, /img-src [^;]*https:\/\/cdn\.example\.com/, 'CSP 应放行该图片的源');
  });

  /** 主界面按 ?lang= 渲染 —— 测试客户端的 Accept-Language 固定是 en-US */
  function welcome(lang: string): Promise<Response> {
    return request(`${baseUrl}/?lang=${lang}`);
  }

  test('★ 底部提示语可自定义，默认是「如有问题，请联系二维码提供方。」', async () => {
    await saveAppearance({ ...base, welcomeHint: '' });
    assert.match(
      await (await welcome('zh-CN')).text(),
      /如有问题，请联系二维码提供方。/,
      '留空时用内置文案',
    );
    assert.match(
      await (await welcome('en-US')).text(),
      /If you have any questions, please contact whoever provided you with the QR code\./,
      '英文词条同步更新',
    );

    await saveAppearance({ ...base, welcomeHintZh: '有事请联系老王。' });
    const custom = await (await welcome('zh-CN')).text();
    assert.match(custom, /有事请联系老王。/);
    assert.doesNotMatch(custom, /如有问题/);
    // 只填了中文，英文访客拿到的仍是英文内置文案 —— 两份互不回退，
    // 否则英文页面上会冒出一句中文
    assert.match(
      await (await welcome('en-US')).text(),
      /If you have any questions, please contact whoever provided you with the QR code\./,
      '中文文案不该漏到英文页面',
    );

    await saveAppearance({ ...base });
  });

  test('★ 主界面文案中英分栏，各取各的', async () => {
    await saveAppearance({
      ...base,
      welcomeTitleZh: '产品资料发布',
      welcomeTitleEn: 'Product Documents',
      welcomeMessageZh: '扫码查看我们的资料。',
      welcomeMessageEn: 'Scan the code to browse our documents.',
      welcomeHintZh: '有事请联系老王。',
      welcomeHintEn: 'Contact Lao Wang if you need help.',
    });

    const zh = await (await welcome('zh-CN')).text();
    assert.match(zh, /产品资料发布/);
    assert.match(zh, /扫码查看我们的资料。/);
    assert.match(zh, /有事请联系老王。/);
    assert.doesNotMatch(zh, /Product Documents/, '中文页不该出现英文那份');
    assert.doesNotMatch(zh, /Contact Lao Wang/);

    const en = await (await welcome('en-US')).text();
    assert.match(en, /Product Documents/);
    assert.match(en, /Scan the code to browse our documents\./);
    assert.match(en, /Contact Lao Wang if you need help\./);
    assert.doesNotMatch(en, /产品资料发布/, '英文页不该出现中文那份');

    // landing 页标题也要跟着走：<title> 用的是同一份标题
    assert.match(en, /<title>Product Documents/);

    await saveAppearance({ ...base });
  });

  test('★ 外观设置里主界面文案确实是中英两栏，且有产品名字段', async () => {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/appearance`, { headers: { cookie } })
    ).text();
    // 断言字段名而不是文案 —— 后者会随语言和措辞变动
    for (const name of [
      'productName',
      'welcomeTitleZh',
      'welcomeTitleEn',
      'welcomeMessageZh',
      'welcomeMessageEn',
      'welcomeImageAltZh',
      'welcomeImageAltEn',
      'welcomeHintZh',
      'welcomeHintEn',
    ]) {
      assert.match(page, new RegExp(`name="${name}"`), `缺少字段 ${name}`);
    }
    // 旧的单语字段名不该再出现（否则会和一个双语字段重名/互相覆盖）
    assert.doesNotMatch(page, /name="welcomeTitle"/);
    assert.doesNotMatch(page, /name="welcomeHint"/);
  });

  test('★ 主界面不放任何链接按钮（二维码是线下印在产品上的）', async () => {
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/appearance`, { headers: { cookie } })
    ).text();
    assert.doesNotMatch(page, /name="welcomeLinks"/, '外观设置里不该再有二维码链接字段');

    const html = await (await welcome('zh-CN')).text();
    assert.doesNotMatch(html, /class="links/, '主界面不该有任何链接区');
    assert.doesNotMatch(html, /相关链接/);
    // 落地页只有标题、正文、页脚提示，一个可点的出口都不给
    assert.match(html, /如有问题，请联系二维码提供方。/);
  });

  test('主界面默认文案：标题与正文', async () => {
    await saveAppearance({ ...base });
    const html = await (await welcome('zh-CN')).text();
    assert.ok(html.includes(zhWelcomeTitle()), `主界面标题应当是内置文案，实际没有 ${zhWelcomeTitle()}`);
    assert.match(html, /本站用于发布资料/);
  });

  test('★ 产品名里的特殊字符进 HTML 前必须被转义', async () => {
    // 默认产品名本身就带一个 `&`，所以上面那条其实一直在覆盖转义；
    // 这里再单独拿一个同时带 & 和尖括号的名字钉死。
    // 产品名进的是 <title> 和侧边栏，不转义就是一条从配置通往 XSS 的通路 ——
    // 而后台会话 cookie 就在同源。
    await saveAppearance({ ...base, productName: 'A&B <b>x</b>' });

    const cookie = await login();
    const admin = await (await request(`${baseUrl}/admin`, { headers: { cookie } })).text();
    assert.ok(admin.includes('A&amp;B &lt;b&gt;x&lt;/b&gt;'), '特殊字符必须被转义');
    assert.ok(!admin.includes('<b>x</b>'), '不得原样输出标签');
  });

  test('★ 产品名统一改后台抬头，但不动主界面标题', async () => {
    await saveAppearance({ ...base, productName: 'Acme 资料库' });

    const cookie = await login();
    const admin = await (
      await request(`${baseUrl}/admin`, { headers: { cookie } })
    ).text();
    assert.match(admin, /Acme 资料库/, '后台抬头应换成新产品名');
    assert.ok(
      !admin.includes(escapeForHtml(DEFAULT_PRODUCT)),
      '旧产品名不该残留（按转义后的形式比，否则这条断言永远通过）',
    );

    // 登录页同样跟着走
    const login1 = await request(`${baseUrl}/admin`);
    assert.match(await login1.text(), /Acme 资料库/);

    // 提到本程序的后台提示语也要跟着走 —— 这些以前是写死字面量的。
    // 顺带钉住占位符确实被替换了：t() 在缺参数时会把「{product}」原样留在页面上，
    // 那是个不会报错、只会在界面上露馅的失败模式。
    const domain = await (
      await request(`${baseUrl}/admin/domain`, { headers: { cookie } })
    ).text();
    assert.match(domain, /Acme 资料库/, '后台提示语里的产品名也要跟着变');
    assert.doesNotMatch(domain, /\{product\}/, '占位符没被替换');
    assert.ok(!domain.includes(escapeForHtml(DEFAULT_PRODUCT)), '不该残留默认产品名');

    // ★ 主界面标题是另一处独立设置，不受产品名影响
    const landing = await (await welcome('zh-CN')).text();
    assert.ok(
      landing.includes(zhWelcomeTitle()),
      '改产品名不该连带改掉落地页标题',
    );

    // 留空回退默认值，而不是留一个半截抬头
    await saveAppearance({ ...base, productName: '' });
    const after = JSON.parse(await readFile(configPath, 'utf8')) as {
      appearance: { productName: string };
    };
    assert.equal(after.appearance.productName, DEFAULT_PRODUCT);
  });

  test('主界面可以关掉，改回 404', async () => {
    const saved = await saveAppearance({ ...base, rootBehavior: 'notFound' });
    assert.equal(saved.status, 302);

    const response = await request(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(response.status, 404);

    // 复原，避免影响后续用例
    await saveAppearance({ ...base, rootBehavior: 'welcome' });
  });
});

describe('界面语言', () => {
  test('后台跟随浏览器的 Accept-Language', async () => {
    const english = await request(`${baseUrl}/admin`, {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    assert.match(await english.text(), /First-time setup|Sign in/);

    const chinese = await request(`${baseUrl}/admin`, {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    });
    assert.match(await chinese.text(), /首次设置|管理后台登录/);
  });
});

describe('内容面不受后台影响', () => {
  test('目录列表正常', async () => {
    const listing = await request(`${baseUrl}/Docs/`);
    assert.equal(listing.status, 200);
    assert.match(await listing.text(), /readme\.txt/);
  });

  test('★ 根路径显示欢迎页，且不列出任何目录名', async () => {
    const root = await request(`${baseUrl}/`);
    const html = await root.text();
    assert.equal(root.status, 200);
    assert.doesNotMatch(html, /class="label"/, '欢迎页不应有目录列表');
    assert.doesNotMatch(html, /Docs/, '欢迎页不能泄露有哪些目录');
  });

  test('rootBehavior 设为 notFound 时根路径返回 404', async () => {
    // 通过配置文件热重载切换，验证两种模式都可用
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      appearance?: Record<string, unknown>;
    };
    config.appearance = { ...(config.appearance ?? {}), rootBehavior: 'notFound' };
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    // 等待文件监听去抖并重载
    await new Promise((resolve) => setTimeout(resolve, 700));

    const response = await request(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(response.status, 404);

    // 复原，避免影响后续用例
    config.appearance = { ...config.appearance, rootBehavior: 'welcome' };
    await writeFile(configPath, JSON.stringify(config), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

  test('响应头无服务器指纹且带 nosniff', async () => {
    for (const pathname of ['/', '/Docs/', '/Docs/readme.txt']) {
      const response = await request(`${baseUrl}${pathname}`);
      assert.equal(response.headers.get('server'), null, `${pathname} 不应有 Server 头`);
      assert.equal(response.headers.get('x-powered-by'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  test('★ CSP 必须显式放行 connect-src 与 frame-src', async () => {
    // 这两条都是「不写就静默失效」的：CSP 里没有它们时，浏览器会回退到
    // default-src 'none'，于是：
    //   connect-src —— 后台所有 fetch 全被拒（目录浏览器逐层展开、文件上传）
    //   frame-src   —— 外观设置的实时预览 iframe 被拒
    // ★ 端到端测试**发现不了**这两条：跑测试用的是 Node 的 fetch，
    //   不经过浏览器，CSP 根本不参与。只有真人打开页面才会发现，
    //   而控制台只给一句 "Refused to connect ... default-src 'none'"。
    //   所以必须在这里把策略本身钉住。
    const response = await request(`${baseUrl}/admin/`);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /connect-src 'self'/, 'fetch/XHR 需要 connect-src');
    assert.match(csp, /frame-src 'self'/, '实时预览 iframe 需要 frame-src');
    assert.match(csp, /default-src 'none'/, '默认仍应是不放行');

    // 反过来钉住：别为了图省事把 unsafe-inline 放开 ——
    // 内联样式被拒是我们刻意接受的代价（也正因如此样式必须走类名）
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.doesNotMatch(csp, /unsafe-eval/);
  });
});

/**
 * 后台各设置页的「保存之后真的生效」。
 *
 * 这些页面此前只有「能打开」的覆盖，没有用例验证保存**之后**的行为。上传设置
 * 更是压根没有入口：配置项存在、文件管理页的提示语也明确指着「系统设置」，
 * 但那一页上并没有这张卡片，只能手改 config.json —— 一个死链接式的缺口。
 *
 * 所以这里一律按三段断言：**提交 → 配置落盘 → 行为真的改变**。
 * 只看提交返回 302 是不够的，那正是「表单能提交但什么也没发生」这类问题的盲区。
 */
describe('后台设置项：保存后真的生效', () => {
  type StoredConfig = {
    system: {
      upload: { enabled: boolean; maxSizeMb: number; allowOverwrite: boolean };
      accessLog: { enabled: boolean; ringSize: number };
      sessionTtlMinutes: number;
      bindSessionToIp: boolean;
    };
    access: { siteMode: string; adminIpAllowlist: string[]; deniedExtensions: string[]; deniedFilenames: string[] };
    directories: Array<{ id: string; name: string }>;
  };

  async function stored(): Promise<StoredConfig> {
    return JSON.parse(await readFile(configPath, 'utf8')) as StoredConfig;
  }

  /** 从任意后台页面取一个可用的 CSRF 令牌 */
  async function csrfOf(pathname: string, cookie: string): Promise<string> {
    const page = await (await request(`${baseUrl}${pathname}`, { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    assert.notEqual(csrf, '', `应能从 ${pathname} 提取 CSRF 令牌`);
    return csrf;
  }

  async function save(pathname: string, fields: Record<string, string>): Promise<Response> {
    const cookie = await login();
    const csrf = await csrfOf(pathname.replace(/\/[^/]+$/, ''), cookie);
    return postForm(`${baseUrl}${pathname}`, { _csrf: csrf, ...fields }, cookie);
  }

  async function docsId(): Promise<string> {
    const id = (await stored()).directories.find((d) => d.name === 'Docs')?.id ?? '';
    assert.notEqual(id, '', '测试配置里应当有 Docs 目录');
    return id;
  }

  async function uploadRaw(name: string, body: string): Promise<Response> {
    const dirId = await docsId();
    const cookie = await login();
    const page = await (
      await request(`${baseUrl}/admin/files?dir=${dirId}`, { headers: { cookie } })
    ).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    return request(`${baseUrl}/admin/files/upload?dir=${dirId}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'x-filename': encodeURIComponent(name), 'x-csrf': csrf },
      body,
    });
  }

  test('★ 上传设置能改、能落盘，关掉之后上传接口真的拒绝', async () => {
    // 两个复选框都不勾 = 都关掉；顺带改一个数值字段
    const saved = await save('/admin/system/upload', { uploadMaxSizeMb: '7' });
    assert.equal(saved.status, 302, await saved.text().catch(() => ''));

    const off = (await stored()).system.upload;
    assert.equal(off.enabled, false, '不勾选即关闭');
    assert.equal(off.allowOverwrite, false);
    assert.equal(off.maxSizeMb, 7);

    // 行为要跟着变：接口 403，并且**不留半截文件**
    const rejected = await uploadRaw('while-disabled.txt', 'x');
    assert.equal(rejected.status, 403, await rejected.text().catch(() => ''));
    assert.equal(
      await readFile(path.join(contentDir, 'Docs', 'while-disabled.txt')).catch(() => null),
      null,
      '关闭上传后不该有任何东西落盘',
    );

    // 文件管理页此时应当给出「已在系统设置中关闭」的提示 —— 而那个开关现在真的存在
    const dirId = await docsId();
    const cookie = await login();
    const files = await (
      await request(`${baseUrl}/admin/files?dir=${dirId}`, { headers: { cookie } })
    ).text();
    assert.match(files, /关闭|disabled/i, '关闭时文件页要说明原因');

    // 复原
    const back = await save('/admin/system/upload', { uploadEnabled: '1', uploadMaxSizeMb: '1' });
    assert.equal(back.status, 302);
    assert.equal((await stored()).system.upload.enabled, true);
    assert.equal((await uploadRaw('re-enabled.txt', 'ok')).status, 200);
  });

  test('★ 整站密码：设上之后内容面要密码，改回公开立刻放行', async () => {
    assert.equal(
      (await save('/admin/access/site', { siteMode: 'password', sitePassword: 'site-pass-123' })).status,
      302,
    );
    assert.equal((await stored()).access.siteMode, 'password');

    // 闸门对未认证访客生效：拿不到列表内容
    const gated = await request(`${baseUrl}/Docs/`, { redirect: 'manual' });
    assert.notEqual(gated.status, 200, '设了整站密码后不应直接给出列表');
    assert.doesNotMatch(await gated.text().catch(() => ''), /readme\.txt/);

    // 复原：改回公开，无需密码
    assert.equal((await save('/admin/access/site', { siteMode: 'public' })).status, 302);
    assert.equal((await stored()).access.siteMode, 'public');
    assert.equal((await request(`${baseUrl}/Docs/`)).status, 200);
  });

  test('★ 登录会话时长与 IP 绑定能改能落盘', async () => {
    const saved = await save('/admin/access/session', {
      sessionTtlMinutes: '90',
      bindSessionToIp: '1',
    });
    assert.equal(saved.status, 302, await saved.text().catch(() => ''));
    assert.equal((await stored()).system.sessionTtlMinutes, 90);
    assert.equal((await stored()).system.bindSessionToIp, true);

    // 越界的值会被夹到合法区间，而不是原样写进去
    await save('/admin/access/session', { sessionTtlMinutes: '999999' });
    assert.equal((await stored()).system.sessionTtlMinutes, 43200, '应当夹到上限');

    // 复原
    await save('/admin/access/session', { sessionTtlMinutes: '720' });
    assert.equal((await stored()).system.sessionTtlMinutes, 720);
    assert.equal((await stored()).system.bindSessionToIp, false);
  });

  test('★ 非法的 IP 白名单被拒绝，且不会写进配置', async () => {
    const before = (await stored()).access.adminIpAllowlist;

    const response = await save('/admin/access/ip', { allowlist: '127.0.0.1/32\n这根本不是CIDR' });
    assert.equal(response.status, 400, '应当是带明细的 400');
    assert.match(await response.text(), /CIDR/i, '要指出到底哪里不对');
    assert.deepEqual(
      (await stored()).access.adminIpAllowlist,
      before,
      '★ 校验不过就不能落盘 —— 否则页面弹红字、配置却已经变成错的',
    );
  });

  test('★ 自定义的敏感扩展名保存后真的 404', async () => {
    const secretPath = path.join(contentDir, 'Docs', 'secret.zzz');
    await writeFile(secretPath, 'top secret\n', 'utf8');
    assert.equal((await request(`${baseUrl}/Docs/secret.zzz`)).status, 200, '加规则前应当可访问');

    const before = (await stored()).access;
    const saved = await save('/admin/access/files', {
      // 两个列表都要显式回传：表单里缺哪个字段就等于把哪个清空
      deniedExtensions: [...before.deniedExtensions, '.zzz'].join('\n'),
      deniedFilenames: before.deniedFilenames.join('\n'),
    });
    assert.equal(saved.status, 302);
    // ★ 这里必须问的是**保存返回之后的第一条**内容请求。
    //   曾经的写法是 store.update() 里 `void refresh()` —— 目录映射（带着 deny 规则）
    //   是异步重建的，保存返回时它可能还是旧的，于是这条断言有一半概率拿到 200。
    //   那不只是测试不稳定：线上就是「刚禁掉的扩展名还能下载一下」。
    //   现在 store 会等订阅者跑完再返回，这条断言因此是确定性的。
    assert.equal((await request(`${baseUrl}/Docs/secret.zzz`)).status, 404, '加进规则后一律 404');

    // 复原
    await save('/admin/access/files', {
      deniedExtensions: before.deniedExtensions.join('\n'),
      deniedFilenames: before.deniedFilenames.join('\n'),
    });
    await rm(secretPath, { force: true });
    assert.equal((await request(`${baseUrl}/Docs/readme.txt`)).status, 200, '复原后正常文件仍可访问');
  });

  test('★ 目录的新增、改名、删除都会落盘，且立刻反映到内容面', async () => {
    const extraPath = path.join(contentDir, 'Extra');
    // 刻意不预先建好这个文件夹：现在「新增目录」会自己 mkdir，
    // 这里要证明的正是服务端把它建了出来（而不是「路径碰巧已经存在」）。
    assert.equal(await exists(extraPath), false);

    const created = await save('/admin/directories/create', {
      name: 'Extra',
      parent: contentDir,
      folder: 'Extra',
      label: '',
      access: 'inherit',
      note: '',
      enabled: '1',
    });
    assert.equal(created.status, 302, await created.text().catch(() => ''));
    assert.equal(await exists(extraPath), true, '文件夹应当由服务端建出来');

    const record = (await stored()).directories.find((d) => d.name === 'Extra');
    assert.ok(record, '新目录应当写进配置');
    assert.equal((await request(`${baseUrl}/Extra/`)).status, 200, '新目录应立刻可访问');

    // 「改名」改的是 URL 前缀，物理文件夹不动
    const renamed = await save('/admin/directories/update', {
      id: record.id,
      name: 'ExtraRenamed',
      parent: contentDir,
      folder: 'Extra',
      label: '',
      access: 'inherit',
      note: '',
      enabled: '1',
    });
    assert.equal(renamed.status, 302);
    assert.ok((await stored()).directories.some((d) => d.name === 'ExtraRenamed'));
    assert.equal((await request(`${baseUrl}/ExtraRenamed/`)).status, 200);
    assert.equal((await request(`${baseUrl}/Extra/`)).status, 404, '旧名字应当失效');

    const removed = await save('/admin/directories/delete', { id: record.id });
    assert.equal(removed.status, 302);
    assert.equal(
      (await stored()).directories.some((d) => d.id === record.id),
      false,
      '删除后配置里不应再留着它',
    );
    assert.equal((await request(`${baseUrl}/ExtraRenamed/`)).status, 404);

    await rm(extraPath, { recursive: true, force: true });
  });

  test('★ 非法目录名被拒绝，且不写进配置', async () => {
    const before = (await stored()).directories.length;
    // 保留名与路由打架；含斜杠会让 URL 与实际目录对不上
    for (const bad of ['admin', 'a/b', '..']) {
      const response = await save('/admin/directories/create', {
        name: bad,
        parent: contentDir,
        folder: bad,
        label: '',
        access: 'inherit',
        note: '',
        enabled: '1',
      });
      // 「..」拼接后落到池子之外，会被闸门先拦下（403）—— 同样是拒绝，同样是没落盘
      assert.ok(
        response.status === 400 || response.status === 403,
        `${bad} 应当被拒绝，实际 ${response.status}`,
      );
    }
    assert.equal((await stored()).directories.length, before, '被拒绝的目录不能留在配置里');
  });

  describe('扫描导入', () => {
    /** 勾选项的字段名带目录名 —— 与 views/forms.ts 的 SCAN_PICK_PREFIX 一致 */
    const pick = (name: string): Record<string, string> => ({ [`pick:${name}`]: '1' });

    const dropAll = async (names: readonly string[]): Promise<void> => {
      const config = await stored();
      for (const name of names) {
        const record = config.directories.find((d) => d.name === name);
        if (record !== undefined) await save('/admin/directories/delete', { id: record.id });
        await rm(path.join(contentDir, name), { recursive: true, force: true });
      }
    };

    before(async () => {
      await mkdir(path.join(contentDir, 'ScanA'), { recursive: true });
      await mkdir(path.join(contentDir, 'ScanB'), { recursive: true });
    });

    // 只收拾自己造的两条。**别碰 Docs** —— 它是夹具的内容目录，
    // 后面的访问日志用例要靠它。删掉它那些用例照样会绿（404 也会被记进日志），
    // 那才是最坏的一种坏：测试还在跑，验的东西已经没了。
    after(async () => {
      await dropAll(['ScanA', 'ScanB']);
    });

    /**
     * ★ 以前这里不管勾没勾都是**全量**导入，i18n 文案却写着「勾选后批量创建」——
     *   文案和实现对不上，用户勾一个得到一个。这条用例钉的就是「只导入勾选的」。
     */
    test('★ 只导入勾选的那些，没勾的原样留在磁盘上', async () => {
      const response = await save('/admin/directories/scan', {
        root: contentDir,
        ...pick('ScanA'),
      });
      assert.equal(response.status, 302);

      const names = (await stored()).directories.map((d) => d.name);
      assert.ok(names.includes('ScanA'), '勾选的应当被导入');
      assert.ok(!names.includes('ScanB'), '没勾的不该被导入 —— 这正是这次改的东西');
      assert.equal(await exists(path.join(contentDir, 'ScanB')), true, '没勾的文件夹不该被删');
    });

    test('★ 一个都没勾 → 不导入任何东西，并给出提示', async () => {
      const before = (await stored()).directories.length;
      const response = await save('/admin/directories/scan', { root: contentDir });
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location') ?? '', /err=/);
      assert.equal((await stored()).directories.length, before);
    });

    test('★ 勾一个磁盘上不存在的名字 → 不落盘（名字是客户端说了算的）', async () => {
      const before = (await stored()).directories.length;
      const response = await save('/admin/directories/scan', {
        root: contentDir,
        ...pick('NotOnDisk'),
      });
      // 名单以 readdir 的实际结果为准，不是一个对得上的名字就照着建
      assert.match(response.headers.get('location') ?? '', /err=/);
      assert.equal((await stored()).directories.length, before, '不存在的名字不该被登记');
    });

    test('★ 勾一个已经发布过的 → 不重复导入', async () => {
      const before = (await stored()).directories.length;
      const response = await save('/admin/directories/scan', {
        root: contentDir,
        ...pick('ScanA'),
      });
      assert.match(response.headers.get('location') ?? '', /err=/);
      assert.equal((await stored()).directories.length, before, '重复导入应当被跳过');
    });
  });

  /**
   * ★ 窄屏列折叠要求「表头藏哪几列、数据行就藏哪几列」。
   *
   *   只给 <th> 加 col-opt 而漏了 <td>（这个错误我犯过），宽屏上完全看不出来，
   *   手机上才会看到表头和数据错位一格 —— 看着像整张表串行了。
   *   逐张表数一遍，比人肉 review 可靠。
   */
  test('★ 每张表里标了 col-opt 的表头与数据列一一对应', async () => {
    const cookie = await login();
    const pages = ['/admin/', '/admin/directories', '/admin/users', '/admin/logs', '/admin/files'];

    for (const page of pages) {
      const html = await (await request(`${baseUrl}${page}`, { headers: { cookie } })).text();
      const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
      assert.ok(tables.length > 0, `${page} 上应当有表格`);

      for (const table of tables) {
        const head = /<thead[\s\S]*?<\/thead>/.exec(table)?.[0] ?? '';
        const body = /<tbody[\s\S]*?<\/tbody>/.exec(table)?.[0] ?? '';
        const headOpt = (head.match(/<th[^>]*col-opt/g) ?? []).length;

        // 空表用一条 colspan 占位，没有可对齐的数据列，跳过
        const firstRow = /<tr>[\s\S]*?<\/tr>/.exec(body)?.[0] ?? '';
        if (firstRow.includes('colspan')) continue;
        const bodyOpt = (firstRow.match(/<td[^>]*col-opt/g) ?? []).length;
        assert.equal(
          bodyOpt,
          headOpt,
          `${page}：表头藏了 ${headOpt} 列，数据行却藏了 ${bodyOpt} 列 —— 窄屏上会错位`,
        );
      }
    }
  });

  test('★ 配置导出要登录，导出的是完整配置', async () => {
    const anonymous = await request(`${baseUrl}/admin/system/export`, { redirect: 'manual' });
    assert.notEqual(anonymous.status, 200, '导出含密码哈希与会话密钥，必须先登录');

    const cookie = await login();
    const response = await request(`${baseUrl}/admin/system/export`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const dumped = JSON.parse(await response.text()) as Record<string, unknown>;
    for (const key of ['system', 'appearance', 'access', 'directories']) {
      assert.ok(key in dumped, `导出内容应当包含 ${key}`);
    }
  });

  test('导入非 JSON 被拒绝，现有配置不受影响', async () => {
    const before = await stored();
    const response = await save('/admin/system/import', { json: '这不是 JSON' });
    assert.equal(response.status, 400);
    assert.deepEqual((await stored()).directories, before.directories);
  });

  test('★ 打开访问日志后能记到请求，并能导出成 CSV', async () => {
    assert.equal(
      (await save('/admin/system/log', { logEnabled: '1', logRingSize: '50', logLevel: 'info' })).status,
      302,
    );
    assert.equal((await stored()).system.accessLog.enabled, true);

    // 制造一条访问记录，再导出。
    // ★ 断言状态码：不带断言的话，这条日志记录是 200 还是 404 都能让下面的
    //   `includes('/Docs/readme.txt')` 通过 —— 404 一样会被记进访问日志，
    //   于是「夹具被人删了」这种情况会伪装成一条通过的用例。
    assert.equal((await request(`${baseUrl}/Docs/readme.txt`)).status, 200);

    const cookie = await login();
    const response = await request(`${baseUrl}/admin/logs/export`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment/);

    // 首行是表头（文件带 BOM，比较时先去掉）；且必须真的含刚才那条记录
    const csv = (await response.text()).replace(/^﻿/, '');
    const [header, ...rows] = csv.trimEnd().split('\n');
    assert.equal(header, 'time,ip,method,path,status,bytes,durationMs,userAgent');
    assert.ok(
      rows.some((line) => line.includes('/Docs/readme.txt')),
      `CSV 里应当有刚才那次访问，实际：\n${rows.slice(0, 5).join('\n')}`,
    );

    // 复原
    await save('/admin/system/log', { logRingSize: '500', logLevel: 'info' });
    assert.equal((await stored()).system.accessLog.enabled, false);
  });
});
