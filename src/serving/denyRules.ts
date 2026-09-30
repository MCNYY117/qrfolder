/**
 * 敏感文件屏蔽规则。
 *
 * 两条独立语义，不要混淆：
 *   - isDenied()   —— 硬拒绝，直接 404。列表里不显示，直接敲 URL 也拿不到。
 *   - isHidden()   —— 仅从列表隐藏，且（当 hideDotfiles 开启时）一并拒绝直连。
 *
 * 拦截点必须有两处：列表渲染时过滤 + 文件请求时拦截。
 * 只做前者是假的防护。
 */

import type { AccessConfig } from '../config/schema.ts';

/** 编译后的规则，供请求路径上快速判定 */
export type DenyRules = {
  hideDotfiles: boolean;
  /** 小写、含前导点的扩展名 */
  extensions: readonly string[];
  /** 原始通配模式，仅供后台展示 */
  filenamePatterns: readonly string[];
  /** 预编译的通配正则 */
  filenameRegexes: readonly RegExp[];
};

const regexCache = new Map<string, RegExp>();

/** 把 * 与 ? 通配模式转成正则。结果缓存，避免每请求重复编译。 */
function patternToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`);
  regexCache.set(pattern, re);
  return re;
}

export function compileDenyRules(access: AccessConfig): DenyRules {
  return {
    hideDotfiles: access.hideDotfiles,
    extensions: access.deniedExtensions.map((e) => e.toLowerCase()),
    filenamePatterns: access.deniedFilenames,
    filenameRegexes: access.deniedFilenames.map(patternToRegExp),
  };
}

/**
 * 是否硬拒绝该文件名。
 *
 * 扩展名用 endsWith 而非精确比对扩展名，是为了覆盖 `prod.env` 这类
 * 「敏感扩展名 + 自定义前缀」的常见命名。
 */
export function isDenied(name: string, rules: DenyRules): boolean {
  if (name === '' || name === '.' || name === '..') return true;

  const lower = name.toLowerCase();

  for (const ext of rules.extensions) {
    if (ext !== '' && lower.endsWith(ext)) return true;
  }
  for (const re of rules.filenameRegexes) {
    if (re.test(lower)) return true;
  }
  return false;
}

/**
 * 是否从列表中隐藏。
 * hideDotfiles 开启时，点开头的条目既不出现在列表里，也不允许直连。
 */
export function isHidden(name: string, rules: DenyRules): boolean {
  return rules.hideDotfiles && name.startsWith('.');
}

/** 该条目是否应完全不可见（不出现在列表，且直连返回 404） */
export function isBlocked(name: string, rules: DenyRules): boolean {
  return isDenied(name, rules) || isHidden(name, rules);
}
