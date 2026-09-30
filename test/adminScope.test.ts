/**
 * 超级管理员 / 子管理员的隔离集成测试。
 *
 * 存在的理由：权限模型如果只在界面上收敛（藏按钮、藏导航），那是一层纸 ——
 * 子管理员在地址栏里直接敲别人目录的网址、或者拿别人的目录 id 提交一个表单，
 * 就绕过去了。所以这里全部是**起真实进程、发真实请求**的端到端用例，
 * 而且刻意不看界面文案（改文案或换语言不该让测试误报）。
 *
 * 覆盖四条独立的防线，任何一条塌了都是完整的越权：
 *   1. 后台路由：别人的目录 id → 404（不是 403，不能反过来确认对象存在）
 *   2. 内容面：带子管理员 cookie 直接访问别人的目录 → 404
 *   3. 目录 cookie：把 A 目录的票据改名成 B 的 → 仍然要密码
 *   4. 超级管理员专属路由：一律 404
 *
 * 另外覆盖两件与「权限改了要不要重启」有关的事：
 *   - 权限是**每次请求现查**的，勾上就立刻生效（票据里不带权限）
 *   - 账号被删，那一跳就失效
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../src/admin/auth.ts';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const ADMIN_PW = 'super-admin-password';
const ALICE_PW = 'alice-password-1';
const BOB_PW = 'bob-password-11';
const ALICE_DIR_PW = 'alice-directory-pw';
const BOB_DIR_PW = 'bob-directory-pw';

/** 会话密钥写死，这样才能在测试里伪造一张「升级前」的旧票据 */
const SESSION_SECRET = 'test-session-secret-for-admin-scope';

const ALICE_ID = 'alice0001';
const BOB_ID = 'bob00001';

/**
 * alice 的初始权限。
 *
 * 刻意**不含** dirs.delete —— 后面要验证「勾上之后同一张 cookie 立刻就能删」，
 * 那正是「权限不写进票据、每次现查」这件事的回归保护。
 */
const ALICE_PERMS = ['dirs.view', 'dirs.create', 'dirs.browse', 'files.view', 'dirs.qr'];

let workDir = '';
let contentRoot = '';
/** alice 的**授权父目录**（她的工作区），本身不发布 */
let aliceDir = '';
/** alice 名下的那个内容目录（工作区下面的一层） */
let aliceSite = '';
let bobDir = '';
let bobSite = '';
let configPath = '';
let child: ChildProcess | null = null;
let baseUrl = '';
let port = 0;
let aliceDirId = '';
let bobDirId = '';

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const value = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return value;
}

async function waitForPort(target: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${target}/robots.txt`)).status === 200) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start on port ${target}`);
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: init.redirect ?? 'manual',
    headers: { 'accept-language': 'zh-CN', ...(init.headers ?? {}) },
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

/** 从页面里抠出 CSRF 令牌。用它而不是直接算，是为了顺带验证表单确实带着令牌 */
function csrfOf(html: string): string {
  const match = /name="_csrf" value="([^"]*)"/.exec(html);
  assert.ok(match !== null, '页面里应当有 CSRF 令牌');
  return match[1] ?? '';
}

async function get(pathname: string, cookie?: string): Promise<Response> {
  return request(`${baseUrl}${pathname}`, cookie === undefined ? {} : { headers: { cookie } });
}

async function post(
  pathname: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return request(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

/** 登录并返回 `qrfolder_session=...` 形式的 cookie 串 */
async function login(username: string, password: string): Promise<string | null> {
  const response = await post('/admin/login', { username, password });
  const session = cookieOf(response, 'qrfolder_session');
  return session === null ? null : `qrfolder_session=${session}`;
}

/**
 * 后台一次带 CSRF 的 POST。
 *
 * 令牌从目标页面取 —— 后台每个表单里的令牌都是同一个（由会话密钥与票据派生），
 * 所以随便拿一页的就行。
 */
async function postAdmin(
  pathname: string,
  fields: Record<string, string>,
  cookie: string,
): Promise<Response> {
  const page = await get('/admin/', cookie);
  const html = await page.text();
  // 先确认「自己这张票据是好的」：不然下面测出来的 404 可能只是「谁都没登录」，
  // 那会让整条越权断言变成永远通过的空测试。
  assert.equal(
    page.status,
    200,
    `取 CSRF 令牌时后台应当可访问，实际 ${page.status} → ${page.headers.get('location') ?? ''}`,
  );
  return post(pathname, { ...fields, _csrf: csrfOf(html) }, cookie);
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
}

/** 磁盘上到底有没有这个东西。新建目录是要动磁盘的，断言必须落到这里 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(config: unknown): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'qrfolder-scope-'));
  contentRoot = path.join(workDir, 'content');
  // 夹具的形状照着线上来：**授权父目录是「工作区」，发布的目录是它下面的一层**。
  // 两者不能是同一个路径 —— 那正是 isAuthorizedParent 要拦的配置：
  // 同一个位置既当「可以往里建东西的容器」又当「一个对外发布的站点」，
  // 两套语义会打架（往工作区里随手建的草稿文件夹会立刻出现在公开列表上）。
  aliceDir = path.join(contentRoot, 'Alice');
  aliceSite = path.join(aliceDir, 'Docs');
  bobDir = path.join(contentRoot, 'Bob');
  bobSite = path.join(bobDir, 'Docs');

  await mkdir(aliceSite, { recursive: true });
  await mkdir(bobSite, { recursive: true });
  await writeFile(path.join(aliceSite, 'alice-file.txt'), 'alice\n', 'utf8');
  await writeFile(path.join(bobSite, 'bob-secret.txt'), 'bob\n', 'utf8');

  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  configPath = path.join(workDir, 'config.json');

  // 固定 id，方便在断言里引用；owner 直接用它们
  aliceDirId = 'dir-alice';
  bobDirId = 'dir-bob';

  const config = {
    version: 1,
    system: {
      host: '127.0.0.1',
      port,
      sessionSecret: SESSION_SECRET,
      // 外层边界。子管理员各自的 roots 必须是它的子目录（校验器强制）
      scanRoots: [contentRoot],
      accessLog: { enabled: false },
    },
    appearance: { rootBehavior: 'welcome', welcomeMessage: '' },
    access: {
      admins: [
        {
          id: '',
          username: 'admin',
          role: 'super',
          password: await hashPassword(ADMIN_PW),
          permissions: [],
          roots: [],
          enabled: true,
          note: '',
        },
        {
          id: ALICE_ID,
          username: 'alice',
          role: 'sub',
          password: await hashPassword(ALICE_PW),
          permissions: ALICE_PERMS,
          // 授权父目录只给到她自己那一层：她建不出 contentRoot 之下、
          // Alice 之外的任何目录
          roots: [aliceDir],
          enabled: true,
          note: '',
        },
        {
          id: BOB_ID,
          username: 'bob',
          role: 'sub',
          password: await hashPassword(BOB_PW),
          permissions: ['dirs.view', 'files.view'],
          roots: [bobDir],
          enabled: true,
          note: '',
        },
      ],
    },
    directories: [
      {
        id: aliceDirId,
        name: 'Alice',
        path: aliceSite,
        owner: ALICE_ID,
        // 目录密码：用来验证「把别人的目录票改名过去」这条路走不通
        access: 'password',
        password: await hashPassword(ALICE_DIR_PW),
      },
      {
        id: bobDirId,
        name: 'Bob',
        path: bobSite,
        owner: BOB_ID,
        access: 'password',
        password: await hashPassword(BOB_DIR_PW),
      },
    ],
  };

  await writeConfig(config);

  child = spawn(
    process.execPath,
    [path.join(APP_DIR, 'src', 'main.ts'), '--config', configPath, '--port', String(port)],
    { cwd: APP_DIR, stdio: 'ignore' },
  );

  await waitForPort(port);
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

describe('登录', () => {
  test('子管理员能用自己的用户名密码登录', async () => {
    assert.ok((await login('alice', ALICE_PW)) !== null);
  });

  test('用户名对、密码错 → 401', async () => {
    const response = await post('/admin/login', { username: 'alice', password: 'wrong-password' });
    assert.equal(response.status, 401);
  });

  test('★ 用户名不存在与密码错返回同一个状态码（不泄露用户名是否存在）', async () => {
    const missing = await post('/admin/login', { username: 'nobody-here', password: 'whatever-12' });
    assert.equal(missing.status, 401);
  });
});

describe('后台：别人的目录按不存在处理', () => {
  let alice = '';
  let bob = '';

  before(async () => {
    alice = (await login('alice', ALICE_PW)) ?? '';
    bob = (await login('bob', BOB_PW)) ?? '';
    assert.notEqual(alice, '');
    assert.notEqual(bob, '');
  });

  test('目录列表里只有自己的目录', async () => {
    const html = await (await get('/admin/directories', alice)).text();
    assert.match(html, /Alice/);
    assert.doesNotMatch(html, /Bob/, '不该看到别人的目录');
  });

  test('★ 被放行的那条路径本身走得通（只看拦截会漏掉「全站 404」这种坏法）', async () => {
    const response = await get('/admin/directories', alice);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Alice/);
  });

  test('★ ?edit=<别人的 id> 不会打开表单', async () => {
    const html = await (await get(`/admin/directories?edit=${bobDirId}`, alice)).text();
    assert.doesNotMatch(html, /id="dir-dialog"/, '不该渲染出编辑表单');
  });

  test('★ 删除别人的目录 → 404，且配置里那条还在', async () => {
    const response = await postAdmin('/admin/directories/delete', { id: bobDirId }, alice);
    assert.equal(response.status, 404);

    const config = await readConfig();
    const dirs = config['directories'] as { id: string }[];
    assert.ok(dirs.some((d) => d.id === bobDirId), '别人的目录不该被删掉');
  });

  test('★ 二维码也按归属拦（它是受保护目录的钥匙）', async () => {
    assert.equal((await get(`/admin/directories/qr?dir=${bobDirId}`, alice)).status, 404);
    assert.equal((await get(`/admin/directories/qr?dir=${aliceDirId}`, alice)).status, 200);
  });

  test('★ 文件管理页选别人的目录 → 404', async () => {
    assert.equal((await get(`/admin/files?dir=${bobDirId}`, alice)).status, 404);
    assert.equal((await get(`/admin/files?dir=${aliceDirId}`, alice)).status, 200);
  });

  test('上传到别人的目录 → 404（不是 403，也不回 JSON 之外的东西）', async () => {
    const response = await request(`${baseUrl}/admin/files/upload?dir=${bobDirId}`, {
      method: 'POST',
      headers: { cookie: alice, 'x-csrf': 'whatever', 'x-filename': 'x.txt' },
      body: 'hello',
    });
    assert.equal(response.status, 404);
  });

  test('★ 超级管理员仍然看得到全部目录（界面上「被放行的那条」也要验）', async () => {
    const admin = (await login('admin', ADMIN_PW)) ?? '';
    const html = await (await get('/admin/directories', admin)).text();
    assert.match(html, /Alice/);
    assert.match(html, /Bob/);
  });
});

describe('后台：超级管理员专属路由对子管理员一律 404', () => {
  let alice = '';

  before(async () => {
    alice = (await login('alice', ALICE_PW)) ?? '';
  });

  const superOnly: ReadonlyArray<[string, () => Promise<Response>]> = [
    ['GET /system/export（含密码哈希与会话密钥）', () => get('/admin/system/export', alice)],
    ['GET /access', () => get('/admin/access', alice)],
    ['GET /domain', () => get('/admin/domain', alice)],
    ['GET /users', () => get('/admin/users', alice)],
    ['POST /reload', () => postAdmin('/admin/reload', {}, alice)],
    ['POST /rotate-secret', () => postAdmin('/admin/rotate-secret', {}, alice)],
    ['POST /logs/clear', () => postAdmin('/admin/logs/clear', {}, alice)],
    ['POST /system/import', () => postAdmin('/admin/system/import', { json: '{}' }, alice)],
    ['POST /system/scanroots', () => postAdmin('/admin/system/scanroots', { scanRoots: 'C:\\' }, alice)],
    ['POST /users/create', () => postAdmin('/admin/users/create', { username: 'evil' }, alice)],
  ];

  for (const [label, send] of superOnly) {
    test(label, async () => {
      assert.equal((await send()).status, 404);
    });
  }

  test('★ /system/export 用 POST 也拿不到（这一条曾经完全没有方法检查）', async () => {
    assert.equal((await postAdmin('/admin/system/export', {}, alice)).status, 404);
  });

  test('★ 没有 logs.view 时日志页与导出都拿不到', async () => {
    assert.equal((await get('/admin/logs', alice)).status, 404);
    assert.equal((await get('/admin/logs/export', alice)).status, 404);
  });

  test('★ 没有 appearance.view 时外观页也拿不到（不是「只读」而是「不存在」）', async () => {
    assert.equal((await get('/admin/appearance', alice)).status, 404);
  });
});

describe('内容面：子管理员只能进自己名下的目录', () => {
  let alice = '';

  before(async () => {
    alice = (await login('alice', ALICE_PW)) ?? '';
  });

  test('★ 自己的目录 200，别人的 404（页面在不在都要验）', async () => {
    assert.equal((await get('/Alice/', alice)).status, 200);
    assert.equal((await get('/Bob/', alice)).status, 404);
  });

  test('★ 别人的目录里的文件也拿不到', async () => {
    assert.equal((await get('/Bob/bob-secret.txt', alice)).status, 404);
  });

  test('★ 而且不是「弹密码页」—— 那等于确认了这个目录存在', async () => {
    const response = await get('/Bob/', alice);
    const html = await response.text();
    assert.equal(response.status, 404);
    assert.doesNotMatch(html, /name="password"/, '不该出现目录密码闸门');
  });

  test('超级管理员在内容面照旧畅通（后台实时预览要用）', async () => {
    const admin = (await login('admin', ADMIN_PW)) ?? '';
    assert.equal((await get('/Alice/', admin)).status, 200);
    assert.equal((await get('/Bob/', admin)).status, 200);
  });
});

describe('目录 cookie 不能改名越权', () => {
  test('★ 把 Alice 的目录票改名成 Bob 的，仍然要密码', async () => {
    // 先以访客身份拿到 Alice 的目录票
    const passed = await post('/Alice/', { password: ALICE_DIR_PW });
    const names = passed.headers.getSetCookie().map((entry) => entry.split('=')[0] ?? '');
    const aliceCookieName = names.find((name) => name.startsWith('qrfolder_session_dir_'));
    assert.ok(aliceCookieName !== undefined, '应当种下一枚目录会话 cookie');
    const value = cookieOf(passed, aliceCookieName);
    assert.ok(value !== null);

    // 名字里嵌着目录 id，所以「改名」就是把 id 那段换掉
    const forgedName = `qrfolder_session_dir_${bobDirId}`;
    assert.notEqual(forgedName, aliceCookieName);

    // 改名后的票据签名照样验得过（同一个会话密钥），所以必须在别处挡住
    const response = await get('/Bob/', `${forgedName}=${value}`);
    assert.equal(response.status, 401, '改名的票据不该放行');
    assert.match(await response.text(), /type="password"/);

    // 原来的名字仍然有效 —— 证明拦的不是「这张票本身坏了」
    assert.equal((await get('/Alice/', `${aliceCookieName}=${value}`)).status, 200);
  });
});

describe('授权根目录是硬边界', () => {
  let alice = '';

  before(async () => {
    alice = (await login('alice', ALICE_PW)) ?? '';
  });

  /**
   * ★ 这一组用例会**真的在磁盘上建文件夹**，也会给夹具添几条目录记录。
   *
   * 收尾不是洁癖：后面「回归」那一组要拿一个「alice 名下的目录」当靶子，
   * 而它是按「第一个归 alice 的」找的。留在这里的临时目录会排到前面去，
   * 于是那边以一个和它毫无关系的 400 失败 —— 一个模块改了夹具，另一个模块跟着红。
   */
  after(async () => {
    const superCookie = (await login('admin', ADMIN_PW)) ?? '';
    const config = await readConfig();
    const created = (config['directories'] as { id: string; name: string; path: string }[]).filter(
      (d) => ['AliceSub', 'NoPrefix', 'Already'].includes(d.name),
    );
    for (const dir of created) {
      await postAdmin('/admin/directories/delete', { id: dir.id }, superCookie);
      await rm(dir.path, { recursive: true, force: true });
    }
  });

  test('★ 在自己授权范围之外建目录 → 403，且不写进配置、不落盘', async () => {
    const response = await postAdmin(
      '/admin/directories/create',
      { name: 'Escape', parent: bobDir, folder: 'Escape', enabled: '1' },
      alice,
    );
    assert.equal(response.status, 403);

    const config = await readConfig();
    const dirs = config['directories'] as { name: string }[];
    assert.ok(!dirs.some((d) => d.name === 'Escape'), '越界的目录不该被创建');
    assert.equal(await exists(path.join(bobDir, 'Escape')), false, '越界时一个文件夹都不该建出来');
  });

  test('★ 在自己的授权范围内建目录 → 成功，文件夹真的出现在磁盘上，归属盖成自己', async () => {
    const response = await postAdmin(
      '/admin/directories/create',
      { name: 'AliceSub', parent: aliceDir, folder: 'Sub', enabled: '1' },
      alice,
    );
    assert.equal(response.status, 302, '授权范围内的创建应当成功');

    // ★ 这是本站第一个会在磁盘上建目录的操作，所以断言落在磁盘上 ——
    //   只断言「配置里多了一条」的话，mkdir 整个没跑也照样绿。
    assert.equal(await exists(path.join(aliceDir, 'Sub')), true, '文件夹应当被真的建出来');

    const config = await readConfig();
    const created = (config['directories'] as { name: string; owner: string; path: string }[]).find(
      (d) => d.name === 'AliceSub',
    );
    assert.ok(created !== undefined, '目录应当被创建');
    assert.equal(created.owner, ALICE_ID, '归属应当是创建者');
    assert.equal(created.path, path.join(aliceDir, 'Sub'), '落盘的路径应当是父目录 + 目录名');
  });

  test('★ URL 前缀留空时跟目录名走', async () => {
    const response = await postAdmin(
      '/admin/directories/create',
      { name: '', parent: aliceDir, folder: 'NoPrefix', enabled: '1' },
      alice,
    );
    assert.equal(response.status, 302);

    const config = await readConfig();
    const created = (config['directories'] as { name: string }[]).find(
      (d) => d.name === 'NoPrefix',
    );
    assert.ok(created !== undefined, '留空应当回落到目录名，而不是建出一个没有名字的目录');
  });

  test('★ 目录名非法 → 400，且一个文件夹都不建', async () => {
    const bad = ['..', 'a/b', 'CON', 'trailing.', '..\\escape'];
    for (const [index, folder] of bad.entries()) {
      const response = await postAdmin(
        '/admin/directories/create',
        { name: `Bad${index}`, parent: aliceDir, folder, enabled: '1' },
        alice,
      );
      // 「..」这类会在拼接后落到授权范围之外，于是被**闸门**先拦下（403），
      // 根本走不到表单校验那一步。两种拒绝都是对的，这里只要求「不是成功」。
      assert.ok(
        response.status === 400 || response.status === 403,
        `目录名「${folder}」应当被拒，实际 ${response.status}`,
      );
    }
    // 「..」和「a/b」如果漏出去，落点会跑到 Alice 的上一级 —— 那是别人的地盘
    const above = await readdir(contentRoot);
    assert.deepEqual(above.filter((name) => name.startsWith('Bad')), [], '越界的名字不该落盘');
  });

  test('★ 父目录在服务器上不存在 → 400，且不会递归造出中间层', async () => {
    // alice 的授权根是 aliceDir，往它下面编一个不存在的父目录
    const missing = path.join(aliceDir, 'ghost', 'deeper');
    const response = await postAdmin(
      '/admin/directories/create',
      { name: 'GhostChild', parent: missing, folder: 'GhostChild', enabled: '1' },
      alice,
    );
    assert.equal(response.status, 400);
    assert.equal(await exists(path.join(aliceDir, 'ghost')), false, '不该悄悄造出中间的层级');
  });

  test('★ 目标已存在 → 不报错，直接发布（这正是「发布一个已存在的文件夹」）', async () => {
    await mkdir(path.join(aliceDir, 'Already'), { recursive: true });

    const response = await postAdmin(
      '/admin/directories/create',
      { name: 'Already', parent: aliceDir, folder: 'Already', enabled: '1' },
      alice,
    );
    assert.equal(response.status, 302);

    const config = await readConfig();
    assert.ok(
      (config['directories'] as { name: string }[]).some((d) => d.name === 'Already'),
      '已存在的文件夹应当被直接登记',
    );
  });

  test('★ 超级管理员同样只能在池子里选位置（池子是硬边界，没有例外入口）', async () => {
    const admin = (await login('admin', ADMIN_PW)) ?? '';
    // 池子（配置里写的还是旧键 scanRoots）只到 contentRoot
    const response = await postAdmin(
      '/admin/directories/create',
      { name: 'OutOfPool', parent: workDir, folder: 'OutOfPool', enabled: '1' },
      admin,
    );
    assert.equal(response.status, 403, '超级管理员也不能发布池子之外的文件夹');
    assert.equal(await exists(path.join(workDir, 'OutOfPool')), false);
  });

  /**
   * ★ 「授权父目录」是放东西的容器，本身不能被当成内容目录发布。
   *
   *   两种位置都算：池子里的路径，以及子管理员被勾选的授权根。
   *   不拦的话会得到这么一团：同一个文件夹既是「某人可以往里建东西的工作区」，
   *   又是一个对外发布的站点 —— 他随手丢进去的草稿会立刻出现在公开列表上，
   *   而站长以为自己只是发布了一个工作区。
   *
   *   这条只能由**超级管理员**来触发：子管理员的目标落在别人的授权根上时，
   *   会先被「授权范围」那条拦下（403），根本走不到这里。
   */
  test('★ 授权父目录本身不能被发布（子管理员的工作区）', async () => {
    const admin = (await login('admin', ADMIN_PW)) ?? '';
    const before = (await readConfig())['directories'] as unknown[];

    const response = await postAdmin(
      '/admin/directories/create',
      // bobDir 是 bob 被勾选的授权根
      { name: 'BobRoot', parent: contentRoot, folder: 'Bob', enabled: '1' },
      admin,
    );
    assert.equal(response.status, 400, '工作区本身不能发布');

    const after = (await readConfig())['directories'] as unknown[];
    assert.equal(after.length, before.length, '被拒之后不该有任何落盘');
  });

  /**
   * ★ 老数据可以停用、可以删，但**不许重新启用**。
   *
   *   只按「路径有没有改动」来判的话，「容器不能发布」这条对历史记录就是空的：
   *   点一下启用照样发布出去。所以判据是「这次保存之后它会不会是启用状态」。
   */
  test('★ 已经存在的「容器」记录：允许停用，不允许启用', async () => {
    const config = await readConfig();
    (config['directories'] as unknown[]).push({
      id: 'legacy-container',
      name: 'LegacyWorkspace',
      path: aliceDir, // alice 的工作区
      label: '',
      enabled: false,
      access: 'inherit',
      password: null,
      allowedCidrs: [],
      followSymlinks: false,
      sort: '',
      order: '',
      hideDotfiles: null,
      note: '',
      owner: ALICE_ID,
    });
    await writeConfig(config);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const admin = (await login('admin', ADMIN_PW)) ?? '';
    const target = { id: 'legacy-container', name: 'LegacyWorkspace', parent: contentRoot, folder: 'Alice', access: 'inherit' };

    // 停着的时候可以保存（改标题之类）
    const off = await postAdmin('/admin/directories/update', target, admin);
    assert.equal(off.status, 302, '停用状态下应当可以保存');

    // 勾上启用 → 拒
    const on = await postAdmin(
      '/admin/directories/update',
      { ...target, enabled: '1' },
      admin,
    );
    assert.equal(on.status, 400, '不许把容器重新启用');

    const after = await readConfig();
    const record = (after['directories'] as { id: string; enabled: boolean }[]).find(
      (d) => d.id === 'legacy-container',
    );
    assert.equal(record?.enabled, false, '被拒之后它必须还是停用的');

    // 收拾
    await postAdmin('/admin/directories/delete', { id: 'legacy-container' }, admin);
  });

  /**
   * 「目标正好是池子根」这条分支在集成测试里**够不着**：池子只有 contentRoot 一项，
   * 而要从表单拼出 contentRoot 这个路径，父目录必须填 workDir —— 那已经不在池子里，
   * 会先被池子那条拦下。所以规则本身在 test/adminPolicy.test.ts 里用纯函数测，
   * 那边可以随便造配置。
   */
  test('★ 扫描导入不会把授权父目录当候选', async () => {
    const admin = (await login('admin', ADMIN_PW)) ?? '';
    // 造一个普通文件夹做对照。Alice 和 Bob 都是子管理员的工作区，
    // 得有个「不该被波及」的东西才说明这条规则不是把整个列表清空。
    const plain = path.join(contentRoot, 'Plain');
    await mkdir(plain, { recursive: true });

    // 候选列表直接来自目录浏览器接口，所以这里查的就是它
    const response = await get(
      `/admin/directories/picker?path=${encodeURIComponent(contentRoot)}`,
      admin,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { directories: { name: string }[] };
    const names = body.directories.map((d) => d.name);

    assert.ok(!names.includes('Bob'), 'Bob 是子管理员的授权根，不该出现在「挑一个来发布」的候选里');
    assert.ok(!names.includes('Alice'), 'Alice 同上');
    assert.ok(names.includes('Plain'), '普通文件夹照常列出 —— 这条规则不是把整个浏览器清空');

    await rm(plain, { recursive: true, force: true });
  });

  test('★ 目录浏览器越界 → 403 JSON（不是 HTML 错误页）', async () => {
    const response = await get(`/admin/directories/picker?path=${encodeURIComponent(bobDir)}`, alice);
    assert.equal(response.status, 403);
    assert.match(response.headers.get('content-type') ?? '', /json/);
  });

  test('目录浏览器在自己范围内可用', async () => {
    const response = await get(`/admin/directories/picker?path=${encodeURIComponent(aliceDir)}`, alice);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { path: string }).path, aliceDir);
  });
});

describe('权限改动实时生效', () => {
  let admin = '';
  let alice = '';

  before(async () => {
    admin = (await login('admin', ADMIN_PW)) ?? '';
    alice = (await login('alice', ALICE_PW)) ?? '';
    assert.notEqual(admin, '');
  });

  test('★ 没有 dirs.delete 时删除请求 404，目录还在', async () => {
    const response = await postAdmin('/admin/directories/delete', { id: aliceDirId }, alice);
    assert.equal(response.status, 404);

    const config = await readConfig();
    assert.ok((config['directories'] as { id: string }[]).some((d) => d.id === aliceDirId));
  });

  test('★ 超级管理员勾上 dirs.delete 之后，同一张 cookie 立刻能删', async () => {
    const response = await postAdmin(
      '/admin/users/update',
      {
        id: ALICE_ID,
        username: 'alice',
        enabled: '1',
        note: '',
        roots: aliceDir,
        // 逐项勾选：原来的 + 新加的。没勾的键不在表单里，就是「没有」
        ...Object.fromEntries([...ALICE_PERMS, 'dirs.delete'].map((p) => [`perm_${p}`, '1'])),
      },
      admin,
    );
    assert.equal(response.status, 302, '保存账号应当成功');

    // ★ 不重新登录，用同一张 alice 票据
    const deleted = await postAdmin('/admin/directories/delete', { id: aliceDirId }, alice);
    assert.equal(deleted.status, 302, '权限勾上后应当立刻生效，不需要重新登录');

    const config = await readConfig();
    assert.ok(!(config['directories'] as { id: string }[]).some((d) => d.id === aliceDirId));
  });

  test('★ 账号被删之后，那一张票据立刻就失效', async () => {
    // 先把目录还回去，免得后面的用例没有内容可看
    const restored = await postAdmin(
      '/admin/directories/create',
      { name: 'Alice', parent: aliceDir, folder: 'Docs', enabled: '1', owner: ALICE_ID },
      admin,
    );
    assert.equal(restored.status, 302, '把 Alice 目录建回去应当成功');

    const removed = await postAdmin('/admin/users/delete', { id: BOB_ID }, admin);
    assert.equal(removed.status, 302);

    const bobCookie = await login('bob', BOB_PW);
    assert.equal(bobCookie, null, '被删的账号不能再登录');
  });

  test('★ 已登录的票据在账号被删后失效（无状态票据下唯一的即时撤销手段）', async () => {
    // 重新建一个子管理员，登录，然后删掉他，再用旧 cookie 访问
    await postAdmin(
      '/admin/users/create',
      // 复选框名字是 `perm_` + 权限键本身，而权限键里带点（dirs.view）
      { username: 'temp-user', password: 'temp-password-1', enabled: '1', 'perm_dirs.view': '1' },
      admin,
    );
    const temp = (await login('temp-user', 'temp-password-1')) ?? '';
    assert.equal((await get('/admin/directories', temp)).status, 200);

    const config = await readConfig();
    const created = (config['access'] as { admins: { id: string; username: string }[] }).admins.find(
      (a) => a.username === 'temp-user',
    );
    assert.ok(created !== undefined);
    await postAdmin('/admin/users/delete', { id: created.id }, admin);

    const after = await get('/admin/directories', temp);
    assert.equal(after.status, 302, '账号没了就应当被踢回登录页');
    assert.match(after.headers.get('location') ?? '', /\/login$/);
  });
});

describe('管理员管理页', () => {
  let admin = '';

  before(async () => {
    admin = (await login('admin', ADMIN_PW)) ?? '';
  });

  test('列出了超级管理员与全部子管理员', async () => {
    const html = await (await get('/admin/users', admin)).text();
    assert.match(html, /admin/);
    assert.match(html, /alice/);
  });

  test('★ 用户名重复被拒绝（大小写不敏感）', async () => {
    const response = await postAdmin(
      '/admin/users/create',
      { username: 'ALICE', password: 'some-password-1', enabled: '1' },
      admin,
    );
    assert.equal(response.status, 400);
  });

  test('★ 自定义 CSS 那种提权路径不存在：子管理员建不了账号', async () => {
    const alice = (await login('alice', ALICE_PW)) ?? '';
    const response = await postAdmin(
      '/admin/users/create',
      { username: 'backdoor', password: 'some-password-1', enabled: '1' },
      alice,
    );
    assert.equal(response.status, 404);
  });

  test('★ 超级管理员这一行不能删', async () => {
    const response = await postAdmin('/admin/users/delete', { id: '' }, admin);
    assert.equal(response.status, 302, '应当被拒绝后重定向回去，而不是 500');

    const config = await readConfig();
    const admins = (config['access'] as { admins: { role: string }[] }).admins;
    assert.ok(admins.some((a) => a.role === 'super'), '超级管理员必须还在');
  });

  test('★ 超出 scanRoots 的授权目录被拒绝，且不会静默保存', async () => {
    const response = await postAdmin(
      '/admin/users/create',
      {
        username: 'rootescape',
        password: 'some-password-1',
        enabled: '1',
        roots: path.join(workDir, 'not-a-scan-root'),
      },
      admin,
    );
    assert.equal(response.status, 400);

    const config = await readConfig();
    const admins = (config['access'] as { admins: { username: string }[] }).admins;
    assert.ok(!admins.some((a) => a.username === 'rootescape'));
  });
});

/**
 * 授权即承诺：把某个父目录授权给子管理员、或者把它加进父目录池，
 * 都等于承诺「这里能用」。磁盘上没有就当场建出来。
 *
 * 这一组用例会真的在磁盘上建文件夹、也会改父目录池，所以结束后要把两样都收拾干净 ——
 * 池子被改窄会让后面 alice 的授权根变成「不在池子里」而被拒。
 */
describe('授权父目录时自动建目录', () => {
  let admin = '';
  /** 这一组往池子里加过的路径，结束时按这个列表原样改回去 */
  let originalPool: string[] = [];

  const NEW_ROOT = (name: string): string => path.join(contentRoot, name);

  before(async () => {
    admin = (await login('admin', ADMIN_PW)) ?? '';
    const config = await readConfig();
    originalPool = (config['system'] as { parentRoots: string[] }).parentRoots;
  });

  after(async () => {
    // 账号：把这一组建的两个删掉
    const config = await readConfig();
    const created = (config['access'] as { admins: { id: string; username: string }[] }).admins.filter(
      (a) => a.username.startsWith('mkdirtest'),
    );
    for (const account of created) {
      await postAdmin('/admin/users/delete', { id: account.id }, admin);
    }
    // 池子：改回原样
    await postAdmin('/admin/system/parentroots', { parentRoots: originalPool.join('\n') }, admin);
    // 磁盘：删掉这一组建出来的文件夹
    for (const name of ['newbie', 'newbie-two']) {
      await rm(path.join(contentRoot, name), { recursive: true, force: true });
    }
  });

  test('★ 给子管理员授权一个还不存在的父目录 → 磁盘上真的建出来，账号保存成功', async () => {
    const root = NEW_ROOT('newbie');
    assert.equal(await exists(root), false, '前提：这个文件夹一开始不该存在');

    const response = await postAdmin(
      '/admin/users/create',
      {
        username: 'mkdirtest-one',
        password: 'some-password-1',
        enabled: '1',
        roots: root,
        'perm_dirs.view': '1',
      },
      admin,
    );
    assert.equal(response.status, 302, '授权时应当顺手把目录建出来，而不是拒绝保存');
    assert.equal(await exists(root), true, '授权之后磁盘上必须真的有这个文件夹');

    const config = await readConfig();
    const record = (config['access'] as { admins: { username: string; roots: string[] }[] }).admins.find(
      (a) => a.username === 'mkdirtest-one',
    );
    assert.deepEqual(record?.roots, [root]);
  });

  test('★ 上级目录不存在 → 拦住保存，配置和磁盘都不动', async () => {
    const root = NEW_ROOT(path.join('ghost-parent', 'child'));
    const before = (await readConfig())['access'] as { admins: unknown[] };
    const beforeCount = before.admins.length;

    const response = await postAdmin(
      '/admin/users/create',
      {
        username: 'mkdirtest-two',
        password: 'some-password-1',
        enabled: '1',
        roots: root,
        'perm_dirs.view': '1',
      },
      admin,
    );
    assert.equal(response.status, 400, '建不出来就不该留下一条「配置里有、磁盘上没有」的记录');

    // 提示语要说清是**哪一级**不存在、下一步做什么。
    // 只回一个系统错误串（ENOENT: no such file or directory, mkdir ...）等于没说。
    const banner = (await response.text()).match(/class="banner err">([^<]*)</)?.[1] ?? '';
    assert.match(banner, /ghost-parent/, '提示里要带上出问题的那个路径');
    assert.match(banner, /上一级/, '提示里要指出去建上一级，而不是丢一个 errno');

    const after = (await readConfig())['access'] as { admins: { username: string }[] };
    assert.equal(after.admins.length, beforeCount, '账号不该被建出来');
    assert.ok(!after.admins.some((a) => a.username === 'mkdirtest-two'));
    // 非递归：中间那一层也不许被悄悄造出来
    assert.equal(await exists(path.join(contentRoot, 'ghost-parent')), false);
  });

  test('★ 往父目录池里加一个不存在的路径 → 同样建出来', async () => {
    const root = NEW_ROOT('newbie-two');
    assert.equal(await exists(root), false);

    const response = await postAdmin(
      '/admin/system/parentroots',
      { parentRoots: [...originalPool, root].join('\n') },
      admin,
    );
    assert.equal(response.status, 302);
    assert.equal(await exists(root), true, '池子里的位置也要真的存在');

    const config = await readConfig();
    assert.ok(
      (config['system'] as { parentRoots: string[] }).parentRoots.includes(root),
      '新路径应当进池子',
    );
  });

  test('★ 池子里的相对路径被拒绝（否则会按服务器的工作目录去建文件夹）', async () => {
    // 基线取「此刻」的池子，不是最初的 —— 上一条用例刚往里加过一项
    const before = (await readConfig())['system'] as { parentRoots: string[] };

    const response = await postAdmin(
      '/admin/system/parentroots',
      { parentRoots: [...before.parentRoots, 'not-an-absolute-path'].join('\n') },
      admin,
    );
    assert.equal(response.status, 400);

    const after = (await readConfig())['system'] as { parentRoots: string[] };
    assert.deepEqual(after.parentRoots, before.parentRoots, '被拒绝的池子不该落盘');
  });
});

/**
 * 「删除目录及其内容」是全站唯一一个不可撤销的操作，闸门必须逐条验。
 *
 * 这一组会真的删磁盘上的文件夹，所以每条用例自己造、自己收。
 */
describe('删除目录内容', () => {
  let admin = '';
  let alice = '';
  /** 待删目录的固定名字，方便断言「还在 / 没了」 */
  const TARGET_NAME = 'PurgeMe';
  const targetDir = (): string => path.join(contentRoot, TARGET_NAME);

  before(async () => {
    admin = (await login('admin', ADMIN_PW)) ?? '';
    alice = (await login('alice', ALICE_PW)) ?? '';
  });

  /** 造一个真的带文件的目录并发布，返回它的 id */
  const makePurgeable = async (): Promise<string> => {
    await mkdir(targetDir(), { recursive: true });
    await writeFile(path.join(targetDir(), 'inside.txt'), 'data\n', 'utf8');
    const created = await postAdmin(
      '/admin/directories/create',
      { name: TARGET_NAME, parent: contentRoot, folder: TARGET_NAME, enabled: '1' },
      admin,
    );
    assert.equal(created.status, 302, '夹具目录应当创建成功');
    const config = await readConfig();
    const id = (config['directories'] as { id: string; name: string }[]).find(
      (d) => d.name === TARGET_NAME,
    )?.id;
    assert.ok(id !== undefined);
    return id;
  };

  /** 把「取消发布」也做掉，别给后面的用例留垃圾 */
  const cleanUp = async (id: string): Promise<void> => {
    await postAdmin('/admin/directories/delete', { id }, admin);
    await rm(targetDir(), { recursive: true, force: true });
  };

  test('★ 子管理员碰不到这个接口（写死超管，不是可勾选的权限）', async () => {
    const id = await makePurgeable();
    const response = await postAdmin(
      '/admin/directories/purge',
      { id, confirm: TARGET_NAME },
      alice,
    );
    assert.equal(response.status, 404, '子管理员一律当作这个接口不存在');
    assert.equal(await exists(path.join(targetDir(), 'inside.txt')), true, '一个文件都不该少');
    await cleanUp(id);
  });

  test('★ 目录名打错 → 400，磁盘上原样不动', async () => {
    const id = await makePurgeable();
    const response = await postAdmin(
      '/admin/directories/purge',
      { id, confirm: 'purgeme' }, // 大小写不对也算不对
      admin,
    );
    assert.equal(response.status, 400);
    assert.equal(await exists(path.join(targetDir(), 'inside.txt')), true);
    const config = await readConfig();
    assert.ok(
      (config['directories'] as { id: string }[]).some((d) => d.id === id),
      '被拒之后配置条目也还在',
    );
    await cleanUp(id);
  });

  test('★ 名字打对 → 文件夹连同内容一起消失，配置条目也没了', async () => {
    const id = await makePurgeable();
    const response = await postAdmin(
      '/admin/directories/purge',
      { id, confirm: TARGET_NAME },
      admin,
    );
    assert.equal(response.status, 302);
    assert.equal(await exists(targetDir()), false, '整个文件夹应当被删掉');
    assert.equal(
      ((await readConfig())['directories'] as { id: string }[]).some((d) => d.id === id),
      false,
      '配置条目也要一起清掉，不能留下一条指向不存在路径的幽灵记录',
    );
  });

  /**
   * ★ 目标是「授权父目录」时必须拒绝。
   *
   * 这条在 API 上造不出来（新建就会被 isAuthorizedParent 拒掉），
   * 所以直接改配置文件 —— 模拟的正是「历史遗留数据」和「有人手工编辑过配置」。
   */
  test('★ 目标是授权父目录 → 拒绝，里面别人的东西一个都不能少', async () => {
    const config = await readConfig();
    const dirs = config['directories'] as unknown[];
    dirs.push({
      id: 'purge-guard-test',
      name: 'AliceWorkspace',
      path: aliceDir, // alice 的授权根
      label: '',
      enabled: true,
      access: 'inherit',
      password: null,
      allowedCidrs: [],
      followSymlinks: false,
      sort: '',
      order: '',
      hideDotfiles: null,
      note: '',
      owner: ALICE_ID,
    });
    await writeConfig(config);
    // 配置监听是**目录级**的（见 store.ts），改动会被自动重载；给它一点时间
    await new Promise((resolve) => setTimeout(resolve, 600));

    const response = await postAdmin(
      '/admin/directories/purge',
      { id: 'purge-guard-test', confirm: 'AliceWorkspace' },
      admin,
    );
    assert.equal(response.status, 400, '删授权父目录等于把里面所有人的东西一起删');
    assert.equal(await exists(path.join(aliceSite, 'alice-file.txt')), true, 'alice 的文件必须还在');

    // 复原
    const after = await readConfig();
    after['directories'] = (after['directories'] as { id: string }[]).filter(
      (d) => d.id !== 'purge-guard-test',
    );
    await writeConfig(after);
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
});

describe('回归：权限与浏览范围的五个坑', () => {
  let admin = '';
  let alice = '';
  /** alice 名下的目录 id。前面的用例删过又建过，id 变了，所以每次现查 */
  let currentId = '';

  /** 给 alice 重设权限（逐项勾选：没勾的键不在表单里 = 没有） */
  const grantAlice = async (
    permissions: readonly string[],
    roots: string = aliceDir,
  ): Promise<void> => {
    const response = await postAdmin(
      '/admin/users/update',
      {
        id: ALICE_ID,
        username: 'alice',
        enabled: '1',
        note: '',
        roots,
        ...Object.fromEntries(permissions.map((p) => [`perm_${p}`, '1'])),
      },
      admin,
    );
    assert.equal(response.status, 302, '保存账号应当成功');
  };

  const reloadId = async (): Promise<void> => {
    const config = await readConfig();
    const dir = (config['directories'] as { id: string; owner: string }[]).find((d) => d.owner === ALICE_ID);
    assert.ok(dir !== undefined, 'alice 应当有一个名下的目录');
    currentId = dir.id;
  };

  before(async () => {
    admin = (await login('admin', ADMIN_PW)) ?? '';
    alice = (await login('alice', ALICE_PW)) ?? '';
    assert.notEqual(admin, '');
    await reloadId();
  });

  test('★ 只勾 dirs.delete 时 dirs.view 会被自动补上，否则删完跳回的页面是 404', async () => {
    await grantAlice(['dirs.delete']);

    const config = await readConfig();
    const record = (
      config['access'] as { admins: { id: string; permissions: string[] }[] }
    ).admins.find((a) => a.id === ALICE_ID);
    assert.ok(record !== undefined);
    assert.ok(
      record.permissions.includes('dirs.view'),
      `dirs.delete 应当带上 dirs.view，实际是 ${JSON.stringify(record.permissions)}`,
    );

    // ★ 关键不是配置里有没有这一项，而是**那条被放行的路径本身走得通**：
    //   删除成功后会 302 回 /admin/directories，那个页面打不开，
    //   用户看到的就是「点了删除，然后一个 404」。
    const page = await get('/admin/directories', alice);
    assert.equal(page.status, 200, '补上 dirs.view 之后目录页必须能打开');

    const deleted = await postAdmin('/admin/directories/delete', { id: currentId }, alice);
    assert.equal(deleted.status, 302, '删除本身应当成功');
    const target = await get(deleted.headers.get('location') ?? '/', alice);
    assert.equal(target.status, 200, '删除后跳回的页面也必须能打开');
  });

  test('★ 目录浏览器从「自己的」授权根开始，不是从超级管理员的扫描根开始', async () => {
    await grantAlice(['dirs.view', 'dirs.browse']);

    const own = await get('/admin/directories/picker?path=', alice);
    assert.equal(own.status, 200);
    const body = (await own.json()) as { path: string };
    assert.equal(body.path, aliceDir, '空路径应当落在自己的授权根上');

    // 也不能只是「能浏览」就算了：超级管理员的扫描根必须仍然挡住，
    // 否则子管理员会看到别人文件夹的名字
    const outside = await get(`/admin/directories/picker?path=${encodeURIComponent(contentRoot)}`, alice);
    assert.equal(outside.status, 403, '不能浏览超级管理员的扫描根');
  });

  /**
   * ★ 端到端的越权路径，值得单独跑一遍完整链路：
   *   授权父目录覆盖到别人的目录 → 新建目录指过去 → 那个新目录归自己 →
   *   归属检查与内容面全都放行 → 读到别人的文件。
   *
   * 纯函数层面的规则由 test/adminPolicy.test.ts 覆盖；这里证明的是
   * 「策略层真的接进了请求路径」，以及被放行的那条路本身走得通。
   */
  test('★ 不能新建目录指向别人名下的目录（授权根覆盖到也不行）', async () => {
    // 把 alice 的授权父目录放宽到整个内容根 —— 线上就是这么配的
    await grantAlice(['dirs.view', 'dirs.create'], contentRoot);

    const config = await readConfig();
    const bobEntry = (config['directories'] as { name: string; path: string; owner: string }[]).find(
      (d) => d.name === 'Bob',
    );
    assert.ok(bobEntry !== undefined, '夹具里应当还有 Bob 那个目录');

    // 目标就是 Bob 那个**内容目录**本身（工作区下面那一层）。
    // 注意不能拿工作区那一层当靶子：Bob 的账号在前面已经被删掉了，
    // 而「别人的地盘」这条规则看的是目录的归属，不是账号还在不在。
    const escaped = await postAdmin(
      '/admin/directories/create',
      { name: 'Peek', parent: bobDir, folder: 'Docs', enabled: '1' },
      alice,
    );
    assert.equal(escaped.status, 403, '把新目录指向别人的目录必须被拒');

    const after = await readConfig();
    assert.ok(
      !(after['directories'] as { name: string }[]).some((d) => d.name === 'Peek'),
      '被拒之后不该有任何落盘',
    );

    // ★ 反向确认：这条规则不是「把建目录整个封死」。
    //   同一个根下换一个没被占用、也不在别人目录里的位置，必须放行。
    const ok = await postAdmin(
      '/admin/directories/create',
      { name: 'Fresh', parent: contentRoot, folder: 'Fresh', enabled: '1' },
      alice,
    );
    assert.equal(ok.status, 302, '同一个授权根内的空闲位置应当可以建');
  });

  test('★ 概览页不再报「尚未设置管理员密码」', async () => {
    // 迁移之后 access.adminPassword 恒为 null，拿它当判据的话这条横幅永远在
    const html = await (await get('/admin/', admin)).text();
    assert.doesNotMatch(html, /尚未设置管理员密码/);
    assert.doesNotMatch(html, /No admin password set yet/);
  });

  test('★ 自己名下被停用的目录仍然看得见（否则永远没法重新启用）', async () => {
    await grantAlice(['dirs.view']);
    await reloadId();

    const off = await postAdmin(
      '/admin/directories/update',
      { id: currentId, name: 'Alice', parent: aliceDir, folder: 'Docs', access: 'inherit' }, // enabled 不勾 = 停用
      admin,
    );
    assert.equal(off.status, 302);

    const config = await readConfig();
    const dir = (config['directories'] as { id: string; enabled: boolean }[]).find((d) => d.id === currentId);
    assert.equal(dir?.enabled, false, '目录应当已被停用');

    const html = await (await get('/admin/directories', alice)).text();
    assert.match(html, /Alice/, '停用的自有目录不该从子管理员的列表里消失');
  });

  test('★ 目录不再是密码模式时，旧哈希会被清掉（列表上不该留一把无效的锁）', async () => {
    await grantAlice(['dirs.view', 'dirs.update']);
    await reloadId();

    const on = await postAdmin(
      '/admin/directories/update',
      {
        id: currentId,
        name: 'Alice',
        parent: aliceDir,
        folder: 'Docs',
        enabled: '1',
        access: 'password',
        password: 'directory-password-1',
      },
      admin,
    );
    assert.equal(on.status, 302);

    type Row = { id: string; access: string; password: unknown };
    let config = await readConfig();
    let dir = (config['directories'] as Row[]).find((d) => d.id === currentId);
    assert.equal(dir?.access, 'password');
    assert.notEqual(dir?.password, null, '密码模式下应当有哈希');

    const back = await postAdmin(
      '/admin/directories/update',
      { id: currentId, name: 'Alice', parent: aliceDir, folder: 'Docs', enabled: '1', access: 'inherit' },
      admin,
    );
    assert.equal(back.status, 302);

    config = await readConfig();
    dir = (config['directories'] as Row[]).find((d) => d.id === currentId);
    assert.equal(dir?.access, 'inherit');
    assert.equal(dir?.password, null, '不再是密码模式时旧哈希必须清掉，否则切回去会让旧密码复活');

    // 顺带钉住界面那一侧。用「按 <tr> 切段再找名字」而不是一条大正则：
    // 目录名外面可能包着编辑链接，行的结构会随权限变。
    const html = await (await get('/admin/directories', admin)).text();
    const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    const rows = tbody.split('<tr>');
    const rowOf = (name: string): string => rows.find((r) => r.includes(`>${name}<`)) ?? '';

    const aliceRow = rowOf('Alice');
    assert.notEqual(aliceRow, '', '应当能找到 Alice 那一行');
    assert.doesNotMatch(aliceRow, /🔒/, '不再是密码模式就不该显示锁');

    // 反向确认这条断言不是「永远通过」：Bob 那个目录确实还是密码模式，
    // 它的行上必须仍然有锁。
    const bobRow = rowOf('Bob');
    assert.notEqual(bobRow, '', '应当能找到 Bob 那一行');
    assert.match(bobRow, /🔒/, '密码模式下的目录必须显示锁（否则上面那条断言等于没测）');
  });
});

describe('会话令牌版本', () => {
  test('★ 升级前的 v1 票据被拒绝，而不是被当成超级管理员', async () => {
    // 手工造一张 v1 票据：内容与旧版本完全一致（没有 `a` 字段），签名也是真的
    const payload = { k: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const legacy = `v1.${body}.${signature}`;

    const response = await get('/admin/directories', `qrfolder_session=${legacy}`);
    assert.equal(response.status, 302, '旧票据不该被接受');
    assert.match(response.headers.get('location') ?? '', /\/login$/);
  });

  test('★ v2 的超级管理员票据照常可用（证明上面拦的是版本号，不是「什么都拦」）', async () => {
    const payload = { k: 'admin', a: '', exp: Math.floor(Date.now() / 1000) + 3600 };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');

    const response = await get('/admin/directories', `qrfolder_session=v2.${body}.${signature}`);
    assert.equal(response.status, 200);
  });
});
