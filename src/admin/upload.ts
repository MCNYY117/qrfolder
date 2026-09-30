/**
 * 文件上传。
 *
 * 设计取舍：**不使用 multipart/form-data**。
 *
 * 浏览器的 `fetch(url, { body: file })` 可以直接把 File 对象作为原始请求体
 * 发出，文件名放在自定义请求头里。这样就绕开了 multipart 解析器 ——
 * 那是零依赖下最容易出错、也最容易被畸形输入打穿的部分。
 * 代价是页面需要几行 JS 逐个上传（顺带还能显示进度）。
 *
 * 上传是**唯一由用户直接指定磁盘文件名**的入口，所以文件名必须走
 * 与 URL 路径完全相同的段级校验，不能依赖「取路径末段」这种间接约束。
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError } from '../http/errors.ts';
import { isBlocked } from '../serving/denyRules.ts';
import type { PreparedDirectory } from '../serving/resolveTarget.ts';
import {
  isInside,
  resolveRealSafe,
  resolveSafe,
  UnsafePathError,
  validateSegment,
} from '../serving/safePath.ts';

export type UploadPlan = {
  /** 最终落盘的绝对路径 */
  absPath: string;
  fileName: string;
  /** 目标是否已存在同名文件 */
  existed: boolean;
  /** 目标所在目录的绝对路径 */
  absDir: string;
};

/**
 * 解析并校验一次上传的目标。
 *
 * @param relPath 用户提供的相对子路径（形如 '/sub/dir'，保持 URL 编码状态）
 * @param fileName 已解码的文件名（来自 x-filename 请求头）
 * @throws HttpError 400 / 404
 */
export async function planUpload(
  dir: PreparedDirectory,
  relPath: string,
  fileName: string,
): Promise<UploadPlan> {
  // ---- ① 文件名先过段级校验 ----
  try {
    validateSegment(fileName);
  } catch (error) {
    if (error instanceof UnsafePathError) {
      throw new HttpError(400, `invalid filename: ${error.message}`);
    }
    throw error;
  }

  // 敏感文件规则同样适用于上传 —— 否则可以上传一个 .env 再读回来
  if (isBlocked(fileName, dir.denyRules)) {
    throw new HttpError(400, 'filename rejected by deny rules');
  }

  // ---- ② 目标子目录必须在根之内 ----
  let absDir: string;
  try {
    absDir = resolveSafe(dir.root, relPath === '' ? '/' : relPath);
  } catch (error) {
    if (error instanceof UnsafePathError) throw new HttpError(404, 'invalid path');
    throw error;
  }

  try {
    absDir = await resolveRealSafe(dir.realRoot, absDir);
  } catch {
    throw new HttpError(404, 'target directory not found');
  }

  let stat;
  try {
    stat = await fs.stat(absDir);
  } catch {
    throw new HttpError(404, 'target directory not found');
  }
  if (!stat.isDirectory()) throw new HttpError(400, 'target is not a directory');

  // ---- ③ 最终路径仍在根之内 ----
  const absPath = path.join(absDir, fileName);
  if (!isInside(absDir, absPath)) throw new HttpError(400, 'invalid target path');

  let existed = false;
  try {
    await fs.lstat(absPath);
    existed = true;
  } catch {
    existed = false;
  }

  return { absPath, fileName, existed, absDir };
}

/** 边收边计数，超过上限立即中断 —— 不把整个文件读进内存 */
function byteLimiter(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new HttpError(413, 'upload exceeds the size limit'));
        return;
      }
      callback(null, chunk);
    },
  });
}

export type ReceiveOptions = {
  maxBytes: number;
  allowOverwrite: boolean;
};

/**
 * 接收请求体并落盘。
 *
 * 先写临时文件再改名：避免半截文件被当成正常内容对外提供，
 * 也避免上传中断时把原有文件覆盖成残缺状态。
 *
 * @returns 实际写入的字节数
 */
export async function receiveUpload(
  req: IncomingMessage,
  plan: UploadPlan,
  options: ReceiveOptions,
): Promise<number> {
  if (plan.existed && !options.allowOverwrite) {
    throw new HttpError(409, 'a file with the same name already exists');
  }

  const tempPath = `${plan.absPath}.qrfolder-${randomBytes(6).toString('hex')}.part`;
  let written = 0;

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      req,
      byteLimiter(options.maxBytes),
      counter,
      createWriteStream(tempPath, { flags: 'wx' }),
    );

    await fs.rename(tempPath, plan.absPath);
    return written;
  } catch (error) {
    // 无论哪种失败，都不能留下临时文件
    await fs.rm(tempPath, { force: true }).catch(() => undefined);

    if (error instanceof HttpError) throw error;

    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new HttpError(409, 'a file with the same name already exists');
    if (code === 'ENOSPC') throw new HttpError(507, 'no space left on device');
    if (code === 'EACCES' || code === 'EPERM') {
      throw new HttpError(403, 'no permission to write into this directory');
    }
    throw new HttpError(500, `upload failed: ${String(error)}`);
  }
}

/** 列出某个目录的内容，供管理界面导航 */
export type DirectoryListingEntry = {
  name: string;
  isDir: boolean;
  size: number | null;
  mtime: string;
};

export async function listForAdmin(absDir: string): Promise<DirectoryListingEntry[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: DirectoryListingEntry[] = [];

  for (const entry of entries) {
    const isDir = entry.isDirectory();
    let size: number | null = null;
    let mtime = new Date(0);
    try {
      const st = await fs.stat(path.join(absDir, entry.name));
      size = isDir ? null : st.size;
      mtime = st.mtime;
    } catch {
      // 条目在扫描期间消失：保留但用占位值
    }
    out.push({ name: entry.name, isDir, size, mtime: mtime.toISOString() });
  }

  // 目录在前，各自按名称排序
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}
