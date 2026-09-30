/**
 * 文件流式响应 + Range 分段。
 *
 * 这个文件决定「浏览器里能不能直接预览 PDF / 拖动视频进度条」，
 * 同时也是资源泄漏的高发区（客户端取消下载后 fd 不释放）。
 *
 * 刻意不对文件响应做 gzip：Range 与压缩流无法共存
 * （压缩后的字节偏移与原始文件偏移不对应），
 * 且文档类文件本来就不适合在线压缩。压缩只用于动态生成的 HTML。
 */

import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { lookupMime } from './mime.ts';

const RANGE_RE = /^(\d*)-(\d*)$/;

export type Disposition = 'inline' | 'attachment';

export type SendFileOptions = {
  /** inline = 浏览器内预览；attachment = 强制下载 */
  disposition: Disposition;
  /** 覆盖自动判定的 Content-Type */
  contentType?: string;
  /**
   * 用于 Content-Disposition 的文件名（默认取路径末段）。
   * 单独提供是为了支持「显示名与磁盘名不同」的场景。
   */
  downloadName?: string;
};

/** 基于 size + mtime 的强 ETag */
export function buildEtag(stat: Stats): string {
  const size = stat.size.toString(16);
  const mtime = Math.floor(stat.mtimeMs).toString(16);
  return `"${size}-${mtime}"`;
}

/**
 * 构造 Content-Disposition。
 *
 * 非 ASCII 文件名必须按 RFC 5987 双写：`filename=`（ASCII 回退）+ `filename*=UTF-8''`（真名）。
 * 只写前者会让中文文件名在部分浏览器/代理下变成乱码或直接丢失。
 */
export function contentDisposition(disposition: Disposition, filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

type RangeResult =
  | { kind: 'none' }
  | { kind: 'satisfiable'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * 解析 Range 头。规则遵循 RFC 7233 与 Go 的 net/http.ServeContent：
 *   - 语法不合法 / 多段 → 忽略 Range，发 200 全量
 *   - end 越界 → 收敛到文件末尾（不是 416）
 *   - 只有 start 越界才是 416
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return { kind: 'none' };

  const spec = header.slice('bytes='.length).trim();
  // 多段请求（bytes=0-9,20-29）：退化为全量，这是 RFC 允许的
  if (spec === '' || spec.includes(',')) return { kind: 'none' };

  const m = RANGE_RE.exec(spec);
  if (m === null) return { kind: 'none' };

  const rawStart = m[1] ?? '';
  const rawEnd = m[2] ?? '';
  if (rawStart === '' && rawEnd === '') return { kind: 'none' };

  // 后缀区间 bytes=-N：最后 N 个字节
  if (rawStart === '') {
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'satisfiable', start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start)) return { kind: 'none' };
  if (start > size - 1) return { kind: 'unsatisfiable' };

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return { kind: 'unsatisfiable' };

  return { kind: 'satisfiable', start, end };
}

function send416(res: ServerResponse, size: number): void {
  res.setHeader('Content-Range', `bytes */${size}`);
  res.setHeader('Content-Length', '0');
  res.writeHead(416);
  res.end();
}

function headerEquals(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  // If-None-Match 可能是逗号分隔列表，也可能带 W/ 前缀
  return value.split(',').some((part) => {
    const t = part.trim();
    return t === expected || t === `W/${expected}` || t === '*';
  });
}

/**
 * 发送文件。调用方需保证：
 *   - absPath 已通过 safePath 校验
 *   - stat 对应该路径且不是目录
 *   - 敏感文件规则已判定通过
 */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  absPath: string,
  stat: Stats,
  options: SendFileOptions,
): Promise<void> {
  const size = stat.size;
  const etag = buildEtag(stat);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  // ---- 条件请求：命中则 304，不读盘 ----
  const notModified =
    headerEquals(req.headers['if-none-match'], etag) ||
    isNotModifiedSince(req.headers['if-modified-since'], stat);
  if (notModified) {
    res.writeHead(304);
    res.end();
    return;
  }

  const name = options.downloadName ?? path.basename(absPath);
  res.setHeader('Content-Type', options.contentType ?? lookupMime(absPath));
  res.setHeader('Content-Disposition', contentDisposition(options.disposition, name));

  // ---- 空文件单独处理：否则 end 会算成 -1 ----
  if (size === 0) {
    if (req.headers.range !== undefined) {
      send416(res, 0);
      return;
    }
    res.setHeader('Content-Length', '0');
    res.writeHead(200);
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (range.kind === 'unsatisfiable') {
    send416(res, size);
    return;
  }

  const partial = range.kind === 'satisfiable';
  const start = partial ? range.start : 0;
  const end = partial ? range.end : size - 1;

  res.setHeader('Content-Length', String(end - start + 1));
  if (partial) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.writeHead(206);
  } else {
    res.writeHead(200);
  }

  // HEAD 只回头，绝不建流读盘
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  // createReadStream 的 end 是「含」的，语义与 HTTP 一致，直接传即可。
  // 常见错误是传 end: start + length，会多读一个字节且与 Content-Length 不符，
  // 表现为浏览器下载 PDF 报「文件损坏」。
  const stream = createReadStream(absPath, { start, end });

  // 客户端取消下载时必须销毁流，否则 fd 迟迟不释放，
  // 几百次取消之后服务就打不开新文件了。
  const destroyStream = (): void => {
    stream.destroy();
  };
  res.on('close', destroyStream);

  try {
    await pipeline(stream, res);
  } catch {
    // 响应头已发出，此时无法再回 500，只能断连
    res.destroy();
  } finally {
    res.off('close', destroyStream);
  }
}

/** If-Modified-Since 比较（秒级精度，HTTP 日期不含毫秒） */
function isNotModifiedSince(header: string | string[] | undefined, stat: Stats): boolean {
  if (typeof header !== 'string') return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(stat.mtimeMs / 1000) * 1000 <= since;
}
