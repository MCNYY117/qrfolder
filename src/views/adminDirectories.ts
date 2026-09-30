/**
 * 目录管理页。
 *
 * 「浏览服务器目录」按钮走 JSON 接口逐层展开，不做文件上传 ——
 * 保持零依赖，同时避免引入 multipart 解析器。
 */

import type { AccessLevel, Lang, SortField, SortOrder, ThemeMode } from '../config/schema.ts';
import { t } from '../i18n/index.ts';
import { escapeHtml } from './html.ts';
import {
  renderAdminLayout,
  type AdminLayoutOptions,
  type AdminNavKey,
  type Notice,
} from './adminLayout.ts';
import {
  SCAN_PICK_PREFIX,
  checkboxField,
  csrfInput,
  passwordField,
  selectField,
  textField,
  textareaField,
} from './forms.ts';

export type DirectoryRow = {
  id: string;
  name: string;
  path: string;
  label: string;
  enabled: boolean;
  access: AccessLevel;
  hasPassword: boolean;
  followSymlinks: boolean;
  note: string;
  available: boolean;
  reason: string;
};

export type DirectoryFormState = {
  /** 空字符串表示新增 */
  id: string;
  /** URL 前缀（`dir.name`）。留空 = 用目录名 */
  name: string;
  /**
   * 物理位置 = 父目录 + 目录名，服务端拼成绝对路径。
   *
   * 不存拼好的完整路径：存了就有两个真值来源，改了一个忘了另一个时，
   * 表单显示的和实际落盘的会悄悄分叉。
   */
  parent: string;
  folder: string;
  label: string;
  enabled: boolean;
  access: AccessLevel;
  followSymlinks: boolean;
  sort: string;
  order: string;
  cidrs: string;
  note: string;
  /**
   * 归属账号 id。空串 = 超级管理员。
   *
   * 这个字段只在超级管理员的表单里渲染（子管理员看不见、也改不了），
   * 所以「字段缺失」这件事是有意义的：读表单时缺失就保留原值。
   */
  owner: string;
};

/** 归属下拉框的选项。子管理员看不到这个下拉 */
export type OwnerOption = { id: string; username: string };

/**
 * 当前身份在这一页能做什么。
 *
 * **这只是界面收敛：** 藏掉按钮是为了不让人点进去撞 404，
 * 真正的强制在 `admin/policy.ts` 的路由策略表里，两者互不替代。
 */
export type DirectoryPerms = {
  create: boolean;
  update: boolean;
  remove: boolean;
  qr: boolean;
  browse: boolean;
  /** 改「对外访问地址」—— 二维码弹窗里那个保存按钮要它 */
  publicBase: boolean;
  /**
   * 删目录**及其内容**（不可撤销）。写死等于「是不是超级管理员」——
   * 这不是一个可勾选的权限，见 policy.ts 里 dirs.purge 的注释。
   */
  purge: boolean;
  isSuper: boolean;
};

export type DirectoriesPageOptions = {
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
  rows: readonly DirectoryRow[];
  editing: DirectoryFormState | null;
  /**
   * 正在编辑的那个目录在服务器上的绝对路径。只用于「删除内容」弹窗里显示
   * 「将要删掉哪个文件夹」—— 那是按下永久删除之前最后一眼确认的东西。
   *
   * 单独传而不是塞进 `DirectoryFormState`：表单里是「父目录 + 目录名」两个字段，
   * 再存一份拼好的路径就有了第二个真值来源，改了这边忘了那边时，
   * 弹窗显示的和实际要删的会悄悄分叉。
   */
  editingPath: string;
  /** 调用者可以用的父目录池：超管 = 全部，子管理员 = 他被勾选的那几个 */
  parentRoots: readonly string[];
  /** 系统设置里的「对外访问地址」，作为二维码弹窗的初值 */
  publicBaseUrl: string;
  perms: DirectoryPerms;
  /** 归属下拉框的候选账号。只有超级管理员用得上 */
  owners: readonly OwnerOption[];
};

function accessLabel(lang: Lang, access: AccessLevel): string {
  if (access === 'public') return t(lang, 'dirs.accessPublic');
  if (access === 'password') return t(lang, 'dirs.accessPassword');
  return t(lang, 'dirs.accessInherit');
}

function directoryForm(options: DirectoriesPageOptions, form: DirectoryFormState): string {
  const { lang, adminPath } = options;
  const isNew = form.id === '';
  const action = `${adminPath}/directories/${isNew ? 'create' : 'update'}`;

  const accessOptions = [
    { value: 'inherit', label: t(lang, 'dirs.accessInherit') },
    { value: 'public', label: t(lang, 'dirs.accessPublic') },
    { value: 'password', label: t(lang, 'dirs.accessPassword') },
  ];

  const sortOptions = [
    { value: '', label: t(lang, 'dirs.sortInherit') },
    { value: 'namedirfirst', label: 'namedirfirst' },
    { value: 'name', label: 'name' },
    { value: 'size', label: 'size' },
    { value: 'time', label: 'time' },
  ];

  const orderOptions = [
    { value: '', label: t(lang, 'dirs.sortInherit') },
    { value: 'asc', label: t(lang, 'app.sortAsc') },
    { value: 'desc', label: t(lang, 'app.sortDesc') },
  ];

  // 新建时默认落在池子的第一项；编辑时用当前所在的父目录。
  const parent = form.parent !== '' ? form.parent : (options.parentRoots[0] ?? '');

  // ★ 编辑一个路径在池子之外的老目录时，把它的当前父目录补进下拉框。
  //   不补的话，下拉框里选中项是空的，一保存就等于「把它挪到池子里的第一项去」——
  //   改个标题顺手把线上目录搬了家。补进来之后，「不动它」才是可表达的。
  //   服务端对「路径没变」是放行的（见 checkScope 的 pathUnchanged），
  //   但改目录名就会真的越界并被拒 —— 那时提示语会告诉他去池子里加。
  const parentOptions = options.parentRoots.map((root) => ({ value: root, label: root }));
  if (parent !== '' && !options.parentRoots.includes(parent)) {
    parentOptions.unshift({
      value: parent,
      label: `${parent} ${t(lang, 'dirs.fieldParentOutside')}`,
    });
  }

  // 用原生 <dialog> 呈现：服务端渲染好表单内容，页面脚本只负责 showModal()。
  // 这样不必在前端再实现一遍表单构建，且 ?edit=<id> 的链接可以直达。
  return `<dialog id="dir-dialog" class="dialog">
  <form method="post" action="${escapeHtml(action)}">
    <h2>${escapeHtml(isNew ? t(lang, 'dirs.add') : `${t(lang, 'common.edit')} · ${form.name}`)}</h2>
    ${csrfInput(options.csrfToken)}
    ${isNew ? '' : `<input type="hidden" name="id" value="${escapeHtml(form.id)}">`}

    <div class="row">
      ${textField({
        name: 'name',
        label: t(lang, 'dirs.fieldName'),
        value: form.name,
        hint: t(lang, 'dirs.fieldNameHint'),
        placeholder: 'Manuals',
      })}
      ${textField({
        name: 'label',
        label: t(lang, 'dirs.fieldLabel'),
        value: form.label,
        hint: t(lang, 'dirs.fieldLabelHint'),
      })}
    </div>

    ${selectField({
      name: 'parent',
      label: t(lang, 'dirs.fieldParent'),
      value: parent,
      options: parentOptions,
      hint: t(lang, 'dirs.fieldParentHint'),
    })}

    <div class="field">
      <label for="f_folder">${escapeHtml(t(lang, 'dirs.fieldFolder'))}</label>
      <div class="field-inline">
        <input type="text" id="f_folder" name="folder" value="${escapeHtml(form.folder)}"
               placeholder="Manuals" required autocomplete="off">
        ${
          // 浏览按钮只是「看看这个父目录下已经有什么」的辅助，填的还是目录名。
          // 没有 dirs.browse 的人照样能手填，所以这里只是少个按钮，不是少条路。
          options.perms.browse
            ? `<button type="button" id="browse-btn">${escapeHtml(t(lang, 'dirs.browse'))}</button>`
            : ''
        }
      </div>
      <div class="hint">${escapeHtml(t(lang, 'dirs.fieldFolderHint'))}</div>
      <div id="picker-host"></div>
    </div>

    ${
      // 归属只有超级管理员能改。子管理员新建时服务端直接盖章成他自己，
      // 表单里连字段都不出现 —— 免得有人以为「没选就是公共的」。
      options.perms.isSuper
        ? selectField({
            name: 'owner',
            label: t(lang, 'dirs.fieldOwner'),
            value: form.owner,
            options: options.owners.map((owner) => ({ value: owner.id, label: owner.username })),
            hint: t(lang, 'dirs.fieldOwnerHint'),
          })
        : ''
    }

    ${selectField({
      name: 'access',
      label: t(lang, 'dirs.fieldAccess'),
      value: form.access,
      options: accessOptions,
    })}

    ${passwordField({
      name: 'password',
      label: t(lang, 'dirs.fieldPassword'),
      hint: t(lang, 'dirs.fieldPasswordHint'),
    })}

    ${textareaField({
      name: 'cidrs',
      label: t(lang, 'dirs.fieldCidrs'),
      value: form.cidrs,
      rows: 3,
      hint: t(lang, 'dirs.fieldCidrsHint'),
    })}

    <div class="row">
      ${selectField({
        name: 'sort',
        label: t(lang, 'dirs.fieldSort'),
        value: form.sort,
        options: sortOptions,
        hint: t(lang, 'dirs.fieldSortHint'),
      })}
      ${selectField({
        name: 'order',
        label: t(lang, 'app.defaultOrder'),
        value: form.order,
        options: orderOptions,
      })}
    </div>

    ${checkboxField({
      name: 'enabled',
      label: t(lang, 'dirs.fieldEnabled'),
      checked: form.enabled,
    })}

    ${checkboxField({
      name: 'followSymlinks',
      label: t(lang, 'dirs.fieldFollowSymlinks'),
      checked: form.followSymlinks,
      hint: t(lang, 'dirs.fieldFollowSymlinksHint'),
    })}

    ${textField({
      name: 'note',
      label: t(lang, 'dirs.fieldNote'),
      value: form.note,
      hint: t(lang, 'dirs.fieldNoteHint'),
    })}

    ${
      // 「危险操作」只在编辑已有目录时出现：新建的时候还没有东西可删。
      //
      // 这两个动作**不放在列表行里**：那会让操作列挤五个按钮，而表格是固定布局，
      // 每列只有「宽度 ÷ 列数」，多出来的会被 .panel 的 overflow:hidden 裁掉。
      // 放在这里其实也更合规矩 —— 你正看着这个目录的完整路径做决定。
      isNew ? '' : dangerZone(options, form)
    }

    <div class="dialog-actions">
      <a class="btn" href="${escapeHtml(adminPath)}/directories">${escapeHtml(t(lang, 'common.cancel'))}</a>
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
    </div>
  </form>
</dialog>`;
}

/**
 * 编辑弹窗底部的「危险操作」区。
 *
 * ★ 两个按钮用**不同的机制**提交，都是刻意的：
 *   - 取消发布用 `formaction` 把同一个表单发到 /directories/delete。表单里已经有
 *     id 和 CSRF，浏览器原生支持换提交地址，不用再嵌一个 <form>
 *     （表单不能嵌套，这是 HTML 的硬规矩）。
 *   - 删除内容只是**打开**那个确认弹窗（type="button" + data-purge）——
 *     它有自己的 <dialog> 和表单，而且必须让用户再手打一遍目录名。
 *     那个弹窗渲染在编辑弹窗**外面**（见 renderDirectoriesPage），否则表单就嵌套了。
 */
function dangerZone(options: DirectoriesPageOptions, form: DirectoryFormState): string {
  const { lang, adminPath } = options;

  const unpublish = options.perms.remove
    ? `<div class="danger-row">
      <button type="submit" class="act" formaction="${escapeHtml(adminPath)}/directories/delete"
              formnovalidate
              data-confirm="${escapeHtml(t(lang, 'dirs.confirmDelete', { name: form.name }))}"
      >${escapeHtml(t(lang, 'dirs.unpublish'))}</button>
      <span class="hint">${escapeHtml(t(lang, 'dirs.unpublishHint'))}</span>
    </div>`
    : '';

  const purge = options.perms.purge
    ? `<div class="danger-row">
      <button type="button" class="act danger" data-purge="${escapeHtml(form.id)}"
              data-purge-name="${escapeHtml(form.name)}"
              data-purge-path="${escapeHtml(options.editingPath)}"
      >${escapeHtml(t(lang, 'dirs.purge'))}</button>
      <span class="hint">${escapeHtml(t(lang, 'dirs.purgeHint'))}</span>
    </div>`
    : '';

  if (unpublish === '' && purge === '') return '';

  return `<div class="danger-zone">
      <h3 class="sub">${escapeHtml(t(lang, 'dirs.dangerZone'))}</h3>
      ${unpublish}
      ${purge}
    </div>`;
}

/**
 * 二维码弹窗。
 *
 * 图片本身由服务端渲染（`/admin/directories/qr`），前端只负责换 `src`：
 * 二维码编码器只有一份实现，放在服务端，避免前后端各写一遍再慢慢跑偏。
 * 页面脚本做的那点字符串拼接仅用于展示「二维码内容」那行字。
 */
function qrDialog(options: DirectoriesPageOptions): string {
  const { lang, adminPath } = options;

  return `<dialog id="qr-dialog" class="dialog">
  <form method="post" action="${escapeHtml(adminPath)}/system/publicbase">
    ${csrfInput(options.csrfToken)}
    <input type="hidden" name="return" value="${escapeHtml(adminPath)}/directories">
    <h2>${escapeHtml(t(lang, 'dirs.qr'))}<span id="qr-dialog-name"></span></h2>

    <div class="field">
      <label for="qr-base">${escapeHtml(t(lang, 'dirs.qrBase'))}</label>
      ${
        // 没有改「对外访问地址」的权限时，输入框本身也要锁住。
        // 只藏掉保存按钮是不够的：输入框还能改，二维码会跟着变，
        // 看着像"改了但没保存"，而按下保存本来也只会 404。
        // 用 readonly 而不是 disabled —— 值还得让脚本读、让人能复制。
        `<input type="text" id="qr-base" name="publicBaseUrl" value="${escapeHtml(options.publicBaseUrl)}"
             placeholder="https://files.example.com" autocomplete="off"${
               options.perms.publicBase ? '' : ' readonly'
             }>`
      }
      <div class="hint">${escapeHtml(
        options.perms.publicBase ? t(lang, 'dirs.qrBaseHint') : t(lang, 'dirs.qrBaseReadonly'),
      )}</div>
    </div>

    <div class="qr-frame"><img id="qr-image" alt="" width="240" height="240"></div>

    <div class="field">
      <label>${escapeHtml(t(lang, 'dirs.qrContent'))}</label>
      <div class="mono qr-target" id="qr-target"></div>
    </div>
    <div class="hint" id="qr-note"></div>

    <div class="dialog-actions">
      <a class="btn" id="qr-svg" href="#" download>${escapeHtml(t(lang, 'dirs.qrDownloadSvg'))}</a>
      <a class="btn" id="qr-png" href="#" download>${escapeHtml(t(lang, 'dirs.qrDownloadPng'))}</a>
      ${
        // 「保存对外地址」提交到 /system/publicbase，没权限的人点了只会 404。
        // 说明文字放在上面输入框下面（那里本来就是提示语的位置），
        // 不要塞进这一行按钮里 —— 这行是 flex 布局，一句中文挤在按钮中间很难看。
        options.perms.publicBase
          ? `<button type="submit">${escapeHtml(t(lang, 'dirs.qrSaveBase'))}</button>`
          : ''
      }
      <button type="button" id="qr-close">${escapeHtml(t(lang, 'common.close'))}</button>
    </div>
  </form>
</dialog>`;
}

/**
 * 「删除内容」弹窗。
 *
 * 单独一个弹窗、由脚本按行填值，而不是每行各渲染一个 —— 见 pageScript 里的说明。
 * 里面那句警告要显眼：这是全站唯一一个不可撤销的操作。
 */
function purgeDialog(options: DirectoriesPageOptions): string {
  const { lang, adminPath } = options;

  return `<dialog id="purge-dialog" class="dialog">
  <form method="post" action="${escapeHtml(adminPath)}/directories/purge">
    ${csrfInput(options.csrfToken)}
    <input type="hidden" name="id" id="purge-id">
    <h2>${escapeHtml(t(lang, 'dirs.purgeTitle'))}</h2>

    <div class="banner err">${escapeHtml(t(lang, 'dirs.purgeWarn'))}</div>

    <div class="kv">
      <span>${escapeHtml(t(lang, 'dirs.purgePath'))}</span>
      <span class="mono" id="purge-path"></span>
    </div>
    <div class="kv">
      <span>${escapeHtml(t(lang, 'dirs.colName'))}</span>
      <span class="mono" id="purge-name"></span>
    </div>

    <div class="field mt-12">
      ${/* 标签文字由脚本填：里面要嵌当前这一行的目录名，而弹窗只有一个。
           用 {name} 占位再在客户端替换 —— 和上传那行「正在上传 {name}」同一套路。 */ ''}
      <label for="purge-confirm" id="purge-label"></label>
      <input type="text" id="purge-confirm" name="confirm" autocomplete="off" required>
      <div class="hint">${escapeHtml(t(lang, 'dirs.purgeConfirmHint'))}</div>
    </div>

    <div class="dialog-actions">
      <button type="button" id="purge-cancel">${escapeHtml(t(lang, 'common.cancel'))}</button>
      <button type="submit" class="danger">${escapeHtml(t(lang, 'dirs.purgeSubmit'))}</button>
    </div>
  </form>
</dialog>`;
}

/** 二维码弹窗脚本：打开时按目录 id 拉图，输入域名后实时重取 */
function qrScript(nonce: string, adminPath: string, lang: Lang, publicBaseUrl: string): string {
  const labels = {
    empty: t(lang, 'dirs.qrEmptyBase'),
    failed: t(lang, 'dirs.qrFailed'),
    title: t(lang, 'dirs.qr'),
    configuredBase: publicBaseUrl,
  };

  return `<script nonce="${nonce}">
(function () {
  var dialog = document.getElementById('qr-dialog');
  if (!dialog) return;

  var L = ${JSON.stringify(labels)};
  var AP = ${JSON.stringify(adminPath)};
  var baseInput = document.getElementById('qr-base');
  var image = document.getElementById('qr-image');
  var targetBox = document.getElementById('qr-target');
  var note = document.getElementById('qr-note');
  var svgLink = document.getElementById('qr-svg');
  var pngLink = document.getElementById('qr-png');
  var nameSpan = document.getElementById('qr-dialog-name');
  var current = null;

  // 必须与服务端 qrBaseOf 的优先级逐条对齐：输入框 → 已保存的对外地址 → 当前访问地址。
  // 少了中间那层，就会出现「输入框清空后显示的是一回事、实际生成的码是另一回事」——
  // 图片是对的，旁边那行字是错的，比两者都错更难发现。
  function effectiveBase() {
    var raw = baseInput.value.trim();
    if (raw === '') return L.configuredBase !== '' ? L.configuredBase : location.origin;
    if (!/^https?:\\/\\//i.test(raw)) raw = location.protocol + '//' + raw;
    return raw.replace(/\\/+$/, '');
  }

  function endpoint(format, download) {
    var query = AP + '/directories/qr?dir=' + encodeURIComponent(current.id) + '&format=' + format;
    var raw = baseInput.value.trim();
    if (raw !== '') query += '&base=' + encodeURIComponent(raw);
    if (download) query += '&download=1';
    return query;
  }

  function refresh() {
    if (current === null) return;
    image.src = endpoint('svg', false);
    svgLink.href = endpoint('svg', true);
    pngLink.href = endpoint('png', true);
    targetBox.textContent = effectiveBase() + '/' + encodeURIComponent(current.name) + '/';
    note.textContent = baseInput.value.trim() === '' && L.configuredBase === '' ? L.empty : '';
  }

  // 防抖：每敲一个字符就重取一次既浪费又让二维码一直闪
  var timer = 0;
  baseInput.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  });

  image.addEventListener('error', function () {
    note.textContent = L.failed;
  });

  var buttons = document.querySelectorAll('[data-qr]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (event) {
      var button = event.currentTarget;
      current = { id: button.getAttribute('data-qr'), name: button.getAttribute('data-qr-name') };
      nameSpan.textContent = ' · ' + current.name;
      refresh();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  }

  document.getElementById('qr-close').addEventListener('click', function () {
    dialog.close();
  });

  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });
})();
</script>`;
}

/**
 * 页面上那两处「列出某个目录的一级子目录」的脚本。
 *
 * 一处是新建/编辑表单里的「浏览…」——只列**选中的那个父目录**的直接子目录，
 * 点一下把名字填进「目录名」框，不做逐层下钻（下钻这个动作已经被父目录下拉框
 * 承担了；两套导航并存时，人分不清点一下改的是「我在哪」还是「我叫什么」）。
 *
 * 另一处是「扫描导入」的勾选列表 —— 同一个接口、同一份渲染逻辑，只是把每一项
 * 渲染成复选框而不是按钮。
 *
 * ★ 两处共用一个 script 块是刻意的：里面那段「fetch 回来的可能是 HTML 登录页」
 *   的防护很难写对（要同时看 r.redirected 和 content-type），复制一份迟早分叉，
 *   而分叉的方向一定是「其中一处悄悄变成一个什么都不说明的『加载失败』」。
 */
function pickerScript(
  nonce: string,
  adminPath: string,
  lang: Lang,
  takenNames: readonly { name: string; enabled: boolean }[],
): string {
  const labels = {
    hint: t(lang, 'dirs.browseHint'),
    empty: t(lang, 'dirs.browseEmpty'),
    failed: t(lang, 'dirs.browseFailed'),
    scanLoading: t(lang, 'dirs.scanLoading'),
    scanNone: t(lang, 'dirs.scanNone'),
    scanPublished: t(lang, 'dirs.scanPublished'),
    scanDisabled: t(lang, 'dirs.scanDisabled'),
    scanAll: t(lang, 'dirs.scanAll'),
    scanAllOff: t(lang, 'dirs.scanAllOff'),
    // 把 {name} 原样留在文案里，交给前端换成真实目录名
    purgeLabel: t(lang, 'dirs.purgeConfirmLabel', { name: '{name}' }),
  };

  return `<script nonce="${nonce}">
(function () {
  // 编辑表单以 <dialog> 呈现：内容由服务端渲染好，这里只负责打开。
  // 用原生 dialog 而不是自己实现遮罩，是为了让 Esc 关闭、焦点陷阱这些行为免费可用。
  var dialog = document.getElementById('dir-dialog');
  if (dialog) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    // 原生 dialog 只有 Esc 会关闭，点击遮罩需要自己处理
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });
  }

  var L = ${JSON.stringify(labels)};
  // 服务端已经知道哪些 URL 前缀被占了。**只传调用者看得见的那几个** ——
  // 拿全量来标记，等于把「存在一个叫某某的目录」这件事告诉子管理员。
  // 看不见的那些由服务端在导入时静默跳过。
  //
  // ★ 值里带着「启没启用」：停用的目录**并没有在对外发布**，标成「已发布」
  //   是在说假话，会让人以为线上还开着。名字确实被占（URL 前缀全局唯一），
  //   所以照样不能勾，但标签要说实话。
  var TAKEN = ${JSON.stringify(
    Object.fromEntries(takenNames.map((row) => [row.name.toLowerCase(), row.enabled])),
  )};

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 取某个目录的一级子目录。拿不到就调 onFail。
   *
   * ★ 不能直接 r.json()。这个接口在「没权限」「会话过期」时回的是 HTML 页面，
   *   json() 会抛，前端就只剩一个 'failed' —— 什么都说明不了，
   *   用户看着像坏了，其实只是需要重新登录。
   *   fetch 默认跟随重定向，所以会话过期时这里是 200 + 登录页 HTML，
   *   靠 r.redirected 才能认出来。
   */
  function listDirs(path, onOk, onFail) {
    var url = ${JSON.stringify(adminPath)} + '/directories/picker?path=' + encodeURIComponent(path);
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.redirected) return { error: L.failed };
        var type = r.headers.get('content-type') || '';
        if (type.indexOf('json') === -1) return { error: L.failed };
        return r.json();
      })
      .then(function (data) {
        if (data.error) { onFail(data.error); return; }
        onOk(data.directories || []);
      })
      .catch(function () { onFail(L.failed); });
  }

  // ---------------- 新建/编辑表单里的「浏览…」 ----------------
  var btn = document.getElementById('browse-btn');
  var host = document.getElementById('picker-host');
  var folderInput = document.getElementById('f_folder');
  var parentSelect = document.getElementById('f_parent');

  if (btn && host && folderInput && parentSelect) {
    btn.addEventListener('click', function () {
      listDirs(
        parentSelect.value,
        function (dirs) {
          var html = '<div class="hint">' + escapeHtml(L.hint) + '</div>';
          if (dirs.length === 0) {
            html += '<div class="empty">' + escapeHtml(L.empty) + '</div>';
          } else {
            // 每一项都是 <button> 而不是 <a href="#">：天然可 Tab、可回车，
            // 也不会在状态栏里显示一个假的链接地址。
            for (var i = 0; i < dirs.length; i++) {
              html +=
                '<button type="button" class="picker-item" data-name="' + escapeHtml(dirs[i].name) + '">' +
                '<span class="ic dir" aria-hidden="true"></span>' + escapeHtml(dirs[i].name) + '</button>';
            }
          }
          host.innerHTML = html;

          var items = host.querySelectorAll('[data-name]');
          for (var j = 0; j < items.length; j++) {
            (function (item) {
              item.addEventListener('click', function () {
                folderInput.value = item.getAttribute('data-name');
                host.innerHTML = '';
              });
            })(items[j]);
          }
        },
        function (message) { host.textContent = message; },
      );
    });

    // 换父目录后旧的候选列表就不再对应当前位置了，直接清掉 ——
    // 留着会让人从上一个位置的列表里挑一个名字，然后发布到新的位置去。
    parentSelect.addEventListener('change', function () {
      host.innerHTML = '';
    });
  }

  // ---------------- 扫描导入的勾选列表 ----------------
  var scanHost = document.getElementById('scan-list');
  var scanRoot = document.getElementById('f_root');
  var scanToggle = document.getElementById('scan-toggle');

  if (scanHost && scanRoot) {
    var loadScan = function () {
      scanHost.textContent = L.scanLoading;
      listDirs(
        scanRoot.value,
        function (dirs) {
          if (dirs.length === 0) {
            scanHost.innerHTML = '<div class="empty">' + escapeHtml(L.scanNone) + '</div>';
            return;
          }
          var html = '';
          for (var i = 0; i < dirs.length; i++) {
            var name = dirs[i].name;
            var taken = TAKEN[name.toLowerCase()];
            var done = taken !== undefined;
            // 名字被占就不能再勾（URL 前缀全局唯一），但标签要说实话：
            // 停用的目录并没有在对外发布，标成「已发布」会让人以为线上还开着。
            var tag = done
              ? '<span class="tag off">' +
                escapeHtml(taken ? L.scanPublished : L.scanDisabled) +
                '</span>'
              : '';
            // 字段名带目录名（name="pick:<目录名>"），值恒为 1。
            // 不用同名多值的复选框：手写的 urlencoded 解析器把重复的键折叠成
            // 最后一个，那样勾十个只会导入一个，而且不报错。
            html +=
              '<label class="check scan-item' + (done ? ' done' : '') + '">' +
              '<input type="checkbox" name="${SCAN_PICK_PREFIX}' + escapeHtml(name) + '" value="1"' +
              (done ? ' disabled' : '') + '>' +
              '<span class="ic dir" aria-hidden="true"></span>' +
              '<span class="scan-name">' + escapeHtml(name) + '</span>' +
              tag +
              '</label>';
          }
          scanHost.innerHTML = html;
        },
        function (message) { scanHost.textContent = message; },
      );
    };

    scanRoot.addEventListener('change', loadScan);
    loadScan();

    if (scanToggle) {
      var allOn = false;
      scanToggle.addEventListener('click', function () {
        allOn = !allOn;
        var boxes = scanHost.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = allOn && !boxes[i].disabled;
        scanToggle.textContent = allOn ? L.scanAllOff : L.scanAll;
      });
    }
  }

  // ---------------- 「删除内容」弹窗 ----------------
  //
  // 和二维码弹窗同一套路：一个 <dialog>，按钮上带 data-* 属性，
  // 脚本负责把当前这一行的信息填进去再 showModal()。
  // 每行一个弹窗的话，几十个目录就是几十个隐藏表单。
  var purgeDialog = document.getElementById('purge-dialog');
  var purgeButtons = document.querySelectorAll('[data-purge]');

  if (purgeDialog && purgeButtons.length > 0) {
    var purgeName = document.getElementById('purge-name');
    var purgeLabel = document.getElementById('purge-label');
    var purgePath = document.getElementById('purge-path');
    var purgeInput = document.getElementById('purge-confirm');

    for (var p = 0; p < purgeButtons.length; p++) {
      (function (button) {
        button.addEventListener('click', function () {
          var name = button.getAttribute('data-purge-name');
          document.getElementById('purge-id').value = button.getAttribute('data-purge');
          purgeName.textContent = name;
          purgeLabel.textContent = L.purgeLabel.split('{name}').join(name);
          purgePath.textContent = button.getAttribute('data-purge-path');
          // 每次打开都清空：上一轮打对了名字、这一轮换了另一个目录，
          // 留着旧值就等于替用户确认了一次
          purgeInput.value = '';
          if (typeof purgeDialog.showModal === 'function') purgeDialog.showModal();
          else purgeDialog.setAttribute('open', '');
        });
      })(purgeButtons[p]);
    }

    document.getElementById('purge-cancel').addEventListener('click', function () {
      purgeDialog.close();
    });
    purgeDialog.addEventListener('click', function (event) {
      if (event.target === purgeDialog) purgeDialog.close();
    });
  }
})();
</script>`;
}

export function renderDirectoriesPage(options: DirectoriesPageOptions): string {
  const { lang, adminPath } = options;

  const rows =
    options.rows.length === 0
      ? `<tr><td colspan="5" class="muted">${escapeHtml(t(lang, 'dirs.empty'))}</td></tr>`
      : options.rows
          .map((row) => {
            const nameCell = options.perms.update
              ? `<a href="${escapeHtml(adminPath)}/directories?edit=${escapeHtml(row.id)}">${escapeHtml(row.name)}</a>`
              : escapeHtml(row.name);
            const qrButton = options.perms.qr
              ? `<button type="button" class="act" data-qr="${escapeHtml(row.id)}" data-qr-name="${escapeHtml(row.name)}">${escapeHtml(t(lang, 'dirs.qr'))}</button>`
              : '';
            const editLink = options.perms.update
              ? `<a class="act" href="${escapeHtml(adminPath)}/directories?edit=${escapeHtml(row.id)}">${escapeHtml(t(lang, 'common.edit'))}</a>`
              : '';
            // ★ 两个删除类动作**不在这一行里**，在编辑弹窗底部的「危险操作」区
            //   （见 directoryForm）。放在行里的话操作列要挤五个按钮：表格是
            //   固定布局，每列只拿到「宽度 ÷ 列数」——1080px 的版心上操作列是 206px，
            //   而五个按钮排一行要 338px，溢出的部分会被 .panel 的 overflow:hidden
            //   裁掉，看着就是「删除按钮不见了」。挪走之后行里只剩三个按钮。
            //
            // ★ 表头标了 col-opt 的列，数据行必须标同一个 ——
            //   只藏表头不藏数据，窄屏上表头和数据会错位一格，看上去像串行了。
            return `<tr>
      <td>${nameCell}</td>
      <td class="mono col-opt">${escapeHtml(row.path)}
        ${row.available ? '' : `<br><span class="tag err">${escapeHtml(t(lang, 'dirs.unavailable'))}</span> <span class="mono">${escapeHtml(row.reason)}</span>`}
      </td>
      <td class="col-opt">${escapeHtml(accessLabel(lang, row.access))}${row.hasPassword ? ' 🔒' : ''}</td>
      <td>${row.enabled ? `<span class="tag ok">${escapeHtml(t(lang, 'common.enabled'))}</span>` : `<span class="tag off">${escapeHtml(t(lang, 'common.disabled'))}</span>`}</td>
      <td class="col-actions">
        <div class="row-actions">
          <a class="act open" href="/${encodeURIComponent(row.name)}/" target="_blank" rel="noopener">${escapeHtml(t(lang, 'dirs.previewLink'))}</a>
          ${qrButton}
          ${editLink}
        </div>
      </td>
    </tr>`;
          })
          .join('\n    ');

  // 扫描导入 = 批量建目录。要 dirs.create（能建），**也**要 dirs.browse（能看有什么可建）——
  // 少了后者，这个卡片会渲染出一个空的勾选列表，或者一个下拉框里全是被授权的父目录，
  // 点下去 404。没有这两样就干脆不显示这张卡。
  const canScan = options.perms.create && options.perms.browse && options.parentRoots.length > 0;
  const scanCard = !canScan
    ? ''
    : `<div class="card">
  <h2>${escapeHtml(t(lang, 'dirs.scan'))}</h2>
  <p class="hint">${escapeHtml(t(lang, 'dirs.scanHint'))}</p>
  <form method="post" action="${escapeHtml(adminPath)}/directories/scan">
    ${csrfInput(options.csrfToken)}
    ${selectField({
      name: 'root',
      label: t(lang, 'dirs.scanRoot'),
      value: options.parentRoots[0] ?? '',
      options: options.parentRoots.map((root) => ({ value: root, label: root })),
    })}
    <div id="scan-list" class="picker">${escapeHtml(t(lang, 'dirs.scanLoading'))}</div>
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'dirs.scanImport'))}</button>
      <button type="button" id="scan-toggle">${escapeHtml(t(lang, 'dirs.scanAll'))}</button>
    </div>
    <div class="hint">${escapeHtml(t(lang, 'dirs.scanImportHint'))}</div>
  </form>
</div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'dirs.title'))}</h1>
<p class="lead">${escapeHtml(t(lang, 'dirs.intro'))}</p>

<div class="panel">
  <table>
    <thead><tr>
      <th>${escapeHtml(t(lang, 'dirs.colName'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'dirs.colPath'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'dirs.colAccess'))}</th>
      <th>${escapeHtml(t(lang, 'dirs.colStatus'))}</th>
      <th class="col-actions">${escapeHtml(t(lang, 'dirs.colActions'))}</th>
    </tr></thead>
    <tbody>
    ${rows}
    </tbody>
  </table>
</div>

${
  // 池子里一个位置都没有时不放这个按钮：点开是一个空的父目录下拉框，
  // 填完提交必然被拒。不如直接说清楚缺什么 —— 缺的是「位置」，不是「权限」。
  options.perms.create && options.parentRoots.length === 0
    ? `<div class="card"><p class="hint">${escapeHtml(
        t(lang, options.perms.isSuper ? 'dirs.noParentRootsSuper' : 'dirs.noParentRootsSub'),
      )}</p></div>`
    : options.perms.create
      ? `<div class="actions">
  <a class="btn primary" href="${escapeHtml(adminPath)}/directories?new=1">${escapeHtml(t(lang, 'dirs.add'))}</a>
</div>`
      : ''
}

${scanCard}

${options.editing === null ? '' : directoryForm(options, options.editing)}

${options.perms.qr ? qrDialog(options) : ''}

${options.perms.purge ? purgeDialog(options) : ''}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'directories',
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
  const scripts =
    (options.perms.qr ? qrScript(options.nonce, adminPath, lang, options.publicBaseUrl) : '') +
    pickerScript(
      options.nonce,
      adminPath,
      lang,
      options.rows.map((row) => ({ name: row.name, enabled: row.enabled })),
    );
  return renderAdminLayout(layoutOptions).replace('</body>', `${scripts}\n</body>`);
}

export function emptyDirectoryForm(): DirectoryFormState {
  return {
    id: '',
    name: '',
    parent: '',
    folder: '',
    label: '',
    enabled: true,
    access: 'inherit',
    followSymlinks: false,
    sort: '',
    order: '',
    cidrs: '',
    note: '',
    owner: '',
  };
}

export type { SortField, SortOrder };
