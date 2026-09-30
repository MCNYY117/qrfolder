/**
 * 把 URL 路径解析为「哪个目录、哪个文件」。
 *
 * ★ 默认文档（index.html 等）在这里**根本不存在于逻辑中** ——
 *   既有 Caddy 实现要靠 `index __disabled__` 这种技巧去压制它，
 *   而这里是从架构上就没有这个概念。这是本次重写要保住的既有行为。
 */

import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AccessConfig, DirectoryConfig } from '../config/schema.ts';
import { notFound } from '../http/errors.ts';
import { compileDenyRules, isBlocked, type DenyRules } from './denyRules.ts';
import { isInside, prepareRoot, resolveSafe, resolveRealSafe, splitPathSegments, UnsafePathError } from './safePath.ts';

export type PreparedDirectory = {
  readonly config: DirectoryConfig;
  readonly denyRules: DenyRules;
  /** 规范化后的根路径 */
  readonly root: string;
  /** realpath 展开后的根路径 */
  readonly realRoot: string;
  /** 路径不存在 / 不可访问时为 false —— 后台允许先配路径后建目录 */
  readonly available: boolean;
  readonly reason: string;
};

export type ContentTarget =
  | { kind: 'listing'; dir: PreparedDirectory; absPath: string; urlPath: string }
  | { kind: 'file'; dir: PreparedDirectory; absPath: string }
  | { kind: 'redirect'; location: string };

/** 受保护路径：绝不能通过内容面泄露出去 */
export type ProtectedPaths = {
  /** 应用目录 */
  appDir: string;
  /** 配置文件 */
  configFile: string;
};

/**
 * 启动时（以及配置变更后）预处理目录列表。
 * 单个目录不可用不能让整个服务起不来 —— 标记为不可用即可。
 */
export async function prepareDirectories(
  directories: readonly DirectoryConfig[],
  access: AccessConfig,
  protectedPaths: ProtectedPaths,
): Promise<Map<string, PreparedDirectory>> {
  const map = new Map<string, PreparedDirectory>();

  for (const config of directories) {
    if (!config.enabled) continue;

    const effective: AccessConfig = {
      ...access,
      hideDotfiles: config.hideDotfiles ?? access.hideDotfiles,
    };
    const denyRules = compileDenyRules(effective);

    let root = path.resolve(config.path);
    let realRoot = root;
    let available = true;
    let reason = '';

    const protection = checkProtected(config.path, protectedPaths);
    if (protection !== null) {
      available = false;
      reason = protection;
    } else {
      try {
        const prepared = await prepareRoot(config.path);
        root = prepared.root;
        realRoot = prepared.realRoot;
      } catch (error) {
        available = false;
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    map.set(config.name.toLowerCase(), {
      config,
      denyRules,
      root,
      realRoot,
      available,
      reason,
    });
  }

  return map;
}

function checkProtected(target: string, protectedPaths: ProtectedPaths): string | null {
  const normalized = path.resolve(target);
  for (const guard of [protectedPaths.appDir, protectedPaths.configFile]) {
    const resolved = path.resolve(guard);
    // 目标落在受保护路径之内，或受保护路径落在目标之内 —— 都不允许
    if (isInside(resolved, normalized) || isInside(normalized, resolved)) {
      return `内容目录与受保护路径重叠：${resolved}`;
    }
  }
  return null;
}

export type DirectoryMatch =
  /** 站点根路径 */
  | { kind: 'root' }
  /** 首段不对应任何已配置目录 */
  | { kind: 'unknown' }
  | { kind: 'match'; dir: PreparedDirectory; rest: string };

/**
 * 只做「路径 → 哪个目录」的匹配，不碰文件系统。
 *
 * 访问决策要在真正解析文件之前做出 —— 否则密码校验就发生在
 * 已经知道文件存在与否之后了。
 */
export function matchDirectory(
  pathname: string,
  directories: ReadonlyMap<string, PreparedDirectory>,
): DirectoryMatch {
  const rawSegments = pathname.split('/').filter((segment) => segment !== '');
  const firstRaw = rawSegments[0];
  if (firstRaw === undefined) return { kind: 'root' };

  let firstName: string;
  try {
    firstName = decodeURIComponent(firstRaw);
  } catch {
    return { kind: 'unknown' };
  }

  const dir = directories.get(firstName.toLowerCase());
  if (dir === undefined) return { kind: 'unknown' };

  return { kind: 'match', dir, rest: `/${rawSegments.slice(1).join('/')}` };
}

/**
 * 解析内容请求。
 *
 * @param pathname 来自 new URL(req.url, base).pathname，仍处于百分号编码状态
 * @throws HttpError 404（不存在 / 无权限 / 非法路径一律同一个响应，不泄露差异）
 */
export async function resolveContentTarget(
  pathname: string,
  directories: ReadonlyMap<string, PreparedDirectory>,
  protectedPaths: ProtectedPaths,
): Promise<ContentTarget> {
  const rawSegments = pathname.split('/').filter((segment) => segment !== '');
  const firstRaw = rawSegments[0];
  if (firstRaw === undefined) throw notFound();

  let firstName: string;
  try {
    firstName = decodeURIComponent(firstRaw);
  } catch {
    throw notFound();
  }

  const dir = directories.get(firstName.toLowerCase());
  if (dir === undefined || !dir.available) throw notFound();

  // 首段之后的部分（保持编码状态，交给 safePath 逐段解码校验）
  const rest = `/${rawSegments.slice(1).join('/')}`;

  let segments: string[];
  let absPath: string;
  try {
    segments = splitPathSegments(rest);
    absPath = resolveSafe(dir.root, rest);
  } catch (error) {
    if (error instanceof UnsafePathError) throw notFound();
    throw error;
  }

  // 逐段应用敏感文件规则。只查最终文件名是不够的 ——
  // 一个被隐藏的中间目录同样不该被穿越。
  for (const segment of segments) {
    if (isBlocked(segment, dir.denyRules)) throw notFound();
  }

  let linkStat;
  try {
    linkStat = await lstat(absPath);
  } catch {
    throw notFound();
  }

  if (linkStat.isSymbolicLink() && !dir.config.followSymlinks) throw notFound();

  let real: string;
  try {
    real = await resolveRealSafe(dir.realRoot, absPath);
  } catch {
    // 符号链接逃逸、目标消失、权限不足 —— 一律 404
    throw notFound();
  }

  // 最后一道保险：绝不把应用目录或配置文件发出去
  for (const guard of [protectedPaths.appDir, protectedPaths.configFile]) {
    if (isInside(path.resolve(guard), real)) throw notFound();
  }

  let target;
  try {
    target = await stat(real);
  } catch {
    throw notFound();
  }

  if (target.isDirectory()) {
    // 目录请求缺少尾斜杠 → 308 到带斜杠的地址，
    // 否则页面里的相对链接会解析到父目录
    if (!pathname.endsWith('/')) {
      return { kind: 'redirect', location: `${pathname}/` };
    }
    return { kind: 'listing', dir, absPath: real, urlPath: pathname };
  }

  return { kind: 'file', dir, absPath: real };
}
