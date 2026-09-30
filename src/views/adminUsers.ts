/**
 * 管理员账号管理页（仅超级管理员可见）。
 *
 * 表单用**内联卡片**而不是弹窗，和目录管理页不同：权限有十几项，
 * 弹窗里塞不下，而且这一页是低频操作，不需要目录页那种"点开就改"的流畅感。
 */

import {
  ADMIN_PERMISSION_GROUPS,
  type AdminAccount,
  type AdminPermission,
  type Lang,
  type ThemeMode,
} from '../config/schema.ts';
import { permissionLabel, t } from '../i18n/index.ts';
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
  passwordField,
  textField,
  textareaField,
} from './forms.ts';

/** 一行账号的展示数据 */
export type AdminUserRow = {
  id: string;
  username: string;
  role: 'super' | 'sub';
  enabled: boolean;
  permissions: readonly AdminPermission[];
  /** 名下目录数。超级管理员这里是全部目录数 */
  ownedCount: number;
  note: string;
};

export type AdminUserFormState = {
  id: string;
  /**
   * 是不是「新建」。
   *
   * 不能拿 `id === ''` 当判据 —— 超级管理员的 id **本来就是空串**
   * （`SUPER_ADMIN_ID`，与 `DirectoryConfig.owner` 的空串语义对齐），
   * 那样一打开它的编辑表单就会被当成新建。
   */
  isNew: boolean;
  username: string;
  enabled: boolean;
  permissions: readonly string[];
  roots: string;
  note: string;
};

export type UsersPageOptions = {
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
  /** 当前登录者，用来解释「为什么删不了自己」 */
  currentUsername: string;
  notice?: Notice;
  rows: readonly AdminUserRow[];
  /** 打开表单时非 null */
  editing: AdminUserFormState | null;
  /** 可分配给子管理员的父目录（来自 system.parentRoots 这个池子） */
  availableRoots: readonly string[];
};

/** 权限勾选网格，按 ADMIN_PERMISSION_GROUPS 分组 */
function permissionGrid(lang: Lang, selected: readonly string[]): string {
  return ADMIN_PERMISSION_GROUPS.map((group) => {
    const boxes = group.permissions
      .map((permission) =>
        checkboxField({
          name: `perm_${permission}`,
          label: permissionLabel(lang, permission),
          checked: selected.includes(permission),
          hint: t(lang, `perm.${permission}.hint` as Parameters<typeof t>[1]),
        }),
      )
      .join('\n    ');
    return `<h3 class="sub">${escapeHtml(t(lang, `permGroup.${group.key}` as Parameters<typeof t>[1]))}</h3>
    ${boxes}`;
  }).join('\n    ');
}

export function renderUsersPage(options: UsersPageOptions): string {
  const { lang, adminPath } = options;

  const rows = options.rows
    .map((row) => {
      const roleTag =
        row.role === 'super'
          ? `<span class="tag ok">${escapeHtml(t(lang, 'users.roleSuper'))}</span>`
          : `<span class="tag">${escapeHtml(t(lang, 'users.roleSub'))}</span>`;
      const statusTag = row.enabled
        ? ''
        : ` <span class="tag warn">${escapeHtml(t(lang, 'users.disabled'))}</span>`;
      const perms =
        row.role === 'super'
          ? escapeHtml(t(lang, 'users.allPermissions'))
          : row.permissions.length === 0
            ? `<span class="tag off">${escapeHtml(t(lang, 'users.noPermission'))}</span>`
            : escapeHtml(String(row.permissions.length)) + ' ' + escapeHtml(t(lang, 'users.permissionCount'));

      // 自己不能删自己：删掉之后这个页面就再也打不开了（除非本机恢复）
      const isSelf = row.username === options.currentUsername;
      const deleteButton =
        row.role === 'super' || isSelf
          ? ''
          : `<form method="post" action="${escapeHtml(adminPath)}/users/delete" class="form-inline">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
        <input type="hidden" name="id" value="${escapeHtml(row.id)}">
        <button type="submit" class="act danger" title="${escapeHtml(t(lang, 'users.deleteHint'))}">${escapeHtml(t(lang, 'common.delete'))}</button>
      </form>`;

      // col-opt 要和表头逐列对上，否则窄屏上表头与数据错位（见 adminDirectories 的说明）
      return `<tr>
      <td>${escapeHtml(row.username)}</td>
      <td class="col-opt">${roleTag}${statusTag}</td>
      <td class="col-opt">${perms}</td>
      <td class="num">${row.ownedCount}</td>
      <td><div class="row-actions">
        <a class="act" href="${escapeHtml(adminPath)}/users?edit=${encodeURIComponent(row.id)}">${escapeHtml(t(lang, 'common.edit'))}</a>
        ${deleteButton}
      </div></td>
    </tr>`;
    })
    .join('\n');

  const table = `<div class="card">
  <h2>${escapeHtml(t(lang, 'users.listSection'))}</h2>
  <div class="panel">
  <table>
    <thead><tr>
      <th>${escapeHtml(t(lang, 'users.colUsername'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'users.colRole'))}</th>
      <th class="col-opt">${escapeHtml(t(lang, 'users.colPermissions'))}</th>
      <th class="num">${escapeHtml(t(lang, 'users.colDirs'))}</th>
      <th>${escapeHtml(t(lang, 'users.colActions'))}</th>
    </tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</div>`;

  const editing = options.editing;
  const isNew = editing !== null && editing.isNew;
  const editingSuper = editing !== null && !editing.isNew && editing.id === '';
  const form = editing === null
    ? `<div class="actions mb-16">
    <a class="btn primary" href="${escapeHtml(adminPath)}/users?new=1">${escapeHtml(t(lang, 'users.add'))}</a>
  </div>`
    : `<div class="card">
  <h2>${escapeHtml(t(lang, isNew ? 'users.addTitle' : 'users.editTitle'))}</h2>
  <form method="post" action="${escapeHtml(adminPath)}/${isNew ? 'users/create' : 'users/update'}">
    ${csrfInput(options.csrfToken)}
    <input type="hidden" name="id" value="${escapeHtml(editing.id)}">
    <div class="row">
      ${textField({
        name: 'username',
        label: t(lang, 'users.username'),
        value: editing.username,
        hint: t(lang, 'users.usernameHint'),
        required: true,
      })}
      ${checkboxField({
        name: 'enabled',
        label: t(lang, 'users.enabled'),
        checked: editing.enabled,
      })}
    </div>
    ${passwordField({
      name: 'password',
      label: t(lang, 'users.password'),
      ...(isNew ? { required: true } : { hint: t(lang, 'users.passwordKeep') }),
    })}
    ${textField({
      name: 'note',
      label: t(lang, 'users.note'),
      value: editing.note,
    })}
    ${
      // 超级管理员的角色、权限、目录范围都由角色本身决定，表单里不渲染 ——
      // 渲染了也没用（服务端会忽略），反而让人以为「取消勾选就能降权」。
      editingSuper
        ? `<p class="hint">${escapeHtml(t(lang, 'users.superFixed'))}</p>`
        : `<h3 class="sub">${escapeHtml(t(lang, 'users.permissionsSection'))}</h3>
    <p class="hint">${escapeHtml(t(lang, 'users.permissionsHint'))}</p>
    <p class="hint">${escapeHtml(t(lang, 'users.permissionsImplied'))}</p>
    ${permissionGrid(lang, editing.permissions)}
    <h3 class="sub">${escapeHtml(t(lang, 'users.rootsSection'))}</h3>
    ${textareaField({
      name: 'roots',
      label: t(lang, 'users.roots'),
      value: editing.roots,
      rows: 4,
      hint:
        options.availableRoots.length === 0
          ? t(lang, 'users.rootsNoPool')
          : t(lang, 'users.rootsHint', { list: options.availableRoots.join('  |  ') }),
    })}`
    }
    <div class="actions">
      <button type="submit" class="primary">${escapeHtml(t(lang, 'common.save'))}</button>
      <a class="btn" href="${escapeHtml(adminPath)}/users">${escapeHtml(t(lang, 'common.cancel'))}</a>
    </div>
  </form>
</div>`;

  const body = `
<h1>${escapeHtml(t(lang, 'users.title'))}</h1>
<p class="lead">${escapeHtml(options.productName)}</p>
<p class="hint">${escapeHtml(t(lang, 'users.intro'))}</p>
${form}
${table}
`;

  const layoutOptions: AdminLayoutOptions = {
    lang,
    nonce: options.nonce,
    accentColor: options.accentColor,
    adminPath,
    nav: 'users',
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

/** 把账号转成表单初值 */
export function toUserFormState(account: AdminAccount): AdminUserFormState {
  return {
    id: account.id,
    isNew: false,
    username: account.username,
    enabled: account.enabled,
    // 超级管理员的权限与根目录隐含在角色里，表单里不渲染那两块，给空值即可
    permissions: account.role === 'super' ? [] : account.permissions,
    roots: account.role === 'super' ? '' : account.roots.join('\n'),
    note: account.note,
  };
}

export function emptyUserForm(): AdminUserFormState {
  return { id: '', isNew: true, username: '', enabled: true, permissions: [], roots: '', note: '' };
}
