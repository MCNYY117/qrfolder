/**
 * 目录扫描、过滤与排序。
 *
 * 性能与健壮性要点：
 *   - 用 readdir({ withFileTypes: true }) 拿到条目类型，但不能拿到大小/时间，
 *     所以仍需逐条 stat。这里用并发上限包住，避免几千条目时把 libuv 线程池打爆。
 *   - 单个条目 stat 失败（被杀毒软件/索引器短暂占用是常见现象）不能拖垮整个
 *     列表页 —— 降级为占位值即可。
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Lang, SortField, SortOrder } from '../config/schema.ts';
import { isBlocked, type DenyRules } from './denyRules.ts';
import { getCollator } from './format.ts';

export type DirEntry = {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  /** 目录为 null */
  size: number | null;
  mtime: Date;
};

export type ScanOptions = {
  lang: Lang;
  rules: DenyRules;
  followSymlinks: boolean;
  sort: SortField;
  order: SortOrder;
  /** 单次列出的条目上限 */
  limit: number;
};

export type ScanResult = {
  entries: DirEntry[];
  numDirs: number;
  numFiles: number;
  truncated: boolean;
};

/** 逐条 stat 的并发上限 */
const STAT_CONCURRENCY = 32;

/** 以固定并发度映射，避免几千个 fs 操作同时排队 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 扫描一个目录。
 *
 * @param dirPath 已通过 safePath 校验的绝对路径
 */
export async function scanDirectory(dirPath: string, options: ScanOptions): Promise<ScanResult> {
  const dirents = await readdir(dirPath, { withFileTypes: true });

  // ---- 先做零成本过滤，再 stat ----
  const candidates = dirents.filter((dirent) => {
    if (isBlocked(dirent.name, options.rules)) return false;
    // 不跟随符号链接时直接剔除，列表里不显示、也无法直连
    if (dirent.isSymbolicLink() && !options.followSymlinks) return false;
    return true;
  });

  const entries = await mapLimit(candidates, STAT_CONCURRENCY, async (dirent) => {
    const full = path.join(dirPath, dirent.name);
    const isSymlink = dirent.isSymbolicLink();

    let isDir = dirent.isDirectory();
    let size: number | null = null;
    let mtime = new Date(0);

    try {
      // 用 stat（跟随链接）而非 lstat：开启 followSymlinks 时，
      // 指向目录的链接应当表现为目录。
      const st = await stat(full);
      isDir = st.isDirectory();
      size = isDir ? null : st.size;
      mtime = st.mtime;
    } catch {
      // 条目在扫描期间消失，或被占用导致瞬时失败：保留条目但用占位值，
      // 绝不能因为一条失败就让整个列表页 500。
      if (!isDir) size = 0;
    }

    return { name: dirent.name, isDir, isSymlink, size, mtime } satisfies DirEntry;
  });

  const numDirs = entries.filter((e) => e.isDir).length;
  const numFiles = entries.length - numDirs;

  sortEntries(entries, options);

  const truncated = entries.length > options.limit;
  return {
    entries: truncated ? entries.slice(0, options.limit) : entries,
    numDirs,
    numFiles,
    truncated,
  };
}

/**
 * 排序。结果必须是全序（末尾以 name 兜底），否则同大小/同时间的条目
 * 顺序会在多次请求间抖动。
 */
export function sortEntries(
  entries: DirEntry[],
  options: Pick<ScanOptions, 'lang' | 'sort' | 'order'>,
): void {
  const collator = getCollator(options.lang);
  const factor = options.order === 'desc' ? -1 : 1;

  // 'name' 是纯名称排序（目录与文件混排）；其余模式一律目录优先
  const dirsFirst = options.sort !== 'name';

  const byName = (a: DirEntry, b: DirEntry): number => collator.compare(a.name, b.name);

  entries.sort((a, b) => {
    if (dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;

    switch (options.sort) {
      // 名称就是主排序字段，方向要跟着 order 走
      case 'name':
      case 'namedirfirst':
        return byName(a, b) * factor;

      case 'size': {
        const diff = (a.size ?? -1) - (b.size ?? -1);
        // 平手时以名称升序兜底，保证全序稳定（否则同大小的条目顺序会抖动）
        return diff !== 0 ? diff * factor : byName(a, b);
      }

      case 'time': {
        const diff = a.mtime.getTime() - b.mtime.getTime();
        return diff !== 0 ? diff * factor : byName(a, b);
      }

      default:
        return byName(a, b) * factor;
    }
  });
}
