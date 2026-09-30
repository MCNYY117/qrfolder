/**
 * 域名与证书页。
 *
 * 这一页改的是**公网暴露面**：填错域名、关掉 header -Server、把管理接口写错，
 * 后果都在外网可见。所以除了表单，还坚持做两件事：
 *   1. 把**将要应用的 Caddyfile 原文**显示出来 —— 让人看见将要发生什么；
 *   2. 显示**实际正在服用的证书**（连本机 443 取回来），而不是只说一句「已保存」。
 */

import type { Lang, ThemeMode, TlsConfig } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml } from './html.ts';
import {
  renderAdminLayout,
  type AdminLayoutOptions,
  type AdminNavKey,
  type Notice,
} from './adminLayout.ts';
import { checkboxField, csrfInput, textField, textareaField } from './forms.ts';
import type { ProbeResult } from '../tls/certInfo.ts';

export type DomainPageOptions = {
  lang: Lang;
  nonce: string;
  accentColor: string;
  adminPath: string;
  csrfToken: string;
  siteTitle: string;
  pendingRestart: boolean;
  configIssues: boolean;
  theme: ThemeMode;
  productName: string;
  /** 可见的导航项，由权限决定。不传表示全部可见 */
  navKeys?: readonly AdminNavKey[];
  /** 顶栏显示的身份：用户名 + 角色 */
  accountLabel?: string;
  notice?: Notice;
  tls: TlsConfig;
  /** 生成的 Caddyfile；null 表示生成失败，原因在 caddyfileError */
  caddyfile: string | null;
  caddyfileError: string;
  /** Caddy 管理接口是否可达 */
  caddyReachable: boolean;
  /** 解析到的 Caddy 可执行文件路径；null 表示找不到 */
  caddyBinaryPath: string | null;
  /** 80 / 443 是否有服务在监听 */
  port80: boolean;
  port443: boolean;
  /** 证书探测结果；null 表示这次没检查 */
  probe: ProbeResult | null;
};

/** 域名数组 ⇄ 文本框：允许换行也允许逗号，两种写法都常见 */
function domainsToText(domains: readonly string[]): string {
  return domains.join('\n');
}

function textToDomains(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
}

export { textToDomains };

function portBadge(lang: Lang, port: number, listening: boolean): string {
  const state = listening
    ? `<span class="tag ok">${escapeHtml(t(lang, 'domain.portListening'))}</span>`
    : `<span class="tag err">${escapeHtml(t(lang, 'domain.portClosed'))}</span>`;
  return `<div class="kv"><span>${escapeHtml(t(lang, 'domain.portState', { port }))}</span>${state}</div>`;
}

function certificateBlock(lang: Lang, probe: ProbeResult | null, product: string): string {
  if (probe === null) {
    return `<p class="hint">${escapeHtml(t(lang, 'domain.certNotChecked'))}</p>`;
  }

  if (probe.state === 'unreachable') {
    return `<div class="banner err">${escapeHtml(t(lang, 'domain.certUnreachable'))}<br><span class="mono">${escapeHtml(probe.detail)}</span></div>`;
  }

  // 单独拎出来：这句提示要给出「该去改什么」，而不是让人以为证书没签下来
  if (probe.state === 'not-tls') {
    return `<div class="banner err">${escapeHtml(t(lang, 'domain.certNotTls', { product }))}<br><span class="mono">${escapeHtml(probe.detail)}</span></div>`;
  }

  if (probe.state === 'no-certificate') {
    return `<div class="banner warn">${escapeHtml(t(lang, 'domain.certMissing', { detail: probe.detail }))}</div>`;
  }

  const cert = probe.certificate;
  const days =
    cert.daysLeft >= 0
      ? t(lang, 'domain.certDaysLeft', { n: cert.daysLeft })
      : t(lang, 'domain.certExpired', { n: Math.abs(cert.daysLeft) });

  const rows: [string, string][] = [
    [t(lang, 'domain.certSubject'), cert.subject],
    [t(lang, 'domain.certIssuer'), cert.issuer],
    [t(lang, 'domain.certValid'), `${cert.validFrom} → ${cert.validTo}（${days}）`],
    [t(lang, 'domain.certCovers'), cert.altNames.join(', ')],
  ];

  const body = rows
    .map(
      ([label, value]) =>
        `<div class="kv"><span>${escapeHtml(label)}</span><span class="mono">${escapeHtml(value)}</span></div>`,
    )
    .join('');

  return `<div class="banner ${cert.daysLeft > 21 ? 'ok' : 'warn'}">${escapeHtml(days)}</div>${body}`;
}

export function renderDomainPage(options: DomainPageOptions): string {
  const { lang, adminPath, tls } = options;

  const caddyfilePreview =
    options.caddyfile === null
      ? `<div class="banner err">${escapeHtml(
          t(lang, 'domain.previewUnavailable', { reason: options.caddyfileError }),
        )}</div>`
      : `<pre class="code-block">${escapeHtml(options.caddyfile)}</pre>`;

  const primary = tls.domains[0] ?? 'your-domain.example.com';

  const form = `<div class="card">
  <h2>${escapeHtml(t(lang, 'domain.bindSection'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/domain/apply">
    ${csrfInput(options.csrfToken)}
    ${checkboxField({
      name: 'enabled',
      label: t(lang, 'domain.enabled'),
      checked: tls.enabled,
      hint: t(lang, 'domain.enabledHint', { product: options.productName }),
    })}
    ${textareaField({
      name: 'domains',
      label: t(lang, 'domain.domains'),
      value: domainsToText(tls.domains),
      rows: 2,
      hint: t(lang, 'domain.domainsHint'),
      placeholder: 'www.example.com',
    })}
    ${textField({
      name: 'email',
      label: t(lang, 'domain.email'),
      value: tls.email,
      hint: t(lang, 'domain.emailHint'),
      placeholder: 'admin@example.com',
    })}
    ${checkboxField({
      name: 'staging',
      label: t(lang, 'domain.staging'),
      checked: tls.staging,
      hint: t(lang, 'domain.stagingHint'),
    })}
    <details class="advanced">
      <summary>${escapeHtml(t(lang, 'domain.advancedSection'))}</summary>
      ${textField({
        name: 'caddyBinary',
        label: t(lang, 'domain.caddyBinary'),
        value: tls.caddyBinary,
        hint: t(lang, 'domain.caddyBinaryHint'),
        placeholder: 'C:\\caddy\\caddy.exe',
      })}
      ${textField({
        name: 'caddyConfigPath',
        label: t(lang, 'domain.caddyConfigPath'),
        value: tls.caddyConfigPath,
        hint: t(lang, 'domain.caddyConfigPathHint'),
      })}
      ${textField({
        name: 'adminApi',
        label: t(lang, 'domain.adminApi'),
        value: tls.adminApi,
        hint: t(lang, 'domain.adminApiHint'),
      })}
    </details>
    <div class="hint">${escapeHtml(t(lang, 'domain.applyNote', { domain: primary }))}</div>
    <div class="dialog-actions">
      <a class="btn" href="${escapeHtml(adminPath)}/domain?check=1">${escapeHtml(t(lang, 'domain.certCheck'))}</a>
      <button type="submit" class="primary">${escapeHtml(t(lang, 'domain.apply'))}</button>
    </div>
  </form>
</div>`;

  const statusCard = `<div class="card">
  <h2>${escapeHtml(t(lang, 'domain.statusSection'))}</h2>
  <div class="kv"><span>${escapeHtml(t(lang, 'domain.caddyApi'))}</span>${
    options.caddyReachable
      ? `<span class="tag ok">${escapeHtml(t(lang, 'domain.reachable'))}</span>`
      : `<span class="tag err">${escapeHtml(t(lang, 'domain.unreachable'))}</span>`
  }</div>
  <div class="kv"><span class="mono">${escapeHtml(tls.adminApi)}</span></div>
  <div class="kv"><span>${escapeHtml(t(lang, 'domain.caddyBinary'))}</span>${
    options.caddyBinaryPath === null
      ? `<span class="tag err">${escapeHtml(t(lang, 'domain.binaryMissing'))}</span>`
      : `<span class="mono">${escapeHtml(options.caddyBinaryPath)}</span>`
  }</div>
  ${portBadge(lang, 80, options.port80)}
  ${portBadge(lang, 443, options.port443)}
  <h3 class="sub">${escapeHtml(t(lang, 'domain.certTitle'))}</h3>
  ${certificateBlock(lang, options.probe, options.productName)}
  <p class="hint">${escapeHtml(t(lang, 'domain.renewNote'))}</p>
</div>`;

  const previewCard = `<div class="card">
  <h2>${escapeHtml(t(lang, 'domain.previewSection'))}</h2>
  <p class="hint">${escapeHtml(t(lang, 'domain.previewHint'))}</p>
  ${caddyfilePreview}
</div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'domain.title'))}</h1>
<p class="lead">${escapeHtml(t(lang, 'domain.intro'))}</p>
${form}
${previewCard}
${statusCard}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'domain',
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
