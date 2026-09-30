/**
 * 大小与时间的展示格式化。
 *
 * 性能要点：Intl 格式化器构造开销很大，必须缓存复用。
 * 绝不能在排序比较函数或渲染循环里 new Intl.DateTimeFormat。
 */

import type { Lang } from '../config/schema.ts';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** 人类可读的文件大小。目录请传 null，由调用方显示占位符。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 小于 10 时保留一位小数，否则取整 —— 兼顾精度与列宽
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${SIZE_UNITS[unit]}`;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(lang: Lang, timeZone: string): Intl.DateTimeFormat {
  // 'auto' 由前端按访问者设备转换；服务端先渲染服务器本地时间作为回退，
  // 这样即使浏览器禁用了 JS，显示的也是合理的时间而不是空白
  const effective = timeZone === 'auto' ? '' : timeZone;
  const key = `${lang}|${effective}`;
  const cached = dateFormatterCache.get(key);
  if (cached !== undefined) return cached;

  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (effective !== '') options.timeZone = effective;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(lang, options);
  } catch {
    // 配置里的时区非法时退回服务器本地时区，而不是让整个页面崩掉
    delete options.timeZone;
    formatter = new Intl.DateTimeFormat(lang, options);
  }
  dateFormatterCache.set(key, formatter);
  return formatter;
}

/** 展示用时间，如 2026-09-23 14:30 */
export function formatDateTime(date: Date, lang: Lang, timeZone: string): string {
  return getDateFormatter(lang, timeZone).format(date);
}

/** <time datetime="..."> 用的机器可读形式 */
export function toIsoString(date: Date): string {
  return date.toISOString();
}

/** 运行时长，如 "2d 3h 4m" */
export function formatUptime(seconds: number, lang: Lang): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}${lang === 'zh-CN' ? '天' : 'd'}`);
  if (hours > 0) parts.push(`${hours}${lang === 'zh-CN' ? '小时' : 'h'}`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}${lang === 'zh-CN' ? '分' : 'm'}`);
  return parts.join(' ');
}

const collatorCache = new Map<string, Intl.Collator>();

/**
 * 取排序器。numeric: true 让 file2 排在 file10 前面，符合直觉。
 *
 * ★ 结果必须缓存。在比较函数里 new Intl.Collator 会让排序慢两个数量级，
 *   几百个文件的目录就能把事件循环卡住。
 */
export function getCollator(lang: Lang): Intl.Collator {
  const cached = collatorCache.get(lang);
  if (cached !== undefined) return cached;

  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
  collatorCache.set(lang, collator);
  return collator;
}
