/**
 * 词条本身的一致性检查。
 *
 * 类型系统已经保证了两件事：**键**不会漏（en-US 是 Record<MsgKey, string>），
 * 以及 `t()` 的调用方拿得到字符串。它保证不了的是**占位符**：
 *
 *   中文写 `'{product} 已启动'`、英文只写了 `'started'` —— 编译通过，
 *   英文用户看到的就是一句没了主语的话；反过来漏传参数时，`t()` 会把
 *   `{product}` 原样留在界面上（见 i18n/index.ts 的替换实现），
 *   同样是编译期发现不了的。
 *
 * 这个文件就是补这两个洞。它不测文案好不好，只测「占位符对不对得上」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LANGS, t } from '../src/i18n/index.ts';
import { zhCN } from '../src/i18n/zh-CN.ts';
import { enUS } from '../src/i18n/en-US.ts';

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const;

/** 取出 `{name}` 形式的占位符，去重并排序，便于比较 */
function placeholdersOf(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

describe('词条一致性', () => {
  const [primary, secondary] = LANGS;

  test('★ 中英两份的占位符必须完全一致', () => {
    const zh = DICTS[primary];
    const en = DICTS[secondary];
    const mismatched: string[] = [];

    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      const a = placeholdersOf(zh[key]).join(',');
      const b = placeholdersOf(en[key]).join(',');
      if (a !== b) mismatched.push(`${key}: zh{${a}} vs en{${b}}`);
    }

    assert.deepEqual(
      mismatched,
      [],
      `这些词条两种语言的占位符对不上，会让某一种语言少显示内容：\n  ${mismatched.join('\n  ')}`,
    );
  });

  test('占位符替换是「全有或全无」—— 缺参数会原样留下 {name}', () => {
    // 这不是在测一个缺陷，而是在**记录**这个失败模式：
    // 上一条测试挡住了中英不一致，调用处漏传参数则由集成测试断言页面上
    // 不出现 `{...}` 来兜。这里把行为写死，将来谁改了替换实现能立刻发现。
    const rendered = t(primary, 'cli.started', { version: '9.9.9' });
    assert.ok(rendered.includes('{product}'), '漏传的占位符应原样保留，而不是变成空串');
    assert.ok(rendered.includes('9.9.9'), '传了的占位符应被替换');
  });

  test('产品名占位符在两种语言里都在，且能被替换掉', () => {
    for (const lang of LANGS) {
      const rendered = t(lang, 'cli.started', { product: 'ACME', version: '1.0.0' });
      assert.ok(rendered.includes('ACME'), `${lang} 的产品名没被替换`);
      assert.ok(!rendered.includes('{'), `${lang} 仍残留未替换的占位符：${rendered}`);
    }
  });

  test('每个键在两种语言里都非空', () => {
    for (const lang of LANGS) {
      const empty = Object.entries(DICTS[lang])
        .filter(([, value]) => String(value).trim() === '')
        .map(([key]) => key);
      assert.deepEqual(empty, [], `${lang} 里这些键是空的：${empty.join(', ')}`);
    }
  });
});
