import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * 在磁盘上确保这些目录存在。
 *
 * 用途是「授权即承诺」：超级管理员把某个父目录授权给子管理员、或者把它加进父目录池，
 * 等于承诺了「这里能用」。让它在磁盘上不存在，等于把人放进一间打不开的房间 ——
 * 他填完表单点保存，拿到一句「父目录不存在」，然后还得回来找超管。
 *
 * 三条刻意的设计：
 *
 * 1. **非递归。** 上级目录不存在就报错，绝不悄悄造出中间的层级。
 *    递归建目录会把「我把路径打错了一个字」变成一个看不见的错误 ——
 *    本来想建 `D:\data\shared`、打成 `D:\data\shard`，就在那个错的位置上
 *    建出一串空文件夹，直到有人问「东西传到哪去了」才会发现。
 *    报错里会点名是**哪一级**不存在，照着补就行。
 * 2. **只认绝对路径。** 相对路径会被 `path.resolve` 解释成「服务器进程的当前目录」——
 *    一个和用户填的东西毫无关系的位置，然后我们真的会在那里建文件夹。
 * 3. **已存在但不是目录 → 失败。** `mkdir` 撞上同名文件同样报 EEXIST，
 *    照单全收的话，「授权了一个其实是个文件的路径」会被静默放过。
 */

export type EnsureFailure =
  /** 上级目录不存在（非递归建目录的必然结果） */
  | 'parentMissing'
  /** 这个位置上已经有一个同名文件 */
  | 'notADirectory'
  /** 没有权限 */
  | 'denied'
  /** 不是绝对路径 */
  | 'notAbsolute'
  /** 其余的系统错误，附原始信息 */
  | 'failed';

export type EnsureResult =
  | { ok: true }
  | { ok: false; path: string; reason: EnsureFailure; detail: string };

function classify(error: unknown): EnsureFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'parentMissing';
  if (code === 'ENOTDIR') return 'notADirectory';
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  return 'failed';
}

/** 依次确保每个目录存在。遇到第一个失败就停下 —— 一次只报一个问题，人才知道先修哪个 */
export async function ensureDirectories(paths: readonly string[]): Promise<EnsureResult> {
  for (const raw of paths) {
    const value = raw.trim();
    if (value === '') continue;

    if (!path.isAbsolute(value)) {
      return { ok: false, path: value, reason: 'notAbsolute', detail: value };
    }
    const target = path.resolve(value);

    // 先 stat 再 mkdir：一是能区分「已经是目录」和「同名文件」，
    // 二是已经存在的目录不必再进一次 mkdir（也免得动它的时间戳）。
    try {
      const info = await stat(target);
      if (!info.isDirectory()) {
        return { ok: false, path: target, reason: 'notADirectory', detail: target };
      }
      continue;
    } catch {
      // 不存在 —— 正是要建的那种，往下走
    }

    try {
      await mkdir(target);
    } catch (error) {
      // EEXIST 出现在并发下（两个标签页同时保存）：另一个请求已经建好了，
      // 对我们要的结果而言这就是成功。
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return {
        ok: false,
        path: target,
        reason: classify(error),
        detail: String((error as Error).message ?? error),
      };
    }
  }
  return { ok: true };
}

/** 失败原因对应的 i18n 词条键。让路由层挑文案，这个模块不碰 i18n */
export const ENSURE_REASON_KEY = {
  parentMissing: 'dirs.ensureParentMissing',
  notADirectory: 'dirs.ensureNotADirectory',
  denied: 'dirs.ensureDenied',
  notAbsolute: 'dirs.ensureNotAbsolute',
  failed: 'dirs.ensureFailed',
} as const;
