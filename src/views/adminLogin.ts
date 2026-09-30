/**
 * 登录页与首次运行设置页。
 *
 * 两者都不渲染侧边栏 —— 未认证时不应暴露任何后台结构信息。
 */

import type { Lang, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { csrfInput, passwordField, textField } from './forms.ts';
import { renderBareLayout, type Notice } from './adminLayout.ts';

export type LoginPageOptions = {
  lang: Lang;
  nonce: string;
  accentColor: string;
  adminPath: string;
  /** 登录页也要跟主题，否则深色站点上会闪一张白页 */
  theme: ThemeMode;
  productName: string;
  notice?: Notice;
};

export function renderLoginPage(options: LoginPageOptions): string {
  const { lang, adminPath } = options;

  // 用户名 + 密码。**不用 autofocus**：焦点落在用户名的同时浏览器密码管理器
  // 才能正确识别这是一组登录凭据。
  const body = `<form method="post" action="${adminPath}/login">
  ${textField({
    name: 'username',
    label: t(lang, 'login.username'),
    value: '',
    required: true,
  })}
  ${passwordField({
    name: 'password',
    label: t(lang, 'login.password'),
    required: true,
  })}
  <button type="submit" class="primary full">${t(lang, 'login.submit')}</button>
</form>`;

  return renderBareLayout({
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    title: t(lang, 'login.title'),
    lead: t(lang, 'admin.title'),
    theme: options.theme,
    productName: options.productName,
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    body,
  });
}

export type SetupPageOptions = {
  lang: Lang;
  nonce: string;
  accentColor: string;
  adminPath: string;
  theme: ThemeMode;
  productName: string;
  /** 提交失败时回填，免得用户重填一遍。留空则用默认用户名 */
  username?: string;
  notice?: Notice;
};

export function renderSetupPage(options: SetupPageOptions): string {
  const { lang, adminPath } = options;

  const body = `<form method="post" action="${adminPath}/setup">
  ${textField({
    name: 'username',
    label: t(lang, 'setup.username'),
    value: options.username ?? 'admin',
    hint: t(lang, 'setup.usernameHint'),
    required: true,
  })}
  ${passwordField({
    name: 'password',
    label: t(lang, 'setup.password'),
    hint: t(lang, 'setup.tooShort'),
    required: true,
  })}
  ${passwordField({
    name: 'confirm',
    label: t(lang, 'setup.confirm'),
    required: true,
  })}
  <button type="submit" class="primary full">${t(lang, 'setup.submit')}</button>
</form>`;

  return renderBareLayout({
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    title: t(lang, 'setup.title'),
    lead: t(lang, 'setup.intro'),
    theme: options.theme,
    productName: options.productName,
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    body,
  });
}

/** 密码门：整站或单个目录需要密码时展示 */
export type PasswordGateOptions = {
  lang: Lang;
  nonce: string;
  accentColor: string;
  action: string;
  title: string;
  csrfToken: string;
  theme: ThemeMode;
  productName: string;
  notice?: Notice;
};

export function renderPasswordGate(options: PasswordGateOptions): string {
  const { lang } = options;

  // 内容面的密码闸门发生在拿到会话之前，没有会话可用于派生 CSRF 令牌；
  // 那一侧由登录限流负责防爆破。
  const body = `<form method="post" action="${options.action}">
  ${options.csrfToken === '' ? '' : csrfInput(options.csrfToken)}
  ${passwordField({
    name: 'password',
    label: t(lang, 'password.label'),
    required: true,
  })}
  <button type="submit" class="primary full">${t(lang, 'password.submit')}</button>
</form>`;

  return renderBareLayout({
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    title: options.title,
    lead: t(lang, 'password.prompt'),
    theme: options.theme,
    productName: options.productName,
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    body,
  });
}
