import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  isWithin,
  normalizeBaseUrl,
  validateConfig,
  validateContentPath,
  validateDirectoryName,
} from '../src/config/validate.ts';

const APP = path.resolve('/fake/app');
const CONFIG_FILE = path.join(APP, 'config', 'config.json');

/**
 * 夹具用的绝对路径根，沿用本文件既有的 `path.resolve('/fake/...')` 写法。
 *
 * ★ 不要在这里写 `C:\Sites` —— 在 Linux 上那不是绝对路径（反斜杠也不是
 *   分隔符），`validateContentPath` 会直接判它非法，`isWithin` 也会把
 *   子路径判成不相干的两处。这类用例只有 CI 跑 Linux 时才会失败。
 */
const SITES = path.resolve('/fake/sites');
/** 池子外面的一块地方，用来验证越界会被丢掉 */
const OUTSIDE = path.resolve('/fake/outside');
const SHARED = path.join(SITES, 'shared');
const DOCS_PATH = path.join(SITES, 'docs');

describe('isWithin', () => {
  test('自身算在内', () => {
    assert.equal(isWithin(APP, APP), true);
  });

  test('子路径算在内', () => {
    assert.equal(isWithin(APP, path.join(APP, 'a', 'b')), true);
  });

  test('父目录不算在内', () => {
    assert.equal(isWithin(path.join(APP, 'a'), APP), false);
  });

  test('兄弟路径不算在内', () => {
    assert.equal(isWithin(APP, `${APP}-other`), false);
  });

  test('以两点开头的子路径仍算在内', () => {
    assert.equal(isWithin(APP, path.join(APP, '..foo')), true);
  });
});

describe('validateContentPath', () => {
  test('★ 回归：受保护目录之外的正常内容目录必须放行', () => {
    // 曾经的 bug：重叠检测方向写反，导致任何位于受保护目录之外的
    // 内容目录都被判定为「重叠」并被丢弃，表现为配置里 directories 全空。
    assert.equal(validateContentPath(path.resolve('/data/manuals'), [APP, CONFIG_FILE]), null);
    assert.equal(validateContentPath(path.resolve('/srv/files'), [APP]), null);
  });

  test('内容目录落在应用目录之内 → 拒绝', () => {
    assert.notEqual(validateContentPath(path.join(APP, 'data'), [APP]), null);
  });

  test('应用目录落在内容目录之内 → 拒绝（反向重叠）', () => {
    assert.notEqual(validateContentPath(path.dirname(APP), [APP]), null);
  });

  test('与应用目录完全相同 → 拒绝', () => {
    assert.notEqual(validateContentPath(APP, [APP]), null);
  });

  test('与配置文件完全相同 → 拒绝', () => {
    assert.notEqual(validateContentPath(CONFIG_FILE, [CONFIG_FILE]), null);
  });

  test('盘符根目录 → 拒绝', () => {
    assert.notEqual(validateContentPath(path.parse(process.cwd()).root, []), null);
  });

  test('相对路径 → 拒绝', () => {
    assert.notEqual(validateContentPath('data/manuals', []), null);
  });

  test('空字符串 → 拒绝', () => {
    assert.notEqual(validateContentPath('', []), null);
  });
});

describe('配置校验——外观', () => {
  function validate(appearance: Record<string, unknown>) {
    return validateConfig({ version: 1, appearance });
  }

  test('★ timeZone 允许保留值 auto（回归：曾被判为非法时区导致保存 500）', () => {
    const result = validate({ timeZone: 'auto' });
    assert.equal(result.ok, true, `不应报错，实际：${JSON.stringify(result.issues)}`);
    assert.equal(result.config.appearance.timeZone, 'auto');
  });

  test('timeZone 允许空字符串（服务器本地时区）', () => {
    assert.equal(validate({ timeZone: '' }).ok, true);
  });

  test('timeZone 允许合法 IANA 名称', () => {
    assert.equal(validate({ timeZone: 'Asia/Shanghai' }).ok, true);
    assert.equal(validate({ timeZone: 'UTC' }).ok, true);
  });

  test('timeZone 真的非法时才报错', () => {
    const result = validate({ timeZone: 'Not/AZone' });
    assert.equal(result.ok, false);
    assert.equal(result.config.appearance.timeZone, '');
  });

  test('★ rootBehavior 两个取值都可用，非法值回退', () => {
    assert.equal(validate({ rootBehavior: 'welcome' }).config.appearance.rootBehavior, 'welcome');
    assert.equal(validate({ rootBehavior: 'notFound' }).config.appearance.rootBehavior, 'notFound');
    assert.equal(validate({ rootBehavior: 'bogus' }).config.appearance.rootBehavior, 'welcome');
  });

  test('颜色值白名单', () => {
    assert.equal(validate({ accentColor: '#16a34a' }).config.appearance.accentColor, '#16a34a');
    // 非法值回退默认，且必须报 issue
    const bad = validate({ accentColor: '#fff}</style><script>' });
    assert.equal(bad.config.appearance.accentColor, '#2563eb');
    assert.equal(bad.ok, false);
  });

  test('底部提示语原样保留，留空表示用内置文案', () => {
    assert.deepEqual(validate({ welcomeHint: '' }).config.appearance.welcomeHint, { zh: '', en: '' });
    assert.deepEqual(validate({ welcomeHint: '请联系二维码提供方。' }).config.appearance.welcomeHint, {
      zh: '请联系二维码提供方。',
      en: '请联系二维码提供方。',
    });
  });

  /**
   * ★ 旧配置升级：这些字段在引入中英分栏之前是**纯字符串**。
   * 迁移必须把它填进两份，否则老用户打开主界面会发现文案凭空没了。
   */
  test('★ 旧版的纯字符串文案迁移到中英两份，内容逐字不变', () => {
    const config = validate({
      welcomeTitle: '老站点的标题',
      welcomeMessage: '本站用于发布产品资料',
      welcomeImageAlt: '公司 Logo',
    }).config.appearance;

    assert.deepEqual(config.welcomeTitle, { zh: '老站点的标题', en: '老站点的标题' });
    assert.deepEqual(config.welcomeMessage, { zh: '本站用于发布产品资料', en: '本站用于发布产品资料' });
    assert.deepEqual(config.welcomeImageAlt, { zh: '公司 Logo', en: '公司 Logo' });
  });

  test('★ 双语对象按语言各取各的；缺一份只影响那一份', () => {
    const config = validate({ welcomeTitle: { zh: '中文标题', en: 'English title' } }).config.appearance;
    assert.deepEqual(config.welcomeTitle, { zh: '中文标题', en: 'English title' });

    // 只填中文：英文那份保持空串（回退到英文内置文案），不是退到中文
    const half = validate({ welcomeTitle: { zh: '只有中文' } }).config.appearance;
    assert.deepEqual(half.welcomeTitle, { zh: '只有中文', en: '' });
  });

  test('双语字段收到垃圾类型时不崩，回退到空', () => {
    assert.deepEqual(validate({ welcomeHint: 42 }).config.appearance.welcomeHint, { zh: '', en: '' });
    assert.deepEqual(validate({ welcomeHint: { zh: 'a', en: null } }).config.appearance.welcomeHint, {
      zh: 'a',
      en: '',
    });
  });

  test('产品名留空回退默认值', () => {
    assert.equal(validate({ productName: '' }).config.appearance.productName, 'QRFolder');
    assert.equal(validate({ productName: '  ' }).config.appearance.productName, 'QRFolder');
    assert.equal(validate({ productName: ' Acme ' }).config.appearance.productName, 'Acme');
  });
});

describe('normalizeBaseUrl', () => {
  test('保留协议、主机、端口与路径前缀，去掉尾斜杠', () => {
    assert.equal(normalizeBaseUrl('https://files.example.com'), 'https://files.example.com');
    assert.equal(normalizeBaseUrl('https://files.example.com/'), 'https://files.example.com');
    assert.equal(normalizeBaseUrl('http://192.168.1.10:8080'), 'http://192.168.1.10:8080');
    assert.equal(normalizeBaseUrl('https://example.com/files/'), 'https://example.com/files');
    assert.equal(normalizeBaseUrl('  https://files.example.com  '), 'https://files.example.com');
  });

  test('允许省略协议，按调用方给的协议补全', () => {
    assert.equal(normalizeBaseUrl('192.168.1.10:8080', 'http'), 'http://192.168.1.10:8080');
    assert.equal(normalizeBaseUrl('files.example.com', 'https'), 'https://files.example.com');
    // 配置文件里没有「当前请求」可参考，省略协议一律判非法
    assert.equal(normalizeBaseUrl('files.example.com'), null);
  });

  test('★ 拒绝会让二维码指向错误目标的写法', () => {
    // 非 http(s) 协议：编进二维码就成了另一个协议的链接
    assert.equal(normalizeBaseUrl('ftp://example.com'), null);
    assert.equal(normalizeBaseUrl('javascript:alert(1)', 'http'), null);
    assert.equal(normalizeBaseUrl('data:text/html,x', 'http'), null);
    // 带凭据：会被原样编进图案，扫码的人看不到来源
    assert.equal(normalizeBaseUrl('https://user:pw@example.com'), null);
    // 查询串与锚点在二维码里没有意义，多半是贴错了
    assert.equal(normalizeBaseUrl('https://example.com/?a=1'), null);
    assert.equal(normalizeBaseUrl('https://example.com/#x'), null);
    assert.equal(normalizeBaseUrl(''), null);
    assert.equal(normalizeBaseUrl('   '), null);
  });
});

describe('配置校验——对外访问地址', () => {
  function validate(system: Record<string, unknown>) {
    return validateConfig({ version: 1, system });
  }

  test('留空合法，表示跟随当前访问地址', () => {
    const result = validate({ publicBaseUrl: '' });
    assert.equal(result.ok, true);
    assert.equal(result.config.system.publicBaseUrl, '');
  });

  test('合法绝对值被归一化后保留', () => {
    const result = validate({ publicBaseUrl: 'https://files.example.com/' });
    assert.equal(result.ok, true);
    assert.equal(result.config.system.publicBaseUrl, 'https://files.example.com');
  });

  test('★ 非法值被清空并报 issue（config 里没有当前请求可参考）', () => {
    for (const value of ['files.example.com', 'ftp://example.com', 'https://user:pw@example.com']) {
      const result = validate({ publicBaseUrl: value });
      assert.equal(result.ok, false, `${value} 应当报错`);
      assert.equal(result.config.system.publicBaseUrl, '', `${value} 应当被清空`);
    }
  });
});

describe('配置校验——管理员账号', () => {
  /** 一个形状合法就够用的密码记录：normalizePassword 只检查非空字符串与数值区间 */
  const PASSWORD = {
    algo: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
    keylen: 64,
    salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
    hash: 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=',
  };

  function validate(access: Record<string, unknown>, system: Record<string, unknown> = {}) {
    return validateConfig({ version: 1, access, system });
  }

  /**
   * ★ 这条保护的是**每一次升级**。
   *
   * 迁移如果产生哪怕一条 issue，store.reload() 就会保留旧配置（那是防「配置改坏
   * 导致整站变公开」的机制），`--check` 也会返回非零 —— 现场表现就是「升级后起不来，
   * 而且看起来像配置损坏」。所以迁移必须是静默的。
   */
  test('★ 旧版单管理员密码静默迁移成超级管理员，不产生任何 issue', () => {
    const result = validate({ adminPassword: PASSWORD });

    assert.equal(result.ok, true, `迁移不该报错，实际：${JSON.stringify(result.issues)}`);
    assert.deepEqual(result.issues, []);

    const admins = result.config.access.admins;
    assert.equal(admins.length, 1);
    assert.equal(admins[0]?.username, 'admin');
    assert.equal(admins[0]?.role, 'super');
    assert.equal(admins[0]?.enabled, true);
    assert.deepEqual(admins[0]?.password, { ...PASSWORD, algo: 'scrypt' });
  });

  test('★ 迁移后内存里不再带着旧哈希（否则 /system/export 还会吐它）', () => {
    const result = validate({ adminPassword: PASSWORD });
    assert.equal(result.config.access.adminPassword, null);
  });

  test('既没有 admins 也没有旧密码 = 还没初始化，合法', () => {
    const result = validate({});
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.access.admins, []);
  });

  test('★ 密码记录坏掉的账号被丢掉并报错，而不是静默变成「没密码」', () => {
    // 静默变 null 会让它在后台看起来仍是个正常账号，而 null 密码在别处
    // 被当作「没设密码」—— 两件事叠加就是一条认证绕过
    const result = validate({
      admins: [{ username: 'alice', role: 'sub', password: { salt: '', hash: '' } }],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.config.access.admins, [], '坏账号必须整个丢掉');
    assert.ok(result.issues.some((issue) => issue.at.includes('password')));
  });

  test('用户名不合法 / 重复（大小写不敏感）都被拒绝', () => {
    for (const username of ['ab', 'a b', 'a/b', '有中文', 'x'.repeat(65)]) {
      const result = validate({ admins: [{ username, role: 'sub', password: PASSWORD }] });
      assert.equal(result.config.access.admins.length, 0, `${username} 应当被拒绝`);
    }

    const dup = validate({
      admins: [
        { username: 'Alice', role: 'sub', password: PASSWORD },
        { username: 'alice', role: 'sub', password: PASSWORD },
      ],
    });
    assert.equal(dup.config.access.admins.length, 1, '大小写不同也算重名');
    assert.equal(dup.config.access.admins[0]?.username, 'Alice');
  });

  test('★ 只允许一个超级管理员，多出来的降级（不是丢弃）', () => {
    const result = validate({
      admins: [
        { username: 'root', role: 'super', password: PASSWORD },
        { username: 'other', role: 'super', password: PASSWORD },
      ],
    });
    const admins = result.config.access.admins;
    assert.equal(admins.length, 2, '丢掉的代价可能是「一个超级管理员都不剩」');
    assert.equal(admins[0]?.role, 'super');
    assert.equal(admins[1]?.role, 'sub', '第二个应当降级');
    assert.ok(result.issues.some((issue) => issue.message.includes('超级管理员只能有一个')));
  });

  test('★ 未知权限键被丢弃并报错（fail-closed，绝不「不认识就放行」）', () => {
    const result = validate({
      admins: [
        {
          username: 'alice',
          role: 'sub',
          password: PASSWORD,
          permissions: ['files.view', 'root.everything', 'dirs.view'],
        },
      ],
    });
    assert.deepEqual(result.config.access.admins[0]?.permissions, ['files.view', 'dirs.view']);
    assert.ok(result.issues.some((issue) => issue.message.includes('未知权限')));
  });

  test('★ 授权根目录必须落在父目录池之内，否则子管理员能自己扩权', () => {
    const result = validate(
      {
        admins: [
          {
            username: 'alice',
            role: 'sub',
            password: PASSWORD,
            roots: [path.join(SHARED, 'alice'), OUTSIDE],
          },
        ],
      },
      { parentRoots: [SHARED] },
    );
    const roots = result.config.access.admins[0]?.roots ?? [];
    assert.equal(roots.length, 1, '越界的那个必须被丢掉');
    assert.ok(roots[0]?.endsWith('alice'));
    assert.ok(result.issues.some((issue) => issue.at.includes('roots')));
  });

  /**
   * ★ 这条保护的是**每一次升级**，和 adminPassword 的迁移同一条道理。
   *
   * 旧配置里这个字段叫 scanRoots。迁移如果报哪怕一条 issue，
   * `store.reload()` 就会永远保留旧配置、`--check` 退出码非零 ——
   * 现场表现是「升级后起不来，而且看起来像配置损坏」。
   */
  test('★ 旧的 scanRoots 静默迁移成 parentRoots，不产生任何 issue', () => {
    const result = validate({}, { scanRoots: [SHARED, DOCS_PATH] });

    assert.deepEqual(result.issues, [], '迁移不该报错');
    assert.deepEqual(result.config.system.parentRoots, [SHARED, DOCS_PATH]);
    // 输出里不该再留着旧键，否则两个键并存会让人分不清哪个说了算
    assert.equal('scanRoots' in result.config.system, false);
  });

  test('新键存在时以新键为准（旧键只是兼容读入）', () => {
    const result = validate({}, { parentRoots: [OUTSIDE], scanRoots: [SITES] });
    assert.deepEqual(result.config.system.parentRoots, [OUTSIDE]);
    assert.deepEqual(result.issues, []);
  });

  test('父目录池会去重并解析成绝对路径', () => {
    // 以前这里是 asStringArray，原样保留用户敲进来的字符串，
    // 于是同一个目录的两种写法会被当成两个不同的根
    // 同一个目录的两种写法（带不带尾随分隔符）必须收敛成一条
    const result = validate({}, { parentRoots: [SHARED, SHARED + path.sep, '  ', DOCS_PATH] });
    assert.equal(result.config.system.parentRoots.length, 2);
    assert.ok(result.config.system.parentRoots.every((r) => path.isAbsolute(r)));
  });

  /**
   * ★ 回归：这些前置权限不补上，子管理员会进入「能干、但干完看不到结果」的状态 ——
   *   每一个目录动作都以 redirect 回 /admin/directories 收尾，而那个页面要 dirs.view。
   *   现场表现是「子管理员删目录，删成功了，然后浏览器落到一个 404」。
   *
   * 同时钉住「不报 issue」：报 issue 会让 store.reload() 永远拒绝这份配置，
   * 等于为了一个无害的补齐把整份配置判死。
   */
  test('★ 动作类权限会自动补上它依赖的「查看」权限，且不报 issue', () => {
    const result = validate({
      admins: [
        { username: 'admin', role: 'super', password: PASSWORD },
        { username: 'alice', role: 'sub', password: PASSWORD, permissions: ['dirs.delete'] },
        { username: 'bob', role: 'sub', password: PASSWORD, permissions: ['appearance.edit'] },
        { username: 'carol', role: 'sub', password: PASSWORD, permissions: ['logs.export'] },
        { username: 'dave', role: 'sub', password: PASSWORD, permissions: ['files.view'] },
      ],
    });

    assert.deepEqual(result.issues, [], '补齐不该产生 issue');

    const permsOf = (name: string): string[] =>
      result.config.access.admins.find((a) => a.username === name)?.permissions ?? [];

    assert.ok(permsOf('alice').includes('dirs.view'), 'dirs.delete 应当带上 dirs.view');
    assert.ok(permsOf('bob').includes('appearance.view'), 'appearance.edit 应当带上 appearance.view');
    assert.ok(permsOf('carol').includes('logs.view'), 'logs.export 应当带上 logs.view');

    // 反向确认：不相关的权限不该被顺手加进来
    assert.deepEqual(
      [...permsOf('dave')].sort(),
      ['files.view'],
      '只有 files.view 的人不该被塞进目录相关的权限',
    );
  });

  test('超级管理员的 permissions / roots 被忽略（它隐含全部权限）', () => {
    const result = validate({
      admins: [
        {
          username: 'root',
          role: 'super',
          password: PASSWORD,
          permissions: ['files.view'],
          roots: [SITES],
        },
      ],
    });
    assert.deepEqual(result.config.access.admins[0]?.permissions, []);
    assert.deepEqual(result.config.access.admins[0]?.roots, []);
  });
});

describe('配置校验——目录归属', () => {
  const PASSWORD = {
    algo: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
    keylen: 64,
    salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
    hash: 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=',
  };

  test('老配置没有 owner 字段 → 归超级管理员，不报错', () => {
    const result = validateConfig({
      version: 1,
      directories: [{ name: 'Docs', path: DOCS_PATH }],
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.config.directories[0]?.owner, '');
  });

  test('★ 指向不存在账号的归属被改回超级管理员并报错', () => {
    // 不改的话这个目录会对**所有人**隐身，包括超级管理员，界面上还没有任何线索
    const result = validateConfig({
      version: 1,
      access: {
        admins: [{ username: 'alice', role: 'sub', password: PASSWORD, id: 'alice-id' }],
      },
      directories: [{ name: 'Docs', path: DOCS_PATH, owner: 'ghost-id' }],
    });
    assert.equal(result.config.directories[0]?.owner, '');
    assert.ok(result.issues.some((issue) => issue.at.includes('owner')));
  });

  test('有效的归属被保留', () => {
    const result = validateConfig({
      version: 1,
      access: {
        admins: [{ username: 'alice', role: 'sub', password: PASSWORD, id: 'alice-id' }],
      },
      directories: [{ name: 'Docs', path: DOCS_PATH, owner: 'alice-id' }],
    });
    assert.equal(result.config.directories[0]?.owner, 'alice-id');
  });
});

describe('validateDirectoryName', () => {
  test('正常名称通过', () => {
    assert.equal(validateDirectoryName('Manuals'), null);
    assert.equal(validateDirectoryName('技术文档'), null);
    assert.equal(validateDirectoryName('Datasheet 2026'), null);
    assert.equal(validateDirectoryName('v1.2.3'), null);
  });

  test('空名称与超长名称被拒绝', () => {
    assert.notEqual(validateDirectoryName(''), null);
    assert.notEqual(validateDirectoryName('a'.repeat(129)), null);
  });

  test('含斜杠被拒绝', () => {
    assert.notEqual(validateDirectoryName('a/b'), null);
    assert.notEqual(validateDirectoryName('a\\b'), null);
  });

  test('点与双点被拒绝', () => {
    assert.notEqual(validateDirectoryName('.'), null);
    assert.notEqual(validateDirectoryName('..'), null);
  });

  test('★ 尾随点或空格被拒绝（Windows 会静默剥掉，导致 URL 与实际不符）', () => {
    assert.notEqual(validateDirectoryName('foo.'), null);
    assert.notEqual(validateDirectoryName('foo '), null);
  });

  test('保留名称被拒绝', () => {
    assert.notEqual(validateDirectoryName('admin'), null);
    assert.notEqual(validateDirectoryName('ADMIN'), null, '应大小写不敏感');
    assert.notEqual(validateDirectoryName('robots.txt'), null);
  });

  test('双下划线开头被拒绝（与内部路径冲突）', () => {
    assert.notEqual(validateDirectoryName('__internal'), null);
  });

  test('控制字符被拒绝', () => {
    assert.notEqual(validateDirectoryName('a b'), null);
    assert.notEqual(validateDirectoryName('a\nb'), null);
  });
});
