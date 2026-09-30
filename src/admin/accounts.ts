/**
 * 管理员账号的查询与范围计算。
 *
 * 这里刻意**不碰任何 I/O，也不引用 http/views** —— 于是一整套权限判定可以在
 * 不起服务器的情况下单测（见 test/adminPolicy.test.ts）。授权这种东西最怕
 * 「只能靠起服务才测得出来」，那样没人会去测边界情况。
 */

import path from 'node:path';

import { isWithin } from '../config/validate.ts';
import type { AdminAccount, AdminPermission, Config, DirectoryConfig } from '../config/schema.ts';

/**
 * 一次请求里「当前是谁、能看见什么」。每次请求构造一次，全程复用。
 *
 * 注意它是从**当前配置**算出来的，不是从票据里读出来的 —— 这就是
 * 「改了权限立刻生效、删了账号立刻失效」的实现方式。
 */
export type AdminViewer = {
  id: string;
  username: string;
  /** 超级管理员：看得见一切，且不受授权根目录限制 */
  super: boolean;
  /** 子管理员被授予的权限。超级管理员这里是空集 —— 判断一律走 hasPermission() */
  permissions: ReadonlySet<AdminPermission>;
  /** 可见的目录 id。超级管理员 = 全部 */
  directoryIds: ReadonlySet<string>;
  /** 允许浏览 / 新建内容目录的父目录。超级管理员为空数组，表示不受限 */
  roots: readonly string[];
};

/** 超级管理员账号。返回 undefined 表示还没初始化 → 走首次设置流程 */
export function superAccount(config: Config): AdminAccount | undefined {
  return config.access.admins.find((account) => account.role === 'super');
}

export function accountById(config: Config, id: string): AdminAccount | undefined {
  if (id === '') return superAccount(config);
  return config.access.admins.find((account) => account.id === id);
}

export function accountByUsername(config: Config, username: string): AdminAccount | undefined {
  const key = username.trim().toLowerCase();
  if (key === '') return undefined;
  return config.access.admins.find((account) => account.username.toLowerCase() === key);
}

/**
 * 这个账号能不能看见这个目录。
 *
 * 需求里的「自己新建的 **或** 被分配的」就落在这一行：两者都由 `owner` 表达。
 * 空串 owner 表示超级管理员的目录 —— 子管理员看不到，超级管理员看得到。
 */
export function canSeeDirectory(account: AdminAccount, dir: DirectoryConfig): boolean {
  if (account.role === 'super') return true;
  return dir.owner === account.id;
}

/**
 * 该账号可见的目录。
 *
 * ★ 读的是 `config.directories`，**不是** `deps.directories()` ——
 *   后者只含**已启用**的目录。用那个过滤，子管理员会看不到自己那个被禁用的目录，
 *   于是永远没法把它重新启用。那是个「越用越少、还找不到原因」的坑。
 */
export function visibleDirectories(config: Config, account: AdminAccount): DirectoryConfig[] {
  return config.directories.filter((dir) => canSeeDirectory(account, dir));
}

/** 子管理员允许浏览与新建内容目录的父目录。超级管理员为空数组 = 不受限 */
export function authorizedRoots(account: AdminAccount): readonly string[] {
  return account.role === 'super' ? [] : account.roots;
}

/**
 * 这个路径**本身**是不是一个「授权父目录」—— 池子里的，或某个子管理员被勾选的。
 *
 * ★ 这类位置是「放东西的容器」，不是「要发布的文件」，所以本身不能当内容目录发布。
 *   两个理由，第二个才是要紧的：
 *   1. 把容器整个发布出去，等于把它里面所有人的东西一起公开；
 *   2. 同一个路径同时是「某人可以往里建东西的活动范围」和「一个对外发布的站点」，
 *      两套语义会打架 —— 子管理员建的东西莫名其妙出现在一个已发布的列表里，
 *      而站长以为自己只是发布了一个工作区。
 *
 * 只比**相等**，不比包含：池子根下面的子目录照常可以发布，那才是常规用法。
 */
export function isAuthorizedParent(config: Config, target: string): boolean {
  const resolved = path.resolve(target);
  if (config.system.parentRoots.some((root) => isSamePath(root, resolved))) return true;
  return config.access.admins.some(
    (account) =>
      account.role === 'sub' && account.roots.some((root) => isSamePath(root, resolved)),
  );
}

/**
 * 两个路径是不是同一个位置。
 *
 * Windows 上大小写不敏感，`C:\Sites` 和 `c:\sites` 是同一处 —— 不折一下大小写，
 * 用户换个写法就能绕开「授权父目录不能发布」这条。别的平台保持大小写敏感
 * （那边 `A` 和 `a` 真是两个目录，折了会误伤）。
 */
function isSamePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 目标路径是否落在这个账号被授权的某个父目录之内。
 *
 * 超级管理员恒为真 —— 这一层问的是「这个位置是不是你的地盘」，而超级管理员
 * 本来就哪儿都去得。**它不管「允许的父级目录」那个池子**，那是另一回事：
 * 池子是硬边界，对超级管理员一样有效，由各处调用方自己查
 * （`handleDirectoryAction`、`serveDirectoryPicker`、`/directories/scan`）。
 */
export function isPathAuthorized(account: AdminAccount, target: string): boolean {
  if (account.role === 'super') return true;
  const resolved = path.resolve(target);
  return account.roots.some((root) => isWithin(path.resolve(root), resolved));
}

/**
 * 目标路径是否落在**别人名下**的某个内容目录里（含相等）。
 *
 * ★ 不挡这一条，整套按目录隔离就是漏的：子管理员只要授权父目录覆盖到了
 *   别人的目录 —— 而「根目录 = 整个内容根」是最自然的配法 —— 就能新建一个
 *   目录指过去。那个新目录确实归他自己，所以归属检查、权限检查、内容面的
 *   404 全都拦不住，他于是从内容面把别人的文件读了出来。
 *
 * `ignoreDirectoryId` 是正在编辑的那个目录：它自己不算「别人的」，
 * 否则一个目录只要被摆在别人的目录之下，改个标题都会被拒。
 *
 * 超级管理员恒为 false —— 他本来就看得见全部目录，没有什么可「越」的。
 */
export function isInsideForeignDirectory(
  config: Config,
  account: AdminAccount,
  target: string,
  ignoreDirectoryId = '',
): boolean {
  if (account.role === 'super') return false;
  const resolved = path.resolve(target);
  return config.directories.some(
    (dir) =>
      dir.id !== ignoreDirectoryId &&
      dir.owner !== account.id &&
      isWithin(path.resolve(dir.path), resolved),
  );
}

export function viewerOf(config: Config, account: AdminAccount): AdminViewer {
  const isSuper = account.role === 'super';
  return {
    id: account.id,
    username: account.username,
    super: isSuper,
    permissions: new Set(isSuper ? [] : account.permissions),
    directoryIds: new Set(visibleDirectories(config, account).map((dir) => dir.id)),
    roots: authorizedRoots(account),
  };
}

/** 超级管理员隐含全部权限，所以判断权限一律走这个函数，不要直接查 permissions 集合 */
export function hasPermission(viewer: AdminViewer, permission: AdminPermission): boolean {
  if (viewer.super) return true;
  return viewer.permissions.has(permission);
}

export function hasAnyPermission(viewer: AdminViewer, permissions: readonly AdminPermission[]): boolean {
  return permissions.some((permission) => hasPermission(viewer, permission));
}

/**
 * 把访问日志里的一条 path 映射回目录 id，供日志页按范围过滤。
 *
 * ★ 必须**先按 `/` 切段、再比首段**，不能用 `startsWith('/Docs')` ——
 *   那样名为 `Docs2` 的兄弟目录会被误判成 `Docs` 的访问，于是子管理员
 *   在自己根本无权看的目录的日志里，看见别人的访问记录。
 */
export function directoryIdOfLogPath(config: Config, logPath: string): string | null {
  const pathname = logPath.split('?')[0] ?? '';
  const first = pathname.split('/').filter((segment) => segment !== '')[0];
  if (first === undefined) return null;

  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // 编码坏了就按原样比，不抛 —— 日志里什么都可能出现
  }

  const key = decoded.toLowerCase();
  const dir = config.directories.find((entry) => entry.name.toLowerCase() === key);
  return dir?.id ?? null;
}
