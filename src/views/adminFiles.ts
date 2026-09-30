/**
 * 文件管理页：在配置好的目录中浏览并上传文件。
 *
 * 上传不用 multipart —— 前端把 File 对象直接作为请求体发出，文件名放在
 * 自定义请求头里。这样服务端只需流式落盘，省掉了最容易出错的那部分解析。
 */

import type { Lang, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml } from './html.ts';
import {
  renderAdminLayout,
  type AdminLayoutOptions,
  type AdminNavKey,
  type Notice,
} from './adminLayout.ts';
import { formatBytes, formatDateTime } from '../serving/format.ts';

export type FileManagerDir = {
  id: string;
  name: string;
  label: string;
  available: boolean;
};

export type FileManagerEntry = {
  name: string;
  isDir: boolean;
  size: number | null;
  mtime: string;
};

export type FilesPageOptions = {
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
  dirs: readonly FileManagerDir[];
  selectedDirId: string;
  /** 当前子路径（已解码，用于显示） */
  relPath: string;
  /** 当前子路径（URL 编码，用于链接） */
  relPathEncoded: string;
  entries: readonly FileManagerEntry[];
  listError: string;
  /** 系统级的全局开关（System → Uploads） */
  uploadEnabled: boolean;
  /**
   * 这个身份有没有 `files.upload`。
   *
   * 和上面的全局开关**分开**：两者都会让上传区消失，但原因不同，
   * 提示语也该不同 —— 「管理员在系统设置里关掉了」和「你没有被授予上传权限」
   * 指向的是完全不同的下一步动作。
   */
  canUpload: boolean;
  maxSizeMb: number;
  allowOverwrite: boolean;
  timeZone: string;
};

/** 拼一个指向某个子路径的链接 */
function href(adminPath: string, dirId: string, relPath: string): string {
  const params = new URLSearchParams({ dir: dirId });
  if (relPath !== '') params.set('path', relPath);
  return `${adminPath}/files?${params.toString()}`;
}

function breadcrumbsHtml(options: FilesPageOptions): string {
  const { lang, adminPath, selectedDirId, relPath } = options;
  const parts = relPath.split('/').filter((p) => p !== '');

  const crumbs = [`<a href="${escapeHtml(href(adminPath, selectedDirId, ''))}">${escapeHtml(t(lang, 'files.root'))}</a>`];
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated === '' ? part : `${accumulated}/${part}`;
    crumbs.push(
      `<a href="${escapeHtml(href(adminPath, selectedDirId, accumulated))}">${escapeHtml(part)}</a>`,
    );
  }
  return `<nav class="crumbs">${crumbs.join('<span class="sep">/</span>')}</nav>`;
}

function entriesHtml(options: FilesPageOptions): string {
  const { lang, adminPath, selectedDirId, relPath } = options;

  if (options.listError !== '') {
    return `<tr><td colspan="3" class="cell-err">${escapeHtml(options.listError)}</td></tr>`;
  }

  const rows: string[] = [];
  if (relPath !== '') {
    const parent = relPath.split('/').slice(0, -1).join('/');
    rows.push(
      `<tr class="up"><td colspan="3"><a href="${escapeHtml(href(adminPath, selectedDirId, parent))}"><i class="ic dir"></i>${escapeHtml(t(lang, 'files.parent'))}</a></td></tr>`,
    );
  }

  for (const entry of options.entries) {
    // 图标、省略号、整行结构都和内容页一致（图标来自 baseCss 的 .ic）
    const icon = entry.isDir
      ? '<i class="ic dir"></i>'
      : `<i class="ic file" data-ext="${escapeHtml(fileExtensionOf(entry.name))}"></i>`;
    const label = `<span class="label">${escapeHtml(entry.name)}</span>`;
    const name = entry.isDir
      ? `<a href="${escapeHtml(href(adminPath, selectedDirId, relPath === '' ? entry.name : `${relPath}/${entry.name}`))}">${icon}${label}</a>`
      : `${icon}${label}`;
    const size = entry.isDir || entry.size === null ? '—' : escapeHtml(formatBytes(entry.size));
    // col-opt 与表头逐列对齐（见 adminDirectories 的说明）
    rows.push(
      `<tr><td class="c-name">${name}</td><td class="num col-opt">${size}</td><td class="c-time col-opt"><time datetime="${escapeHtml(
        entry.mtime,
      )}">${escapeHtml(formatDateTime(new Date(entry.mtime), lang, options.timeZone))}</time></td></tr>`,
    );
  }

  // ★ 判据是「有没有条目」，不是「已经推了几行」。
  //   以前这里数的是 rows.length，而「返回上一级」那一行在进循环之前就被推进去了，
  //   于是**子目录为空时永远不显示「此目录为空」** —— 只看到一行「返回上一级」，
  //   分不清是空目录还是没加载出来。
  //
  //   注意是 push 而不是 return：直接 return 会把上面那行「返回上一级」一起丢掉，
  //   空目录里就没有回到上层的入口了（面包屑虽然也在，但那是另一条路）。
  if (options.entries.length === 0) {
    rows.push(
      `<tr><td colspan="3" class="empty">${escapeHtml(
        t(lang, relPath === '' ? 'listing.emptyDir' : 'files.empty'),
      )}</td></tr>`,
    );
  }
  return rows.join('\n    ');
}

/** 取扩展名徽章上要显示的那几个字符（与内容页的 .ic.file 一致） */
function fileExtensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).slice(0, 4) : '';
}

export function renderFilesPage(options: FilesPageOptions): string {
  const { lang, adminPath } = options;

  if (options.dirs.length === 0) {
    return layout(options, `<h1>${escapeHtml(t(lang, 'files.title'))}</h1>
<p class="lead">${escapeHtml(t(lang, 'files.intro'))}</p>
<div class="card"><p>${escapeHtml(t(lang, 'files.noDirectory'))}</p>
<div class="actions"><a class="btn" href="${escapeHtml(adminPath)}/directories">${escapeHtml(t(lang, 'admin.navDirectories'))}</a></div></div>`);
  }

  const dirOptions = options.dirs
    .map(
      (dir) =>
        `<option value="${escapeHtml(dir.id)}"${dir.id === options.selectedDirId ? ' selected' : ''}>${escapeHtml(dir.label || dir.name)}</option>`,
    )
    .join('');

  const uploadCard =
    options.uploadEnabled && options.canUpload
      ? `<div class="card">
  <h2>${escapeHtml(t(lang, 'files.upload'))}</h2>
  <div id="drop-zone" class="drop-zone">
    <p>${escapeHtml(t(lang, 'files.dropHint'))}</p>
    <input type="file" id="file-input" multiple hidden>
    <button type="button" id="pick-btn" class="primary">${escapeHtml(t(lang, 'files.chooseFiles'))}</button>
    <p class="hint">${escapeHtml(
      t(lang, 'files.tooLarge', { mb: options.maxSizeMb }) + ' · ' + t(lang, 'files.overwriteHint'),
    )}</p>
  </div>
  <div id="upload-status" class="upload-status"></div>
</div>`
      : `<div class="card"><div class="banner warn">${escapeHtml(
          t(lang, options.uploadEnabled ? 'files.noUploadPermission' : 'files.disabled'),
        )}</div></div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'files.title'))}</h1>
<p class="lead">${escapeHtml(t(lang, 'files.intro'))}</p>

<div class="card">
  <form method="get" action="${escapeHtml(adminPath)}/files" class="row pick-row">
    <div class="field pick-dir">
      <label for="dir-pick">${escapeHtml(t(lang, 'files.pickDirectory'))}</label>
      <select id="dir-pick" name="dir">${dirOptions}</select>
    </div>
    <button type="submit">${escapeHtml(t(lang, 'common.confirm'))}</button>
  </form>
</div>

${uploadCard}

<div class="card">
  ${breadcrumbsHtml(options)}
  <div class="panel">
  <table>
    <thead><tr>
      <th>${escapeHtml(t(lang, 'listing.colName'))}</th>
      <th class="c-size col-opt">${escapeHtml(t(lang, 'listing.colSize'))}</th>
      <th class="c-time col-opt">${escapeHtml(t(lang, 'listing.colTime'))}</th>
    </tr></thead>
    <tbody>
    ${entriesHtml(options)}
    </tbody>
  </table>
  </div>
</div>
`;

  const withScript = layout(options, body).replace(
    '</body>',
    `${uploadScript(options)}\n</body>`,
  );
  return withScript;
}

function layout(options: FilesPageOptions, body: string): string {
  const layoutOptions: AdminLayoutOptions = {
    lang: options.lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath: options.adminPath,
    nav: 'files',
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

/** 上传脚本：串行上传、逐个显示结果，全部结束后刷新列表 */
function uploadScript(options: FilesPageOptions): string {
  if (!options.uploadEnabled || !options.canUpload) return '';

  const endpoint = `${options.adminPath}/files/upload?dir=${encodeURIComponent(options.selectedDirId)}${
    options.relPathEncoded === '' ? '' : `&path=${encodeURIComponent(options.relPathEncoded)}`
  }`;

  // 把 {name} 原样留在文案里，交给前端替换成真实文件名。
  // 不用控制字符当占位符 —— 那在源码里既不可读也容易被打错。
  const uploadingTemplate = t(options.lang, 'files.uploading', { name: '{name}' });

  return `<script nonce="${options.nonce}">
(function () {
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var CSRF = ${JSON.stringify(options.csrfToken)};
  var UPLOADING = ${JSON.stringify(uploadingTemplate)};

  var zone = document.getElementById('drop-zone');
  var input = document.getElementById('file-input');
  var pick = document.getElementById('pick-btn');
  var status = document.getElementById('upload-status');
  if (!zone || !input || !pick || !status) return;

  function line(text, cls) {
    var el = document.createElement('div');
    el.className = 'upload-row' + (cls ? ' ' + cls : '');
    el.textContent = text;
    status.appendChild(el);
    return el;
  }

  var failed = 0;

  function uploadOne(file) {
    return new Promise(function (resolve) {
      var row = line(UPLOADING.split('{name}').join(file.name));
      // 串行上传：一次只发一个，避免并发把带宽和内存打满
      fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          // 文件名放在头里；服务端会做与 URL 路径完全相同的段级校验
          'x-filename': encodeURIComponent(file.name),
          'x-csrf': CSRF
        },
        body: file
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok) {
            row.className = 'upload-row ok';
            row.textContent = file.name + ' — ' + (data.message || 'OK');
          } else {
            failed++;
            row.className = 'upload-row err';
            row.textContent = file.name + ' — ' + (data.error || ('HTTP ' + res.status));
          }
          resolve();
        });
      }).catch(function (err) {
        failed++;
        row.className = 'upload-row err';
        row.textContent = file.name + ' — ' + String(err);
        resolve();
      });
    });
  }

  function handle(files) {
    if (!files || files.length === 0) return;
    failed = 0;
    var chain = Promise.resolve();
    for (var i = 0; i < files.length; i++) {
      (function (f) { chain = chain.then(function () { return uploadOne(f); }); })(files[i]);
    }
    chain.then(function () {
      // ★ 全成功才刷新：刷新是为了让新文件出现在下面的列表里，
      //   而失败时刷新会把刚印出来的错误行一起冲掉 —— 那正是用户要读的东西。
      //   留着页面不动，他才知道哪个文件没上去、为什么。
      if (failed === 0) window.location.reload();
    });
  }

  pick.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () { handle(input.files); });

  // 拖放：不阻止默认行为的话浏览器会直接打开被拖入的文件
  ['dragenter', 'dragover'].forEach(function (evt) {
    zone.addEventListener(evt, function (e) {
      e.preventDefault();
      zone.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    zone.addEventListener(evt, function (e) {
      e.preventDefault();
      zone.classList.remove('over');
    });
  });
  zone.addEventListener('drop', function (e) {
    handle(e.dataTransfer && e.dataTransfer.files);
  });
})();
</script>`;
}
