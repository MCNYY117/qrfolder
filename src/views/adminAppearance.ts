/**
 * 外观设置页。右侧提供 iframe 实时预览（内容页 CSP 允许自站嵌入）。
 */

import type { AppearanceConfig, Lang, ThemeMode } from '../config/schema.ts';
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
  colorField,
  csrfInput,
  localizedTextField,
  numberField,
  selectField,
  textField,
  textareaField,
} from './forms.ts';

export type AppearancePageOptions = {
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
  /** 有没有 appearance.edit。没有就整页只读 —— 见下面 fieldset 的注释 */
  canEdit: boolean;
  notice?: Notice;
  appearance: AppearanceConfig;
  /** 用于 iframe 预览的路径；为 null 时不显示预览 */
  previewPath: string | null;
};

export function renderAppearancePage(options: AppearancePageOptions): string {
  const { lang, adminPath, appearance } = options;

  // 两个预览：主界面与目录列表 —— 外观设置同时影响这两处，
  // 只给一个的话另一半的效果只能靠保存后去前台看。
  const previewFrames = [
    `<h2>${escapeHtml(t(lang, 'app.welcomePreview'))}</h2>`,
    `<iframe class="preview-frame" src="/" class="mb-20"></iframe>`,
  ];
  if (options.previewPath !== null) {
    previewFrames.push(`<h2>${escapeHtml(t(lang, 'app.preview'))}</h2>`);
    previewFrames.push(`<iframe class="preview-frame" src="${escapeHtml(options.previewPath)}"></iframe>`);
  }

  const preview = `<div class="card">
  <p class="hint">${escapeHtml(t(lang, 'app.previewHint'))}</p>
  ${previewFrames.join('\n  ')}
</div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'app.title'))}</h1>
<p class="lead">${escapeHtml(options.productName)}</p>

<form method="post" action="${escapeHtml(adminPath)}/appearance">
  ${csrfInput(options.csrfToken)}
  ${options.canEdit ? '' : `<div class="banner warn">${escapeHtml(t(lang, 'app.readOnly'))}</div>`}

  ${
    // 只读态用原生 <fieldset disabled> 一次性罩住所有控件：
    // 逐个 input 加 disabled 会漏（这一页有二十多个控件、还在不断加），
    // 而漏掉的那一个恰好就是「看得见、改得动、但提交 404」的那一个。
    //
    // ★ 清默认边框必须用 class，**不能写 style="border:none"** ——
    //   本站 CSP 是 `style-src 'nonce-…'`，内联 style 属性会被浏览器拒绝执行，
    //   结果就是 fieldset 露出默认的 2px 凹槽边框，页面上多出一圈框。
    `<fieldset class="fieldset-bare"${options.canEdit ? '' : ' disabled'}>
  `
  }
  <div class="card">
    <h2>${escapeHtml(t(lang, 'app.basicSection'))}</h2>
    ${textField({
      name: 'productName',
      label: t(lang, 'app.productName'),
      value: appearance.productName,
      hint: t(lang, 'app.productNameHint'),
      placeholder: 'QRFolder',
    })}
    ${textField({
      name: 'siteTitle',
      label: t(lang, 'app.siteTitle'),
      value: appearance.siteTitle,
      hint: t(lang, 'app.siteTitleHint'),
    })}
    ${textField({
      name: 'footerText',
      label: t(lang, 'app.footerText'),
      value: appearance.footerText,
      hint: t(lang, 'app.footerTextHint'),
    })}
    ${selectField({
      name: 'listingLanguage',
      label: t(lang, 'app.listingLanguage'),
      value: appearance.listingLanguage,
      options: [
        { value: 'auto', label: t(lang, 'app.langAuto') },
        { value: 'zh-CN', label: '中文' },
        { value: 'en-US', label: 'English' },
      ],
    })}
  </div>

  <div class="card">
    <h2>${escapeHtml(t(lang, 'app.welcomeSection'))}</h2>
    <p class="hint">${escapeHtml(t(lang, 'app.welcomeHint'))}</p>
    <div class="mt-14">
      ${selectField({
        name: 'rootBehavior',
        label: t(lang, 'app.rootBehavior'),
        value: appearance.rootBehavior,
        options: [
          { value: 'welcome', label: t(lang, 'app.rootWelcome') },
          { value: 'notFound', label: t(lang, 'app.rootNotFound') },
        ],
      })}
      ${localizedTextField({
        name: 'welcomeTitle',
        label: t(lang, 'app.welcomeTitle'),
        value: appearance.welcomeTitle,
        hint: t(lang, 'app.welcomeTitleHint'),
      })}
      ${localizedTextField({
        name: 'welcomeMessage',
        label: t(lang, 'app.welcomeMessage'),
        value: appearance.welcomeMessage,
        rows: 3,
        hint: t(lang, 'app.welcomeMessageHint'),
      })}
      ${textField({
        name: 'welcomeImage',
        label: t(lang, 'app.welcomeImage'),
        value: appearance.welcomeImage,
        hint: t(lang, 'app.welcomeImageHint'),
        placeholder: '/Manuals/logo.png',
      })}
      ${localizedTextField({
        name: 'welcomeImageAlt',
        label: t(lang, 'app.welcomeImageAlt'),
        value: appearance.welcomeImageAlt,
        hint: t(lang, 'app.welcomeImageAltHint'),
      })}
      ${numberField({
        name: 'welcomeImageWidth',
        label: t(lang, 'app.welcomeImageWidth'),
        value: appearance.welcomeImageWidth,
        min: 0,
        max: 4000,
        hint: t(lang, 'app.welcomeImageWidthHint'),
      })}
      ${localizedTextField({
        name: 'welcomeHint',
        label: t(lang, 'app.welcomeNote'),
        value: appearance.welcomeHint,
        hint: t(lang, 'app.welcomeNoteHint'),
        // 占位符直接给出该语言的内置文案 —— 留空时访客看到的就是这句
        placeholder: { zh: t('zh-CN', 'welcome.userHint'), en: t('en-US', 'welcome.userHint') },
      })}
    </div>
  </div>

  <div class="card">
    <h2>${escapeHtml(t(lang, 'app.themeSection'))}</h2>
    <div class="row">
      ${colorField({ name: 'accentColor', label: t(lang, 'app.accentColor'), value: appearance.accentColor })}
      ${colorField({ name: 'folderColor', label: t(lang, 'app.folderColor'), value: appearance.folderColor })}
    </div>
    <div class="row">
      ${selectField({
        name: 'theme',
        label: t(lang, 'app.theme'),
        value: appearance.theme,
        options: [
          { value: 'auto', label: t(lang, 'app.themeAuto') },
          { value: 'light', label: t(lang, 'app.themeLight') },
          { value: 'dark', label: t(lang, 'app.themeDark') },
        ],
      })}
      ${selectField({
        name: 'density',
        label: t(lang, 'app.density'),
        value: appearance.density,
        options: [
          { value: 'comfortable', label: t(lang, 'app.densityComfortable') },
          { value: 'compact', label: t(lang, 'app.densityCompact') },
        ],
      })}
    </div>
  </div>

  <div class="card">
    <h2>${escapeHtml(t(lang, 'app.displaySection'))}</h2>
    ${checkboxField({ name: 'showBreadcrumbs', label: t(lang, 'app.showBreadcrumbs'), checked: appearance.showBreadcrumbs })}
    ${checkboxField({ name: 'showFileSize', label: t(lang, 'app.showFileSize'), checked: appearance.showFileSize })}
    ${checkboxField({ name: 'showModTime', label: t(lang, 'app.showModTime'), checked: appearance.showModTime })}
    ${checkboxField({ name: 'showFilterBox', label: t(lang, 'app.showFilterBox'), checked: appearance.showFilterBox })}
    ${checkboxField({ name: 'showSummary', label: t(lang, 'app.showSummary'), checked: appearance.showSummary })}
    <div class="row mt-12">
      ${selectField({
        name: 'defaultSort',
        label: t(lang, 'app.defaultSort'),
        value: appearance.defaultSort,
        options: ['namedirfirst', 'name', 'size', 'time'].map((v) => ({ value: v, label: v })),
      })}
      ${selectField({
        name: 'defaultOrder',
        label: t(lang, 'app.defaultOrder'),
        value: appearance.defaultOrder,
        options: [
          { value: 'asc', label: t(lang, 'app.sortAsc') },
          { value: 'desc', label: t(lang, 'app.sortDesc') },
        ],
      })}
    </div>
    ${textField({
      name: 'timeZone',
      label: t(lang, 'app.timeZone'),
      value: appearance.timeZone,
      hint: t(lang, 'app.timeZoneHint'),
      placeholder: 'Asia/Shanghai',
    })}
  </div>

  <div class="card">
    <h2>${escapeHtml(t(lang, 'app.fileSection'))}</h2>
    ${textareaField({
      name: 'previewExtensions',
      label: t(lang, 'app.previewExtensions'),
      value: appearance.previewExtensions.join('\n'),
      rows: 6,
      hint: t(lang, 'app.previewExtensionsHint'),
    })}
    ${textareaField({
      name: 'forceDownloadExtensions',
      label: t(lang, 'app.forceDownloadExtensions'),
      value: appearance.forceDownloadExtensions.join('\n'),
      rows: 5,
      hint: t(lang, 'app.forceDownloadExtensionsHint'),
    })}
  </div>

  <div class="card">
    <h2>${escapeHtml(t(lang, 'app.customCss'))}</h2>
    ${textareaField({
      name: 'customCss',
      label: t(lang, 'app.customCss'),
      value: appearance.customCss,
      rows: 6,
      hint: t(lang, 'app.customCssHint'),
    })}
  </div>
  </fieldset>

  ${
    options.canEdit
      ? `<div class="actions mb-16">
    <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
  </div>`
      : ''
  }
</form>

${preview}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'appearance',
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
