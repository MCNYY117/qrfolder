/**
 * 概览页。
 */

import type { AccessLogEntry } from '../logging/types.ts';
import type { AdminPermission, Lang, ThemeMode } from '../config/schema.ts';
import { permissionLabel, t } from '../i18n/index.ts';
import { escapeHtml } from './html.ts';
import {
  renderAdminLayout,
  type AdminLayoutOptions,
  type AdminNavKey,
  type Notice,
} from './adminLayout.ts';
import { formatDateTime, formatUptime } from '../serving/format.ts';

export type DashboardOptions = {
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
  host: string;
  port: number;
  uptimeSeconds: number;
  configPath: string;
  configLoadedAt: number;
  configIssueCount: number;
  directoryTotal: number;
  directoryEnabled: number;
  directoryUnavailable: number;
  logSize: number;
  logSummary: { total: number; notFound: number; partial: number };
  lockedIps: number;
  recent: readonly AccessLogEntry[];
  timeZone: string;
  /**
   * 是不是超级管理员。
   *
   * 概览页本身对**任何**登录账号开放，所以这里的每一项都得问一句「他配吗」：
   * 重载 / 清日志 / 轮换密钥是超级管理员专属路由，服务器路径与整站计数
   * 也只该给超级管理员看。子管理员看到的是**按自己范围算过的**那一份统计。
   */
  isSuper: boolean;
  /** 有没有 logs.view —— 没有就不显示日志缓冲与最近访问 */
  canViewLogs: boolean;
  /** 当前身份说明卡。子管理员靠它知道自己被授了什么 */
  account: {
    username: string;
    role: 'super' | 'sub';
    permissions: readonly AdminPermission[];
    roots: readonly string[];
  };
};

function stat(label: string, value: string, small = false): string {
  return `<div class="stat"><div class="k">${escapeHtml(label)}</div><div class="v${small ? ' small' : ''}">${escapeHtml(value)}</div></div>`;
}

export function renderDashboard(options: DashboardOptions): string {
  const { lang } = options;

  const stats = [
    stat(t(lang, 'dash.uptime'), formatUptime(options.uptimeSeconds, lang)),
    stat(t(lang, 'dash.listen'), `${options.host}:${options.port}`, true),
    stat(
      t(lang, 'dash.directoryCount'),
      `${options.directoryEnabled} / ${options.directoryTotal}`,
    ),
    // 日志缓冲是全局的，子管理员看不到也不该看到它有多大
    ...(options.canViewLogs ? [stat(t(lang, 'dash.logBuffered'), String(options.logSize))] : []),
  ].join('\n    ');

  // 「今天有多少请求」这类计数取自全局环形缓冲，按目录拆不开。
  // 没给 logs.view 的账号干脆不给这一排 —— 显示一份「已经过滤过的」数字
  // 会让人以为看到的是全部，比不显示更糟。
  const counters = options.canViewLogs
    ? [
        stat(t(lang, 'dash.todayRequests'), String(options.logSummary.total)),
        stat(t(lang, 'dash.notFound'), String(options.logSummary.notFound)),
        stat(t(lang, 'dash.partial'), String(options.logSummary.partial)),
        stat(t(lang, 'dash.lockedIps'), String(options.lockedIps)),
      ].join('\n    ')
    : '';

  const recentRows =
    options.recent.length === 0
      ? `<tr><td colspan="5" class="muted">${escapeHtml(t(lang, 'dash.noLogs'))}</td></tr>`
      : options.recent
          .map(
            // col-opt 与表头逐列对齐（见 adminDirectories 的说明）
            (entry) => `<tr>
      <td class="mono">${escapeHtml(formatDateTime(new Date(entry.time), lang, options.timeZone))}</td>
      <td class="mono col-opt">${escapeHtml(entry.ip)}</td>
      <td class="col-opt"><span class="tag${entry.status >= 400 ? ' err' : ''}">${entry.status}</span></td>
      <td class="mono">${escapeHtml(entry.method)} ${escapeHtml(entry.path)}</td>
      <td class="num col-opt">${entry.durationMs} ms</td>
    </tr>`,
          )
          .join('\n    ');

  const infoRows = [
    // 配置文件路径是服务器上的绝对路径，只有超级管理员看得到
    ...(options.isSuper
      ? [
          [t(lang, 'dash.configPath'), `<span class="mono">${escapeHtml(options.configPath)}</span>`],
          [
            t(lang, 'dash.configLoadedAt'),
            escapeHtml(formatDateTime(new Date(options.configLoadedAt), lang, options.timeZone)),
          ],
        ]
      : []),
    [
      t(lang, 'dirs.colStatus'),
      options.directoryUnavailable > 0
        ? `<span class="tag err">${escapeHtml(t(lang, 'dirs.unavailable'))} × ${options.directoryUnavailable}</span>`
        : `<span class="tag ok">OK</span>`,
    ],
    [
      t(lang, 'dash.pendingRestart'),
      options.pendingRestart
        ? `<span class="tag warn">${escapeHtml(t(lang, 'common.yes'))}</span>`
        : `<span class="tag off">${escapeHtml(t(lang, 'common.no'))}</span>`,
    ],
  ]
    .map(([k, v]) => `<tr><th class="w-38">${k}</th><td>${v}</td></tr>`)
    .join('\n    ');

  // 身份卡：子管理员登录后第一句想问的就是「我到底能干什么」。
  // 权限逐项列出来，省得他去翻「管理员」页（那一页他本来也打不开）。
  const account = options.account;
  const roleText = t(lang, account.role === 'super' ? 'users.roleSuper' : 'users.roleSub');
  const permText =
    account.role === 'super'
      ? t(lang, 'users.allPermissions')
      : account.permissions.length === 0
        ? `<span class="tag off">${escapeHtml(t(lang, 'users.noPermission'))}</span>`
        : account.permissions
            .map((p) => `<span class="tag">${escapeHtml(permissionLabel(lang, p))}</span>`)
            .join(' ');
  const accountCard = `<div class="card">
  <h2>${escapeHtml(t(lang, 'dash.whoami'))}</h2>
  <div class="kv"><span>${escapeHtml(t(lang, 'users.colUsername'))}</span><span class="mono">${escapeHtml(account.username)}</span></div>
  <div class="kv"><span>${escapeHtml(t(lang, 'users.colRole'))}</span><span>${escapeHtml(roleText)}</span></div>
  <div class="kv"><span>${escapeHtml(t(lang, 'users.colPermissions'))}</span><span>${permText}</span></div>
  ${
    account.role === 'super'
      ? ''
      : `<div class="kv"><span>${escapeHtml(t(lang, 'users.rootsSection'))}</span><span class="mono">${
          account.roots.length === 0
            ? escapeHtml(t(lang, 'users.noRoots'))
            : escapeHtml(account.roots.join('  |  '))
        }</span></div>`
  }
</div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'dash.title'))}</h1>
<p class="lead">${escapeHtml(options.productName)}</p>

<div class="stats">
    ${stats}
</div>

${counters === '' ? '' : `<div class="stats">
    ${counters}
</div>`}

${accountCard}

${
  options.isSuper
    ? `<div class="card">
  <h2>${escapeHtml(t(lang, 'dash.actions'))}</h2>
  <div class="actions">
    <form method="post" action="${escapeHtml(options.adminPath)}/reload" class="form-inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit">${escapeHtml(t(lang, 'dash.reloadConfig'))}</button>
    </form>
    <form method="post" action="${escapeHtml(options.adminPath)}/logs/clear" class="form-inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit">${escapeHtml(t(lang, 'dash.clearLogs'))}</button>
    </form>
    <form method="post" action="${escapeHtml(options.adminPath)}/rotate-secret" class="form-inline"
          data-confirm="${escapeHtml(t(lang, 'dash.rotateWarn'))}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit" class="danger">${escapeHtml(t(lang, 'dash.rotateSecret'))}</button>
    </form>
  </div>
</div>`
    : ''
}

<div class="card">
  <h2>${escapeHtml(t(lang, options.isSuper ? 'dash.configPath' : 'dash.statusSection'))}</h2>
  <div class="panel">
  <table>
    ${infoRows}
  </table>
  </div>
</div>

${
  options.canViewLogs
    ? `<div class="card">
  <h2>${escapeHtml(t(lang, 'dash.recent'))}</h2>
  <div class="panel">
  <table>
    <thead><tr>
      <th>${escapeHtml(t(lang, 'logs.colTime'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colIp'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'logs.colStatus'))}</th>
      <th>${escapeHtml(t(lang, 'logs.colPath'))}</th>
      <th></th>
    </tr></thead>
    <tbody>
    ${recentRows}
    </tbody>
  </table>
  </div>
</div>`
    : ''
}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath: options.adminPath,
    nav: 'dashboard',
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
