/**
 * 应用日志（stderr/stdout）。
 *
 * 只负责「运行状态」，不记录请求 —— 请求走 logging/accessLog.ts 的环形缓冲。
 */

import type { LogLevel } from '../config/schema.ts';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: LogLevel, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra === undefined) {
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
    return;
  }

  if (level === 'error' || level === 'warn') console.error(line, extra);
  else console.log(line, extra);
}

export const log = {
  debug: (message: string, extra?: unknown): void => emit('debug', message, extra),
  info: (message: string, extra?: unknown): void => emit('info', message, extra),
  warn: (message: string, extra?: unknown): void => emit('warn', message, extra),
  error: (message: string, extra?: unknown): void => emit('error', message, extra),
};
