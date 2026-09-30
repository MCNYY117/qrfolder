/**
 * 访问控制页。
 *
 * 特别注意「自锁」防护：保存 IP 白名单前必须先告诉用户当前 IP，
 * 并在保存后自己不在名单内时二次确认。这是这套配置里最容易
 * 把自己关在门外的地方。
 */

import type { Lang, RateLimitConfig, SiteMode, ThemeMode } from '../config/schema.ts';
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
  passwordField,
  selectField,
  textareaField,
} from './forms.ts';

export type AccessPageOptions = {
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
  siteMode: SiteMode;
  hasSitePassword: boolean;
  hasAdminPassword: boolean;
  ipAllowlist: string;
  currentIp: string;
  /** 正在测试的 IP（来自查询参数） */
  testIp?: string;
  /** IP 测试结果，已渲染好的 HTML 片段 */
  testIpResult?: string;
  rateLimit: RateLimitConfig;
  sessionTtlMinutes: number;
  bindSessionToIp: boolean;
  hideDotfiles: boolean;
  deniedExtensions: string;
  deniedFilenames: string;
};

export function renderAccessPage(options: AccessPageOptions): string {
  const { lang, adminPath } = options;

  const siteForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'access.siteSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/access/site">
    ${csrfInput(options.csrfToken)}
    ${selectField({
      name: 'siteMode',
      label: t(lang, 'access.siteMode'),
      value: options.siteMode,
      options: [
        { value: 'public', label: t(lang, 'access.sitePublic') },
        { value: 'password', label: t(lang, 'access.sitePassword') },
      ],
    })}
    ${passwordField({
      name: 'sitePassword',
      label: t(lang, 'access.sitePassword'),
      hint: t(lang, 'access.sitePasswordHint') + (options.hasSitePassword ? ` (${t(lang, 'common.enabled')})` : ''),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const passwordForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'access.adminPassword'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/access/password" id="pw-form">
    ${csrfInput(options.csrfToken)}
    ${passwordField({ name: 'password', label: t(lang, 'access.newPassword'), hint: t(lang, 'access.passwordHint') })}
    ${passwordField({ name: 'confirm', label: t(lang, 'access.confirmPassword') })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const ipForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'access.ipAllowlist'))}</h2>
  <p class="hint">${escapeHtml(t(lang, 'access.currentIp'))}: <b class="mono">${escapeHtml(options.currentIp)}</b></p>
  <form method="post" action="${escapeHtml(adminPath)}/access/ip" id="ip-form">
    ${csrfInput(options.csrfToken)}
    ${textareaField({
      name: 'allowlist',
      label: t(lang, 'access.ipAllowlist'),
      value: options.ipAllowlist,
      rows: 4,
      hint: t(lang, 'access.ipAllowlistHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
  <hr class="hr">
  <h2>${escapeHtml(t(lang, 'access.ipTest'))}</h2>
  <form method="get" action="${escapeHtml(adminPath)}/access" class="row pick-row">
    <div class="field field-grow">
      <input type="text" name="testIp" value="${escapeHtml(options.testIp ?? '')}" placeholder="192.168.1.10">
    </div>
    <button type="submit">${escapeHtml(t(lang, 'common.confirm'))}</button>
  </form>
  ${options.testIpResult ?? ''}
</div>`;

  const rateLimitForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'access.ratelimitSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/access/ratelimit">
    ${csrfInput(options.csrfToken)}
    <div class="row">
      ${numberField({ name: 'loginMaxAttempts', label: t(lang, 'access.maxAttempts'), value: options.rateLimit.loginMaxAttempts, min: 1, max: 1000 })}
      ${numberField({ name: 'loginWindowMinutes', label: t(lang, 'access.windowMinutes'), value: options.rateLimit.loginWindowMinutes, min: 1, max: 1440 })}
    </div>
    <div class="row">
      ${numberField({ name: 'lockoutMinutes', label: t(lang, 'access.lockoutMinutes'), value: options.rateLimit.lockoutMinutes, min: 1, max: 10080 })}
      ${numberField({ name: 'lockoutMaxMinutes', label: t(lang, 'access.lockoutMax'), value: options.rateLimit.lockoutMaxMinutes, min: 1, max: 43200 })}
    </div>
    ${numberField({
      name: 'maxConcurrentHashes',
      label: t(lang, 'access.maxConcurrentHashes'),
      value: options.rateLimit.maxConcurrentHashes,
      min: 1,
      max: 64,
      hint: t(lang, 'access.maxConcurrentHashesHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  // 会话时长与「绑定来源 IP」放在这一页，和密码、限流同属「谁能进后台、进来待多久」
  const sessionForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'access.sessionSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/access/session">
    ${csrfInput(options.csrfToken)}
    ${numberField({
      name: 'sessionTtlMinutes',
      label: t(lang, 'access.sessionTtl'),
      value: options.sessionTtlMinutes,
      min: 5,
      max: 43200,
      hint: t(lang, 'access.sessionTtlHint'),
    })}
    ${checkboxField({
      name: 'bindSessionToIp',
      label: t(lang, 'access.bindSessionToIp'),
      checked: options.bindSessionToIp,
      hint: t(lang, 'access.bindSessionToIpHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const filesForm = `<div class="card">
  <h2>${escapeHtml(t(lang, 'access.filesSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/access/files">
    ${csrfInput(options.csrfToken)}
    ${checkboxField({ name: 'hideDotfiles', label: t(lang, 'access.hideDotfiles'), checked: options.hideDotfiles })}
    ${textareaField({
      name: 'deniedExtensions',
      label: t(lang, 'access.deniedExtensions'),
      value: options.deniedExtensions,
      rows: 8,
      hint: t(lang, 'access.deniedExtensionsHint'),
    })}
    ${textareaField({
      name: 'deniedFilenames',
      label: t(lang, 'access.deniedFilenames'),
      value: options.deniedFilenames,
      rows: 5,
      hint: t(lang, 'access.deniedFilenamesHint'),
    })}
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'access.title'))}</h1>
<p class="lead">${escapeHtml(t(lang, 'access.adminSection'))}</p>
${siteForm}
${passwordForm}
${ipForm}
${rateLimitForm}
${sessionForm}
${filesForm}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'access',
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
