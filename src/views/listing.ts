/**
 * 目录列表页。
 *
 * 关键行为：**永远显示列表，绝不因为目录里存在 index.html 而改为返回它**。
 * 这一条由 serving/resolveTarget.ts 保证（它根本不检查默认文档），
 * 本文件只负责渲染。
 */

import type { AppearanceConfig, Lang, SortField, SortOrder, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml, headMeta, themeSwitchHtml } from './html.ts';
import { listingCss } from './styles.ts';
import { formatBytes, formatDateTime, toIsoString } from '../serving/format.ts';

export type ListingItemView = {
  /** 显示名（已解码的原始文件名） */
  name: string;
  /** 已做百分号编码的链接 */
  href: string;
  isDir: boolean;
  /** 目录传 null */
  size: number | null;
  mtime: Date;
  /** 扩展名徽章文字（服务端算好，不再依赖前端 JS 推断） */
  ext: string;
};

export type ListingBreadcrumb = {
  text: string;
  href: string;
};

export type ListingViewOptions = {
  lang: Lang;
  appearance: AppearanceConfig;
  nonce: string;
  /** 页面标题：站点标题优先，否则用当前目录名 */
  title: string;
  breadcrumbs: ListingBreadcrumb[];
  items: ListingItemView[];
  numDirs: number;
  numFiles: number;
  canGoUp: boolean;
  sort: SortField;
  order: SortOrder;
  truncated: boolean;
  limit: number;
  /** 需要沿用到排序链接里的其它查询参数，如 'lang=en-US' */
  preservedQuery: string;
  /** 语言切换链接；为 null 时不渲染 */
  langSwitchHref: string | null;
  /** 本次生效的主题，写到 <html data-theme> */
  theme: ThemeMode;
  /** 主题切换链接；为 null 时不渲染 */
  themeSwitch: { toLight: string; toDark: string } | null;
};

/**
 * 生成表头排序链接：点击在升降序间切换，换列则从升序开始。
 *
 * `preserved` 是必须沿用下去的其它查询参数（目前是 lang）——
 * 不带上它，用户切一次语言或排序就会把另一个设置丢掉。
 */
function sortHeader(
  lang: Lang,
  field: SortField,
  currentSort: SortField,
  currentOrder: SortOrder,
  label: string,
  preserved: string,
): string {
  const isActive = currentSort === field;
  const nextOrder: SortOrder = isActive && currentOrder === 'asc' ? 'desc' : 'asc';
  const suffix = preserved === '' ? '' : `&amp;${preserved}`;

  if (isActive) {
    const dirLabel = t(lang, currentOrder === 'asc' ? 'listing.sortAsc' : 'listing.sortDesc');
    const arrow = currentOrder === 'asc' ? ' ↑' : ' ↓';
    return `<a href="?sort=${field}&amp;order=${nextOrder}${suffix}" title="${escapeHtml(dirLabel)}">${escapeHtml(label)}${arrow}</a>`;
  }
  return `<a href="?sort=${field}&amp;order=${nextOrder}${suffix}">${escapeHtml(label)}</a>`;
}

export function renderListing(options: ListingViewOptions): string {
  const { lang, appearance } = options;
  const css = listingCss({
    accentColor: appearance.accentColor,
    folderColor: appearance.folderColor,
    density: appearance.density,
    customCss: appearance.customCss,
  });

  // ---- 面包屑：仅在层级足够深时显示 ----
  // 站点根路径是被封锁的（返回 404），所以第一段不可点，
  // 否则用户点一下面包屑就撞 404。
  const showCrumbs = appearance.showBreadcrumbs && options.breadcrumbs.length > 1;
  const crumbsHtml = showCrumbs
    ? `<nav class="crumbs">${options.breadcrumbs
        .map((crumb, i) => {
          const sep = i > 0 ? '<span class="sep">/</span>' : '';
          return `${sep}<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.text)}</a>`;
        })
        .join('')}</nav>`
    : '';

  const summaryHtml = appearance.showSummary
    ? `<div class="summary">${escapeHtml(
        t(lang, 'listing.summary', { dirs: options.numDirs, files: options.numFiles }),
      )}</div>`
    : '';

  const toolbarHtml = appearance.showFilterBox
    ? `<div class="toolbar">
    <input id="filter" type="search" placeholder="${escapeHtml(t(lang, 'listing.filterPlaceholder'))}" autocomplete="off" spellcheck="false">
  </div>`
    : '';

  // ---- 表头 ----
  const preserved = options.preservedQuery;
  const sizeTh = appearance.showFileSize
    ? `<th class="c-size">${sortHeader(lang, 'size', options.sort, options.order, t(lang, 'listing.colSize'), preserved)}</th>`
    : '';
  const timeTh = appearance.showModTime
    ? `<th class="c-time">${sortHeader(lang, 'time', options.sort, options.order, t(lang, 'listing.colTime'), preserved)}</th>`
    : '';
  const colCount = 1 + (appearance.showFileSize ? 1 : 0) + (appearance.showModTime ? 1 : 0);

  // ---- 行 ----
  const upRow = options.canGoUp
    ? `<tr class="up"><td colspan="${colCount}"><a href="..">${escapeHtml(t(lang, 'listing.up'))}</a></td></tr>`
    : '';

  const rows = options.items
    .map((item) => {
      const icon = item.isDir
        ? '<i class="ic dir"></i>'
        : `<i class="ic file" data-ext="${escapeHtml(item.ext)}"></i>`;

      const sizeTd = appearance.showFileSize
        ? `<td class="c-size">${item.isDir || item.size === null ? '—' : escapeHtml(formatBytes(item.size))}</td>`
        : '';
      // timeZone='auto' 时打上标记，由前端按访问者设备就地转换；
      // 服务端先渲染服务器本地时间作为回退
      const tzAttr = appearance.timeZone === 'auto' ? ' data-tz="auto"' : '';
      const timeTd = appearance.showModTime
        ? `<td class="c-time"><time datetime="${toIsoString(item.mtime)}"${tzAttr}>${escapeHtml(
            formatDateTime(item.mtime, lang, appearance.timeZone),
          )}</time></td>`
        : '';

      return `<tr>
      <td class="c-name"><a href="${escapeHtml(item.href)}">${icon}<span class="label">${escapeHtml(item.name)}</span></a></td>
      ${sizeTd}
      ${timeTd}
    </tr>`;
    })
    .join('\n    ');

  const emptyText = options.items.length === 0 && !options.canGoUp
    ? t(lang, 'listing.emptyDir')
    : t(lang, 'listing.empty');

  const truncatedNotice = options.truncated
    ? `<div class="notice">${escapeHtml(t(lang, 'listing.truncated', { limit: options.limit }))}</div>`
    : '';

  const footer = appearance.footerText !== ''
    ? `<div class="notice">${escapeHtml(appearance.footerText)}</div>`
    : '';

  // 页面脚本统一在这里拼装：内联事件处理器会被本站 CSP 拒绝，
  // 所有交互都必须走 addEventListener。
  const scriptParts: string[] = [];

  if (appearance.timeZone === 'auto' && appearance.showModTime) {
    scriptParts.push(`  // 时区跟随访问者设备：把服务端渲染的服务器本地时间就地转换。
  // 转换失败（或被禁用 JS）时保留服务端渲染的回退值，不会出现空白。
  var tzTimes = document.querySelectorAll('time[data-tz="auto"]');
  for (var t = 0; t < tzTimes.length; t++) {
    (function (el) {
      var when = new Date(el.getAttribute('datetime'));
      if (isNaN(when.getTime())) return;
      try {
        el.textContent = when.toLocaleString(navigator.language || undefined, {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
      } catch (err) { /* 保留回退值 */ }
    })(tzTimes[t]);
  }`);
  }

  if (appearance.showFilterBox) {
    // 用 class 切换而非 inline style —— CSP 的 style-src 不带
    // 'unsafe-inline' 时会拦截 element.style 赋值。
    scriptParts.push(`  var input = document.getElementById('filter');
  if (input) {
    var empty = document.getElementById('empty');
    var rows = document.querySelectorAll('#rows tr:not(.up)');
    var apply = function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      for (var i = 0; i < rows.length; i++) {
        var label = rows[i].querySelector('.label');
        var hit = !q || (label && label.textContent.toLowerCase().indexOf(q) !== -1);
        rows[i].classList.toggle('hide', !hit);
        if (hit) shown++;
      }
      if (empty) empty.classList.toggle('hide', shown > 0);
    };
    input.addEventListener('input', apply);
    input.addEventListener('keyup', function (e) {
      if (e.key === 'Escape') { input.value = ''; apply(); }
    });
    input.focus({ preventScroll: true });
  }`);
  }

  const script =
    scriptParts.length === 0
      ? ''
      : `<script nonce="${options.nonce}">
(function () {
${scriptParts.join('\n\n')}
})();
</script>`;

  const langSwitch =
    options.langSwitchHref === null
      ? ''
      : `<a class="lang-switch" href="${escapeHtml(options.langSwitchHref)}" title="${escapeHtml(t(lang, 'listing.languageLabel'))}">${lang === 'zh-CN' ? 'English' : '中文'}</a>`;

  const themeSwitch =
    options.themeSwitch === null
      ? ''
      : themeSwitchHtml({
          lang,
          toLightHref: options.themeSwitch.toLight,
          toDarkHref: options.themeSwitch.toDark,
        });

  return `<!DOCTYPE html>
<html lang="${lang}" data-theme="${options.theme}">
<head>
${headMeta({
    title: options.title,
    css,
    nonce: options.nonce,
    accentColor: appearance.accentColor,
    lang,
    frameAncestors: "'self'",
  })}
</head>
<body>
<div class="wrap">
  ${crumbsHtml}
  <div class="head">
    <div class="head-main">
      <h1>${escapeHtml(options.title)}</h1>
      ${summaryHtml}
    </div>
    <div class="head-actions">${langSwitch}${themeSwitch}</div>
  </div>
  ${toolbarHtml}
  <div class="panel">
    <table>
      <thead>
        <tr>
          <th class="c-name">${sortHeader(lang, 'namedirfirst', options.sort, options.order, t(lang, 'listing.colName'), preserved)}</th>
          ${sizeTh}
          ${timeTh}
        </tr>
      </thead>
      <tbody id="rows">
        ${upRow}
        ${rows}
      </tbody>
    </table>
    <div id="empty" class="empty hide">${escapeHtml(emptyText)}</div>
  </div>
  ${truncatedNotice}
  ${footer}
</div>
${script}
</body>
</html>
`;
}
