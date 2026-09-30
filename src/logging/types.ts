/** 一条访问日志。字段在入队时即截断，避免环形缓冲变成内存炸弹。 */
export type AccessLogEntry = {
  time: number;
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  durationMs: number;
  userAgent: string;
};

/** 字段长度上限。User-Agent 可达数百 KB，不截断就是内存泄漏。 */
export const ACCESS_LOG_LIMITS = {
  path: 512,
  userAgent: 256,
  ip: 64,
} as const;
