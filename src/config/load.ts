/**
 * 配置文件的读写。
 *
 * 用 JSON 而非 JS/TS：后台要写回、要能导出导入、要能被非程序员编辑。
 *
 * ★ 必须用 fs.readFile + JSON.parse，绝不能用
 *   `import cfg from './config.json' with { type: 'json' }` ——
 *   模块缓存会让热重载静默失效（永远读到第一次的内容）。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_CONFIG, type Config } from './schema.ts';
import { validateConfig, type ValidationIssue, type ValidateOptions } from './validate.ts';

export type LoadResult = {
  /** 文件是否已存在 */
  existed: boolean;
  config: Config;
  issues: ValidationIssue[];
  /** 解析失败时的原始错误 */
  parseError?: string;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读取并校验配置。文件不存在时返回带默认值的空配置（不落盘）。
 */
export async function loadConfigFile(
  filePath: string,
  options: ValidateOptions = {},
): Promise<LoadResult> {
  let text: string;
  try {
    // 剥掉可能存在的 UTF-8 BOM：Windows 上的记事本、PowerShell 的
    // Set-Content -Encoding UTF8 等都会写入 BOM，而 JSON.parse 会直接报错，
    // 表现为「配置文件明明是对的却解析失败」。
    text = (await fs.readFile(filePath, 'utf8')).replace(/^﻿/, '');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { existed: false, config: structuredClone(DEFAULT_CONFIG), issues: [] };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    // 解析失败时返回默认配置，但必须带上 parseError，
    // 由 store 决定「保留旧配置」而不是采用这份默认值。
    return {
      existed: true,
      config: structuredClone(DEFAULT_CONFIG),
      issues: [{ at: '', message: 'JSON 解析失败' }],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const result = validateConfig(raw, options);
  return { existed: true, config: result.config, issues: result.issues };
}

/**
 * 原子写配置。
 *
 * 先写 .tmp 再 rename 覆盖 —— 中途崩溃不会留下半截文件。
 * Windows 上杀毒软件/索引器可能短暂占用目标文件导致 EPERM/EBUSY，需要重试。
 */
export async function writeConfigAtomic(filePath: string, config: Config): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = `${filePath}.tmp`;
  const json = `${JSON.stringify(config, null, 2)}\n`;
  // 不带 BOM：Node 的 JSON.parse 会拒绝 UTF-8 BOM
  await fs.writeFile(tmp, json, 'utf8');

  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (attempt >= 3 || !retryable) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      await delay(50 * (attempt + 1));
    }
  }
}

/** 首次运行时生成会话密钥 */
export function generateSessionSecret(): string {
  return randomBytes(32).toString('base64');
}

/** 取配置文件的最后修改时间（毫秒），不存在返回 0 */
export async function getMtimeMs(filePath: string): Promise<number> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}
