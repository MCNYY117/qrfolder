/**
 * 后台路由策略表与账号范围的单测。
 *
 * 这个文件不起服务器 —— 授权逻辑全是纯函数，就该能在毫秒级测完边界情况。
 * 起服务的集成测试在 test/adminScope.test.ts。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ADMIN_ROUTES,
  resolveRoute,
  isAllowed,
  checkScope,
  joinTarget,
  type RoutePolicy,
} from '../src/admin/policy.ts';
import {
  accountById,
  accountByUsername,
  canSeeDirectory,
  directoryIdOfLogPath,
  hasPermission,
  isAuthorizedParent,
  isPathAuthorized,
  superAccount,
  viewerOf,
  visibleDirectories,
} from '../src/admin/accounts.ts';
import type { AdminAccount, AdminPermission, Config, DirectoryConfig } from '../src/config/schema.ts';

// ---------------------------------------------------------------- 夹具

/**
 * 夹具用的绝对路径根，**按平台取**。
 *
 * ★ 不能把 `C:\Sites` 写死。在 Linux 上反斜杠不是路径分隔符，`C:\Sites\alice`
 *   会被当成一个完整的**文件名**，于是 `path.relative('C:\Sites', 'C:\Sites\alice')`
 *   得到 `../C:\Sites\alice` —— 包含性判断整个反过来，一整套授权用例全部失败。
 *   而在 Windows 上开发时完全看不出来，只有 CI 跑 Linux 才会暴露。
 */
const IS_WINDOWS = process.platform === 'win32';
/** 共享根：夹具里凡「自己的地盘」都挂在它下面 */
const SITES = IS_WINDOWS ? 'C:\\Sites' : '/sites';
/** 池子外面的一块地方，用来验证越界会被拒 */
const OUTSIDE = IS_WINDOWS ? 'C:\\Elsewhere' : '/elsewhere';
/** 一处与内容目录无关的系统位置 */
const SYSTEM_DIR = IS_WINDOWS ? 'C:\\Windows' : '/etc';
/** 盘符根（POSIX 上就是 `/`），用来验证根目录本身不能被授权 */
const DRIVE_ROOT = IS_WINDOWS ? 'D:\\' : '/';

/** 在共享根下拼一个路径。必须走 path.join —— 字符串拼接会在另一平台上用错分隔符 */
function sites(...parts: string[]): string {
  return path.join(SITES, ...parts);
}

/** 带尾随分隔符的共享根：`C:\Sites\` 与 `/sites/` 指的是同一个目录 */
const SITES_TRAILING = SITES + path.sep;

function account(overrides: Partial<AdminAccount> & { username: string }): AdminAccount {
  return {
    id: overrides.username,
    role: 'sub',
    password: { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 64, salt: 's', hash: 'h' },
    permissions: [],
    roots: [],
    enabled: true,
    note: '',
    ...overrides,
  };
}

function dir(name: string, owner: string, extra: Partial<DirectoryConfig> = {}): DirectoryConfig {
  return {
    id: `id-${name}`,
    name,
    path: sites(name),
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
    owner,
    ...extra,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    system: { scanRoots: [SITES] },
    appearance: {},
    access: { admins: [] },
    directories: [],
    ...overrides,
  } as unknown as Config;
}

// ---------------------------------------------------------------- 策略表

describe('后台路由策略表', () => {
  /**
   * ★ 这张表的整个意义就是「没在表里的路由走不到」。但如果有人新加了一条
   *   路由、忘了加表项，代码不会报错 —— 那条路由只是**静默地 404**，
   *   于是在开发时看着像「写错了路径」，很容易被人顺手把策略层注释掉。
   *
   *   所以这里直接扫源码：把 dispatch 里出现的每个 `sub === '...'` 字面量
   *   揪出来，逐个确认它在表里有对应条目。漏一个就当场失败。
   */
  test('★ dispatch 里出现的每一条路由，策略表里都必须有对应条目', () => {
    const source = readFileSync(new URL('../src/admin/routes.ts', import.meta.url), 'utf8');

    const literals = new Set<string>();
    for (const match of source.matchAll(/sub\s*===\s*'([^']*)'/g)) {
      if (match[1] !== undefined) literals.add(match[1]);
    }

    // 前缀派发（sub.startsWith(...)）不是具体路由，它们底下那些 `sub === '...'`
    // 才是。列在这里是为了让「扫到了但表里没有」的名单保持为空。
    const PREFIX_DISPATCHERS = new Set(['/directories/', '/access/', '/system/']);

    const policyPaths = new Set(ADMIN_ROUTES.map((policy) => policy.path));
    const missing = [...literals].filter(
      (literal) => literal !== '/' && !PREFIX_DISPATCHERS.has(literal) && !policyPaths.has(literal),
    );

    assert.deepEqual(missing, [], `这些路由没有策略条目，它们会静默 404：\n  ${missing.join('\n  ')}`);

    // ★ 防止这条测试退化成「永远通过」：哪天有人把字面量改成常量表，
    //   抽不到东西，上面那条断言就会在空数组上空转。
    assert.ok(
      literals.size >= 20,
      `只从 routes.ts 抽到 ${literals.size} 个路由字面量，这条测试可能已经失效了`,
    );
  });

  /**
   * ★ 这曾经是一个真实的洞：`/system/export` 没有任何方法检查，
   *   一个 POST 就能拿到整份配置 —— 里面含所有密码哈希和 sessionSecret，
   *   拿到密钥就能伪造超级管理员会话。
   */
  test('★ 没声明的方法一律匹配不到（POST /system/export 曾经能拿到整份配置）', () => {
    assert.equal(resolveRoute('/system/export', 'POST'), null);
    assert.notEqual(resolveRoute('/system/export', 'GET'), null);

    // 这些路径只读，任何 POST 都不该匹配到
    for (const path of ['/directories', '/access', '/system', '/logs', '/domain', '/users']) {
      assert.equal(resolveRoute(path, 'POST'), null, `${path} 不该接受 POST`);
    }
    assert.equal(resolveRoute('/directories/qr', 'POST'), null);
    // /appearance 是例外：它有独立的写权限（appearance.edit），所以要单独确认
    assert.notEqual(resolveRoute('/appearance', 'POST'), null);
  });

  test('未知路径匹配不到（调用方据此 404）', () => {
    assert.equal(resolveRoute('/nope', 'GET'), null);
    assert.equal(resolveRoute('/directories/nope', 'POST'), null);
    assert.equal(resolveRoute('/users/../system/export', 'GET'), null, '不做路径规整，一律精确匹配');
  });

  test('策略 id 唯一', () => {
    const ids = ADMIN_ROUTES.map((policy) => policy.id);
    assert.equal(new Set(ids).size, ids.length, `重复的 id：${ids.join(', ')}`);
  });

  test('★ 每个 POST 都必须声明 CSRF 方式，且 none 只能出现在 public / firstRun', () => {
    for (const policy of ADMIN_ROUTES) {
      if (!policy.methods.includes('POST')) continue;
      assert.ok(policy.csrf !== undefined, `${policy.id} 是 POST 但没声明 csrf`);
      if (policy.csrf === 'none') {
        assert.ok(
          policy.access === 'public' || policy.access === 'firstRun',
          `${policy.id} 是 ${String(policy.access)} 却免 CSRF —— 这是个状态变更接口`,
        );
      }
    }
  });

  test('超级管理员专属路由不会出现在可授予权限里', () => {
    // 反过来说：任何一条 super 路由都不该同时带权限数组
    for (const policy of ADMIN_ROUTES) {
      if (typeof policy.access === 'string') continue;
      for (const permission of policy.access) {
        assert.ok(
          !['/system/export', '/system/import', '/access', '/rotate-secret'].includes(policy.path),
          `${policy.path} 不该是可授予权限`,
        );
        assert.ok(permission.length > 0, `${policy.id} 的权限列表里有空串`);
      }
    }
  });

  test('每一类访问等级都真的被用到了（防止写错关键字导致整条策略形同虚设）', () => {
    const accesses = new Set(ADMIN_ROUTES.map((policy) => JSON.stringify(policy.access)));
    for (const expected of ['"public"', '"firstRun"', '"session"', '"super"']) {
      assert.ok(accesses.has(expected), `没有任何路由使用 ${expected}`);
    }
  });
});

// ---------------------------------------------------------------- 权限判定

describe('权限判定', () => {
  const superViewer = viewerOf(config(), account({ username: 'root', role: 'super' }));
  const alice = account({ username: 'alice', permissions: ['files.view'] });
  const aliceViewer = viewerOf(config(), alice);

  test('超级管理员隐含全部权限', () => {
    for (const policy of ADMIN_ROUTES) {
      assert.equal(isAllowed(policy, superViewer), true, `${policy.id} 应当对超级管理员放行`);
    }
  });

  test('子管理员只拿到被勾选的权限', () => {
    assert.equal(hasPermission(aliceViewer, 'files.view'), true);
    assert.equal(hasPermission(aliceViewer, 'files.upload'), false);
    assert.equal(hasPermission(aliceViewer, 'dirs.delete'), false);

    const filesRoute = ADMIN_ROUTES.find((policy) => policy.id === 'files.list');
    assert.ok(filesRoute !== undefined);
    assert.equal(isAllowed(filesRoute, aliceViewer), true);

    const exportRoute = ADMIN_ROUTES.find((policy) => policy.id === 'system.export');
    assert.ok(exportRoute !== undefined);
    assert.equal(isAllowed(exportRoute, aliceViewer), false);
  });

  test('★ 未登录时连 session 级路由都不放行', () => {
    // 这一层不是靠 isAllowed 拦的（它只判断能力），但把语义钉在这里：
    // access 为 public/firstRun 的路由才是真的无需会话
    const publicPaths = ADMIN_ROUTES.filter((policy) => policy.access === 'public').map((p) => p.path);
    assert.deepEqual(publicPaths.sort(), ['/lang', '/login']);
  });
});

// ---------------------------------------------------------------- 范围判定

describe('可见目录', () => {
  const cfg = config({
    access: {
      admins: [
        account({ username: 'root', role: 'super' }),
        account({ username: 'alice' }),
      ],
    },
    directories: [
      dir('AliceDocs', 'alice'),
      dir('BobDocs', 'bob'),
      dir('SharedDocs', ''),
      dir('DisabledOwn', 'alice', { enabled: false }),
    ],
  } as unknown as Partial<Config>);

  const aliceAccount = accountByUsername(cfg, 'alice');
  assert.ok(aliceAccount !== undefined);

  test('子管理员只看得见自己的', () => {
    const names = visibleDirectories(cfg, aliceAccount).map((entry) => entry.name);
    assert.deepEqual(names.sort(), ['AliceDocs', 'DisabledOwn']);
  });

  test('★ 被禁用的自有目录仍然可见（否则永远没法重新启用它）', () => {
    // deps.directories() 只含已启用的目录，用它过滤会造成这个坑
    const names = visibleDirectories(cfg, aliceAccount).map((entry) => entry.name);
    assert.ok(names.includes('DisabledOwn'));
  });

  test('超级管理员看得见全部', () => {
    const root = superAccount(cfg);
    assert.ok(root !== undefined);
    assert.equal(visibleDirectories(cfg, root).length, 4);
  });

  test('★ 归属字段决定一切：owner 为空串的目录归超级管理员，子管理员看不到', () => {
    const shared = dir('SharedDocs', '');
    assert.equal(canSeeDirectory(aliceAccount, shared), false, '空串 = 超级管理员的');
    const root = superAccount(cfg);
    assert.ok(root !== undefined);
    assert.equal(canSeeDirectory(root, shared), true);
  });
});

describe('授权根目录', () => {
  const alice = account({ username: 'alice', roots: [sites('shared', 'alice')] });

  test('落在授权范围内放行', () => {
    assert.equal(isPathAuthorized(alice, sites('shared', 'alice', 'Docs')), true);
    assert.equal(isPathAuthorized(alice, sites('shared', 'alice')), true, '自身也算在内');
  });

  test('★ 越界一律拒绝（否则子管理员能发布服务器上任意目录）', () => {
    assert.equal(isPathAuthorized(alice, sites('shared', 'bob')), false);
    assert.equal(isPathAuthorized(alice, path.join(SYSTEM_DIR, 'System32')), false);
    assert.equal(isPathAuthorized(alice, DRIVE_ROOT), false);
  });

  test('★ 相似前缀不算在内（alice 不能进 alice2）', () => {
    assert.equal(isPathAuthorized(alice, sites('shared', 'alice2', 'Docs')), false);
  });

  test('超级管理员不受根目录限制', () => {
    const root = account({ username: 'root', role: 'super', roots: [] });
    assert.equal(isPathAuthorized(root, SYSTEM_DIR), true);
  });
});

describe('checkScope', () => {
  const alice = account({ username: 'alice', roots: [sites('alice')] });
  const ids = new Set(['dir-alice']);
  /**
   * 授权根是**整个共享根**的账号。
   *
   * 这不是构造出来的极端情况 —— 「根目录 = 整个内容根」是最省事的配法，
   * 线上就是这么配的。Bob 的目录压在这个根里面，于是「在自己授权根之内」
   * 这条检查会放行它，必须再有一条「不能指别人的地盘」。
   */
  const aliceShared = account({ username: 'alice', roots: [SITES] });
  const shared = config({ directories: [dir('Bob', 'bob')] });

  const dirPolicy: RoutePolicy = {
    id: 't.dir',
    methods: ['GET'],
    path: '/t',
    access: ['files.view'],
    scope: [{ kind: 'dir', from: 'query', name: 'dir' }],
  };
  const pathPolicy: RoutePolicy = {
    id: 't.path',
    methods: ['POST'],
    path: '/t',
    access: ['dirs.create'],
    scope: [{ kind: 'path', from: 'body', name: 'path' }],
  };

  const run = (policy: RoutePolicy, url: string, form: Record<string, string> = {}) =>
    checkScope(policy, {
      url: new URL(`http://x${url}`),
      form,
      account: alice,
      directoryIds: ids,
      config: shared,
    });

  test('自己的目录放行，别人的按「不存在」处理', () => {
    assert.deepEqual(run(dirPolicy, '/t?dir=dir-alice'), { ok: true });
    assert.deepEqual(run(dirPolicy, '/t?dir=dir-bob'), { ok: false, reason: 'notFound' });
  });

  test('★ 别人的目录返回 notFound 而不是 outOfRoots —— 「不许」不能反过来确认它存在', () => {
    const verdict = run(dirPolicy, '/t?dir=dir-bob');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false ? verdict.reason : '', 'notFound');
  });

  test('可选的 dir 缺省时放行，但填了别人的仍然拒绝', () => {
    const optional: RoutePolicy = {
      ...dirPolicy,
      scope: [{ kind: 'dir', from: 'query', name: 'dir', optional: true }],
    };
    assert.deepEqual(run(optional, '/t'), { ok: true });
    assert.deepEqual(run(optional, '/t?dir=dir-bob'), { ok: false, reason: 'notFound' });
  });

  test('路径越界返回 outOfRoots（这个可以明说，因为是请求本身不对）', () => {
    assert.deepEqual(run(pathPolicy, '/t', { path: sites('alice', 'Docs') }), { ok: true });
    assert.deepEqual(run(pathPolicy, '/t', { path: OUTSIDE }), {
      ok: false,
      reason: 'outOfRoots',
    });
  });

  test('空路径不算越界（留给表单校验去报「不能为空」）', () => {
    assert.deepEqual(run(pathPolicy, '/t', { path: '' }), { ok: true });
  });

  /**
   * ★ 这一条堵的是一条完整的越权路径：alice 的授权根是 C:\Sites（整个共享根），
   *   Bob 的目录就压在里面。她新建一个目录、路径填 C:\Sites\Bob，于是
   *   新目录归她自己 —— 归属检查放行、内容面的 404 也放行，她就把 Bob 的
   *   文件读出来了。只查「在不在自己的授权根里」是拦不住这条的。
   */
  test('★ 不能把目录指向别人名下的目录（哪怕它在自己的授权根之内）', () => {
    const runShared = (form: Record<string, string>) =>
      checkScope(pathPolicy, {
        url: new URL('http://x/t'),
        form,
        account: aliceShared,
        directoryIds: ids,
        config: shared,
      });

    // 先确认前提成立：这个路径**确实**在自己的授权根里，
    // 否则下面测到的就不是「别人的地盘」那条规则，而是 outOfRoots
    assert.equal(isPathAuthorized(aliceShared, sites('Bob')), true);

    assert.deepEqual(runShared({ path: sites('Bob') }), { ok: false, reason: 'foreignPath' });
    // 别人的目录**里面**也不行
    assert.deepEqual(runShared({ path: sites('Bob', 'inner') }), {
      ok: false,
      reason: 'foreignPath',
    });
    // 自己授权根里没被别人占用的地方照常可以
    assert.deepEqual(runShared({ path: sites('fresh') }), { ok: true });
  });

  test('★ 路径没改动时不做「别人的地盘」检查（否则压在别人目录下就没法改标题）', () => {
    // alice 自己的目录 id-alice，路径恰好也在共享根下（由超级管理员安排）；
    // 只要路径本身没动，改标题、改排序都该放行
    const ownInsideShared = config({
      directories: [dir('Bob', 'bob'), dir('Alice', 'alice', { id: 'dir-alice' })],
    });
    const verdict = checkScope(pathPolicy, {
      url: new URL('http://x/t'),
      form: { id: 'dir-alice', path: sites('Alice') },
      account: alice,
      directoryIds: ids,
      config: ownInsideShared,
    });
    assert.deepEqual(verdict, { ok: true });
  });

  /**
   * ★ 「授权父目录」是放东西的容器，本身不能当内容目录发布。
   *   只比相等、不比包含 —— 池子根下面的子目录照常可以发布，那才是常规用法。
   */
  describe('isAuthorizedParent', () => {
    const withPool = config({
      system: { parentRoots: [SITES] },
      access: { admins: [account({ username: 'alice', roots: [sites('alice')] })] },
    } as Partial<Config>);

    test('池子里的路径算，子管理员被勾选的授权根也算', () => {
      assert.equal(isAuthorizedParent(withPool, SITES), true);
      assert.equal(isAuthorizedParent(withPool, sites('alice')), true);
    });

    test('尾随斜杠、冗余的点段都会被归一化掉', () => {
      assert.equal(isAuthorizedParent(withPool, sites('alice') + path.sep), true);
      assert.equal(isAuthorizedParent(withPool, SITES + path.sep + '.' + path.sep + 'alice'), true);
      assert.equal(isAuthorizedParent(withPool, SITES_TRAILING), true);
    });

    test('★ Windows 上加一层大小写折换，换个写法绕不过去', () => {
      // 别的平台路径大小写敏感，`A` 和 `a` 真是两个目录，折了会误伤 —— 所以只断言 Windows
      if (!IS_WINDOWS) return;
      assert.equal(isAuthorizedParent(withPool, 'c:\\sites\\'), true);
      assert.equal(isAuthorizedParent(withPool, 'C:\\SITES\\ALICE'), true);
    });

    test('★ 只比相等：容器下面的子目录照常可以发布', () => {
      assert.equal(isAuthorizedParent(withPool, sites('docs')), false);
      assert.equal(isAuthorizedParent(withPool, sites('alice', 'site')), false);
    });

    test('超级管理员的 roots 是空数组，不会因此把所有路径都判成授权父目录', () => {
      const withSuper = config({
        system: { parentRoots: [SITES] },
        access: { admins: [account({ username: 'root', role: 'super' })] },
      } as Partial<Config>);
      assert.equal(isAuthorizedParent(withSuper, sites('docs')), false);
      assert.equal(isAuthorizedParent(withSuper, SITES), true);
    });
  });

  test('超级管理员不受路径限制', () => {
    const root = account({ username: 'root', role: 'super' });
    const verdict = checkScope(pathPolicy, {
      url: new URL('http://x/t'),
      form: { path: SYSTEM_DIR },
      account: root,
      directoryIds: new Set(),
      config: shared,
    });
    assert.deepEqual(verdict, { ok: true });
  });

  /**
   * ★ 新建/编辑目录的表单提交的是「父目录 + 目录名」，路径由服务端拼。
   *
   *   闸门必须看**拼出来之后**的那个路径。看一眼 `path` 字段是不够的 ——
   *   那个字段现在根本不在表单里；而如果为了迁就它让前端另外塞一个隐藏字段，
   *   脚本没跑起来时闸门校验的就是一个和真正落盘的路径毫无关系的值。
   */
  describe('joinPath：父目录 + 目录名', () => {
    const joinPolicy: RoutePolicy = {
      id: 't.join',
      methods: ['POST'],
      path: '/t',
      access: ['dirs.create'],
      scope: [{ kind: 'joinPath', from: 'body', parent: 'parent', folder: 'folder' }],
    };

    const run = (form: Record<string, string>, who = alice, cfg = shared) =>
      checkScope(joinPolicy, {
        url: new URL('http://x/t'),
        form,
        account: who,
        directoryIds: ids,
        config: cfg,
      });

    test('拼接结果落在授权根里就放行', () => {
      assert.deepEqual(run({ parent: sites('alice'), folder: 'Docs' }), { ok: true });
    });

    test('拼接结果越界就拒绝', () => {
      assert.deepEqual(run({ parent: sites('alice'), folder: 'Docs' }), { ok: true });
      assert.deepEqual(run({ parent: OUTSIDE, folder: 'Docs' }), {
        ok: false,
        reason: 'outOfRoots',
      });
      // 目录名里的 .. 会被解析掉，落点回到父目录的上一级 —— 必须按解析后的算
      assert.deepEqual(run({ parent: sites('alice'), folder: '..' }), {
        ok: false,
        reason: 'outOfRoots',
      });
    });

    test('父目录没填 = 没填，交给表单校验去报错', () => {
      assert.deepEqual(run({ parent: '', folder: '' }), { ok: true });
      assert.deepEqual(run({}), { ok: true });
    });

    test('★ 换一个父目录、别的都不改 —— 检查的必须仍然是拼出来的那个新位置', () => {
      // 这是这套设计的关键：路径完全由 parent+folder 决定，
      // 不存在「客户端说它没改，于是跳过检查」那条路
      assert.deepEqual(run({ parent: SITES, folder: 'alice' }, aliceShared), { ok: true });
      assert.deepEqual(run({ parent: SITES, folder: 'Bob' }, aliceShared), {
        ok: false,
        reason: 'foreignPath',
      });
    });

    test('joinTarget 与 path.resolve 同规则（目录名为空时就是父目录本身）', () => {
      assert.equal(joinTarget(sites('alice'), ''), path.resolve(sites('alice')));
      assert.equal(joinTarget(SITES, 'Docs'), path.resolve(sites('Docs')));
      assert.equal(joinTarget(SITES, '  Docs  '), path.resolve(sites('Docs')));
    });
  });
});

// ---------------------------------------------------------------- 日志归属

describe('日志路径归属', () => {
  const cfg = config({
    directories: [dir('Docs', 'alice'), dir('Docs2', 'bob'), dir('技术文档', 'bob')],
  } as unknown as Partial<Config>);

  test('按首段匹配', () => {
    assert.equal(directoryIdOfLogPath(cfg, '/Docs/readme.txt'), 'id-Docs');
    assert.equal(directoryIdOfLogPath(cfg, '/Docs/'), 'id-Docs');
    assert.equal(directoryIdOfLogPath(cfg, '/Docs'), 'id-Docs');
  });

  test('★ 不能把 Docs2 的访问算到 Docs 头上（这就是不能用 startsWith 的原因）', () => {
    assert.equal(directoryIdOfLogPath(cfg, '/Docs2/secret.txt'), 'id-Docs2');
  });

  test('百分号编码过的段也能认出来', () => {
    assert.equal(directoryIdOfLogPath(cfg, `/${encodeURIComponent('技术文档')}/a.pdf`), 'id-技术文档');
  });

  test('查询串不影响判定', () => {
    assert.equal(directoryIdOfLogPath(cfg, '/Docs/a.txt?sort=size&order=desc'), 'id-Docs');
  });

  test('站点根与不存在的路径返回 null', () => {
    assert.equal(directoryIdOfLogPath(cfg, '/'), null);
    assert.equal(directoryIdOfLogPath(cfg, ''), null);
    assert.equal(directoryIdOfLogPath(cfg, '/Nope/x'), null);
  });

  test('大小写不敏感（目录名是大小写不敏感地匹配的）', () => {
    assert.equal(directoryIdOfLogPath(cfg, '/docs/a.txt'), 'id-Docs');
  });
});

// ---------------------------------------------------------------- 账号查找

describe('账号查找', () => {
  const cfg = config({
    access: {
      admins: [
        account({ username: 'root', role: 'super', id: '' }),
        account({ username: 'Alice', id: 'alice-id' }),
      ],
    },
  } as unknown as Partial<Config>);

  test('按用户名查找，大小写与首尾空格都不敏感', () => {
    assert.equal(accountByUsername(cfg, 'alice')?.id, 'alice-id');
    assert.equal(accountByUsername(cfg, 'ALICE')?.id, 'alice-id');
    assert.equal(accountByUsername(cfg, '  Alice  ')?.id, 'alice-id');
    assert.equal(accountByUsername(cfg, 'nobody'), undefined);
    assert.equal(accountByUsername(cfg, ''), undefined);
  });

  test('空 id 解析成超级管理员', () => {
    assert.equal(accountById(cfg, '')?.role, 'super');
    assert.equal(accountById(cfg, 'alice-id')?.username, 'Alice');
    assert.equal(accountById(cfg, 'ghost'), undefined);
  });

  test('superAccount 找不到时返回 undefined（首次设置流程据此触发）', () => {
    assert.equal(superAccount(config()) , undefined);
  });
});

// ---------------------------------------------------------------- 权限键同步

describe('权限键与视图的同步', () => {
  test('策略表引用的权限键都是已定义的', async () => {
    const { ADMIN_PERMISSIONS } = await import('../src/config/schema.ts');
    const known = new Set<string>(ADMIN_PERMISSIONS as readonly string[]);
    for (const policy of ADMIN_ROUTES) {
      if (typeof policy.access === 'string') continue;
      for (const permission of policy.access as readonly AdminPermission[]) {
        assert.ok(known.has(permission), `${policy.id} 引用了未定义的权限 ${permission}`);
      }
    }
  });

  test('★ 每个权限键都至少被一条路由用到（否则勾了它什么也不会发生）', async () => {
    const { ADMIN_PERMISSIONS } = await import('../src/config/schema.ts');
    const used = new Set<string>();
    for (const policy of ADMIN_ROUTES) {
      if (typeof policy.access === 'string') continue;
      for (const permission of policy.access) used.add(permission);
    }
    const unused = (ADMIN_PERMISSIONS as readonly string[]).filter((key) => !used.has(key));
    assert.deepEqual(unused, [], `这些权限没有任何路由在用：${unused.join(', ')}`);
  });
});
