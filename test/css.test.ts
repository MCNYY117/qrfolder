import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { centeredCss, listingCss } from '../src/views/styles.ts';
import { baseCss } from '../src/views/baseCss.ts';
import { adminCss } from '../src/views/adminStyles.ts';

/**
 * 内容页 CSS 的冻结基线。
 *
 * 存在的理由：公网内容页正在线上服务真实访客，而后台要跟它共用一套样式
 * （`views/baseCss.ts`）。把规则搬来搬去很容易顺手改掉一点东西 ——
 * 「少了一条 `tbody tr:hover`」这种变化肉眼几乎看不出来，等到有人说
 * 「表格怎么没有悬停高亮了」时，中间已经过去了十几个提交。
 *
 * ★ 比对的是「选择器 → 声明」的集合，**不是**文本。重构本来就会重排规则，
 *   而这里要钉住的是「有哪些规则、每条规则写了什么」。所以：
 *     - 少一个选择器、少一条声明、改一个值  → 炸
 *     - 多出来的选择器只有一种合法来源：共用基底 baseCss
 *     - `:root` 这类变量块允许**新增**自定义属性（没人引用就没有效果），
 *       但已有的自定义属性值不许变
 *
 * 要**有意识地**改内容页样式时，请连着这份基线一起改，并在提交信息里说明。
 */

/** 一条规则：选择器 + 它声明的那些属性 */
type Rule = { selector: string; decls: string[] };

/**
 * 把样式表拆成规则列表。
 *
 * 只需要处理这个项目里用到的 CSS：普通规则 + `@media` 嵌套。
 * `@media` 里的规则会带上条件前缀（`@media (max-width: 640px) >> .wrap`），
 * 这样「同一条规则换个断点」不会被当成没变。
 */
function cssRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  let i = 0;

  while (i < stripped.length) {
    const open = stripped.indexOf('{', i);
    if (open === -1) break;
    const selector = stripped.slice(i, open).trim().replace(/\s+/g, ' ');

    // 花括号配对。这里必须数深度而不是找下一个 '}' —— @media 里还有一层
    let depth = 1;
    let j = open + 1;
    while (j < stripped.length && depth > 0) {
      if (stripped[j] === '{') depth++;
      else if (stripped[j] === '}') depth--;
      j++;
    }

    const body = stripped.slice(open + 1, j - 1);
    if (selector.startsWith('@media') || selector.startsWith('@supports')) {
      for (const rule of cssRules(body)) {
        out.push({ selector: `${selector} >> ${rule.selector}`, decls: rule.decls });
      }
    } else {
      out.push({
        selector,
        decls: body
          .split(';')
          .map((decl) => decl.trim().replace(/\s+/g, ' '))
          .filter((decl) => decl !== ''),
      });
    }
    i = j;
  }
  return out;
}

/** 按选择器归并。同一个选择器出现多次（`:root` 就有两处）时声明合并看待 —— */
/** CSS 变量本来就是这么叠加的，分开比会把「合并成一条」误判成丢失。 */
function bySelector(rules: readonly Rule[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rule of rules) {
    const existing = map.get(rule.selector);
    if (existing === undefined) map.set(rule.selector, [...rule.decls]);
    else existing.push(...rule.decls);
  }
  return map;
}

function isCustomProperty(decl: string): boolean {
  return decl.startsWith('--');
}

/** 基线文本（`选择器 :: 声明; 声明` 一行一条）拆回规则 */
function parseBaseline(text: string): Rule[] {
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf(' :: ');
      return {
        selector: line.slice(0, at),
        decls: line
          .slice(at + 4)
          .split('; ')
          .filter((decl) => decl !== ''),
      };
    });
}

/**
 * 实际样式必须覆盖基线里的每一条；多出来的部分只允许有两种来源：
 * 共用基底里的选择器，或者 `:root` 里新增的自定义属性。
 */
function assertCoversBaseline(actualCss: string, baselineText: string, allowFrom: string, label: string): void {
  const actual = bySelector(cssRules(actualCss));
  const baseline = bySelector(parseBaseline(baselineText));
  const fromBase = bySelector(cssRules(allowFrom));
  const failures: string[] = [];

  // 1. 基线里的每一条都得还在
  for (const [selector, decls] of baseline) {
    const have = actual.get(selector);
    if (have === undefined) {
      failures.push(`少了整条规则：${selector}`);
      continue;
    }
    for (const decl of decls) {
      if (!have.includes(decl)) failures.push(`${selector} 少了声明：${decl}`);
    }
  }

  // 2. 实际样式里不能多出基线之外的东西
  for (const [selector, decls] of actual) {
    const expected = baseline.get(selector);

    if (expected === undefined) {
      // 基线里没有这个选择器：只允许它整条来自共用基底
      const contributed = fromBase.get(selector);
      if (contributed === undefined) {
        failures.push(`多了一条基线里没有的规则：${selector}`);
        continue;
      }
      for (const decl of decls) {
        if (!contributed.includes(decl)) {
          failures.push(`${selector} 多了一条基线里没有的声明：${decl}`);
        }
      }
      continue;
    }

    for (const decl of decls) {
      if (expected.includes(decl)) continue;
      // ★ 基底往 :root 里多塞几个变量是安全的：没有规则引用它就没有任何效果。
      //   但已有变量的**值**不许变 —— 上面第 1 步已经拦住了。
      if (selector.startsWith(':root') && isCustomProperty(decl)) continue;
      if (fromBase.get(selector)?.includes(decl) === true) continue;
      failures.push(`${selector} 多了一条基线里没有的声明：${decl}`);
    }
  }

  assert.deepEqual(failures, [], `${label} 的样式相对基线变了：\n  ${failures.join('\n  ')}`);
}

// ---------------------------------------------------------------- 基线

const LISTING_BASELINE = `
* :: box-sizing: border-box; margin: 0; padding: 0
.crumbs :: font-size: 13px; color: var(--muted); margin-bottom: 10px; word-break: break-all
.crumbs .sep :: margin: 0 6px; opacity: .55
.crumbs a :: color: var(--muted)
.crumbs a:hover :: color: var(--accent)
.empty :: padding: 44px 16px; text-align: center; color: var(--muted); font-size: 14px
.empty.hide :: display: none
.head :: display: flex; align-items: flex-start; justify-content: space-between; gap: 16px
.head-actions :: flex: 0 0 auto; display: flex; align-items: center; gap: 8px
.head-main :: min-width: 0
.ic :: flex: 0 0 22px; width: 22px; height: 22px; position: relative; display: inline-block
.ic.dir :: background: var(--dir); border-radius: 3px; height: 16px; margin-top: 3px
.ic.dir::before :: content: ""; position: absolute; left: 0; top: -4px; width: 10px; height: 5px; background: var(--dir); border-radius: 2px 2px 0 0
.ic.file :: background: var(--hover); border: 1px solid var(--line); border-radius: 4px; height: 20px; width: 26px; flex: 0 0 26px; margin-top: 1px
.ic.file::after :: content: attr(data-ext); position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 700; letter-spacing: .2px; color: var(--file); text-transform: uppercase
.label :: min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap
.lang-switch, .theme-switch :: font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; white-space: nowrap
.lang-switch:hover, .theme-switch:hover :: color: var(--accent); border-color: var(--accent); text-decoration: none
.notice :: margin: 12px 0 0; padding: 10px 14px; border-radius: 8px; font-size: 13px; background: var(--hover); color: var(--muted); border: 1px solid var(--line)
.panel :: background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; box-shadow: var(--shadow)
.summary :: font-size: 13px; color: var(--muted); margin-top: 6px
.theme-switch :: align-items: center; gap: 5px
.theme-switch svg :: display: block
.toolbar :: margin: 22px 0 12px
.toolbar input :: width: 100%; max-width: 320px; padding: 9px 13px; font-size: 14px; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; outline: none; font-family: inherit
.toolbar input:focus :: border-color: var(--accent)
.up a :: display: inline-flex; align-items: center; gap: 9px; color: var(--muted); font-size: 14px
.up a:hover :: color: var(--accent)
.up td :: padding: 10px 16px
.wrap :: max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px
:root :: --bg: #f6f7f9; --card: #ffffff; --fg: #1f2328; --muted: #6b7280; --line: #e6e8eb; --accent: #2563eb; --hover: #f2f4f7; --shadow: 0 1px 2px rgba(16, 24, 40, .06); --dir: #f59e0b; --file: #9aa4b2; --row-line: 1.6
:root :: color-scheme: light
:root .theme-switch :: display: none
:root[data-theme="auto"] :: color-scheme: light dark
:root[data-theme="dark"] :: color-scheme: dark
:root[data-theme="dark"] :: --bg: #0f1115; --card: #171a1f; --fg: #e7e9ec; --muted: #98a1ad; --line: #272c34; --hover: #1d222a; --shadow: none; --file: #6b7684
@media (max-width: 640px) >> .wrap :: padding: 20px 12px 48px
@media (max-width: 640px) >> h1 :: font-size: 20px
@media (max-width: 640px) >> tbody td :: padding: 9px 12px
@media (max-width: 640px) >> tbody td.c-time :: font-size: 12px
@media (max-width: 640px) >> th.c-size, td.c-size :: display: none
@media (max-width: 640px) >> th.c-time, td.c-time :: width: 118px; font-size: 12px
@media (prefers-color-scheme: dark) >> :root[data-theme="auto"] :: --bg: #0f1115; --card: #171a1f; --fg: #e7e9ec; --muted: #98a1ad; --line: #272c34; --hover: #1d222a; --shadow: none; --file: #6b7684
@media (prefers-color-scheme: dark) >> [data-theme="auto"] .theme-switch.to-dark :: display: none
@media (prefers-color-scheme: dark) >> [data-theme="auto"] .theme-switch.to-light :: display: inline-flex
[data-theme="light"] .theme-switch.to-dark, [data-theme="dark"] .theme-switch.to-light, [data-theme="auto"] .theme-switch.to-dark :: display: inline-flex
a :: color: inherit; text-decoration: none
body :: background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif; font-size: 15px; line-height: var(--row-line); -webkit-font-smoothing: antialiased
h1 :: font-size: 24px; font-weight: 600; letter-spacing: -.2px; word-break: break-all
html, body :: height: 100%
table :: width: 100%; border-collapse: collapse; table-layout: fixed
tbody td :: padding: 10px 16px; border-bottom: 1px solid var(--line); vertical-align: middle
tbody tr:hover :: background: var(--hover)
tbody tr:last-child td :: border-bottom: none
td.c-name a :: display: flex; align-items: center; gap: 11px; min-width: 0
td.c-name a:hover .label :: color: var(--accent)
td.c-size :: color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums
td.c-time :: color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums
th.c-size, td.c-size :: width: 110px; text-align: right
th.c-time, td.c-time :: width: 170px
thead th :: font-size: 12px; font-weight: 600; color: var(--muted); text-align: left; padding: 11px 16px; border-bottom: 1px solid var(--line); background: var(--bg); white-space: nowrap
thead th a :: color: var(--muted)
thead th a:hover :: color: var(--accent)
tr.hide :: display: none
`;

const CENTERED_BASELINE = `
* :: box-sizing: border-box; margin: 0; padding: 0
.error :: color: var(--danger); font-size: 13px; margin-top: 4px
:root :: --accent: #2563eb; --bg: #f6f7f9; --fg: #1f2328; --muted: #6b7280; --field: #ffffff; --line: #d8dce1; --danger: #dc2626
:root :: color-scheme: light
:root[data-theme="auto"] :: color-scheme: light dark
:root[data-theme="dark"] :: color-scheme: dark
:root[data-theme="dark"] :: --bg: #0f1115; --fg: #e7e9ec; --muted: #98a1ad; --field: #171a1f; --line: #272c34; --danger: #f87171
@media (prefers-color-scheme: dark) >> :root[data-theme="auto"] :: --bg: #0f1115; --fg: #e7e9ec; --muted: #98a1ad; --field: #171a1f; --line: #272c34; --danger: #f87171
body :: display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 15px
button :: padding: 10px 16px; font-size: 15px; font-family: inherit; cursor: pointer; border: none; border-radius: 8px; background: var(--accent); color: #fff
button:disabled :: opacity: .55; cursor: not-allowed
form :: margin-top: 22px; display: flex; flex-direction: column; gap: 10px
h1 :: margin: 0; font-size: 38px; font-weight: 600; letter-spacing: -1px
html, body :: height: 100%
input[type="password"] :: padding: 10px 13px; font-size: 15px; font-family: inherit; border: 1px solid var(--line); border-radius: 8px; outline: none; background: var(--field); color: inherit
input[type="password"]:focus :: border-color: var(--accent)
main :: text-align: center; padding: 24px; max-width: 420px
p :: margin: 10px 0 0; color: var(--muted); font-size: 14px
`;

const BASE = baseCss({
  accentColor: '#2563eb',
  folderColor: '#f59e0b',
  cellPadY: '10px',
  rowLine: '1.6',
});

describe('共用样式基底', () => {
  test('★ 内容页 CSS 相对基线没有变样', () => {
    assertCoversBaseline(
      listingCss({ accentColor: '#2563eb', folderColor: '#f59e0b', density: 'comfortable' }),
      LISTING_BASELINE,
      BASE,
      '内容页',
    );
  });

  test('★ 错误页 / 密码页 / 主界面的 CSS 相对基线没有变样', () => {
    assertCoversBaseline(centeredCss({ accentColor: '#2563eb' }), CENTERED_BASELINE, BASE, '居中页');
  });

  test('紧凑密度只改行高与单元格内边距，不改规则集合', () => {
    const compact = cssRules(listingCss({ accentColor: '#2563eb', folderColor: '#f59e0b', density: 'compact' }));
    const normal = cssRules(listingCss({ accentColor: '#2563eb', folderColor: '#f59e0b', density: 'comfortable' }));
    assert.deepEqual(
      compact.map((rule) => rule.selector),
      normal.map((rule) => rule.selector),
    );
    const pad = (rules: readonly Rule[]): string =>
      rules.find((rule) => rule.selector === 'tbody td')?.decls.join('; ') ?? '';
    assert.match(pad(compact), /padding: 6px 16px/);
    assert.match(pad(normal), /padding: 10px 16px/);
  });

  /**
   * ★ 三条踩过坑的结构性断言。这些不是「样式好不好看」，而是「有没有又踩同一个坑」。
   */
  test('★ 后台也用 .crumbs，所以基底里必须有它的定义（用过类名却没定义那次的回归）', () => {
    const admin = cssRules(adminCss({ accentColor: '#2563eb' })).map((rule) => rule.selector);
    // 后台视图里确实在用（adminFiles.ts 的面包屑）
    assert.ok(
      admin.includes('.crumbs') || admin.some((selector) => selector.includes('.crumbs')),
      '后台样式里没有 .crumbs —— 面包屑会退化成浏览器默认样式',
    );
  });

  test('★ .top .theme-switch 不许出现 display（会盖掉共享的显隐规则）', () => {
    const rule = cssRules(adminCss({ accentColor: '#2563eb' })).find(
      (item) => item.selector === '.top .theme-switch',
    );
    assert.ok(rule !== undefined, '应当有一条 .top .theme-switch 的版式规则');
    assert.ok(
      !rule.decls.some((decl) => decl.startsWith('display')),
      '写了 display 就会把 :root .theme-switch 的 display:none 盖掉，两个主题按钮会同时出现',
    );
  });

  test('★ 生成的 CSS 花括号必须配平（模板字符串里的注释带反引号会截断它）', () => {
    for (const [label, css] of [
      ['内容页', listingCss({ accentColor: '#2563eb', folderColor: '#f59e0b', density: 'comfortable' })],
      ['居中页', centeredCss({ accentColor: '#2563eb' })],
      ['后台', adminCss({ accentColor: '#2563eb' })],
    ] as const) {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const open = (stripped.match(/\{/g) ?? []).length;
      const close = (stripped.match(/\}/g) ?? []).length;
      assert.equal(open, close, `${label} 的 CSS 花括号不配平（${open} 个 {，${close} 个 }）`);
    }
  });

  /**
   * ★ 抽屉导航的关键约束。踩了就很难自己发现的点：
   *   没有 JS 时，导航必须仍然**能用**（页首一条横向导航），
   *   而不是「藏起来打不开」。所以抽屉那套规则必须挂在 html.js 下面 ——
   *   `.js` 是脚本跑起来之后才加到 <html> 上的。
   */
  test('★ 抽屉样式必须挂在 html.js 下（否则没 JS 时导航直接消失）', () => {
    const rules = cssRules(adminCss({ accentColor: '#2563eb' }));

    const moved = rules.filter((rule) => rule.decls.some((decl) => decl.includes('translateX(-100%)')));
    assert.ok(moved.length > 0, '应当有把侧栏推出屏幕的规则（抽屉收起状态）');
    for (const rule of moved) {
      assert.match(
        rule.selector,
        /html\.js/,
        `${rule.selector} 没有 html.js 前缀 —— 没有 JS 的浏览器会看不到任何导航`,
      );
    }

    // 同一断点里必须先有无 JS 的兜底版式，抽屉才有东西可覆盖
    const fallback = rules.find(
      (rule) => rule.selector === '@media (max-width: 780px) >> .side',
    );
    assert.ok(fallback !== undefined, '780px 断点里应当有一条无 JS 的侧栏版式（页首横向导航）');
  });

  test('★ 汉堡按钮默认隐藏，只在有 JS 的窄屏里出现', () => {
    const rules = cssRules(adminCss({ accentColor: '#2563eb' }));
    const base = rules.find((rule) => rule.selector === '.burger, .nav-scrim');
    assert.deepEqual(base?.decls, ['display: none'], '默认必须藏起来（宽屏和没 JS 时都不该出现）');
    assert.ok(
      rules.some((rule) => rule.selector === '@media (max-width: 780px) >> html.js .burger'),
      '窄屏 + 有 JS 时要把汉堡放出来',
    );
  });

  /**
   * ★ 视图里一个内联 style 属性都不许有。
   *
   *   本站 CSP 是 style-src 'nonce-...'，内联 style 属性会被浏览器**直接丢掉** ——
   *   不报错、不警告，就是不生效。于是页面上看到的是「样式没写」的样子，
   *   而写代码的人以为写好了。仓库里曾经散着三十来处，扫掉之后用这条钉住，
   *   免得下次又顺手写一个 style="margin-top:12px"。
   *
   *   注：注释里提到 style="..." 是允许的（上面这段就在提），所以先把块注释
   *   挖掉再扫 —— **保留换行**，否则行号会漂。
   */
  test('★ 视图源码里不许出现内联 style 属性（CSP 会把它丢掉）', () => {
    const dir = fileURLToPath(new URL('../src/views', import.meta.url));
    const offenders: string[] = [];

    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) =>
        block.replace(/[^\n]/g, ' '),
      );
      source.split(/\r?\n/).forEach((line, index) => {
        if (!line.includes('style="')) return;
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) return;
        offenders.push(`${name}:${index + 1}  ${trimmed}`);
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `这些地方写了内联 style，浏览器不会认：\n  ${offenders.join('\n  ')}\n改用 adminStyles.ts 里的类名。`,
    );
  });

  /**
   * ★ 行内操作必须能换行。
   *
   *   表格是 table-layout: fixed —— 每列只拿到「宽度 ÷ 列数」，目录页五列在
   *   1080px 版心上操作列只有 206px，而五个按钮排一行要 338px。不许换行的话
   *   它们横向溢出单元格，再被 .panel 的 overflow: hidden 裁掉：
   *   表现是「最后那个删除按钮不见了」，宽屏窄屏都会发生。
   *
   *   node --test 里没有排版引擎，量不出 338 > 206，但「能不能换行」是声明层面的
   *   事实，钉住它就够了 —— 这类溢出只有换行一条出路。
   */
  test('★ .row-actions 必须允许换行（否则会被 .panel 的 overflow:hidden 裁掉）', () => {
    const rule = cssRules(adminCss({ accentColor: '#2563eb' })).find(
      (item) => item.selector === '.row-actions',
    );
    assert.ok(rule !== undefined, '应当有一条 .row-actions 的版式规则');
    assert.ok(
      rule.decls.includes('flex-wrap: wrap'),
      '不给换行的话，按钮会溢出单元格并被隐藏 —— 看着就是「删除按钮被遮挡了」',
    );
  });

  test('★ 颜色值必须过白名单：配置里的值不能直接拼进 <style>', () => {
    const evil = listingCss({
      accentColor: '#fff}</style><script>alert(1)</script>',
      folderColor: 'red; } body { display: none',
      density: 'comfortable',
    });
    assert.doesNotMatch(evil, /<\/style>/, '非法颜色值不能活着进到样式表里');
    assert.doesNotMatch(evil, /<script/);
    assert.match(evil, /--accent: #2563eb/, '非法值应当回退到默认色');
  });
});
