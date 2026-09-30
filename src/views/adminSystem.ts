/**
 * 系统设置页。
 */

import type { Lang, LogLevel, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml } from './html.ts';
import {
  renderAdminLayout,
  type AdminLayoutOptions,
  type AdminNavKey,
  type Notice,
} from './adminLayout.ts';
import {
  checkboxField,
  csrfInput,
  numberField,
  selectField,
  textField,
  textareaField,
} from './forms.ts';

export type SystemPageOptions = {
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
  /**
   * 是不是超级管理员。
   *
   * 这一页上除了「对外访问地址」以外的每一张卡片，提交地址在策略表里都是
   * super —— 子管理员渲染出来只会得到「填完一提交就 404」。所以整块整块地裁。
   */
  canEdit: boolean;
  notice?: Notice;
  host: string;
  port: number;
  adminPathValue: string;
  trustProxy: boolean;
  trustedProxyCidrs: string;
  logLevel: LogLevel;
  logEnabled: boolean;
  logRingSize: number;
  logPersist: boolean;
  logFilePath: string;
  logAnonymize: boolean;
  parentRoots: string;
  publicBaseUrl: string;
  uploadEnabled: boolean;
  uploadMaxSizeMb: number;
  uploadOverwrite: boolean;
};

export function renderSystemPage(options: SystemPageOptions): string {
  const { lang, adminPath } = options;

  const serverForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.serverSection'))}</h2>
  <div class="banner warn">${escapeHtml(t(lang, 'sys.needRestart'))}</div>
  <form method="post" action="${escapeHtml(adminPath)}/system/server">
    ${csrfInput(options.csrfToken)}
    <div class="row">
      ${textField({ name: 'host', label: t(lang, 'sys.host'), value: options.host, hint: t(lang, 'sys.hostHint') })}
      ${numberField({ name: 'port', label: t(lang, 'sys.port'), value: options.port, min: 0, max: 65535 })}
    </div>
    ${textField({
      name: 'adminPath',
      label: t(lang, 'sys.adminPath'),
      value: options.adminPathValue,
      hint: t(lang, 'sys.adminPathHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const proxyForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.proxySection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/system/proxy">
    ${csrfInput(options.csrfToken)}
    ${checkboxField({
      name: 'trustProxy',
      label: t(lang, 'sys.trustProxy'),
      checked: options.trustProxy,
      hint: t(lang, 'sys.trustProxyHint'),
    })}
    ${textareaField({
      name: 'trustedProxyCidrs',
      label: t(lang, 'sys.trustedProxies'),
      value: options.trustedProxyCidrs,
      rows: 3,
      hint: t(lang, 'sys.trustedProxiesHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  // 二维码里必须编绝对地址，而服务端推断不出访客用的是哪个公网域名 ——
  // 所以这个字段是「生成二维码」这件事的前置条件，单独放一张卡片。
  const publicBaseForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.publicBaseSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/system/publicbase">
    ${csrfInput(options.csrfToken)}
    ${textField({
      name: 'publicBaseUrl',
      label: t(lang, 'sys.publicBaseUrl'),
      value: options.publicBaseUrl,
      hint: t(lang, 'sys.publicBaseUrlHint'),
      placeholder: 'https://files.example.com',
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const logForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.logSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/system/log">
    ${csrfInput(options.csrfToken)}
    ${checkboxField({ name: 'logEnabled', label: t(lang, 'sys.logEnabled'), checked: options.logEnabled })}
    ${selectField({
      name: 'logLevel',
      label: t(lang, 'sys.logLevel'),
      value: options.logLevel,
      options: ['debug', 'info', 'warn', 'error'].map((level) => ({ value: level, label: level })),
    })}
    ${numberField({
      name: 'logRingSize',
      label: t(lang, 'sys.logRingSize'),
      value: options.logRingSize,
      min: 1,
      max: 100000,
    })}
    ${checkboxField({ name: 'logPersist', label: t(lang, 'sys.logPersist'), checked: options.logPersist })}
    ${textField({
      name: 'logFilePath',
      label: t(lang, 'sys.logFilePath'),
      value: options.logFilePath,
      hint: t(lang, 'sys.logFilePathHint'),
    })}
    ${checkboxField({
      name: 'logAnonymize',
      label: t(lang, 'sys.logAnonymize'),
      checked: options.logAnonymize,
      hint: t(lang, 'sys.logAnonymizeHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const scanForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.parentRootsSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/system/parentroots">
    ${csrfInput(options.csrfToken)}
    ${textareaField({
      name: 'parentRoots',
      label: t(lang, 'sys.parentRoots'),
      value: options.parentRoots,
      rows: 4,
      hint: t(lang, 'sys.parentRootsHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  // 上传是本站唯一的写入口，所以它的开关必须能在后台改 ——
  // 文件管理页在关闭时提示「已在系统设置中关闭」，那这句话得有着落。
  const uploadForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.uploadSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/system/upload">
    ${csrfInput(options.csrfToken)}
    ${checkboxField({
      name: 'uploadEnabled',
      label: t(lang, 'sys.uploadEnabled'),
      checked: options.uploadEnabled,
      hint: t(lang, 'sys.uploadEnabledHint'),
    })}
    ${checkboxField({
      name: 'uploadOverwrite',
      label: t(lang, 'sys.uploadOverwrite'),
      checked: options.uploadOverwrite,
      hint: t(lang, 'sys.uploadOverwriteHint'),
    })}
    ${numberField({
      name: 'uploadMaxSizeMb',
      label: t(lang, 'sys.uploadMaxSize'),
      value: options.uploadMaxSizeMb,
      min: 1,
      max: 102400,
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const ioCard = `<div class="card">
  <h2>${escapeHtml(t(lang, 'sys.exportSection'))}</h2>
  <p class="hint">${escapeHtml(t(lang, 'sys.exportHint'))}</p>
  <div class="actions mt-12">
    <a class="btn" href="${escapeHtml(adminPath)}/system/export">${escapeHtml(t(lang, 'sys.export'))}</a>
  </div>
  <hr class="hr">
  <form method="post" action="${escapeHtml(adminPath)}/system/import">
    ${csrfInput(options.csrfToken)}
    ${textareaField({
      name: 'json',
      label: t(lang, 'sys.import'),
      value: '',
      rows: 6,
      hint: t(lang, 'sys.importHint'),
    })}
    <div class="actions">
      <button type="submit">${escapeHtml(t(lang, 'sys.import'))}</button>
    </div>
  </form>
</div>`;

  // 子管理员只剩「对外访问地址」—— 那是唯一一个可授予的系统级权限。
  // 其它几张卡片都改得动全局（后台路径、代理信任、上传开关、日志缓冲、扫描根），
  // 任何一项落到子管理员手里都等于给了他一条提权路径。
  const body = `
<h1>${escapeHtml(t(lang, 'sys.title'))}</h1>
<p class="lead">${escapeHtml(options.productName)}</p>
${options.canEdit ? serverForm : ''}
${publicBaseForm}
${options.canEdit ? `${proxyForm}\n${uploadForm}\n${logForm}\n${scanForm}\n${ioCard}` : ''}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'system',
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
