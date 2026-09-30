/**
 * 后台表单控件。
 *
 * 所有插值都经过 escapeHtml —— 表单值来自配置，而配置可能被手工编辑过，
 * 不能当作可信内容直接拼进 HTML。
 */

import { escapeHtml } from './html.ts';
import { t, type MsgKey } from '../i18n/index.ts';
import type { Lang, LocalizedText } from '../config/schema.ts';

/**
 * 「扫描导入」里勾选项的字段名前缀：一个目录名一个字段（`pick:Docs=1`）。
 *
 * 为什么不用同名多值的复选框：手写的 urlencoded 解析器把重复的键折叠成最后一个，
 * 于是勾十个只会导入一个，**而且不报错**。字段名唯一就没这个问题。
 *
 * 定义在这里而不是视图里，是因为服务端要按同一个前缀去捞字段 ——
 * 两处各写一遍字符串字面量，改了一处忘了另一处，症状是「勾了没反应」。
 */
export const SCAN_PICK_PREFIX = 'pick:';

export type FieldBase = {
  name: string;
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  id?: string;
};

function fieldId(field: FieldBase): string {
  return field.id ?? `f_${field.name}`;
}

function hintHtml(hint: string | undefined): string {
  return hint === undefined || hint === '' ? '' : `<div class="hint">${escapeHtml(hint)}</div>`;
}

export function textField(field: FieldBase & { type?: 'text' | 'password' | 'number' }): string {
  const id = fieldId(field);
  const required = field.required === true ? ' required' : '';
  const placeholder = field.placeholder === undefined ? '' : ` placeholder="${escapeHtml(field.placeholder)}"`;
  return `<div class="field">
  <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
  <input type="${field.type ?? 'text'}" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}"${placeholder}${required} autocomplete="off">
  ${hintHtml(field.hint)}
</div>`;
}

/** 密码框永不回填值 */
export function passwordField(field: Omit<FieldBase, 'value'> & { value?: string }): string {
  const id = fieldId({ ...field, value: '' });
  // required 以前在这里被漏掉了（textField 有、这里没有），于是「新建账号」的
  // 密码框其实不带 required，空密码要靠服务端拦。补上，两边就一致了。
  const required = field.required === true ? ' required' : '';
  const placeholder = field.placeholder === undefined ? '' : ` placeholder="${escapeHtml(field.placeholder)}"`;
  return `<div class="field">
  <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
  <input type="password" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" value=""${placeholder}${required} autocomplete="new-password">
  ${hintHtml(field.hint)}
</div>`;
}

export function numberField(
  field: Omit<FieldBase, 'value'> & { value: number; min?: number; max?: number },
): string {
  const id = fieldId({ ...field, value: '' });
  const min = field.min === undefined ? '' : ` min="${field.min}"`;
  const max = field.max === undefined ? '' : ` max="${field.max}"`;
  return `<div class="field">
  <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
  <input type="number" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" value="${field.value}"${min}${max}>
  ${hintHtml(field.hint)}
</div>`;
}

export function textareaField(field: FieldBase & { rows?: number }): string {
  const id = fieldId(field);
  const rows = field.rows === undefined ? '' : ` rows="${field.rows}"`;
  return `<div class="field">
  <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
  <textarea id="${escapeHtml(id)}" name="${escapeHtml(field.name)}"${rows}>${escapeHtml(field.value)}</textarea>
  ${hintHtml(field.hint)}
</div>`;
}

export function checkboxField(field: {
  name: string;
  label: string;
  checked: boolean;
  hint?: string;
}): string {
  const id = fieldId({ ...field, value: '' });
  return `<div class="check">
  <input type="checkbox" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" value="1"${field.checked ? ' checked' : ''}>
  <div>
    <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
    ${hintHtml(field.hint)}
  </div>
</div>`;
}

export type SelectOption = { value: string; label: string };

export function selectField(field: {
  name: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  hint?: string;
}): string {
  const id = fieldId({ ...field, value: '' });
  const options = field.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    )
    .join('');
  return `<div class="field">
  <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
  <select id="${escapeHtml(id)}" name="${escapeHtml(field.name)}">${options}</select>
  ${hintHtml(field.hint)}
</div>`;
}

/**
 * 颜色选择器：色块 + 十六进制输入，两者同步，服务端只认文本输入。
 *
 * 注意：这里刻意不用 `oninput=` 内联事件 —— 本站的 CSP 里
 * script-src 只允许带 nonce 的脚本，内联事件处理器会被浏览器直接拒绝。
 * 同步逻辑由 adminLayout 里那段带 nonce 的脚本通过 data 属性统一接线。
 */
export function colorField(field: { name: string; label: string; value: string; hint?: string }): string {
  const id = fieldId({ ...field });
  return `<div class="field">
  <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
  <div class="color-row">
    <input type="color" data-sync-to="${escapeHtml(id)}" value="${escapeHtml(field.value)}">
    <input type="text" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}" pattern="#[0-9a-fA-F]{6}" class="color-hex">
  </div>
  ${hintHtml(field.hint)}
</div>`;
}

/**
 * 一份文案的中英双语输入框。
 *
 * 提交时是**两个平铺字段**（`nameZh` / `nameEn`）而不是一个嵌套结构：
 * 表单解析是本项目手写的 urlencoded 解析器，两个平铺字段比嵌套省事得多，
 * 出错时也能直接从字段名看出是哪一份。
 */
export function localizedTextField(field: {
  name: string;
  label: string;
  value: LocalizedText;
  hint?: string;
  /** 占位提示，同样分中英两份（通常填该语言的内置默认文案，让用户知道留空会显示什么） */
  placeholder?: LocalizedText;
  /** 传了就渲染成多行输入（正文、提示语用） */
  rows?: number;
}): string {
  const item = (suffix: 'Zh' | 'En', lang: 'zh' | 'en', tag: string, value: string): string => {
    const id = `f_${field.name}${suffix}`;
    const placeholder = field.placeholder === undefined ? '' : ` placeholder="${escapeHtml(field.placeholder[lang])}"`;
    const control =
      field.rows === undefined
        ? `<input type="text" id="${escapeHtml(id)}" name="${escapeHtml(field.name + suffix)}" value="${escapeHtml(value)}"${placeholder} autocomplete="off">`
        : `<textarea id="${escapeHtml(id)}" name="${escapeHtml(field.name + suffix)}" rows="${field.rows}"${placeholder}>${escapeHtml(value)}</textarea>`;
    return `<div class="localized-item"><span class="lang-tag">${tag}</span>${control}</div>`;
  };

  return `<div class="field">
  <label>${escapeHtml(field.label)}</label>
  <div class="localized">
    ${item('Zh', 'zh', '中文', field.value.zh)}
    ${item('En', 'en', 'English', field.value.en)}
  </div>
  ${hintHtml(field.hint)}
</div>`;
}

/** 每个 POST 表单都必须带上它 */
export function csrfInput(token: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

/** 把多行文本拆成数组（一行一项，去空行） */
export function linesToArray(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function arrayToLines(values: readonly string[]): string {
  return values.join('\n');
}

/** 枚举下拉项的便捷构造 */
export function enumOptions<T extends string>(
  lang: Lang,
  values: readonly T[],
  keyFor: (value: T) => MsgKey,
): SelectOption[] {
  return values.map((value) => ({ value, label: t(lang, keyFor(value)) }));
}
