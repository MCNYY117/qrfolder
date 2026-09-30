/**
 * 配置校验与归一化。
 *
 * 设计原则：**永远返回一份可用的配置**，把所有问题收集到 issues 里
 * 交给调用方决定怎么处置。绝不抛异常 —— 一个手滑的配置值不应该让服务起不来。
 *
 * 但注意：调用方在「已加载配置之后」的热重载场景必须做选择：
 * 校验不通过时保留旧配置，而不是采用归一化后的默认值。见 store.ts。
 */

import path from 'node:path';

import {
  ACCESS_LEVELS,
  ADMIN_PERMISSIONS,
  DEFAULT_ADMIN_USERNAME,
  DENSITIES,
  LISTING_LANGS,
  LOG_LEVELS,
  RESERVED_DIRECTORY_NAMES,
  ROOT_BEHAVIORS,
  SITE_MODES,
  SORT_FIELDS,
  SORT_ORDERS,
  SUPER_ADMIN_ID,
  THEME_MODES,
  DEFAULT_CONFIG,
  type AccessConfig,
  type AdminAccount,
  type AdminPermission,
  type AdminRole,
  type Config,
  type DirectoryConfig,
  type LocalizedText,
  type PasswordRecord,
  type TlsConfig,
} from './schema.ts';
import { isSafeResourceUrl } from '../util/safeUrl.ts';

export type ValidationIssue = {
  /** 出问题的字段路径，如 directories[0].name */
  at: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  config: Config;
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------- 取值助手

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '');
}

function asHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

/** 把扩展名归一为小写并强制前导点，顺便去重 */
function normalizeExtensions(value: unknown, fallback: readonly string[]): string[] {
  const list = asStringArray(value, fallback);
  const out = new Set<string>();
  for (const item of list) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === '') continue;
    out.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return [...out];
}

/**
 * 归一化一份双语文案。
 *
 * ★ 兼容旧配置：升级前这四个字段是**单个字符串**。遇到字符串就同时填进
 *   中英两份 —— 这样升级后看到的内容与升级前**逐字一致**，不会有人打开
 *   主界面发现文案没了。中英分栏是这次新增的能力，不是对旧值的重新解释。
 */
function normalizeLocalizedText(value: unknown, fallback: LocalizedText): LocalizedText {
  if (typeof value === 'string') return { zh: value, en: value };
  if (!isRecord(value)) return { ...fallback };
  return {
    zh: asString(value['zh'], fallback.zh),
    en: asString(value['en'], fallback.en),
  };
}

function normalizePassword(value: unknown): PasswordRecord | null {
  if (!isRecord(value)) return null;
  const { salt, hash, N, r, p, keylen } = value;
  if (typeof salt !== 'string' || typeof hash !== 'string') return null;
  if (salt === '' || hash === '') return null;
  return {
    algo: 'scrypt',
    N: asInt(N, 16384, 1024, 1 << 20),
    r: asInt(r, 8, 1, 32),
    p: asInt(p, 1, 1, 16),
    keylen: asInt(keylen, 64, 16, 128),
    salt,
    hash,
  };
}

// ---------------------------------------------------------------- 管理员账号

/** 用户名字符集刻意保守：会出现在日志与界面里，不给任何需要转义或易混淆的字符 */
/**
 * 管理员用户名的合法形状。
 *
 * 首次设置页与账号管理页都用它 —— 以前两处各写一份字面量副本，
 * 改了一处忘了另一处就是「首启能设、后来改不了」这种别扭事。
 */
export const ADMIN_USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;

/**
 * 只作为动作存在、必须搭配某个"查看"权限才有意义的权限。
 *
 * 不补上这一条会得到一种很难查的坏状态：**能干，但干完看不到结果**。
 * 具体是每一条目录动作结束时都会 `redirect` 回 `/directories`，而那个页面要
 * `dirs.view`；`appearance.edit` 存完回 `/appearance`，要 `appearance.view`；
 * `logs.export` 导出的是"页面上看到的那一份"，看不到页面就只是盲导。
 * 于是「子管理员删目录，删成功了，然后浏览器落到一个 404」。
 *
 * 界面上这些勾选框仍然各自独立（用户要求逐项勾选），这里只是把前置项补齐。
 */
const PERMISSION_IMPLIES: ReadonlyArray<readonly [AdminPermission, AdminPermission]> = [
  ['dirs.create', 'dirs.view'],
  ['dirs.update', 'dirs.view'],
  ['dirs.delete', 'dirs.view'],
  ['dirs.browse', 'dirs.view'],
  ['dirs.qr', 'dirs.view'],
  ['appearance.edit', 'appearance.view'],
  ['logs.export', 'logs.view'],
];

/**
 * 归一化权限列表。
 *
 * **fail-closed**：不认识的键一律丢掉并报出来，绝不「不认识就当没限制」。
 * 反过来（放行未知键）会让权限表改名之后，老配置里的条目静默变成「什么都能干」。
 *
 * 另外会把 `PERMISSION_IMPLIES` 里的前置权限补齐。这一步**不报 issue** ——
 * 报 issue 会让 `store.reload()` 永远拒绝这份配置，等于为了一个无害的补齐
 * 把整份配置判死。
 */
function normalizePermissions(raw: unknown, at: string, issues: ValidationIssue[]): AdminPermission[] {
  if (!Array.isArray(raw)) return [];
  const out: AdminPermission[] = [];
  for (const item of raw) {
    const key = typeof item === 'string' ? item : '';
    if (!(ADMIN_PERMISSIONS as readonly string[]).includes(key)) {
      issues.push({ at: `${at}.permissions`, message: `未知权限 "${key}"，已忽略` });
      continue;
    }
    const permission = key as AdminPermission;
    if (!out.includes(permission)) out.push(permission);
  }

  for (const [action, prerequisite] of PERMISSION_IMPLIES) {
    if (out.includes(action) && !out.includes(prerequisite)) out.push(prerequisite);
  }

  return out;
}

/**
 * 归一化「允许的父级目录」池，并处理从旧字段 `scanRoots` 的迁移。
 *
 * **迁移必须静默（不产生任何 issue）。** 报 issue 会让 `store.reload()` 永远
 * 保留旧配置、`--check` 退出码非零 —— 现场表现就是「升级后起不来，看着像配置损坏」。
 * 这是 `adminPassword` 那次迁移留下的同一条约定。
 *
 * 顺带把每一项解析成绝对路径并去重：以前这里是 `asStringArray`，原样保留用户
 * 敲进来的字符串，于是 `D:\data` 和 `D:\data\` 会被当成两个不同的根，
 * 而它们指向同一个地方 —— 子管理员的包含性判断会因此出现说不清的边界行为。
 */
function normalizeParentRoots(systemRaw: Record<string, unknown>): string[] {
  const primary = systemRaw['parentRoots'];
  // 旧名只在读入时被识别；输出里不带它，所以第一次保存之后配置文件里就只剩新键
  const legacy = systemRaw['scanRoots'];
  const raw = Array.isArray(primary) ? primary : legacy;
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];
  for (const item of raw) {
    const value = typeof item === 'string' ? item.trim() : '';
    if (value === '') continue;
    const resolved = path.resolve(value);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * 归一化子管理员的授权根目录。
 *
 * ★ 强制落在超级管理员划定的「允许的父级目录」之内 —— 否则子管理员
 *   能给自己加一个根目录，等于自己给自己扩权，整套限制就白做了。
 */
function normalizeRoots(
  raw: unknown,
  at: string,
  parentRoots: readonly string[],
  issues: ValidationIssue[],
): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const value = typeof item === 'string' ? item.trim() : '';
    if (value === '') continue;
    const resolved = path.resolve(value);
    const allowed = parentRoots.some((root) => isWithin(path.resolve(root), resolved));
    if (!allowed) {
      issues.push({ at: `${at}.roots`, message: `"${value}" 不在「允许的父级目录」里，已忽略` });
      continue;
    }
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * 归一化管理员账号列表，并在必要时从旧版的单管理员密码迁移。
 *
 * 三件事与其它校验函数不一样，都是有意的：
 *
 * 1. **坏记录带着 issue 丢掉，而不是像 normalizePassword 那样静默变 null。**
 *    一个密码记录坏掉的账号如果变成 `password: null`，它在后台看起来仍然是个
 *    正常账号，而「密码为 null」在别处被当成「没设密码」。两者叠加就是一条
 *    认证绕过 —— 所以宁可丢掉整个账号并明确报出来。
 * 2. **迁移不产生任何 issue**（见下面的长注释）。
 * 3. **超级管理员只允许一个**，多出来的降级而不是丢弃 —— 手工编辑过的配置里
 *    直接丢掉它，可能一个超级管理员都不剩，那就没人能进后台了。
 */
function validateAdmins(
  raw: unknown,
  issues: ValidationIssue[],
  legacy: PasswordRecord | null,
  parentRoots: readonly string[],
): AdminAccount[] {
  const out: AdminAccount[] = [];
  const seenNames = new Set<string>();
  let sawSuper = false;

  const list = Array.isArray(raw) ? raw : [];
  list.forEach((item, index) => {
    const at = `access.admins[${index}]`;
    if (!isRecord(item)) {
      issues.push({ at, message: '不是对象，已忽略' });
      return;
    }

    const username = asString(item['username'], '').trim();
    if (!ADMIN_USERNAME_RE.test(username)) {
      issues.push({
        at: `${at}.username`,
        message: '用户名不合法（3–64 位字母、数字或 . _ -），已忽略该账号',
      });
      return;
    }
    const nameKey = username.toLowerCase();
    if (seenNames.has(nameKey)) {
      issues.push({ at: `${at}.username`, message: '用户名与前面的账号重复，已忽略' });
      return;
    }

    const password = normalizePassword(item['password']);
    if (password === null) {
      issues.push({ at: `${at}.password`, message: '密码记录不完整，已忽略该账号' });
      return;
    }

    const roleRaw = asString(item['role'], '');
    let role: AdminRole = roleRaw === 'super' ? 'super' : 'sub';
    if (role === 'super') {
      if (sawSuper) {
        issues.push({ at: `${at}.role`, message: '超级管理员只能有一个，该账号已降级为子管理员' });
        role = 'sub';
      } else {
        sawSuper = true;
      }
    } else if (roleRaw !== '' && roleRaw !== 'sub') {
      issues.push({ at: `${at}.role`, message: `未知角色 "${roleRaw}"，按子管理员处理` });
    }

    seenNames.add(nameKey);
    out.push({
      // 超级管理员的 id 恒为空串，与 DirectoryConfig.owner 的空串语义对齐
      id: role === 'super' ? SUPER_ADMIN_ID : asString(item['id'], '').trim() || generateId(username, index),
      username,
      role,
      password,
      permissions: role === 'super' ? [] : normalizePermissions(item['permissions'], at, issues),
      roots: role === 'super' ? [] : normalizeRoots(item['roots'], at, parentRoots, issues),
      enabled: asBool(item['enabled'], true),
      note: asString(item['note'], ''),
    });
  });

  // ---- 从旧版的单管理员密码迁移 ----
  //
  // ★ 这里**绝对不能**产生 issue。store.reload() 只要看到一条 issue 就会保留旧配置
  //   （见 store.ts，那是防「配置改坏了整站变公开」的机制），--check 也会返回非零。
  //   迁移报错的后果就是：**每一次升级都拒绝启动**，而且现场看起来像配置损坏。
  if (out.length === 0 && legacy !== null) {
    out.push({
      id: SUPER_ADMIN_ID,
      username: DEFAULT_ADMIN_USERNAME,
      role: 'super',
      password: legacy,
      permissions: [],
      roots: [],
      enabled: true,
      note: '由旧版的单管理员密码自动迁移',
    });
  }

  return out;
}

/**
 * 把指向不存在账号的目录归属改回超级管理员。
 *
 * 不做的话，一个悬空的 owner 会让那个目录**对所有人隐身** —— 包括超级管理员，
 * 而且界面上不会有任何线索说明为什么少了一个目录。
 */
function bindDirectoryOwners(
  dirs: DirectoryConfig[],
  admins: readonly AdminAccount[],
  issues: ValidationIssue[],
): void {
  const known = new Set(admins.map((account) => account.id));
  dirs.forEach((dir, index) => {
    if (dir.owner === '' || known.has(dir.owner)) return;
    issues.push({ at: `directories[${index}].owner`, message: '归属的账号不存在，已改回超级管理员' });
    dir.owner = '';
  });
}

// ---------------------------------------------------------------- 目录名校验

/** 目录名是否可用作 URL 前缀 */
export function validateDirectoryName(name: string): string | null {
  if (name === '') return '目录名不能为空';
  if (name.length > 128) return '目录名过长';
  if (name.includes('/') || name.includes('\\')) return '目录名不能含斜杠';
  if (name === '.' || name === '..') return '非法目录名';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return '目录名含控制字符';
  }
  // Windows 上尾随点/空格会被文件系统剥掉，导致 URL 与实际不符
  if (/[. ]$/.test(name)) return '目录名不能以点或空格结尾';
  if (RESERVED_DIRECTORY_NAMES.some((r) => r.toLowerCase() === name.toLowerCase())) {
    return `"${name}" 是保留名称`;
  }
  if (name.startsWith('__')) return '目录名不能以双下划线开头';
  return null;
}

/**
 * 内容目录是否安全。
 *
 * 这一层拦住的是最昂贵的一类误配：把项目目录或盘符根配成内容目录，
 * 等于把含 sessionSecret 与密码哈希的 config.json 发布到公网。
 */
/**
 * child 是否位于 parent 之内（含相等）。
 *
 * 注意不能用 `rel.startsWith('..')` 判定「不在内」——那样
 * 一个名为 `..foo` 的合法路径会被误判。
 */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  return !path.isAbsolute(rel);
}

export function validateContentPath(
  target: string,
  protectedPaths: readonly string[],
): string | null {
  if (target === '') return '路径不能为空';
  if (!path.isAbsolute(target)) return '必须是绝对路径';

  const normalized = path.resolve(target);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root) return '不能把盘符根目录作为内容目录';

  for (const protectedPath of protectedPaths) {
    const guard = path.resolve(protectedPath);
    // 重叠有两种方向，必须分别判定：
    //   a) 内容目录在受保护目录之内  → 会把源码/配置发出去
    //   b) 受保护目录在内容目录之内  → 会把源码/配置发出去
    // 之前的实现把 (b) 错写成了「rel 以 .. 开头」，而那只说明
    // normalized 在 guard 之外，方向恰好相反 —— 结果是任何位于
    // 受保护目录之外的正常内容目录都被误判为重叠并丢弃。
    if (isWithin(guard, normalized) || isWithin(normalized, guard)) {
      return `与受保护目录重叠：${guard}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 主校验

export type ValidateOptions = {
  /** 受保护目录（应用目录、配置目录等），内容目录不得与之重叠 */
  protectedPaths?: readonly string[];
};

export function validateConfig(raw: unknown, options: ValidateOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const defaults = DEFAULT_CONFIG;

  if (!isRecord(raw)) {
    issues.push({ at: '', message: '配置根节点必须是一个 JSON 对象' });
    return { ok: false, issues, config: structuredClone(defaults) };
  }

  const systemRaw = isRecord(raw['system']) ? raw['system'] : {};
  const appearanceRaw = isRecord(raw['appearance']) ? raw['appearance'] : {};
  const accessRaw = isRecord(raw['access']) ? raw['access'] : {};
  const accessLogRaw = isRecord(systemRaw['accessLog']) ? systemRaw['accessLog'] : {};
  const uploadRaw = isRecord(systemRaw['upload']) ? systemRaw['upload'] : {};
  const rateLimitRaw = isRecord(accessRaw['rateLimit']) ? accessRaw['rateLimit'] : {};

  // 产品名留空会让后台抬头变成「管理后台 · 」这种半截标题，直接回退默认值
  const productName = asString(appearanceRaw['productName'], defaults.appearance.productName).trim();

  const appearance = {
    productName: productName === '' ? defaults.appearance.productName : productName,
    siteTitle: asString(appearanceRaw['siteTitle'], defaults.appearance.siteTitle),
    listingLanguage: asEnum(appearanceRaw['listingLanguage'], LISTING_LANGS, defaults.appearance.listingLanguage),
    rootBehavior: asEnum(appearanceRaw['rootBehavior'], ROOT_BEHAVIORS, defaults.appearance.rootBehavior),
    welcomeTitle: normalizeLocalizedText(appearanceRaw['welcomeTitle'], defaults.appearance.welcomeTitle),
    welcomeMessage: normalizeLocalizedText(appearanceRaw['welcomeMessage'], defaults.appearance.welcomeMessage),
    welcomeImage: asString(appearanceRaw['welcomeImage'], defaults.appearance.welcomeImage).trim(),
    welcomeImageAlt: normalizeLocalizedText(appearanceRaw['welcomeImageAlt'], defaults.appearance.welcomeImageAlt),
    welcomeImageWidth: asInt(appearanceRaw['welcomeImageWidth'], defaults.appearance.welcomeImageWidth, 0, 4000),
    welcomeHint: normalizeLocalizedText(appearanceRaw['welcomeHint'], defaults.appearance.welcomeHint),
    theme: asEnum(appearanceRaw['theme'], THEME_MODES, defaults.appearance.theme),
    accentColor: asHexColor(appearanceRaw['accentColor'], defaults.appearance.accentColor),
    folderColor: asHexColor(appearanceRaw['folderColor'], defaults.appearance.folderColor),
    density: asEnum(appearanceRaw['density'], DENSITIES, defaults.appearance.density),
    showBreadcrumbs: asBool(appearanceRaw['showBreadcrumbs'], defaults.appearance.showBreadcrumbs),
    showFileSize: asBool(appearanceRaw['showFileSize'], defaults.appearance.showFileSize),
    showModTime: asBool(appearanceRaw['showModTime'], defaults.appearance.showModTime),
    showFilterBox: asBool(appearanceRaw['showFilterBox'], defaults.appearance.showFilterBox),
    showSummary: asBool(appearanceRaw['showSummary'], defaults.appearance.showSummary),
    defaultSort: asEnum(appearanceRaw['defaultSort'], SORT_FIELDS, defaults.appearance.defaultSort),
    defaultOrder: asEnum(appearanceRaw['defaultOrder'], SORT_ORDERS, defaults.appearance.defaultOrder),
    timeZone: asString(appearanceRaw['timeZone'], defaults.appearance.timeZone),
    previewExtensions: normalizeExtensions(
      appearanceRaw['previewExtensions'],
      defaults.appearance.previewExtensions,
    ),
    forceDownloadExtensions: normalizeExtensions(
      appearanceRaw['forceDownloadExtensions'],
      defaults.appearance.forceDownloadExtensions,
    ),
    footerText: asString(appearanceRaw['footerText'], defaults.appearance.footerText),
    customCss: asString(appearanceRaw['customCss'], defaults.appearance.customCss),
  };

  if (appearanceRaw['accentColor'] !== undefined && appearance.accentColor !== appearanceRaw['accentColor']) {
    issues.push({ at: 'appearance.accentColor', message: '不是合法的 #rrggbb，已回退默认值' });
  }
  if (appearanceRaw['folderColor'] !== undefined && appearance.folderColor !== appearanceRaw['folderColor']) {
    issues.push({ at: 'appearance.folderColor', message: '不是合法的 #rrggbb，已回退默认值' });
  }

  // 图片地址会进 <img src>：只放行站内路径与 http(s) 绝对地址，
  // 挡掉 javascript: / data: 这类伪协议 —— 那是配置面通往 XSS 的经典通路。
  if (appearance.welcomeImage !== '' && !isSafeResourceUrl(appearance.welcomeImage)) {
    issues.push({
      at: 'appearance.welcomeImage',
      message: `图片地址不被接受（只允许 / 开头的站内路径或 http(s) 绝对地址），已清空`,
    });
    appearance.welcomeImage = '';
  }
  // 'auto' 是保留值（按访问者设备时区），不是 IANA 名称 ——
  // 不能拿它去问 Intl，否则会被判为非法时区。
  if (appearance.timeZone !== '' && appearance.timeZone !== 'auto') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: appearance.timeZone });
    } catch {
      issues.push({ at: 'appearance.timeZone', message: `无效时区 "${appearance.timeZone}"，已改为服务器本地时区` });
      appearance.timeZone = '';
    }
  }

  // 旧版的单管理员密码先存着：账号列表要等 system.parentRoots 建好之后才能校验
  // （子管理员的授权根目录以它为边界），迁移也在那一步做。
  const legacyAdminPassword = normalizePassword(accessRaw['adminPassword']);

  const access: AccessConfig = {
    siteMode: asEnum(accessRaw['siteMode'], SITE_MODES, defaults.access.siteMode),
    sitePassword: normalizePassword(accessRaw['sitePassword']),
    adminIpAllowlist: asStringArray(accessRaw['adminIpAllowlist'], defaults.access.adminIpAllowlist),
    admins: [],
    adminPassword: legacyAdminPassword,
    rateLimit: {
      loginMaxAttempts: asInt(rateLimitRaw['loginMaxAttempts'], defaults.access.rateLimit.loginMaxAttempts, 1, 1000),
      loginWindowMinutes: asInt(rateLimitRaw['loginWindowMinutes'], defaults.access.rateLimit.loginWindowMinutes, 1, 1440),
      lockoutMinutes: asInt(rateLimitRaw['lockoutMinutes'], defaults.access.rateLimit.lockoutMinutes, 1, 10080),
      lockoutMaxMinutes: asInt(rateLimitRaw['lockoutMaxMinutes'], defaults.access.rateLimit.lockoutMaxMinutes, 1, 43200),
      maxConcurrentHashes: asInt(rateLimitRaw['maxConcurrentHashes'], defaults.access.rateLimit.maxConcurrentHashes, 1, 64),
    },
    hideDotfiles: asBool(accessRaw['hideDotfiles'], defaults.access.hideDotfiles),
    deniedExtensions: normalizeExtensions(accessRaw['deniedExtensions'], defaults.access.deniedExtensions),
    deniedFilenames: asStringArray(accessRaw['deniedFilenames'], defaults.access.deniedFilenames),
  };

  const system = {
    host: asString(systemRaw['host'], defaults.system.host),
    port: asInt(systemRaw['port'], defaults.system.port, 0, 65535),
    adminPath: normalizeAdminPath(asString(systemRaw['adminPath'], defaults.system.adminPath), issues),
    trustProxy: asBool(systemRaw['trustProxy'], defaults.system.trustProxy),
    trustedProxyCidrs: asStringArray(systemRaw['trustedProxyCidrs'], defaults.system.trustedProxyCidrs),
    sessionSecret: asString(systemRaw['sessionSecret'], defaults.system.sessionSecret),
    sessionTtlMinutes: asInt(systemRaw['sessionTtlMinutes'], defaults.system.sessionTtlMinutes, 5, 43200),
    bindSessionToIp: asBool(systemRaw['bindSessionToIp'], defaults.system.bindSessionToIp),
    logLevel: asEnum(systemRaw['logLevel'], LOG_LEVELS, defaults.system.logLevel),
    accessLog: {
      enabled: asBool(accessLogRaw['enabled'], defaults.system.accessLog.enabled),
      ringSize: asInt(accessLogRaw['ringSize'], defaults.system.accessLog.ringSize, 1, 100000),
      persistToFile: asBool(accessLogRaw['persistToFile'], defaults.system.accessLog.persistToFile),
      filePath: asString(accessLogRaw['filePath'], defaults.system.accessLog.filePath),
      anonymizeIp: asBool(accessLogRaw['anonymizeIp'], defaults.system.accessLog.anonymizeIp),
    },
    parentRoots: normalizeParentRoots(systemRaw),
    // 二维码要把域名写进图案里，所以这里必须是能直接编码的绝对地址。
    // 用户很可能只填了 `files.example.com` 或 `192.168.1.10:8080`，
    // 那种写法无法凭空补出协议 —— 与其猜，不如判为非法并保留原值让后台提示。
    publicBaseUrl: normalizePublicBaseUrl(asString(systemRaw['publicBaseUrl'], defaults.system.publicBaseUrl), issues),
    tls: normalizeTls(systemRaw['tls'], issues),
    upload: {
      enabled: asBool(uploadRaw['enabled'], defaults.system.upload.enabled),
      maxSizeMb: asInt(uploadRaw['maxSizeMb'], defaults.system.upload.maxSizeMb, 1, 102400),
      allowOverwrite: asBool(uploadRaw['allowOverwrite'], defaults.system.upload.allowOverwrite),
    },
  };

  const directories = validateDirectories(raw['directories'], options, issues);

  // 账号与归属放在最后：授权根目录要以 system.parentRoots 为边界，
  // 归属校验要知道最终有哪些账号存在。★ 顺序不能动 ——
  // parentRoots 必须先算好，normalizeRoots 才有池子可比。
  access.admins = validateAdmins(accessRaw['admins'], issues, legacyAdminPassword, system.parentRoots);
  bindDirectoryOwners(directories, access.admins, issues);
  // 迁移已经完成，内存镜像不再带着旧哈希（因而 /system/export 也不会吐它）。
  // 文件里那枚哈希留到下一次写入为止 —— 这样回滚到旧版本仍然能登录。
  access.adminPassword = null;

  const config: Config = {
    version: asInt(raw['version'], defaults.version, 1, 1000),
    system,
    appearance,
    access,
    directories,
  };

  return { ok: issues.length === 0, issues, config };
}

/**
 * 归一化「对外访问地址」。
 *
 * 这个值会被编进二维码，所以必须是能直接用的绝对地址：协议、主机、
 * 可选端口、可选路径前缀。返回 `scheme://host[:port][/path]`，不带尾斜杠。
 *
 * `fallbackScheme` 只在后台表单里传：用户填 `192.168.1.10:8080` 这种
 * 「只有域名或 IP 和端口」的写法时，用当前请求的协议补全。
 * 配置文件里手写这种值则判为非法 —— 那时没有「当前请求」可参考，
 * 而协议猜错的二维码在扫码之前看不出任何问题。
 */
export function normalizeBaseUrl(
  raw: string,
  fallbackScheme?: 'http' | 'https',
): string | null {
  let candidate = raw.trim();
  if (candidate === '') return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (fallbackScheme === undefined) return null;
    candidate = `${fallbackScheme}://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;
  // 凭据会被原样编进二维码，扫的人看不到来源，等于公开泄露
  if (url.username !== '' || url.password !== '') return null;
  // 查询串与锚点在二维码里毫无意义，多半是贴错了内容
  if (url.search !== '' || url.hash !== '') return null;

  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function normalizePublicBaseUrl(value: string, issues: ValidationIssue[]): string {
  if (value.trim() === '') return '';
  const normalized = normalizeBaseUrl(value);
  if (normalized === null) {
    issues.push({
      at: 'system.publicBaseUrl',
      message: `不是合法的绝对地址（需要带 http:// 或 https://），已清空：${value.trim()}`,
    });
    return '';
  }
  return normalized;
}

// ---------------------------------------------------------------- 域名与证书

/**
 * 域名合法性。
 *
 * 只做「能不能拿去签证书」这一层的判断，不做完整的 IDNA 校验：
 * 允许字母数字、连字符、点；每一级不能以连字符开头/结尾；总长不超过 253。
 *
 * 刻意**不接受通配符**（`*.example.com`）：签通配符证书必须走 DNS-01 验证，
 * 而标准版 Caddy 不带 DNS 服务商插件，收下了也只会在申请阶段失败，
 * 报出来的还是一句看不懂的 ACME 错误。不如在这里就说清楚。
 */
export function validateDomain(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (domain === '') return '域名不能为空';
  if (domain.length > 253) return '域名过长';
  if (domain.includes('*')) return '不支持通配符域名（需要 DNS 验证，标准版 Caddy 做不到）';

  const labels = domain.split('.');
  // 只有公网可解析的域名能签证书，单段主机名（如 localhost）不行
  if (labels.length < 2) return '需要是完整的域名（至少两段，如 example.com）';

  for (const label of labels) {
    if (label === '') return '域名里有空的层级（连续的点）';
    if (label.length > 63) return '域名里的某一层级过长';
    if (!/^[a-z0-9-]+$/.test(label)) return '只能包含字母、数字和连字符';
    if (label.startsWith('-') || label.endsWith('-')) return '层级不能以连字符开头或结尾';
  }

  // Let's Encrypt 不给纯 IP 签证书
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return '不能是 IP 地址，证书只签给域名';

  return null;
}

/** 够用的邮箱校验：不追求 RFC 5322 全集，只挡明显的手滑 */
export function validateEmail(value: string): string | null {
  const email = value.trim();
  if (email === '') return '邮箱不能为空';
  if (email.length > 254) return '邮箱过长';
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return '邮箱格式不正确';
  return null;
}

function normalizeTls(raw: unknown, issues: ValidationIssue[]): TlsConfig {
  const defaults = DEFAULT_CONFIG.system.tls;
  const source = isRecord(raw) ? raw : {};

  const domains: string[] = [];
  for (const entry of asStringArray(source['domains'], [])) {
    const domain = entry.trim().toLowerCase();
    const error = validateDomain(domain);
    if (error !== null) {
      issues.push({ at: 'system.tls.domains', message: `${error}，已忽略：${entry}` });
      continue;
    }
    if (!domains.includes(domain)) domains.push(domain);
  }

  const email = asString(source['email'], defaults.email).trim();
  if (email !== '') {
    const error = validateEmail(email);
    if (error !== null) {
      issues.push({ at: 'system.tls.email', message: `${error}，已清空` });
    }
  }

  // 管理接口必须是本机的 http(s) 地址：它没有任何鉴权，
  // 一旦写成对外地址，等于把 Caddy 的配置权公开出去
  const adminApiRaw = asString(source['adminApi'], defaults.adminApi).trim();
  let adminApi = adminApiRaw;
  const adminUrl = normalizeBaseUrl(adminApiRaw);
  if (adminUrl === null) {
    issues.push({ at: 'system.tls.adminApi', message: `不是合法的地址，已回退默认值：${adminApiRaw}` });
    adminApi = defaults.adminApi;
  } else if (!isLoopbackUrl(adminUrl)) {
    issues.push({
      at: 'system.tls.adminApi',
      message: '管理接口只允许本机地址（127.0.0.1 / localhost / ::1），已回退默认值',
    });
    adminApi = defaults.adminApi;
  }

  const caddyConfigPath = asString(source['caddyConfigPath'], defaults.caddyConfigPath).trim();
  const enabled = asBool(source['enabled'], defaults.enabled);

  // 开着 HTTPS 却一个域名都没填，Caddyfile 根本无从生成 ——
  // 与其等到应用时抛错，不如在保存这一刻就说清楚
  if (enabled && domains.length === 0) {
    issues.push({ at: 'system.tls.domains', message: '启用 HTTPS 至少要填一个域名' });
  }

  return {
    enabled,
    domains,
    email: email === '' || validateEmail(email) !== null ? '' : email,
    staging: asBool(source['staging'], defaults.staging),
    caddyBinary: asString(source['caddyBinary'], defaults.caddyBinary).trim(),
    caddyConfigPath: caddyConfigPath === '' ? defaults.caddyConfigPath : caddyConfigPath,
    adminApi,
  };
}

/** 管理接口是否指向本机 */
function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function normalizeAdminPath(value: string, issues: ValidationIssue[]): string {
  let p = value.trim();
  if (p === '' || p === '/') {
    issues.push({ at: 'system.adminPath', message: '后台路径不能是根路径，已改为 /admin' });
    return '/admin';
  }
  if (!p.startsWith('/')) p = `/${p}`;
  // 去掉尾随斜杠，便于前缀匹配
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  // 注意：这里刻意不检查 RESERVED_DIRECTORY_NAMES。
  // 那份列表约束的是「目录名」，防止有人建一个叫 admin 的目录与后台抢路由；
  // 而后台路径本身用 /admin 是默认值，若在此拦截就成了自己和自己冲突。
  return p;
}

function validateDirectories(
  raw: unknown,
  options: ValidateOptions,
  issues: ValidationIssue[],
): DirectoryConfig[] {
  if (!Array.isArray(raw)) return [];

  const protectedPaths = options.protectedPaths ?? [];
  const seen = new Map<string, number>();
  const out: DirectoryConfig[] = [];

  raw.forEach((item, index) => {
    const at = `directories[${index}]`;
    if (!isRecord(item)) {
      issues.push({ at, message: '不是对象，已忽略' });
      return;
    }

    const name = asString(item['name'], '').trim();
    const nameError = validateDirectoryName(name);
    if (nameError !== null) {
      issues.push({ at: `${at}.name`, message: `${nameError}，已忽略该目录` });
      return;
    }

    const key = name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({ at: `${at}.name`, message: `与 directories[${previous}] 重名，已忽略` });
      return;
    }
    seen.set(key, index);

    const dirPath = asString(item['path'], '').trim();
    const pathError = validateContentPath(dirPath, protectedPaths);
    if (pathError !== null) {
      issues.push({ at: `${at}.path`, message: `${pathError}，已忽略该目录` });
      return;
    }

    const access = asEnum(item['access'], ACCESS_LEVELS, 'inherit');
    const sort = asEnum(item['sort'], SORT_FIELDS, 'namedirfirst');
    const order = asEnum(item['order'], SORT_ORDERS, 'asc');
    const hideDotfilesRaw = item['hideDotfiles'];

    out.push({
      id: asString(item['id'], '') || generateId(name, index),
      name,
      path: path.resolve(dirPath),
      label: asString(item['label'], ''),
      enabled: asBool(item['enabled'], true),
      access,
      password: normalizePassword(item['password']),
      allowedCidrs: asStringArray(item['allowedCidrs'], []),
      followSymlinks: asBool(item['followSymlinks'], false),
      // 空字符串表示「跟随外观设置」
      sort: item['sort'] === '' ? '' : sort,
      order: item['order'] === '' ? '' : order,
      hideDotfiles: typeof hideDotfilesRaw === 'boolean' ? hideDotfilesRaw : null,
      note: asString(item['note'], ''),
      // 空串 = 超级管理员。老配置没有这个字段，于是升级后全部归超级管理员，
      // 没有人会掉访问权。
      owner: asString(item['owner'], '').trim(),
    });
  });

  return out;
}

/** 稳定 id：同名目录总是得到同一个 id，便于日志与后台引用 */
function generateId(name: string, index: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}${index.toString(16).padStart(2, '0')}`;
}
