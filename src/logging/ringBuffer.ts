/**
 * 定长环形缓冲。
 *
 * ★ 绝不用 Array.prototype.shift() 实现 —— 它是 O(n)，
 *   每次请求都要搬动整个数组，高流量下会成为热点。
 *   这里用取模下标，push 是 O(1)。
 */
export class RingBuffer<T> {
  readonly capacity: number;

  #items: (T | undefined)[];
  /** 最旧元素的下标 */
  #start = 0;
  #count = 0;
  /** 单调递增序号，供后台增量拉取 */
  #seq = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.#items = new Array<T | undefined>(this.capacity);
  }

  get size(): number {
    return this.#count;
  }

  /** 最新一条的序号（没有数据时为 0） */
  get sequence(): number {
    return this.#seq;
  }

  /** @returns 本次写入的序号 */
  push(item: T): number {
    const index = (this.#start + this.#count) % this.capacity;
    if (this.#count < this.capacity) {
      this.#count += 1;
    } else {
      // 已满：覆盖最旧的一条
      this.#start = (this.#start + 1) % this.capacity;
    }
    this.#items[index] = item;
    this.#seq += 1;
    return this.#seq;
  }

  /** 由旧到新返回全部条目 */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.#count; i += 1) {
      const item = this.#items[(this.#start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.#items = new Array<T | undefined>(this.capacity);
    this.#start = 0;
    this.#count = 0;
  }
}
