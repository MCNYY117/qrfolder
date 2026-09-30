/**
 * 内容面的目录级访问决策。
 *
 * 之前这个模块缺失，导致后台配了「需要密码」却完全不生效 ——
 * 配置项、后台表单、密码页视图都有了，唯独没人把校验接进请求路径。
 *
 * 分层约定（**站点密码由调用方先行处理，本模块不管**）：
 *
 *   站点密码  —— 硬性外层闸门。开启后，任何内容路径都要先过它，
 *                包括不存在的路径（否则「弹密码」与「404」的差异
 *                会让攻击者枚举出哪些目录名有效）。
 *   目录密码  —— 在站点闸门之内的第二层，由本模块判定。
 *   管理员会话 —— 放行**自己范围内的**目录，否则后台的「实时预览」会被自己的
 *                密码页挡住。★ 注意这里不再是「管理员一律放行」：
 *                子管理员只能进自己名下的目录，别人的按不存在处理。
 *                不改这一点的话，子管理员在浏览器里直接输别人目录的网址就进去了，
 *                后台把权限做得再细也没用。
 */

import type { Config } from '../config/schema.ts';
import type { PreparedDirectory } from '../serving/resolveTarget.ts';
import { ipInAny, parseCidrList } from './cidr.ts';

export type PasswordScope = 'site' | 'directory';

export type AccessDecision =
  | { kind: 'allow' }
  /** 一律按不存在处理，不确认受保护资源的存在 */
  | { kind: 'deny' }
  | {
      kind: 'password';
      scope: PasswordScope;
      /** scope === 'directory' 时有效 */
      dirId: string;
      dirName: string;
    };

/**
 * 已登录管理员在内容面的可见范围。
 *
 * 以前这里是个 `isAdmin: boolean`，管理员一律放行 —— 那时只有一个管理员，
 * 语义上是对的；有了子管理员之后它就成了绕过后台权限的直接通道。
 */
export type AdminScope = {
  /** 超级管理员：全部放行 */
  super: boolean;
  /** 子管理员名下的目录 id */
  directoryIds: ReadonlySet<string>;
};

export type GuardContext = {
  config: Config;
  /** 当前请求命中的目录；站点根路径为 null */
  dir: PreparedDirectory | null;
  clientIp: string;
  /** 已登录管理员的范围；不是管理员时为 null */
  admin: AdminScope | null;
  hasDirectorySession: (directoryId: string) => boolean;
};

const ALLOW: AccessDecision = { kind: 'allow' };
const DENY: AccessDecision = { kind: 'deny' };

export function evaluateAccess(ctx: GuardContext): AccessDecision {
  const admin = ctx.admin;

  if (admin !== null) {
    // 超级管理员无条件放行 —— 后台的实时预览要靠它
    if (admin.super) return ALLOW;

    const ownDir = ctx.dir;
    // 站点根由调用方决定（欢迎页或 404），这里不表态
    if (ownDir === null) return ALLOW;

    // ★ 归属判定必须在目录密码分支**之前**。
    //   走到密码分支就等于承认了这个目录存在（会弹出「请输入密码」），
    //   而子管理员不该知道别人的目录存不存在 —— 那正是按目录隔离想避免的事。
    if (!admin.directoryIds.has(ownDir.config.id)) return DENY;

    // 自己名下的目录：目录密码与目录级 IP 白名单都放行。
    // 这两项他本来就能在后台里改，再拿它们挡他没有意义。
    return ALLOW;
  }

  const dir = ctx.dir;
  // 站点根路径由调用方处理（欢迎页或 404）
  if (dir === null) return ALLOW;

  // ---- 目录级 IP 白名单：最具体，最先判 ----
  if (dir.config.allowedCidrs.length > 0) {
    const allowlist = parseCidrList(dir.config.allowedCidrs);
    // 条目全部写错时按「不限制」处理，避免一次笔误把目录彻底锁死
    if (allowlist.length > 0 && !ipInAny(allowlist, ctx.clientIp)) return DENY;
  }

  // ---- 目录级密码 ----
  const needsPassword = dir.config.access === 'password' && dir.config.password !== null;
  if (needsPassword && !ctx.hasDirectorySession(dir.config.id)) {
    return {
      kind: 'password',
      scope: 'directory',
      dirId: dir.config.id,
      dirName: dir.config.name,
    };
  }

  return ALLOW;
}

/**
 * 站点级闸门是否需要拦截本次请求。
 *
 * 单独成一个函数，是为了让「先于目录存在性判断」这个顺序约束显式可见。
 */
export function siteGateRequired(
  ctx: Pick<GuardContext, 'config' | 'admin'>,
  hasSiteSession: boolean,
): boolean {
  // 任何已登录的管理员都豁免整站密码：他是运维人员，不是访客。
  // 这么做不会削弱隔离 —— 目录范围检查是**独立**生效的，
  // 子管理员豁免了外层闸门，仍然进不去别人的目录。
  // 反过来（要求他也输一遍整站密码）会得到「预览自己目录还要过一道访客闸门」这种别扭事。
  if (ctx.admin !== null || hasSiteSession) return false;
  return ctx.config.access.siteMode === 'password' && ctx.config.access.sitePassword !== null;
}
