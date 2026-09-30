/**
 * 密码哈希与校验。
 *
 * 三个必须遵守的约束：
 *
 * 1. **请求路径上绝不能用 scryptSync。**
 *    N=16384 单次约 50~120ms 且占 16MiB 内存，同步版本会把整个事件循环卡死，
 *    几个人同时登录服务就假死。
 *
 * 2. **必须限制并发。**
 *    单次 scrypt 占约 16MiB，攻击者并发 500 个登录请求 = 8GB 内存直接 OOM。
 *    按时间窗口的限流挡不住这个 —— 它允许突发并发。必须用信号量。
 *
 * 3. **密码先做 NFKC 归一化。**
 *    中文/全角输入法下，同一个密码可能因 Unicode 表示不同而校验失败。
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { PasswordRecord } from '../config/schema.ts';

export const DEFAULT_HASH_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

/**
 * scrypt 需要 128 * N * r 字节内存。N=16384, r=8 时是 16MiB，
 * 而 Node 的 maxmem 默认只有 32MiB —— 参数调大一档就会
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS。所以显式放大。
 */
const MAXMEM = 64 * 1024 * 1024;

// ---------------------------------------------------------------- 并发闸门

class Semaphore {
  #available: number;
  #limit: number;
  #queue: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
    this.#available = this.#limit;
  }

  get pending(): number {
    return this.#queue.length;
  }

  setLimit(limit: number): void {
    const next = Math.max(1, limit);
    this.#available += next - this.#limit;
    this.#limit = next;
    // 放宽限制后唤醒排队的请求
    while (this.#available > 0 && this.#queue.length > 0) {
      this.#available -= 1;
      this.#queue.shift()?.();
    }
  }

  /** 队列过长时返回 false，由调用方回 503，避免无限堆积 */
  tryAcquire(maxQueue: number): Promise<boolean> | false {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(true);
    }
    if (this.#queue.length >= maxQueue) return false;
    return new Promise<boolean>((resolve) => {
      this.#queue.push(() => resolve(true));
    });
  }

  release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#available = Math.min(this.#limit, this.#available + 1);
  }
}

/** 排队上限：超过就拒绝，而不是让内存无界增长 */
const MAX_HASH_QUEUE = 32;

let hashSemaphore = new Semaphore(4);

export function setHashConcurrency(limit: number): void {
  hashSemaphore.setLimit(limit);
}

/** 当前排队中的哈希请求数（供后台概览展示） */
export function pendingHashCount(): number {
  return hashSemaphore.pending;
}

// ---------------------------------------------------------------- 哈希

function deriveKey(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keylen: number },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

export async function hashPassword(
  password: string,
  salt: Buffer = randomBytes(16),
  params = DEFAULT_HASH_PARAMS,
): Promise<PasswordRecord> {
  const gate = hashSemaphore.tryAcquire(MAX_HASH_QUEUE);
  if (gate === false) throw new Error('too many concurrent password operations');

  try {
    const derived = await deriveKey(password, salt, params);
    return {
      algo: 'scrypt',
      N: params.N,
      r: params.r,
      p: params.p,
      keylen: params.keylen,
      salt: salt.toString('base64'),
      hash: derived.toString('base64'),
    };
  } finally {
    hashSemaphore.release();
  }
}

/** 计时安全比较。长度不等时必须先返回，否则 timingSafeEqual 会抛 RangeError。 */
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 校验密码。
 *
 * record 为 null（尚未设置密码）时**仍然跑一次等价的开销**，
 * 让响应时间不可区分 —— 否则攻击者能靠计时判断「这个站点还没设密码」。
 */
export async function verifyPassword(
  password: string,
  record: PasswordRecord | null,
): Promise<boolean> {
  const gate = hashSemaphore.tryAcquire(MAX_HASH_QUEUE);
  if (gate === false) throw new Error('too many concurrent password operations');

  try {
    if (record === null) {
      await deriveKey(password, Buffer.alloc(16), DEFAULT_HASH_PARAMS);
      return false;
    }

    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const derived = await deriveKey(password, salt, {
      N: record.N,
      r: record.r,
      p: record.p,
      keylen: record.keylen,
    });
    return constantTimeEqual(derived, expected);
  } finally {
    hashSemaphore.release();
  }
}

/** 存储的参数是否已落后于当前默认值（登录成功时可顺手重新哈希） */
export function needsRehash(record: PasswordRecord): boolean {
  return (
    record.N < DEFAULT_HASH_PARAMS.N ||
    record.keylen < DEFAULT_HASH_PARAMS.keylen ||
    record.algo !== 'scrypt'
  );
}
