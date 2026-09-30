/**
 * 配置的类型定义与默认值。
 *
 * 这里同时是「配置项的唯一权威来源」——后台表单、校验器、文档都以此为准。
 * 修改字段时请连带更新 validate.ts 与 docs/configuration.md。
 *
 * 注意：类型擦除模式禁用 enum，所有枚举用字面量联合类型 + as const 数组表达。
 */

// ---------------------------------------------------------------- 基础类型

export const LANGS = ['zh-CN', 'en-US'] as const;
export type Lang = (typeof LANGS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const THEME_MODES = ['auto', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const SORT_FIELDS = ['name', 'namedirfirst', 'size', 'time'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const ACCESS_LEVELS = ['inherit', 'public', 'password'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const SITE_MODES = ['public', 'password'] as const;
export type SiteMode = (typeof SITE_MODES)[number];

export const LISTING_LANGS = ['auto', 'zh-CN', 'en-US'] as const;
export type ListingLang = (typeof LISTING_LANGS)[number];

/** 站点根路径的行为 */
export const ROOT_BEHAVIORS = ['welcome', 'notFound'] as const;
export type RootBehavior = (typeof ROOT_BEHAVIORS)[number];

/**
 * scrypt 派生结果。存参数而非硬编码，未来提高 N 时旧密码仍可校验。
 * salt/hash 均为 base64。
 */
export type PasswordRecord = {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string;
  hash: string;
};

// ---------------------------------------------------------------- 各配置块

export type AccessLogConfig = {
  /** 是否记录访问日志（关闭则后台日志页为空） */
  enabled: boolean;
  /** 内存环形缓冲条数上限，供后台在线查看 */
  ringSize: number;
  /** 是否同时落盘 */
  persistToFile: boolean;
  /** 落盘路径，相对项目根目录 */
  filePath: string;
  /** 记录前对 IP 做匿名化（IPv4 抹末段，IPv6 抹后 64 位） */
  anonymizeIp: boolean;
};

export type UploadConfig = {
  /**
   * 是否允许从后台上传文件。
   *
   * 默认开启（这是后台的功能之一），但它把服务从「只读」变成了「可写」。
   * 如果你的部署必须严格只读，把它关掉。
   */
  enabled: boolean;
  /** 单个文件的大小上限（MB） */
  maxSizeMb: number;
  /** 是否允许覆盖同名文件。默认关闭 —— 覆盖是不可逆的 */
  allowOverwrite: boolean;
};

/**
 * 域名绑定与证书（由 Caddy 承担 TLS 终结与 ACME 申请/续签）。
 *
 * QRFolder 自己**不实现** ACME，也**不监听 443** —— 它只负责把这份配置翻译成
 * 一份 Caddyfile，并让 Caddy 热加载。这样证书的申请、续签、OCSP、
 * HTTP→HTTPS 跳转全部交给久经考验的组件，QRFolder 保持零依赖。
 */
export type TlsConfig = {
  /** 是否启用。关闭时 Caddy 不参与，QRFolder 照常在回环上跑 */
  enabled: boolean;
  /**
   * 对外域名，第一个是主域名（二维码用它拼地址）。
   * 多个域名会签进同一张证书（SAN）。
   */
  domains: string[];
  /** ACME 账户邮箱。证书快过期时 Let's Encrypt 用它发通知，不能乱填 */
  email: string;
  /**
   * 使用 Let's Encrypt **测试环境**。
   * 调试阶段务必打开：正式环境有「同一域名每周 5 张证书」的速率限制，
   * 反复试错很容易把配额用完，一等就是一周。
   */
  staging: boolean;
  /** Caddy 可执行文件的绝对路径。留空表示从 PATH 里找 */
  caddyBinary: string;
  /** 生成的 Caddyfile 写到哪里。相对路径按项目根目录解析 */
  caddyConfigPath: string;
  /** Caddy 管理接口地址，用于热加载配置 */
  adminApi: string;
};

export type SystemConfig = {
  /** 【需重启】监听地址。用反向代理时必须保持回环 */
  host: string;
  /** 【需重启】监听端口 */
  port: number;
  /** 【热】后台挂载路径 */
  adminPath: string;
  /** 【热】是否采信 X-Forwarded-* 头。仅在确实有反代时开启 */
  trustProxy: boolean;
  /** 【热】只有来自这些网段的 X-Forwarded-For 才可信 */
  trustedProxyCidrs: string[];
  /** 【需重启】会话签名密钥。留空则首次运行自动生成并写回 */
  sessionSecret: string;
  /** 【热】后台会话有效期（分钟） */
  sessionTtlMinutes: number;
  /** 【热】会话是否绑定来源 IP（移动网络下会频繁掉线） */
  bindSessionToIp: boolean;
  /** 【热】日志级别 */
  logLevel: LogLevel;
  /** 【热】访问日志 */
  accessLog: AccessLogConfig;
  /**
   * 【热】允许的父级目录 —— 后台里**唯一**的目录边界。
   *
   * 浏览、扫描导入、新建内容目录，三者都止于此：超级管理员从这里挑，
   * 子管理员只能用他自己被勾选的那几个（`AdminAccount.roots`，必须是它的子集）。
   *
   * 字段名以前叫 `scanRoots`，只服务于「扫描导入」。概念合并后旧名不再贴切 ——
   * 旧的 `scanRoots` 仍能被读入（见 `validate.ts` 的迁移），但从下一次保存起
   * 配置文件里就只剩这个新键。
   */
  parentRoots: string[];
  /** 【热】后台上传文件的设置 */
  upload: UploadConfig;
  /**
   * 【热】站点的对外地址，形如 `https://files.example.com`（不带结尾斜杠）。
   *
   * 生成二维码时必须用**绝对地址**，而管理后台通常是从 127.0.0.1 访问的 ——
   * 服务端无法自动推断出访客实际使用哪个公网域名。
   * 留空时退化为使用当前请求的 Host，那只在你恰好用公网域名访问后台时才正确。
   */
  publicBaseUrl: string;
  /** 【热】域名绑定与证书 */
  tls: TlsConfig;
};

/**
 * 一份文案的中英双语版本。
 *
 * 主界面用哪一份**只看访客当前的语言**，两边的回退链各自独立 ——
 * 中文没填就用中文的内置文案，不会退到英文去，反之亦然。
 * 这样「只填了中文」的站点，英文访客看到的仍是通顺的英文默认文案，
 * 而不是夹着一句中文。
 */
export type LocalizedText = {
  zh: string;
  en: string;
};

/** 空的双语文案。注意每次调用都要新对象，别共享同一个引用 */
export function emptyLocalizedText(): LocalizedText {
  return { zh: '', en: '' };
}

/**
 * 按访客语言取一份文案，并去掉首尾空白。
 *
 * 两份**互不回退** —— 中文没填就返回空串，由调用方各自回退到该语言的内置文案。
 * 若这里退到另一种语言，一个「只填了中文」的站点会让英文访客看到一句中文，
 * 比看到通顺的英文默认文案更糟。
 */
export function pickLocalized(text: LocalizedText, lang: Lang): string {
  return (lang === 'zh-CN' ? text.zh : text.en).trim();
}

export type AppearanceConfig = {
  /**
   * 产品名。**后台改这一处，下面这些位置全部跟着变**：
   *   后台侧边栏抬头、后台各页的浏览器标题、登录页、首次设置页、密码页、
   *   启动日志，以及后台里提到本程序的提示语（如「域名与证书」页那句）。
   *
   * 刻意**不影响主界面标题** —— 那是「主界面内容」里的独立设置，
   * 有自己的回退链与中英文版本。把两者绑在一起会让「只想改后台抬头」的人
   * 被迫连落地页一起改。
   *
   * 新增提示语若要提到产品名，一律写成 `{product}` 占位符并在调用处传
   * `productName`；不要写死字面量，否则「改一处」这个承诺就破了。
   */
  productName: string;
  /** 站点标题。留空则显示当前目录名 */
  siteTitle: string;
  /** 内容页语言 */
  listingLanguage: ListingLang;
  /**
   * 站点根路径的行为。
   * 'welcome' 显示一个只有欢迎信息的落地页（不列目录，仍不泄露有哪些目录）；
   * 'notFound' 直接返回 404。
   */
  rootBehavior: RootBehavior;
  /** 主界面标题。留空则依次回退到 siteTitle、内置文案（按访客语言各取一份） */
  welcomeTitle: LocalizedText;
  /** 主界面正文。留空则用内置文案 */
  welcomeMessage: LocalizedText;
  /**
   * 主界面图片地址。
   * 只接受站内绝对路径（/logo.png）或 http(s) 绝对地址；
   * 外链的源会被自动加进该页面的 CSP img-src，否则会被自己的策略拦掉。
   */
  welcomeImage: string;
  /** 图片的替代文本（无障碍与图片加载失败时的提示） */
  welcomeImageAlt: LocalizedText;
  /** 图片显示宽度（px）。0 表示按容器宽度自适应 */
  welcomeImageWidth: number;
  /** 主界面底部那行提示语（如「如有问题，请联系二维码提供方。」）。留空则用内置文案 */
  welcomeHint: LocalizedText;
  theme: ThemeMode;
  /** 主题色，必须是 #rrggbb（插入 CSS 前会校验） */
  accentColor: string;
  folderColor: string;
  density: Density;
  showBreadcrumbs: boolean;
  showFileSize: boolean;
  showModTime: boolean;
  showFilterBox: boolean;
  showSummary: boolean;
  defaultSort: SortField;
  defaultOrder: SortOrder;
  /**
   * 时区。
   *   'auto'           —— 按**访问者设备**的时区显示（服务端先渲染服务器本地时间作为
   *                       回退，再由前端 JS 就地转换，因此禁用 JS 时也不会显示错误时间）
   *   ''               —— 服务器本地时区
   *   'Asia/Shanghai'  —— 固定 IANA 时区
   */
  timeZone: string;
  /** 允许浏览器直接内联预览的扩展名 */
  previewExtensions: string[];
  /** 强制下载、禁止内联的扩展名（防内容目录里的 HTML/SVG 在本站源上执行） */
  forceDownloadExtensions: string[];
  /** 页脚文字。默认留空 —— 满足「无默认页脚」 */
  footerText: string;
  /** 追加到列表页的 CSS，供高级用户微调 */
  customCss: string;
};

export type RateLimitConfig = {
  /** 窗口内允许的最大登录失败次数 */
  loginMaxAttempts: number;
  loginWindowMinutes: number;
  /** 基础锁定时长，逐次翻倍，上限 lockoutMaxMinutes */
  lockoutMinutes: number;
  lockoutMaxMinutes: number;
  /**
   * scrypt 并发上限。这是防「并发撞库打爆内存」的关键——
   * 单次 scrypt 占约 16MiB，限流按时间窗口计数挡不住突发并发。
   */
  maxConcurrentHashes: number;
};

// ---------------------------------------------------------------- 管理员账号

export const ADMIN_ROLES = ['super', 'sub'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * 子管理员可被逐项授予的能力。这里是**键的权威定义** —— 校验器与后台的勾选框
 * 都读这一份，不允许各写各的。
 *
 * 粒度是按**真实存在的路由**定的，不是照搬 CRUD 模板：比如没有 files.delete，
 * 因为压根没有删除文件的路由。
 */
export const ADMIN_PERMISSIONS = [
  'dirs.view',
  'dirs.create',
  'dirs.update',
  'dirs.delete',
  'dirs.browse',
  'dirs.qr',
  'files.view',
  'files.upload',
  'logs.view',
  'logs.export',
  'appearance.view',
  'appearance.edit',
  'sys.publicbase',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * 后台勾选框的分组。分组只影响排版，不影响判定 —— 所以放在这里，
 * 校验器与视图共用一份，避免两边各维护一个列表然后慢慢分叉。
 */
export const ADMIN_PERMISSION_GROUPS: readonly {
  key: string;
  permissions: readonly AdminPermission[];
}[] = [
  {
    key: 'dirs',
    permissions: ['dirs.view', 'dirs.create', 'dirs.update', 'dirs.delete', 'dirs.browse', 'dirs.qr'],
  },
  { key: 'files', permissions: ['files.view', 'files.upload'] },
  { key: 'logs', permissions: ['logs.view', 'logs.export'] },
  { key: 'appearance', permissions: ['appearance.view', 'appearance.edit'] },
  { key: 'system', permissions: ['sys.publicbase'] },
];

/**
 * 超级管理员的账号 id。
 * 用空串而不是一个常量字符串，是为了和 `DirectoryConfig.owner` 的空串语义对齐：
 * 「空 = 超级管理员的」。升级时所有老目录的 owner 都是空串，于是自动归超级管理员。
 */
export const SUPER_ADMIN_ID = '';

/** 从旧版 `adminPassword` 迁移出来的超级管理员用户名 */
export const DEFAULT_ADMIN_USERNAME = 'admin';

export type AdminAccount = {
  /**
   * 稳定 id，会被写进会话票据。
   * 特意与用户名分开：改名不该动摇目录归属，日志里也不该出现一个会变的名字。
   */
  id: string;
  username: string;
  role: AdminRole;
  password: PasswordRecord;
  /** 仅 `role === 'sub'` 生效；超级管理员隐含全部权限 */
  permissions: AdminPermission[];
  /**
   * 仅 `role === 'sub'` 生效：从 `system.parentRoots` 里**勾选**出来的那几个父目录。
   *
   * 校验时强制 ⊆ `system.parentRoots` —— 否则子管理员能自己给自己扩权。
   * 界面上的输入是复选框而不是文本框，就是为了让这条包含关系在配置阶段
   * 就不可能被填错。
   */
  roots: string[];
  enabled: boolean;
  /** 备注，仅超级管理员可见 */
  note: string;
};

export type AccessConfig = {
  /** 整站访问模式 */
  siteMode: SiteMode;
  sitePassword: PasswordRecord | null;
  /** 后台来源 IP 白名单（CIDR）。空数组 = 不限制 */
  adminIpAllowlist: string[];
  /**
   * 管理员账号。**空数组 = 还没初始化**，走首次运行设置流程。
   *
   * 超级管理员最多一个（校验器强制），它的 id 是 `SUPER_ADMIN_ID`。
   */
  admins: AdminAccount[];
  /**
   * @deprecated 单管理员时代的密码，**只用于升级迁移**。
   *
   * 校验时：`admins` 为空且这里非空 → 静默迁移成一个超级管理员账号；
   * 无论迁移与否，输出里都归一化为 `null`（内存镜像不再带着这枚哈希）。
   * 文件里会留到下一次写入为止，这样回滚到旧版本仍然能登录。
   * 新代码不要再读它。
   */
  adminPassword: PasswordRecord | null;
  rateLimit: RateLimitConfig;
  /** 隐藏 . 开头的文件与目录 */
  hideDotfiles: boolean;
  /** 拒绝访问的扩展名（大小写不敏感），一律返回 404 */
  deniedExtensions: string[];
  /** 拒绝访问的文件名（支持 * 通配），一律返回 404 */
  deniedFilenames: string[];
};

export type DirectoryConfig = {
  /** 稳定 id，供日志与后台引用 */
  id: string;
  /** URL 前缀，如 "Manuals" 对应 /Manuals/ */
  name: string;
  /** 物理路径 */
  path: string;
  /** 页面大标题。留空则用 name */
  label: string;
  enabled: boolean;
  access: AccessLevel;
  /** access = 'password' 时生效 */
  password: PasswordRecord | null;
  /** 该目录专属 IP 白名单。空数组 = 跟随全局 */
  allowedCidrs: string[];
  followSymlinks: boolean;
  /** 排序覆盖。空字符串 = 跟随外观设置 */
  sort: SortField | '';
  order: SortOrder | '';
  /** null = 跟随全局 */
  hideDotfiles: boolean | null;
  /** 备注，仅后台可见 */
  note: string;
  /**
   * 归属的管理员账号 id。空串 = 超级管理员。
   *
   * 用一个字段表达「自己建的」和「被分配的」两种情况：创建时盖上创建者的 id，
   * 超级管理员可以在目录管理页改。升级时所有老目录都是空串，于是自动归超级管理员，
   * **没有人会掉访问权**。
   */
  owner: string;
};

export type Config = {
  /** 配置结构版本，供未来迁移 */
  version: number;
  system: SystemConfig;
  appearance: AppearanceConfig;
  access: AccessConfig;
  directories: DirectoryConfig[];
};

// ---------------------------------------------------------------- 默认值

/**
 * 敏感文件名黑名单默认值。
 * 覆盖：凭据、证书私钥、备份、脚本、Windows 系统文件、Office 锁文件。
 */
export const DEFAULT_DENIED_EXTENSIONS: readonly string[] = [
  '.env', '.ini', '.cfg', '.conf', '.bak', '.old', '.orig', '.log', '.tmp',
  '.key', '.pem', '.crt', '.cer', '.pfx', '.p12', '.keystore', '.jks',
  '.sql', '.db', '.sqlite', '.mdb',
  '.ps1', '.bat', '.cmd', '.sh', '.bash', '.zsh',
  '.exe', '.dll', '.so', '.dylib', '.msi', '.com', '.scr',
  '.reg', '.lnk', '.url', '.desktop',
  '.htaccess', '.htpasswd', '.user', '.gitignore',
];

export const DEFAULT_DENIED_FILENAMES: readonly string[] = [
  'desktop.ini',
  'thumbs.db',
  '.ds_store',
  '.git',
  '.svn',
  '.hg',
  '~$*',
  '.~lock.*',
  'web.config',
  'config.json',
];

/**
 * 默认允许浏览器内联预览的扩展名。
 * 刻意不含 .html / .svg / .js / .xml —— 它们能在本站源上执行脚本，
 * 而同源的 /admin 持有会话 cookie。见 docs/security.md。
 */
export const DEFAULT_PREVIEW_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico',
  '.mp4', '.webm', '.ogv', '.mov',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac',
  '.txt', '.md', '.csv', '.json',
];

/** 强制下载、禁止内联的扩展名（可在本站源上执行脚本的类型） */
export const DEFAULT_FORCE_DOWNLOAD_EXTENSIONS: readonly string[] = [
  '.html', '.htm', '.xhtml', '.shtml',
  '.svg', '.svgz',
  '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs',
  '.htc', '.hta',
];

export const DEFAULT_CONFIG: Config = {
  version: 1,
  system: {
    host: '127.0.0.1',
    port: 8080,
    adminPath: '/admin',
    trustProxy: false,
    trustedProxyCidrs: ['127.0.0.1/32', '::1/128'],
    sessionSecret: '',
    sessionTtlMinutes: 720,
    bindSessionToIp: false,
    logLevel: 'info',
    accessLog: {
      enabled: true,
      ringSize: 500,
      persistToFile: false,
      filePath: 'logs/access.log',
      anonymizeIp: false,
    },
    parentRoots: [],
    upload: {
      enabled: true,
      maxSizeMb: 512,
      allowOverwrite: false,
    },
    publicBaseUrl: '',
    tls: {
      enabled: false,
      domains: [],
      email: '',
      // 默认走测试环境：第一次配证书十有八九要试几次，
      // 正式环境的速率限制（同一域名每周 5 张）用完就要等一周
      staging: true,
      caddyBinary: '',
      caddyConfigPath: 'caddy/Caddyfile',
      adminApi: 'http://127.0.0.1:2019',
    },
  },
  appearance: {
    productName: 'QRFolder',
    siteTitle: '',
    listingLanguage: 'auto',
    rootBehavior: 'welcome',
    welcomeTitle: emptyLocalizedText(),
    welcomeMessage: emptyLocalizedText(),
    welcomeImage: '',
    welcomeImageAlt: emptyLocalizedText(),
    welcomeImageWidth: 0,
    welcomeHint: emptyLocalizedText(),
    theme: 'auto',
    accentColor: '#2563eb',
    folderColor: '#f59e0b',
    density: 'comfortable',
    showBreadcrumbs: true,
    showFileSize: true,
    showModTime: true,
    showFilterBox: true,
    showSummary: true,
    defaultSort: 'namedirfirst',
    defaultOrder: 'asc',
    timeZone: '',
    previewExtensions: [...DEFAULT_PREVIEW_EXTENSIONS],
    forceDownloadExtensions: [...DEFAULT_FORCE_DOWNLOAD_EXTENSIONS],
    footerText: '',
    customCss: '',
  },
  access: {
    siteMode: 'public',
    sitePassword: null,
    adminIpAllowlist: [],
    // 空数组 = 还没初始化 → 首次启动进设置流程，并让操作者建出第一个超级管理员
    admins: [],
    adminPassword: null,
    rateLimit: {
      loginMaxAttempts: 5,
      loginWindowMinutes: 15,
      lockoutMinutes: 15,
      lockoutMaxMinutes: 1440,
      maxConcurrentHashes: 4,
    },
    hideDotfiles: true,
    deniedExtensions: [...DEFAULT_DENIED_EXTENSIONS],
    deniedFilenames: [...DEFAULT_DENIED_FILENAMES],
  },
  directories: [],
};

/**
 * 禁止用作目录名的保留路径。
 *
 * 前几个是为了不和自己的路由打架：目录叫 admin，就和后台抢同一个 URL。
 *
 * 后半段是 Windows 的保留设备名。加它们是因为「新建目录」现在会真的调 mkdir ——
 * 以前目录只是配置里的一条记录，路径指向的文件夹得人自己去建，Windows 资源管理器
 * 会替我们拦住 CON/NUL 这类名字；现在服务端自己建，这道防线就没了。
 * 而这类目录建出来在资源管理器里根本打不开，是个「建成功了但谁也进不去」的坑。
 */
export const RESERVED_DIRECTORY_NAMES: readonly string[] = [
  'admin',
  'robots.txt',
  'favicon.ico',
  '.well-known',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
];
