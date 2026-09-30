/**
 * 登录失败限流：按来源 IP 计数 + 指数退避锁定。
 *
 * 定位说明：这一层挡的是「慢速在线爆破」，
 * 挡不住「并发撞库打爆内存」—— 那个由 admin/auth.ts 的 scrypt 信号量负责。
 * 两者缺一不可。
 *
 * 计数存内存，重启清零。这在文档里明确说明；对单实例部署足够。
 */

import type { RateLimitConfig } from '../config/schema.ts';

type Entry = {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  /** 已触发锁定的次数，用于指数退避 */
  lockLevel: number;
};

export type RateLimitVerdict = {
  locked: boolean;
  /** 锁定剩余秒数 */
  retryAfterSeconds: number;
  /** 本次失败后还剩几次机会 */
  remaining: number;
};

/** 表大小上限，防止有人用海量伪造 IP 撑爆内存 */
const MAX_TRACKED_IPS = 10_000;

export class LoginRateLimiter {
  #config: RateLimitConfig;
  #entries = new Map<string, Entry>();

  constructor(config: RateLimitConfig) {
    this.#config = config;
  }

  reconfigure(config: RateLimitConfig): void {
    this.#config = config;
  }

  /** 当前是否处于锁定期 */
  check(ip: string): RateLimitVerdict {
    const now = Date.now();
    const entry = this.#entries.get(ip);
    if (entry === undefined || entry.lockedUntil <= now) {
      return { locked: false, retryAfterSeconds: 0, remaining: this.#config.loginMaxAttempts };
    }
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }

  /** 记一次失败，返回最新状态 */
  recordFailure(ip: string): RateLimitVerdict {
    const now = Date.now();
    const windowMs = this.#config.loginWindowMinutes * 60_000;

    let entry = this.#entries.get(ip);
    if (entry === undefined) {
      this.#maybeEvict();
      entry = { failures: 0, windowStart: now, lockedUntil: 0, lockLevel: 0 };
      this.#entries.set(ip, entry);
    }

    // 窗口过期则重新计数（但保留 lockLevel，让反复触发者被越锁越久）
    if (now - entry.windowStart > windowMs) {
      entry.failures = 0;
      entry.windowStart = now;
    }

    entry.failures += 1;

    if (entry.failures >= this.#config.loginMaxAttempts) {
      entry.lockLevel += 1;
      // 指数退避：15min → 30min → 60min …上限 lockoutMaxMinutes
      const base = this.#config.lockoutMinutes * 60_000;
      const multiplied = base * 2 ** (entry.lockLevel - 1);
      const capped = Math.min(multiplied, this.#config.lockoutMaxMinutes * 60_000);
      entry.lockedUntil = now + capped;
      entry.failures = 0;

      return { locked: true, retryAfterSeconds: Math.ceil(capped / 1000), remaining: 0 };
    }

    return {
      locked: false,
      retryAfterSeconds: 0,
      remaining: this.#config.loginMaxAttempts - entry.failures,
    };
  }

  /** 登录成功：清空该 IP 的计数 */
  recordSuccess(ip: string): void {
    this.#entries.delete(ip);
  }

  /** 当前被锁定的 IP 数量（供后台概览展示） */
  get lockedCount(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.lockedUntil > now) count += 1;
    }
    return count;
  }

  #maybeEvict(): void {
    if (this.#entries.size < MAX_TRACKED_IPS) return;
    const now = Date.now();
    // 先清掉已解锁且窗口过期的
    for (const [ip, entry] of this.#entries) {
      const expired = entry.lockedUntil <= now && now - entry.windowStart > 3_600_000;
      if (expired) this.#entries.delete(ip);
    }
    // 仍然超限则整体清空并记一条（宁可短暂放宽，也不要 OOM）
    if (this.#entries.size >= MAX_TRACKED_IPS) this.#entries.clear();
  }
}
