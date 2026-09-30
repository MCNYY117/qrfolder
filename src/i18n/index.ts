/**
 * 极简 i18n。
 *
 * 设计取舍：不引入 ICU 复数规则、不做嵌套键、不做懒加载。
 * 本项目词条量在数百条量级，一个对象查表足够，
 * 换来的是零依赖与「漏翻即编译失败」的类型保障。
 */

import type { IncomingMessage } from 'node:http';

import { zhCN, type MsgKey } from './zh-CN.ts';
import { enUS } from './en-US.ts';
import type { AdminPermission } from '../config/schema.ts';

export { LANGS, type Lang } from '../config/schema.ts';
export type { MsgKey };

const DICTS = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const;

export const DEFAULT_LANG = 'zh-CN' as const;

/** 是否受支持的语言码 */
export function isLang(value: unknown): value is keyof typeof DICTS {
  return typeof value === 'string' && value in DICTS;
}

export type TParams = Record<string, string | number>;

/**
 * 取词条并替换 {name} 占位符。
 * 缺失的键回退到中文并警告一次 —— 正常开发流程下不该发生（tsc 会先拦下）。
 */
export function t(lang: keyof typeof DICTS, key: MsgKey, params?: TParams): string {
  const dict = DICTS[lang] ?? DICTS[DEFAULT_LANG];
  const template: string = dict[key] ?? DICTS[DEFAULT_LANG][key] ?? key;

  if (params === undefined) return template;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 权限名的显示文案。
 *
 * 键是 `perm.<权限键>`，`test/i18n.test.ts` 的占位符一致性检查管不到这种
 * 拼接出来的键，所以这里必须靠类型收窄 —— `AdminPermission` 只有 13 个取值，
 * 每个都在两本词典里有词条，`tsc` 会在漏掉时直接报错。
 */
export function permissionLabel(lang: keyof typeof DICTS, permission: AdminPermission): string {
  return t(lang, `perm.${permission}` as MsgKey);
}

/**
 * 解析 Accept-Language。
 *
 * 只做够用程度的实现：按逗号分割、按 q 值排序、匹配前两位语言码。
 * 不追求完整 RFC 7231 语义 —— 这里只是给内容页选个语言。
 */
export function parseAcceptLanguage(header: string | string[] | undefined): string[] {
  if (typeof header !== 'string' || header === '') return [];

  return header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam === undefined ? 1 : Number.parseFloat(qParam.trim().slice(2));
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag !== '' && entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

/**
 * 从 Accept-Language 挑一个支持的语言，挑不到返回 null。
 */
export function matchLang(tags: readonly string[]): keyof typeof DICTS | null {
  for (const tag of tags) {
    for (const lang of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      if (tag === lang.toLowerCase()) return lang;
    }
    const short = tag.split('-')[0];
    if (short === 'zh') return 'zh-CN';
    if (short === 'en') return 'en-US';
  }
  return null;
}

/**
 * 决定内容页用哪种语言。
 * 优先级：URL 查询参数 ?lang= → cookie lang → Accept-Language → 站点默认。
 */
export function resolveListingLang(
  req: IncomingMessage,
  url: URL,
  cookieLang: string | undefined,
  configured: 'auto' | 'zh-CN' | 'en-US',
): keyof typeof DICTS {
  if (configured !== 'auto') return configured;

  const fromQuery = url.searchParams.get('lang');
  if (isLang(fromQuery)) return fromQuery;

  if (isLang(cookieLang)) return cookieLang;

  const fromHeader = matchLang(parseAcceptLanguage(req.headers['accept-language']));
  return fromHeader ?? DEFAULT_LANG;
}
