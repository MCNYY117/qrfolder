/**
 * 后台外壳：侧边栏 + 顶栏 + 内容区。
 *
 * 所有交互脚本都带 nonce 并通过 addEventListener 绑定 ——
 * 内联事件处理器（onclick= 等）会被本站 CSP 直接拒绝。
 */

import type { Lang, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml, headMeta, themeSwitchHtml } from './html.ts';
import { adminCss } from './adminStyles.ts';

export type AdminNavKey =
  | 'dashboard'
  | 'directories'
  | 'files'
  | 'users'
  | 'access'
  | 'system'
  | 'domain'
  | 'appearance'
  | 'logs';

/** 全量导航项。过滤由调用方（routes.ts）按权限算好后通过 navKeys 传进来 */
export const NAV_ITEMS: ReadonlyArray<{
  key: AdminNavKey;
  path: string;
  labelKey: Parameters<typeof t>[1];
}> = [
  { key: 'dashboard', path: '', labelKey: 'admin.navDashboard' },
  { key: 'directories', path: '/directories', labelKey: 'admin.navDirectories' },
  { key: 'files', path: '/files', labelKey: 'admin.navFiles' },
  { key: 'users', path: '/users', labelKey: 'admin.navUsers' },
  { key: 'access', path: '/access', labelKey: 'admin.navAccess' },
  { key: 'system', path: '/system', labelKey: 'admin.navSystem' },
  { key: 'domain', path: '/domain', labelKey: 'admin.navDomain' },
  { key: 'appearance', path: '/appearance', labelKey: 'admin.navAppearance' },
  { key: 'logs', path: '/logs', labelKey: 'admin.navLogs' },
];

export type Notice = { kind: 'ok' | 'err' | 'warn'; text: string };

export type AdminLayoutOptions = {
  lang: Lang;
  nonce: string;
  accentColor: string;
  adminPath: string;
  nav: AdminNavKey;
  csrfToken: string;
  siteTitle: string;
  pendingRestart: boolean;
  configIssues: boolean;
  /** 本次生效的主题，写到 <html data-theme> */
  theme: ThemeMode;
  /** 产品名，显示在后台抬头 */
  productName: string;
  /**
   * 侧边栏显示哪些导航项。**不传 = 全部显示**，那是「超级管理员」的默认。
   * 子管理员由 routes.ts 按权限算好传进来，页面上不出现自己用不了的功能。
   */
  navKeys?: readonly AdminNavKey[];
  /** 顶栏身份标签（形如 `alice · 子管理员`）。不传则不显示 */
  accountLabel?: string;
  notice?: Notice;
  body: string;
};

/** 外壳共用的接线脚本：颜色同步、表单确认、复制按钮 */
function wiringScript(nonce: string): string {
  return `<script nonce="${nonce}">
(function () {
  // 颜色选择器与十六进制输入双向同步（不用内联 oninput，CSP 会拒绝）
  var pickers = document.querySelectorAll('input[type="color"][data-sync-to]');
  for (var i = 0; i < pickers.length; i++) {
    (function (picker) {
      var target = document.getElementById(picker.getAttribute('data-sync-to'));
      if (!target) return;
      picker.addEventListener('input', function () { target.value = picker.value; });
      target.addEventListener('input', function () {
        if (/^#[0-9a-fA-F]{6}$/.test(target.value)) picker.value = target.value;
      });
    })(pickers[i]);
  }

  // 危险操作的二次确认（用 data-confirm 代替内联 onsubmit）
  var forms = document.querySelectorAll('form[data-confirm]');
  for (var j = 0; j < forms.length; j++) {
    (function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    })(forms[j]);
  }

  // data-confirm 也可以挂在**按钮**上。编辑弹窗里的「取消发布」就是这种：
  // 它用 formaction 把同一个表单发到另一个地址，而表单本身不该带确认语
  // （否则点「保存」也会弹那句「确定取消发布？」）。
  var confirmButtons = document.querySelectorAll('button[data-confirm]');
  for (var m = 0; m < confirmButtons.length; m++) {
    (function (button) {
      button.addEventListener('click', function (e) {
        // 拦住 click 就等于没提交 —— 按钮的默认行为发生在 click 之后
        if (!window.confirm(button.getAttribute('data-confirm'))) e.preventDefault();
      });
    })(confirmButtons[m]);
  }

  // 主题切换：相对链接 ?theme=dark 会把**整个查询串替换掉**，
  // 于是 /admin/directories?edit=xxx 点一下主题就把弹窗弄没了。
  // 点击时把当前查询串补回去。没有 JS 时按钮照样能用，只是会丢参数。
  var themeLinks = document.querySelectorAll('.theme-switch');
  for (var k = 0; k < themeLinks.length; k++) {
    (function (link) {
      link.addEventListener('click', function (event) {
        var target = link.className.indexOf('to-dark') !== -1 ? 'dark' : 'light';
        var params = new URLSearchParams(window.location.search);
        params.set('theme', target);
        event.preventDefault();
        window.location.href = window.location.pathname + '?' + params.toString();
      });
    })(themeLinks[k]);
  }

  // 日志页自动刷新
  var auto = document.getElementById('log-auto');
  if (auto) {
    var timer = null;
    auto.addEventListener('change', function () {
      if (auto.checked) {
        timer = setInterval(function () { window.location.reload(); }, 3000);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
  }

  // ---------------- 窄屏抽屉导航 ----------------
  //
  // ★ 抽屉样式只在 html.js 下生效（见 adminStyles.ts 的 .js 前缀）。
  //   为什么：没有 JS 时侧栏是页首那条横向导航（朴素但能用）；
  //   如果无条件把它变成 translateX(-100%)，没有 JS 的浏览器会**看不到任何导航**，
  //   而不是「导航变朴素了」。渐进增强的方向只能是「更好用」，不能是「从能用到不能用」。
  document.documentElement.classList.add('js');

  var burger = document.getElementById('nav-burger');
  var side = document.querySelector('.side');
  if (burger && side) {
    var setOpen = function (open) {
      side.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    burger.addEventListener('click', function () {
      setOpen(!side.classList.contains('open'));
    });

    // 点导航项之后要收起来，否则新页面加载前抽屉一直盖在内容上
    var links = side.querySelectorAll('a');
    for (var n = 0; n < links.length; n++) {
      links[n].addEventListener('click', function () { setOpen(false); });
    }

    // Esc 关闭：这是抽屉/弹层这类组件的通用预期
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });

    // 点抽屉外面也关。判断的是「点在遮罩上」而不是「点的不在侧栏里」——
    // 后者在点击落到 <html> 或滚动条上时也会触发，会出现「滚一下菜单就没了」。
    var scrim = document.getElementById('nav-scrim');
    if (scrim) scrim.addEventListener('click', function () { setOpen(false); });

    // 转回宽屏时必须清掉 open，否则拉宽之后那个 class 还在，
    // 再缩回来会看到一个「自己打开」的菜单
    var wide = window.matchMedia('(min-width: 781px)');
    var onWide = function (event) { if (event.matches) setOpen(false); };
    if (typeof wide.addEventListener === 'function') wide.addEventListener('change', onWide);
    else if (typeof wide.addListener === 'function') wide.addListener(onWide);
  }
})();
</script>`;
}

export function renderAdminLayout(options: AdminLayoutOptions): string {
  const { lang, adminPath } = options;
  const css = adminCss({ accentColor: options.accentColor });

  const allowed = options.navKeys === undefined ? null : new Set(options.navKeys);
  const navHtml = NAV_ITEMS.filter((item) => allowed === null || allowed.has(item.key))
    .map((item) => {
      const active = item.key === options.nav ? ' class="active"' : '';
      return `<a href="${escapeHtml(adminPath)}${item.path}"${active}>${escapeHtml(t(lang, item.labelKey))}</a>`;
    })
    .join('\n    ');

  const otherLang = lang === 'zh-CN' ? 'en-US' : 'zh-CN';
  const langLabel = otherLang === 'zh-CN' ? '中文' : 'English';

  const banners: string[] = [];
  if (options.notice !== undefined) {
    banners.push(`<div class="banner ${options.notice.kind}">${escapeHtml(options.notice.text)}</div>`);
  }
  if (options.configIssues) {
    banners.push(`<div class="banner err">${escapeHtml(t(lang, 'admin.configIssues'))}</div>`);
  }
  if (options.pendingRestart) {
    banners.push(`<div class="banner warn">${escapeHtml(t(lang, 'admin.pendingRestart'))}</div>`);
  }

  // 主题切换用「只有查询串」的相对链接：浏览器会把它拼到当前地址上，
  // 于是 ?edit=… 这类参数不会丢，也不需要额外的 next 参数和一条专有路由。
  const themeSwitch = themeSwitchHtml({
    lang,
    toLightHref: '?theme=light',
    toDarkHref: '?theme=dark',
  });

  return `<!DOCTYPE html>
<html lang="${lang}" data-theme="${options.theme}">
<head>
${headMeta({
    title: `${t(lang, 'admin.title')} · ${options.productName}`,
    css,
    nonce: options.nonce,
    accentColor: options.accentColor,
    lang,
    frameAncestors: "'none'",
  })}
</head>
<body>
<div class="layout">
  <aside class="side" id="nav-side">
    <div class="brand">${escapeHtml(options.productName)}<small>${escapeHtml(options.siteTitle || t(lang, 'admin.title'))}</small></div>
    <nav>
    ${navHtml}
    </nav>
  </aside>
  <div class="nav-scrim" id="nav-scrim"></div>
  <div class="main">
    <div class="top">
      <button type="button" class="burger" id="nav-burger" aria-controls="nav-side" aria-expanded="false"
              aria-label="${escapeHtml(t(lang, 'admin.navToggle'))}">
        <span></span><span></span><span></span>
      </button>
      <a class="btn" href="/" target="_blank" rel="noopener">${escapeHtml(t(lang, 'admin.viewSite'))}</a>
      <span class="spacer"></span>
      ${options.accountLabel === undefined ? '' : `<span class="who">${escapeHtml(options.accountLabel)}</span>`}
      <a class="btn" href="${escapeHtml(adminPath)}/lang?set=${otherLang}">${escapeHtml(langLabel)}</a>
      ${themeSwitch}
      <form method="post" action="${escapeHtml(adminPath)}/logout" class="form-inline">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
        <button type="submit">${escapeHtml(t(lang, 'admin.logout'))}</button>
      </form>
    </div>
    <div class="content">
      ${banners.join('\n      ')}
      ${options.body}
    </div>
  </div>
</div>
${wiringScript(options.nonce)}
</body>
</html>
`;
}

/** 登录页 / 首次设置页：无侧边栏、无导航 */
export function renderBareLayout(options: {
  lang: Lang;
  nonce: string;
  accentColor: string;
  title: string;
  lead: string;
  /** 登录页也要跟主题，否则深色站点上会闪一张白页 */
  theme: ThemeMode;
  /** 产品名，显示在登录页标题上 */
  productName: string;
  notice?: Notice;
  body: string;
}): string {
  const css = adminCss({ accentColor: options.accentColor });
  return `<!DOCTYPE html>
<html lang="${options.lang}" data-theme="${options.theme}">
<head>
${headMeta({
    title: `${options.title} · ${options.productName}`,
    css,
    nonce: options.nonce,
    accentColor: options.accentColor,
    lang: options.lang,
    frameAncestors: "'none'",
  })}
</head>
<body>
<div class="login-wrap">
  <div class="login-box">
    <h1>${escapeHtml(options.title)}</h1>
    <p class="lead">${escapeHtml(options.lead)}</p>
    ${options.notice === undefined ? '' : `<div class="banner ${options.notice.kind}">${escapeHtml(options.notice.text)}</div>`}
    ${options.body}
  </div>
</div>
${wiringScript(options.nonce)}
</body>
</html>
`;
}
