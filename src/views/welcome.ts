/**
 * 主界面（站点根路径的落地页）。
 *
 * 刻意**不列出任何目录** —— 那正是 `rootBehavior: 'welcome'` 想避免的信息泄露。
 * 这里只呈现站点想说的话：图片、标题、正文、若干链接。
 * 所有字段都可在后台「外观设置」里自定义。
 */

import { pickLocalized, type AppearanceConfig, type Lang, type ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml, headMeta, themeSwitchHtml } from './html.ts';
import { centeredCss, safeHexColor, THEME_SWITCH_CSS } from './styles.ts';
import { safeResourceUrl } from '../util/safeUrl.ts';

export type WelcomePageOptions = {
  lang: Lang;
  nonce: string;
  appearance: AppearanceConfig;
  /** 语言切换链接；为 null 时不渲染 */
  langSwitchHref: string | null;
  /** 本次生效的主题，写到 <html data-theme> */
  theme: ThemeMode;
  /** 主题切换链接；为 null 时不渲染 */
  themeSwitch: { toLight: string; toDark: string } | null;
};

export function renderWelcomePage(options: WelcomePageOptions): string {
  const { lang, appearance } = options;
  const accent = safeHexColor(appearance.accentColor, '#2563eb');

  // 主界面文案分中英两份，**按访客当前语言各取各的**（见 pickLocalized 的注释）。
  // 三处的回退链因此都是「当前语言的自定义文案 → 当前语言的内置文案」，
  // 不会串到另一种语言去。
  const customTitle = pickLocalized(appearance.welcomeTitle, lang);
  const customMessage = pickLocalized(appearance.welcomeMessage, lang);
  const customHint = pickLocalized(appearance.welcomeHint, lang);

  // 标题回退链：主界面标题 → 站点标题 → 内置文案
  const title =
    customTitle !== ''
      ? customTitle
      : appearance.siteTitle !== ''
        ? appearance.siteTitle
        : t(lang, 'welcome.title');
  const message = customMessage !== '' ? customMessage : t(lang, 'welcome.message');

  // 再校验一次：配置校验已经做过，但渲染层不该假设上游一定干净
  const imageUrl = safeResourceUrl(appearance.welcomeImage);
  const imageHtml =
    imageUrl === ''
      ? ''
      : `<img class="hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(pickLocalized(appearance.welcomeImageAlt, lang))}">`;

  // 语言与主题两个切换并排放在页面底部
  const langSwitch =
    options.langSwitchHref === null
      ? ''
      : `<a class="lang-switch" href="${escapeHtml(options.langSwitchHref)}">${
          lang === 'zh-CN' ? 'English' : '中文'
        }</a>`;

  const themeSwitch =
    options.themeSwitch === null
      ? ''
      : themeSwitchHtml({
          lang,
          toLightHref: options.themeSwitch.toLight,
          toDarkHref: options.themeSwitch.toDark,
        });

  const switches =
    langSwitch === '' && themeSwitch === '' ? '' : `<div class="switch">${langSwitch}${themeSwitch}</div>`;

  const footer =
    appearance.footerText !== '' ? `<p class="footer">${escapeHtml(appearance.footerText)}</p>` : '';

  // 底部提示语：后台可改，留空则用内置文案（「如有问题，请联系二维码提供方。」）。
  // 它是落地页上唯一的求助指引 —— 二维码印在线下物料上，访客手上没有时
  // 只能靠这行字知道该找谁。
  const hint = customHint !== '' ? customHint : t(lang, 'welcome.userHint');

  // ★ 图片宽度必须写进带 nonce 的 <style>，**不能**用内联 style 属性 ——
  //   本页 CSP 的 style-src 只放行带 nonce 的样式块，内联 style 会被浏览器拒绝。
  const heroRule =
    appearance.welcomeImageWidth > 0
      ? `.hero { width: ${appearance.welcomeImageWidth}px; }`
      : '.hero { max-width: 100%; }';

  const body = `
<main>
  ${imageHtml === '' ? '<div class="hero-badge"></div>' : imageHtml}
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${footer}
  <p class="hint">${escapeHtml(hint)}</p>
  ${switches}
</main>
`;

  return `<!DOCTYPE html>
<html lang="${lang}" data-theme="${options.theme}">
<head>
${headMeta({
    title,
    css: `${centeredCss({ accentColor: accent })}
main { max-width: 520px; }
h1 { font-size: 24px; letter-spacing: -.3px; }
.hero { display: block; margin: 0 auto 20px; height: auto; border-radius: 12px; }
.hero-badge {
  display: inline-block; width: 46px; height: 46px; border-radius: 12px;
  background: var(--accent); opacity: .12; margin-bottom: 18px;
}
.footer { margin-top: 22px; font-size: 12px; color: var(--muted); }
.switch {
  margin-top: 26px; display: flex; align-items: center; justify-content: center; gap: 10px;
}
/* 主界面用的是 centeredCss，不带 listingCss 里那套胶囊样式，这里补一份，
   否则语言/主题两个切换会退化成裸链接 —— 在这页上看着就像正文。 */
.switch a {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px;
  color: var(--muted); font-size: 13px; text-decoration: none;
}
.switch a:hover { color: var(--accent); border-color: var(--accent); }
.switch svg { display: block; }
.hint { margin-top: 18px; font-size: 13px; color: var(--muted); }
${THEME_SWITCH_CSS}
${heroRule}`,
    nonce: options.nonce,
    accentColor: accent,
    lang,
    frameAncestors: "'self'",
  })}
</head>
<body>
${body}
</body>
</html>
`;
}
