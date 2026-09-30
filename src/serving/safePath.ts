/**
 * 路径穿越防护 —— 本项目风险最集中的文件。
 *
 * ============================ 核心规则 ============================
 * 必须「先按 '/' 切分，再对每一段单独解码」。
 * 反过来（先整体 decodeURIComponent 再切分）就是任意文件读取漏洞。
 *
 * 实测依据：
 *   new URL('http://h/a/%2e%2e/%2e%2e/x').pathname -> "/x"
 *       ↑ %2e%2e 被 WHATWG URL 解析器免费归一化掉了
 *   new URL('http://h/a%2f..%2fb').pathname        -> "/a%2f..%2fb"
 *       ↑ %2f 原样穿过 URL 解析器
 *   decodeURIComponent('/a%2f..%2fb')              -> "/a/../b"
 *       ↑ 解码那一刻才凭空多出分隔符
 *
 * 所以：切分必须在解码之前。本文件是唯一允许处理 URL pathname 的入口。
 * =================================================================
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError';
  constructor(message: string) {
    super(message);
  }
}

const IS_WINDOWS = process.platform === 'win32';

/** Windows 保留设备名。带扩展名同样保留（CON.txt 也是保留的） */
const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;

/**
 * target 是否位于 root 之内（词法判断，不碰文件系统）。
 *
 * 注意：不能写成 rel.startsWith('..')——那样目录里一个叫 "..foo" 的
 * 合法文件会被误杀，而且几乎不会有人想到去测这个用例。
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  // 跨盘符时 path.relative 返回绝对路径
  return !path.isAbsolute(rel);
}

/**
 * 把 URL 的 pathname 拆成「已解码、已校验」的路径段。
 *
 * @param pathname 来自 new URL(req.url, 'http://x').pathname —— 必须仍处于
 *                 「百分号编码」状态。调用前绝不能对它做 decodeURIComponent。
 * @throws UnsafePathError 任何可疑输入
 */
export function splitPathSegments(pathname: string): string[] {
  if (typeof pathname !== 'string' || pathname === '') {
    throw new UnsafePathError('empty path');
  }
  if (pathname.length > MAX_PATH_LENGTH) {
    throw new UnsafePathError('path too long');
  }

  // ① 在「未解码」的串上切分。顺序反了就是任意文件读取。
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue; // 首尾斜杠、重复斜杠

    // ② 每段只解码一次
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      // %c0%ae 这类非法 UTF-8 序列会抛 URIError
      throw new UnsafePathError('invalid percent-encoding');
    }

    validateSegment(seg);
    segments.push(seg);
  }

  return segments;
}

/**
 * 校验单个路径段（**已解码**）。
 *
 * 抽出来是为了让上传的文件名走同一套规则 —— 上传是唯一由用户直接
 * 指定磁盘文件名的入口，不能只靠「取路径末段」这种间接约束。
 *
 * @throws UnsafePathError
 */
export function validateSegment(seg: string): void {
  if (seg === '' || seg === '.' || seg === '..') {
    throw new UnsafePathError('dot segment');
  }
  // 解码后出现的分隔符，说明是 %2f / %5c 夹带进来的
  if (seg.includes('/')) {
    throw new UnsafePathError('embedded forward slash');
  }
  if (seg.includes('\0')) {
    throw new UnsafePathError('nul byte');
  }
  if (seg.length > MAX_SEGMENT_LENGTH) {
    throw new UnsafePathError('segment too long');
  }

  // ---- 以下仅 Windows 需要 ----
  if (!IS_WINDOWS) return;

  // 反斜杠在 Windows 上就是分隔符
  if (seg.includes('\\')) {
    throw new UnsafePathError('embedded backslash');
  }
  // 冒号：盘符跳转（C:x）与 NTFS 交换数据流（file.txt:ads）
  if (seg.includes(':')) {
    throw new UnsafePathError('colon in segment');
  }
  // ★ Windows 会静默剥掉段末尾的点和空格。
  //   于是 ".. " 既躲过上面 seg === '..' 的字面比较，
  //   又会被文件系统当成 ".." 解析 —— 一条完整的穿越路径。
  //   同理 "foo." 与 "foo" 会指向同一个文件，可用于绕过黑名单。
  if (/[. ]$/.test(seg)) {
    throw new UnsafePathError('trailing dot or space');
  }
  if (WIN_RESERVED_NAME.test(seg)) {
    throw new UnsafePathError('reserved device name');
  }
}

/**
 * 把 URL 的 pathname 映射为 root 下的绝对路径。
 *
 * @param root     内容根目录的绝对路径（须经 prepareRoot 规范化）
 * @param pathname 百分号编码状态的 pathname
 * @throws UnsafePathError 任何可疑输入
 */
export function resolveSafe(root: string, pathname: string): string {
  const segments = splitPathSegments(pathname);

  // ③ 用 join 而不是 resolve。
  //    path.resolve('D:/root', '/etc') === 'D:\etc' —— root 被静默丢弃。
  //    这个错误在 Linux 上不发作，只在 Windows 上炸。
  const joined = path.join(root, ...segments);

  // ④ 词法层面的包含性复查，兜住盘符跳转与 UNC
  if (!isInside(root, joined)) {
    throw new UnsafePathError('escaped root');
  }

  return joined;
}

/**
 * 物理层的符号链接 / NTFS junction 逃逸检查。
 *
 * realRoot 必须由 prepareRoot 在启动时算好并缓存，
 * 不要每个请求都对 root 做一次 realpath。
 *
 * @throws UnsafePathError 目标逃出了根目录
 * @throws Error          ENOENT 等，由调用方转 404
 */
export async function resolveRealSafe(realRoot: string, abs: string): Promise<string> {
  const real = await fs.realpath(abs);
  if (!isInside(realRoot, real)) {
    throw new UnsafePathError('symlink escape');
  }
  return real;
}

export type PreparedRoot = {
  /** 规范化后的绝对路径，用于 path.join 与词法检查 */
  root: string;
  /** realpath 展开后的路径，用于物理层检查 */
  realRoot: string;
};

/**
 * 启动时规范化内容根目录。解析失败（目录不存在）会抛错。
 */
export async function prepareRoot(root: string): Promise<PreparedRoot> {
  if (!path.isAbsolute(root)) {
    throw new Error(`content root must be an absolute path: ${root}`);
  }
  const realRoot = await fs.realpath(root);
  const st = await fs.stat(realRoot);
  if (!st.isDirectory()) {
    throw new Error(`content root is not a directory: ${root}`);
  }
  return { root: path.resolve(realRoot), realRoot };
}
