/**
 * 后台路由的授权策略表 —— 整套权限模型的**唯一执行点**。
 *
 * 为什么是一张表，而不是在每个 handler 开头写一句检查：
 *
 *   **没在表里的路由一律 404。** 在 dispatch() 里新加一个
 *   `if (sub === '/newthing')`，在补上表项之前它是死代码 —— 走不到。
 *   于是「新加了个后台路由，忘了配权限，结果它对所有登录用户敞开」这种事故
 *   在结构上就不可能发生。散落式检查做不到这一点：它依赖每个人每次都记得写。
 *
 * 表里每一条都显式列出**允许的方法**，这也是顺手修掉的一个既有问题：
 * 以前 `/system/export` 没有方法检查，POST 一下就能拿到整份配置（含会话密钥）。
 * 现在没列出的方法直接 404。
 */

import path from 'node:path';

import {
  ADMIN_PERMISSIONS,
  type AdminAccount,
  type AdminPermission,
  type Config,
} from '../config/schema.ts';
import {
  hasAnyPermission,
  isInsideForeignDirectory,
  isPathAuthorized,
  type AdminViewer,
} from './accounts.ts';

/** 允许的 HTTP 方法。刻意只有这两种 —— 后台不用 PUT/DELETE，多一种多一份风险 */
export type HttpMethod = 'GET' | 'POST';

/**
 * 访问等级：
 *   public    —— 不需要会话（登录页、语言切换）
 *   firstRun  —— 只在「还没初始化」时可达（首次设置）
 *   session   —— 任何已登录账号
 *   super     —— 仅超级管理员
 *   权限数组  —— 持有其中**任一**权限即可
 */
export type RouteAccess = 'public' | 'firstRun' | 'session' | 'super' | readonly AdminPermission[];

/** 范围检查：这类路由还要确认「这个对象归不归你」 */
export type ScopeCheck =
  /** 目录归属：参数里的目录 id 必须在可见集合内 */
  | { kind: 'dir'; from: 'query' | 'body'; name: string; optional?: boolean }
  /** 授权根目录：参数里的服务器路径必须落在被授权的父目录内 */
  | { kind: 'path'; from: 'query' | 'body'; name: string }
  /**
   * 同 path，但目标路径由表单里的「父目录 + 目录名」两段拼出来。
   *
   * ★ 新建/编辑目录的表单提交的就是这两个字段。**不要**为了省事让表单另外
   *   提交一个拼好的隐藏 `path` 去迁就这个检查：那个字段只能由页面脚本维护，
   *   脚本没跑起来（或有人直接改表单）时，闸门校验的就是一个和真正落地的路径
   *   毫无关系的值 —— 看上去在查，其实什么也没查住。拼接必须发生在服务端。
   */
  | { kind: 'joinPath'; from: 'body'; parent: string; folder: string };

export type RoutePolicy = {
  /** 稳定标识。测试与日志引用它，不引用会变的 URL */
  id: string;
  /** 允许的方法，没列出的 404 */
  methods: readonly HttpMethod[];
  /** 相对 adminPath 的子路径，精确匹配（'' 表示后台根路径） */
  path: string;
  access: RouteAccess;
  scope?: readonly ScopeCheck[];
  /**
   * POST 的 CSRF 校验方式：
   *   form   —— 表单字段 `_csrf`（绝大多数）
   *   header —— `x-csrf` 请求头（上传：请求体是文件原始字节，塞不下表单）
   *   none   —— 不校验（只允许 public / firstRun，由测试强制）
   */
  csrf?: 'form' | 'header' | 'none';
  /** 拒绝时回 JSON 而不是 HTML 错误页 —— 供前端的 fetch 接口使用 */
  format?: 'json';
};

/**
 * 全部后台路由。**新增路由必须在这里加一行**，否则它不可达
 * （test/adminPolicy.test.ts 会扫源码把这个要求钉住）。
 */
export const ADMIN_ROUTES: readonly RoutePolicy[] = [
  // ---- 会话与身份：不涉及权限，单独一档 ----
  { id: 'home', methods: ['GET'], path: '', access: 'session' },
  { id: 'setup', methods: ['GET', 'POST'], path: '/setup', access: 'firstRun', csrf: 'none' },
  { id: 'login', methods: ['GET', 'POST'], path: '/login', access: 'public', csrf: 'none' },
  // 登出会改变状态（作废会话），所以既限定 POST 也要 CSRF。
  // 后台顶栏那个表单本来就带着 _csrf，收紧它零成本 ——
  // 而且顺手关掉了「一个 <img src="/admin/logout"> 就能把人踢下线」这种骚扰。
  { id: 'logout', methods: ['POST'], path: '/logout', access: 'session', csrf: 'form' },
  { id: 'lang', methods: ['GET'], path: '/lang', access: 'public' },

  // ---- 全局运维动作：会把所有人踢下线或重读磁盘，只能超级管理员 ----
  { id: 'reload', methods: ['POST'], path: '/reload', access: 'super', csrf: 'form' },
  // 轮换密钥会让**所有人**掉线，包括超级管理员自己 —— 给子管理员等于给了一个
  // 针对站长的拒绝服务按钮
  { id: 'rotate-secret', methods: ['POST'], path: '/rotate-secret', access: 'super', csrf: 'form' },

  // ---- 目录 ----
  { id: 'dirs.list', methods: ['GET'], path: '/directories', access: ['dirs.view'] },
  {
    id: 'dirs.picker',
    methods: ['GET'],
    path: '/directories/picker',
    access: ['dirs.browse'],
    // 目录浏览器看的是**服务器的**文件系统，泄露的是内容目录之外的信息，
    // 所以要和「建目录」分开授权
    scope: [{ kind: 'path', from: 'query', name: 'path' }],
    format: 'json',
  },
  {
    id: 'dirs.qr',
    methods: ['GET'],
    path: '/directories/qr',
    access: ['dirs.qr'],
    // 二维码就是受保护目录的钥匙，必须确认这个目录归你
    scope: [{ kind: 'dir', from: 'query', name: 'dir' }],
  },
  {
    id: 'dirs.create',
    methods: ['POST'],
    path: '/directories/create',
    access: ['dirs.create'],
    // 表单提交的是「父目录 + 目录名」，路径在服务端拼 —— 见 joinPath 的注释
    scope: [{ kind: 'joinPath', from: 'body', parent: 'parent', folder: 'folder' }],
    csrf: 'form',
  },
  {
    id: 'dirs.update',
    methods: ['POST'],
    path: '/directories/update',
    access: ['dirs.update'],
    // ★ 两个都要查：id 决定「这个目录归不归你」，路径决定「你想把它指到哪」。
    //   只查 id 的话，子管理员能把自己的目录重定向到别人的内容上。
    scope: [
      { kind: 'dir', from: 'body', name: 'id' },
      { kind: 'joinPath', from: 'body', parent: 'parent', folder: 'folder' },
    ],
    csrf: 'form',
  },
  {
    id: 'dirs.delete',
    methods: ['POST'],
    path: '/directories/delete',
    access: ['dirs.delete'],
    scope: [{ kind: 'dir', from: 'body', name: 'id' }],
    csrf: 'form',
  },
  {
    id: 'dirs.purge',
    methods: ['POST'],
    path: '/directories/purge',
    // ★ 这是全站唯一一个「不可撤销地删服务器真实文件」的操作，所以写死成
    //   超级管理员专属，**不是一个可勾选的权限** —— 子管理员无论被授了什么，
    //   能做的都只是「取消发布」（删配置条目），磁盘上的东西归站长管。
    access: 'super',
    scope: [{ kind: 'dir', from: 'body', name: 'id' }],
    csrf: 'form',
  },
  {
    id: 'dirs.scan',
    methods: ['POST'],
    path: '/directories/scan',
    access: ['dirs.create'],
    scope: [{ kind: 'path', from: 'body', name: 'root' }],
    csrf: 'form',
  },

  // ---- 文件 ----
  {
    id: 'files.list',
    methods: ['GET'],
    path: '/files',
    access: ['files.view'],
    // dir 可以缺省（页面自己会选第一个可见目录），所以标 optional
    scope: [{ kind: 'dir', from: 'query', name: 'dir', optional: true }],
  },
  {
    id: 'files.upload',
    methods: ['POST'],
    path: '/files/upload',
    access: ['files.upload'],
    scope: [{ kind: 'dir', from: 'query', name: 'dir' }],
    csrf: 'header',
    format: 'json',
  },

  // ---- 访问控制：整站策略与管理员自己的凭据，一律超级管理员 ----
  // 这里的每一项都能用来提权或把站长自己锁在门外：
  //   sitePassword 是整站外层闸门；adminIpAllowlist 填错就把自己关在外面；
  //   /access/password 改的就是超级管理员自己的密码。
  { id: 'access.view', methods: ['GET'], path: '/access', access: 'super' },
  { id: 'access.site', methods: ['POST'], path: '/access/site', access: 'super', csrf: 'form' },
  { id: 'access.password', methods: ['POST'], path: '/access/password', access: 'super', csrf: 'form' },
  { id: 'access.ip', methods: ['POST'], path: '/access/ip', access: 'super', csrf: 'form' },
  { id: 'access.ratelimit', methods: ['POST'], path: '/access/ratelimit', access: 'super', csrf: 'form' },
  { id: 'access.session', methods: ['POST'], path: '/access/session', access: 'super', csrf: 'form' },
  { id: 'access.files', methods: ['POST'], path: '/access/files', access: 'super', csrf: 'form' },

  // ---- 系统设置 ----
  {
    id: 'system.view',
    methods: ['GET'],
    path: '/system',
    // 唯一可授予的系统级能力是「改对外访问地址」—— 二维码要靠它拼绝对地址，
    // 拿了 dirs.qr 的人多半也需要它。页面只会渲染他能提交的那张卡片。
    access: ['sys.publicbase'],
  },
  {
    id: 'system.publicbase',
    methods: ['POST'],
    path: '/system/publicbase',
    access: ['sys.publicbase'],
    csrf: 'form',
  },
  { id: 'system.server', methods: ['POST'], path: '/system/server', access: 'super', csrf: 'form' },
  // 开了 trustProxy 就能伪造 X-Forwarded-For，等于绕过后台 IP 白名单
  { id: 'system.proxy', methods: ['POST'], path: '/system/proxy', access: 'super', csrf: 'form' },
  { id: 'system.log', methods: ['POST'], path: '/system/log', access: 'super', csrf: 'form' },
  // 全局开关：关掉上传影响所有管理员，缩小日志缓冲会毁掉审计证据
  { id: 'system.upload', methods: ['POST'], path: '/system/upload', access: 'super', csrf: 'form' },
  // 父目录池本身就是权限边界，能改就能给自己扩权
  { id: 'system.parentroots', methods: ['POST'], path: '/system/parentroots', access: 'super', csrf: 'form' },
  // ★ 导出含全部密码哈希与 sessionSecret —— 拿到密钥就能伪造超级管理员会话；
  //   导入能整体替换 access 与 directories，即自己给自己提权
  { id: 'system.export', methods: ['GET'], path: '/system/export', access: 'super' },
  { id: 'system.import', methods: ['POST'], path: '/system/import', access: 'super', csrf: 'form' },

  // ---- 域名与证书：改的是公网 TLS 暴露面，还会顺带打开 trustProxy ----
  { id: 'domain.view', methods: ['GET'], path: '/domain', access: 'super' },
  { id: 'domain.apply', methods: ['POST'], path: '/domain/apply', access: 'super', csrf: 'form' },

  // ---- 外观：整站共用一份，改它等于改所有目录的页面 ----
  { id: 'appearance.view', methods: ['GET'], path: '/appearance', access: ['appearance.view'] },
  // 自定义 CSS 注入在同源页面上，勾这个权限时界面会给超级管理员提示
  { id: 'appearance.edit', methods: ['POST'], path: '/appearance', access: ['appearance.edit'], csrf: 'form' },

  // ---- 访问日志 ----
  { id: 'logs.view', methods: ['GET'], path: '/logs', access: ['logs.view'] },
  { id: 'logs.export', methods: ['GET'], path: '/logs/export', access: ['logs.export'] },
  // 环形缓冲是全局的，清空等于抹掉痕迹
  { id: 'logs.clear', methods: ['POST'], path: '/logs/clear', access: 'super', csrf: 'form' },

  // ---- 管理员账号：只有超级管理员能碰 ----
  { id: 'users.view', methods: ['GET'], path: '/users', access: 'super' },
  { id: 'users.create', methods: ['POST'], path: '/users/create', access: 'super', csrf: 'form' },
  { id: 'users.update', methods: ['POST'], path: '/users/update', access: 'super', csrf: 'form' },
  { id: 'users.delete', methods: ['POST'], path: '/users/delete', access: 'super', csrf: 'form' },
  // 改密码走 users/update 的可选字段，不单开一条路由 —— 少一个入口就少一处要守。
  // （超级管理员改**自己**的密码仍走 /access/password。）
];

/**
 * 找出这条请求该走哪条策略。
 *
 * 路径**精确匹配**，所以表里顺序无关紧要 —— 不存在「先匹配到更宽的前缀」
 * 这类顺序陷阱（原来 dispatch() 里那个顺序是有讲究的，这里没有了）。
 *
 * 返回 null = 这个路由不存在，调用方一律 404。
 */
export function resolveRoute(sub: string, method: string): RoutePolicy | null {
  const normalized = method.toUpperCase();
  for (const policy of ADMIN_ROUTES) {
    if (policy.path !== sub) continue;
    if (!(policy.methods as readonly string[]).includes(normalized)) continue;
    return policy;
  }
  return null;
}

/** 这个身份能不能走这条路由（只管能力，不管对象归属） */
export function isAllowed(policy: RoutePolicy, viewer: AdminViewer): boolean {
  switch (policy.access) {
    case 'public':
    case 'firstRun':
    case 'session':
      return true;
    case 'super':
      return viewer.super;
    default:
      return hasAnyPermission(viewer, policy.access);
  }
}

export type ScopeVerdict =
  | { ok: true }
  /** 不属于你 —— 一律按「不存在」处理，不确认这个对象存在 */
  | { ok: false; reason: 'notFound' }
  /** 超出被授权的服务器目录范围 —— 这个可以明说，因为是「你的请求本身不对」 */
  | { ok: false; reason: 'outOfRoots' }
  /** 落在别人名下的目录里 —— 同上，可以明说 */
  | { ok: false; reason: 'foreignPath' };

export type ScopeInput = {
  url: URL;
  form: Record<string, string>;
  /** 当前账号。根目录判断要用它的角色与 roots */
  account: AdminAccount;
  /** 可见目录 id 集合 */
  directoryIds: ReadonlySet<string>;
  /** 完整配置。「这个路径是不是别人的地盘」要看全部目录的归属与路径 */
  config: Config;
};

/**
 * 检查这条请求涉及的对象是否在当前身份范围内。
 *
 * 只有声明了 scope 的路由才会走到这里；没声明的路由（比如 `/logs`）由调用方
 * 自己在渲染时按范围过滤数据。
 */
export function checkScope(policy: RoutePolicy, input: ScopeInput): ScopeVerdict {
  for (const check of policy.scope ?? []) {
    if (check.kind === 'dir') {
      const raw =
        check.from === 'query' ? (input.url.searchParams.get(check.name) ?? '') : (input.form[check.name] ?? '');
      if (raw === '' && check.optional === true) continue;
      if (!input.directoryIds.has(raw)) return { ok: false, reason: 'notFound' };
      continue;
    }

    // 这里拼出来的必须与 handleDirectoryAction 最后落盘的路径逐字一致 ——
    // 差一步（少一次 resolve、少一次 join）就等于闸门查的和实际写的不是一个东西。
    const raw =
      check.kind === 'joinPath'
        ? joinTarget(input.form[check.parent] ?? '', input.form[check.folder] ?? '')
        : check.from === 'query'
          ? (input.url.searchParams.get(check.name) ?? '')
          : (input.form[check.name] ?? '');

    // 空路径不是越界，是「没填」，交给后面的表单校验去报错。
    // isPathAuthorized 里对超级管理员恒为真 —— 池子那条硬边界由
    // handleDirectoryAction 自己兜（见那里的注释），这里只管「是不是你的地盘」。
    if (raw.trim() === '') continue;
    const verdict = checkTargetPath(input, raw.trim());
    if (verdict !== null) return verdict;
  }
  return { ok: true };
}

/**
 * 父目录 + 目录名 → 目标绝对路径。
 *
 * ★ 父目录为空时返回空串，**绝不能**写成 `path.resolve('')` ——
 *   那等于服务器的当前工作目录，一个和用户填的东西毫无关系的路径。
 *   碰上「池子恰好盖住 cwd」的部署，一个空表单会被解析成池子里的某个位置。
 *   返回空串，调用方按「没填」处理。
 */
export function joinTarget(parent: string, folder: string): string {
  const base = parent.trim();
  if (base === '') return '';
  const resolved = path.resolve(base);
  const name = folder.trim();
  return name === '' ? resolved : path.resolve(resolved, name);
}

/** 单条 targetPath 检查。通过返回 null */
function checkTargetPath(input: ScopeInput, raw: string): ScopeVerdict | null {
  if (!isPathAuthorized(input.account, raw)) return { ok: false, reason: 'outOfRoots' };

  // ★ 光看「在不在自己的授权根里」是不够的：授权根本身可能把别人的目录
  //   圈在里面（最常见的配法就是「根目录 = 整个内容根」）。不查这一条，
  //   子管理员能新建一个目录指向别人的路径 —— 新目录归他自己，于是
  //   归属检查和内容面全部放行，他就读到了别人的文件。
  const selfId = input.form['id'] ?? '';
  const self = input.config.directories.find((dir) => dir.id === selfId);
  // 路径没改动就不查：这个位置是超级管理员当初安排的，不能因为
  // 上面正好压着别人的目录，就连改标题、改排序都被拒
  const pathUnchanged = self !== undefined && path.resolve(self.path) === path.resolve(raw);
  if (!pathUnchanged && isInsideForeignDirectory(input.config, input.account, raw, selfId)) {
    return { ok: false, reason: 'foreignPath' };
  }
  return null;
}

/** 权限键的运行时校验，供测试与视图共用 */
export function isAdminPermission(value: string): value is AdminPermission {
  return (ADMIN_PERMISSIONS as readonly string[]).includes(value);
}
