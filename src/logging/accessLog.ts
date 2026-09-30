/**
 * 访问日志：内存环形缓冲 + 可选的落盘。
 *
 * 落盘失败的处置原则：**只记录，不抛出**。日志写不进去不应该影响响应。
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AccessLogConfig } from '../config/schema.ts';
import { log } from './appLog.ts';
import { RingBuffer } from './ringBuffer.ts';
import { ACCESS_LOG_LIMITS, type AccessLogEntry } from './types.ts';

/** 落盘用的 JSON Lines 条目 */
type QueuedEntry = AccessLogEntry & { seq: number };

export class AccessLog {
  #buffer: RingBuffer<QueuedEntry>;
  #config: AccessLogConfig;
  #projectRoot: string;
  #stream: WriteStream | null = null;
  #streamPath = '';

  constructor(config: AccessLogConfig, projectRoot: string) {
    this.#config = config;
    this.#projectRoot = projectRoot;
    this.#buffer = new RingBuffer<QueuedEntry>(config.ringSize);
    this.#syncStream();
  }

  /** 配置热重载后调用 */
  reconfigure(config: AccessLogConfig): void {
    if (config.ringSize !== this.#config.ringSize) {
      // 容量变化：重建缓冲（会丢失历史，但避免复杂的迁移逻辑）
      this.#buffer = new RingBuffer<QueuedEntry>(config.ringSize);
    }
    this.#config = config;
    this.#syncStream();
  }

  record(entry: AccessLogEntry): void {
    const trimmed: AccessLogEntry = {
      ...entry,
      path: entry.path.slice(0, ACCESS_LOG_LIMITS.path),
      userAgent: entry.userAgent.slice(0, ACCESS_LOG_LIMITS.userAgent),
      ip: entry.ip.slice(0, ACCESS_LOG_LIMITS.ip),
    };

    // 先占位再回填序号：push 的返回值就是本条日志的序号
    const queued: QueuedEntry = { ...trimmed, seq: 0 };
    queued.seq = this.#buffer.push(queued);

    if (this.#stream !== null) {
      this.#stream.write(`${JSON.stringify(trimmed)}\n`);
    }
  }

  /** 由旧到新返回条目；since 之后仅返回更新的部分 */
  query(options: { since?: number; limit?: number } = {}): QueuedEntry[] {
    const all = this.#buffer.toArray();
    const since = options.since ?? 0;
    const filtered = since > 0 ? all.filter((entry) => entry.seq > since) : all;
    const limit = options.limit ?? filtered.length;
    // 从最新一端截取，保持由旧到新
    return limit >= filtered.length ? filtered : filtered.slice(filtered.length - limit);
  }

  get sequence(): number {
    return this.#buffer.sequence;
  }

  get size(): number {
    return this.#buffer.size;
  }

  clear(): void {
    this.#buffer.clear();
  }

  /** 统计今日概况，供后台概览使用 */
  summarize(): { total: number; notFound: number; partial: number } {
    const all = this.#buffer.toArray();
    return {
      total: all.length,
      notFound: all.filter((e) => e.status === 404).length,
      partial: all.filter((e) => e.status === 206).length,
    };
  }

  async close(): Promise<void> {
    const stream = this.#stream;
    this.#stream = null;
    if (stream === null) return;
    await new Promise<void>((resolve) => stream.end(resolve));
  }

  #syncStream(): void {
    if (!this.#config.persistToFile) {
      this.#stream?.end();
      this.#stream = null;
      this.#streamPath = '';
      return;
    }

    const target = path.resolve(this.#projectRoot, this.#config.filePath);
    if (this.#stream !== null && this.#streamPath === target) return;

    this.#stream?.end();
    this.#streamPath = target;

    void (async () => {
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const stream = createWriteStream(target, { flags: 'a' });
        // 日志写入失败绝不能影响响应，也不能让进程崩溃
        stream.on('error', (error) => {
          log.warn(`access log write failed: ${error.message}`);
          this.#stream = null;
        });
        this.#stream = stream;
      } catch (error) {
        log.warn(`cannot open access log file: ${String(error)}`);
      }
    })();
  }
}
