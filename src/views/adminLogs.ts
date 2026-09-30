/**
 * 访问日志页。
 *
 * 表格里的每个字段都必须转义 —— User-Agent 是完全可控的输入，
 * 里面可以带 <script>。
 */

import type { Lang, ThemeMode } from '../config/schema.ts';
import type { AccessLogEntry } from '../logging/types.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml } from './html.ts';
import {
  renderAdminLayout,
  type AdminLayoutOptions,
  type AdminNavKey,
  type Notice,
} from './adminLayout.ts';
import { formatDateTime } from '../serving/format.ts';

export type LogEntryView = AccessLogEntry & { seq: number };

export type LogsFilter = {
  status: string;
  keyword: string;
  onlyNotOk: boolean;
};

export type LogsPageOptions = {
  lang: Lang;
  nonce: string;
  accentColor: string;
  adminPath: string;
  csrfToken: string;
  siteTitle: string;
  pendingRestart: boolean;
  configIssues: boolean;
  /** 本次生效的主题，写到 <html data-theme> */
  theme: ThemeMode;
  /** 产品名，显示在后台抬头 */
  productName: string;
  /** 可见的导航项，由权限决定。不传表示全部可见 */
  navKeys?: readonly AdminNavKey[];
  /** 顶栏显示的身份：用户名 + 角色 */
  accountLabel?: string;
  notice?: Notice;
  entries: readonly LogEntryView[];
  /** 当前身份**可见范围之内**的记录总数，不是整个环形缓冲的大小 */
  total: number;
  filter: LogsFilter;
  timeZone: string;
  /** 有没有 logs.export —— 没勾就不显示导出按钮（那条路由会 404） */
  canExport: boolean;
  /** 清空是全局动作，只有超级管理员能做 */
  canClear: boolean;
};

export function renderLogsPage(options: LogsPageOptions): string {
  const { lang, adminPath } = options;

  const rows =
    options.entries.length === 0
      ? `<tr><td colspan="7" class="muted">${escapeHtml(t(lang, 'logs.empty'))}</td></tr>`
      : options.entries
          .map(
            // col-opt 与表头逐列对齐：窄屏上留下「时间 + 路径」两列，
            // 那正是排查问题时真正要看的（见 adminDirectories 的说明）
            (entry) => `<tr>
      <td class="mono">${escapeHtml(formatDateTime(new Date(entry.time), lang, options.timeZone))}</td>
      <td class="mono col-opt">${escapeHtml(entry.ip)}</td>
      <td class="mono col-opt">${escapeHtml(entry.method)}</td>
      <td class="mono">${escapeHtml(entry.path)}</td>
      <td class="col-opt"><span class="tag${entry.status >= 400 ? ' err' : entry.status >= 300 ? ' warn' : ' ok'}">${entry.status}</span></td>
      <td class="num col-opt">${entry.bytes > 0 ? entry.bytes : ''}</td>
      <td class="num col-opt">${entry.durationMs}</td>
    </tr>`,
          )
          .join('\n    ');

  const uaList = options.entries
    .map((entry, index) =>
      entry.userAgent === ''
        ? ''
        : `<tr><td class="mono w-120">#${index + 1}</td><td class="mono">${escapeHtml(entry.userAgent)}</td></tr>`,
    )
    .filter((row) => row !== '')
    .join('\n    ');

  const filterForm = `<form method="get" action="${escapeHtml(adminPath)}/logs" class="row pick-row">
  <div class="field field-narrow">
    <label for="f_status">${escapeHtml(t(lang, 'logs.filterStatus'))}</label>
    <input type="text" id="f_status" name="status" value="${escapeHtml(options.filter.status)}" placeholder="404">
  </div>
  <div class="field field-wide">
    <label for="f_keyword">${escapeHtml(t(lang, 'logs.filterKeyword'))}</label>
    <input type="text" id="f_keyword" name="q" value="${escapeHtml(options.filter.keyword)}">
  </div>
  <div class="field field-tight">
    <label class="check-inline">
      <input type="checkbox" name="notOk" value="1"${options.filter.onlyNotOk ? ' checked' : ''}>
      ${escapeHtml(t(lang, 'logs.onlyNotOk'))}
    </label>
  </div>
  <div class="field field-tight">
    <button type="submit">${escapeHtml(t(lang, 'common.confirm'))}</button>
  </div>
</form>`;

  const body = `
<h1>${escapeHtml(t(lang, 'logs.title'))}</h1>
<p class="lead">${escapeHtml(t(lang, 'logs.showing', { shown: options.entries.length, total: options.total }))}</p>

<div class="card">
  ${filterForm}
  <div class="actions mb-12">
    <label class="btn">
      <span class="check-inline"><input type="checkbox" id="log-auto"> ${escapeHtml(t(lang, 'logs.autoRefresh'))}</span>
    </label>
    ${
      options.canClear
        ? `<form method="post" action="${escapeHtml(adminPath)}/logs/clear" class="form-inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit">${escapeHtml(t(lang, 'logs.clear'))}</button>
    </form>`
        : ''
    }
    ${options.canExport ? `<a class="btn" href="${escapeHtml(adminPath)}/logs/export">${escapeHtml(t(lang, 'logs.export'))}</a>` : ''}
  </div>

  <div class="panel">
  <table>
    <thead><tr>
      <th>${escapeHtml(t(lang, 'logs.colTime'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colIp'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colMethod'))}</th>
      <th>${escapeHtml(t(lang, 'logs.colPath'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colStatus'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colBytes'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colDuration'))}</th>
    </tr></thead>
    <tbody>
    ${rows}
    </tbody>
  </table>
  </div>
</div>

${uaList === '' ? '' : `<div class="card">
  <h2>${escapeHtml(t(lang, 'logs.colUa'))}</h2>
  <div class="panel">
  <table><tbody>
    ${uaList}
  </tbody></table>
  </div>
</div>`}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'logs',
    csrfToken: options.csrfToken,
    siteTitle: options.siteTitle,
    pendingRestart: options.pendingRestart,
    configIssues: options.configIssues,
    theme: options.theme,
    productName: options.productName,
    ...(options.navKeys === undefined ? {} : { navKeys: options.navKeys }),
    ...(options.accountLabel === undefined ? {} : { accountLabel: options.accountLabel }),
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    body,
  };
  return renderAdminLayout(layoutOptions);
}
