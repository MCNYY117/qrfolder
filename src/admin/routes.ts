/**
 * 后台路由与动作处理。
 *
 * 统一的守卫顺序（见 handleAdmin）：
 *   来源 IP 白名单 → 会话与身份 → **路由策略（fail-closed）** → 首次设置 →
 *   主题/语言 cookie → 登录 → 账号闸门 → **权限** → **CSRF** → **对象范围** → 业务逻辑
 *
 * 加粗的四步是这一版新加的：路由、权限、CSRF、范围都在**一个地方**判定，
 * 不散在各个 handler 里 —— 散着写的话，新加一条路由忘了配权限就会静默敞开。
 *
 * 任何一步不过都按「不存在」处理（404），不确认后台或某个对象的存在。
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ConfigStore } from '../config/store.ts';
import type {
  AccessLevel,
  AdminAccount,
  AdminPermission,
  AppearanceConfig,
  Config,
  DirectoryConfig,
  Lang,
  LocalizedText,
  SortField,
  SortOrder,
  ThemeMode,
} from '../config/schema.ts';
import { ADMIN_PERMISSIONS, SORT_FIELDS, SORT_ORDERS } from '../config/schema.ts';
import {
  accountById,
  accountByUsername,
  directoryIdOfLogPath,
  hasPermission,
  isAuthorizedParent,
  isPathAuthorized,
  superAccount,
  viewerOf,
  visibleDirectories,
  type AdminViewer,
} from './accounts.ts';
import { DEFAULT_ADMIN_USERNAME, SUPER_ADMIN_ID } from '../config/schema.ts';
import { checkScope, isAllowed, joinTarget, resolveRoute, type RoutePolicy } from './policy.ts';
import { ENSURE_REASON_KEY, ensureDirectories, type EnsureResult } from './ensureDirs.ts';
import {
  ADMIN_USERNAME_RE,
  isWithin,
  normalizeBaseUrl,
  validateContentPath,
  validateDirectoryName,
} from '../config/validate.ts';
import { generateSessionSecret } from '../config/load.ts';
import type { AccessLog } from '../logging/accessLog.ts';
import { log } from '../logging/appLog.ts';
import type { LoginRateLimiter } from '../access/rateLimit.ts';
import { findInvalidCidrs, ipInAny, parseCidrList } from '../access/cidr.ts';
import { parseCookies, parseFormBody, safeRedirectPath } from '../http/request.ts';
import { appendSetCookie, buildCookie, sendHtml, sendJson, sendRedirect } from '../http/response.ts';
import { notFound, tooManyRequests, HttpError } from '../http/errors.ts';
import { matchLang, parseAcceptLanguage, t, type MsgKey } from '../i18n/index.ts';
import { isThemeMode, resolveTheme, THEME_COOKIE } from '../views/html.ts';
import { hashPassword, setHashConcurrency, verifyPassword } from './auth.ts';
import { SESSION_COOKIE, signSession, verifySession, type SessionPayload } from './session.ts';
import { csrfToken, verifyCsrf } from './csrf.ts';
import { renderLoginPage, renderSetupPage } from '../views/adminLogin.ts';
import { renderDashboard } from '../views/adminDashboard.ts';
import { renderDirectoriesPage, emptyDirectoryForm, type DirectoryFormState, type DirectoryRow } from '../views/adminDirectories.ts';
import { renderAccessPage } from '../views/adminAccess.ts';
import { renderSystemPage } from '../views/adminSystem.ts';
import { renderAppearancePage } from '../views/adminAppearance.ts';
import { renderLogsPage, type LogsFilter } from '../views/adminLogs.ts';
import { renderFilesPage } from '../views/adminFiles.ts';
import { renderDomainPage, textToDomains } from '../views/adminDomain.ts';
import { applyCaddyfile, probeAdminApi, resolveCaddyBinary } from '../tls/caddy.ts';
import { buildCaddyfile } from '../tls/caddyfile.ts';
import { probeCertificate, type ProbeResult } from '../tls/certInfo.ts';
import { isPortListening } from '../tls/ports.ts';
import { listForAdmin, planUpload, receiveUpload } from './upload.ts';
import { resolveRealSafe, resolveSafe, validateSegment } from '../serving/safePath.ts';
import { contentDisposition } from '../serving/sendFile.ts';
import { encodeQr, renderQrPng, renderQrSvg, type QrCode } from '../util/qrcode.ts';
import { SCAN_PICK_PREFIX, linesToArray, arrayToLines } from '../views/forms.ts';
import type { PreparedDirectory, ProtectedPaths } from '../serving/resolveTarget.ts';
import type { AdminNavKey, Notice } from '../views/adminLayout.ts';
import {
  renderUsersPage,
  emptyUserForm,
  toUserFormState,
  type AdminUserFormState,
  type AdminUserRow,
} from '../views/adminUsers.ts';

export type AdminDeps = {
  store: ConfigStore;
  accessLog: AccessLog;
  rateLimiter: LoginRateLimiter;
  protectedPaths: ProtectedPaths;
  startedAt: number;
  directories: () => Map<string, PreparedDirectory>;
};

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  lang: Lang;
  nonce: string;
  clientIp: string;
  isHttps: boolean;
  config: Config;
  /** 当前后台挂载路径，等价于 config.system.adminPath */
  adminPath: string;
  /** 相对 adminPath 的子路径，如 ''、'/directories' */
  sub: string;
  /** 本次生效的主题（?theme= → cookie → 站点配置） */
  theme: ThemeMode;
  sessionToken: string | undefined;
  session: SessionPayload | null;
  /**
   * 已解析的表单体。
   *
   * 由 handleAdmin 的 CSRF 那一步统一填充 —— `parseFormBody` 会消费请求流，
   * 只能读一次，所以解析必须集中在一处，handler 直接读这里。
   */
  form: Record<string, string>;
  /**
   * 当前管理员与它的可见范围。
   *
   * 闸门通过之前可能是 null（未登录、账号被删、票据是旧版本）。
   * dispatch() 只在闸门通过之后调用，那里一定非空 —— 需要时用 currentViewer()
   * 取，它把这一步收窄写在一处，省得每个渲染函数各写一遍判空。
   */
  account: AdminAccount | null;
  viewer: AdminViewer | null;
};

/** 取当前身份。只在 dispatch() 及其下游调用 —— 那时闸门已经过了 */
function currentViewer(ctx: Ctx): AdminViewer {
  if (ctx.viewer === null) throw notFound();
  return ctx.viewer;
}

/** 取当前账号。同上。要判断角色或授权根目录（而不只是可见目录）时用它 */
function currentAccount(ctx: Ctx): AdminAccount {
  if (ctx.account === null) throw notFound();
  return ctx.account;
}

/**
 * 侧边栏该显示哪些导航项。
 *
 * 判据取自**同一张策略表**（`ADMIN_ROUTES` 里各页面的 access），而不是另写一套
 * 权限到菜单的映射 —— 两份名单迟早会漂移，漂移的方向一定是「菜单里有、点进去 404」。
 * 这里只做「主页面对应的那条策略准不准走」这一个判断。
 */
function navKeysFor(viewer: AdminViewer): AdminNavKey[] {
  const pagePaths: ReadonlyArray<[AdminNavKey, string]> = [
    ['dashboard', ''],
    ['directories', '/directories'],
    ['files', '/files'],
    ['users', '/users'],
    ['access', '/access'],
    ['system', '/system'],
    ['domain', '/domain'],
    ['appearance', '/appearance'],
    ['logs', '/logs'],
  ];
  return pagePaths
    .filter(([, routePath]) => {
      const page = resolveRoute(routePath, 'GET');
      return page !== null && isAllowed(page, viewer);
    })
    .map(([key]) => key);
}

/** 顶栏身份标签：用户名 + 角色。角色名走 i18n，随界面语言变 */
function accountLabelOf(ctx: Ctx, account: AdminAccount): string {
  const role = t(ctx.lang, account.role === 'super' ? 'users.roleSuper' : 'users.roleSub');
  return `${account.username} · ${role}`;
}

// ---------------------------------------------------------------- 工具

/**
 * 后台界面语言。
 *
 * 优先级：?lang= 查询参数 → lang cookie → 浏览器的 Accept-Language → 兜底。
 *
 * 必须包含 Accept-Language 这一层：否则英文用户第一次打开后台看到的是中文，
 * 而他们并不知道右下角（或者任何地方）有个语言切换按钮。
 */
function langFromRequest(req: IncomingMessage, url: URL, fallback: Lang): Lang {
  const fromQuery = url.searchParams.get('lang');
  if (fromQuery === 'en-US' || fromQuery === 'zh-CN') return fromQuery;

  const fromCookie = parseCookies(req.headers.cookie)['lang'];
  if (fromCookie === 'en-US' || fromCookie === 'zh-CN') return fromCookie;

  const fromBrowser = matchLang(parseAcceptLanguage(req.headers['accept-language']));
  return fromBrowser ?? fallback;
}

/**
 * 后台主题。
 *
 * 与内容面同一套优先级（?theme= → cookie → 站点配置），并且同样在
 * 显式选择时种下 cookie。后台不做独立的「主题」路由：切换按钮用的是
 * 只有查询串的相对链接（`?theme=dark`），不需要 next 参数。
 *
 * 注意那个相对链接会**替换**整个查询串而不是追加 ——
 * /admin/directories?edit=xxx 点一下主题就会丢掉 edit。
 * 补回来的逻辑在 adminLayout 的接线脚本里。
 */
function themeFromRequest(req: IncomingMessage, url: URL, configured: ThemeMode): ThemeMode {
  const requested = url.searchParams.get('theme');
  const cookies = parseCookies(req.headers.cookie);
  return resolveTheme(requested, cookies[THEME_COOKIE], configured);
}

/** 显式选过主题时种 cookie，否则刷新一次就退回默认 */
function setThemeCookieIfChosen(res: ServerResponse, url: URL, isHttps: boolean): void {
  const requested = url.searchParams.get('theme');
  if (!isThemeMode(requested)) return;
  appendSetCookie(
    res,
    buildCookie(THEME_COOKIE, requested, {
      path: '/',
      maxAgeSeconds: 31_536_000,
      httpOnly: false,
      secure: isHttps,
      sameSite: 'Lax',
    }),
  );
}

function setLangCookie(res: ServerResponse, lang: Lang, isHttps: boolean): void {
  appendSetCookie(
    res,
    buildCookie('lang', lang, {
      path: '/',
      maxAgeSeconds: 31_536_000,
      // 内容页可能想用 JS 读它，所以不设 HttpOnly
      httpOnly: false,
      secure: isHttps,
    }),
  );
}

function setSessionCookie(res: ServerResponse, token: string, config: Config, isHttps: boolean): void {
  appendSetCookie(
    res,
    buildCookie(SESSION_COOKIE, token, {
      path: '/',
      maxAgeSeconds: config.system.sessionTtlMinutes * 60,
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
    }),
  );
}

function clearSessionCookie(res: ServerResponse, isHttps: boolean): void {
  appendSetCookie(
    res,
    buildCookie(SESSION_COOKIE, '', {
      path: '/',
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
    }),
  );
}

/** 重定向回某个页面并带一条提示（PRG 模式，避免刷新重复提交） */
function redirectWithNotice(
  res: ServerResponse,
  to: string,
  kind: 'ok' | 'err',
  key: string,
): void {
  const separator = to.includes('?') ? '&' : '?';
  sendRedirect(res, `${to}${separator}${kind}=${encodeURIComponent(key)}`);
}

/**
 * 把「在服务器上建目录失败」翻译成一句能照着做的话。
 *
 * 不直接把系统错误串端给用户：`ENOENT: no such file or directory, mkdir 'D:\a\b'`
 * 对站长没有任何帮助，而这里每种失败其实都有明确的下一步动作
 * （建上一级 / 把路径改成绝对路径 / 换个位置）。原始信息只在兜底那一类里带上。
 */
function describeEnsureFailure(lang: Lang, failure: Extract<EnsureResult, { ok: false }>): string {
  return t(lang, 'dirs.ensureFailedNotice', {
    path: failure.path,
    reason: t(lang, ENSURE_REASON_KEY[failure.reason], { detail: failure.detail }),
  });
}

function noticeFromQuery(url: URL, lang: Lang): Notice | undefined {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  if (ok !== null && ok !== '') return { kind: 'ok', text: t(lang, ok as MsgKey) };
  if (err !== null && err !== '') return { kind: 'err', text: t(lang, err as MsgKey) };
  return undefined;
}

/** 拒绝上传时最多再读多少字节的请求体，超过就直接断连 */
const REJECT_DRAIN_LIMIT = 8 * 1024 * 1024;

/**
 * 把请求体读完（有上限）再返回。
 *
 * ★ 提前拒绝一个上传请求时**必须**先调它。只调 `req.resume()` 是不够的：
 *   响应发出时请求体往往还没读完，Node 发现请求未消费完会直接销毁 socket，
 *   客户端拿到 ECONNRESET —— 浏览器只显示「网络错误」，
 *   而「同名文件已存在」这类提示根本到不了用户眼前。
 *   （见 CLAUDE.md 记着的那次真实事故。）
 */
/**
 * 后台在闸门阶段拒绝一个请求。
 *
 * ★ 拒绝之前必须**把请求体读完**，两个理由，都踩过：
 *
 *   1. 不读完就回响应，Node 发现请求未消费完会直接销毁 socket，客户端拿到的是
 *      网络错误而不是这条 404 —— 上传接口尤为明显（CLAUDE.md 记着那次真实事故）。
 *   2. 残留的字节会留在**同一条 keep-alive 连接**上，于是**下一个**请求会被解析错位。
 *      这不是理论风险：写集成测试时遇到过「用 admin 登录，却拿到 alice 的会话」
 *      这种见鬼的现象，根因就是这里少读了一次请求体 —— 服务端把上一个请求
 *      没消费完的表单字节当成了这次登录的表单体。
 *
 * 对没有请求体的 GET 调 drainBody 是安全的：流已经结束，循环立刻退出。
 */
async function denyAdmin(req: IncomingMessage): Promise<never> {
  await drainBody(req);
  throw notFound();
}

async function drainBody(req: IncomingMessage): Promise<void> {
  let seen = 0;
  try {
    for await (const chunk of req) {
      seen += (chunk as Buffer).length;
      // 上限只是防呆：拒绝一个大文件时没必要把它整个读完
      if (seen > REJECT_DRAIN_LIMIT) {
        req.destroy();
        break;
      }
    }
  } catch {
    // 客户端中途断开，忽略
  }
}

function requireCsrf(ctx: Ctx, form: Record<string, string>): void {
  const token = ctx.sessionToken ?? '';
  if (!verifyCsrf(ctx.config.system.sessionSecret, token, form['_csrf'])) {
    throw new HttpError(403, 'CSRF check failed');
  }
}

function formLines(form: Record<string, string>, key: string): string[] {
  return linesToArray(form[key] ?? '');
}

function formBool(form: Record<string, string>, key: string): boolean {
  return form[key] === '1';
}

function formInt(form: Record<string, string>, key: string, fallback: number, min: number, max: number): number {
  const raw = Number(form[key]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

// ---------------------------------------------------------------- 入口

export async function handleAdmin(
  deps: AdminDeps,
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    url: URL;
    nonce: string;
    clientIp: string;
    isSecure: boolean;
  },
): Promise<boolean> {
  const config = deps.store.get();
  const adminPath = config.system.adminPath;
  const { url, nonce, clientIp, isSecure } = options;

  // 内容面与后台面共用 404：确认路径存在与否本身就是信息泄露
  if (url.pathname !== adminPath && !url.pathname.startsWith(`${adminPath}/`)) return false;

  const lang = langFromRequest(req, url, 'zh-CN');
  const theme = themeFromRequest(req, url, config.appearance.theme);
  // `/admin` 与 `/admin/` 是同一个页面，把孤零零的那条尾斜杠折掉。
  // 只折这一种情况：策略表是**精确匹配**，不做通用的路径规整 ——
  // 规整会让「/directories/../access」这类写法也命中，徒增攻击面。
  const rawSub = url.pathname.slice(adminPath.length);
  const sub = rawSub === '' || rawSub === '/' ? '' : rawSub;

  // ---- ① 来源 IP 白名单 ----
  const allowlist = parseCidrList(config.access.adminIpAllowlist);
  if (allowlist.length > 0 && !ipInAny(allowlist, clientIp)) {
    return await denyAdmin(req);
  }

  // ---- ② 会话与身份 ----
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE];
  const session = verifySession(
    sessionToken,
    config.system.sessionSecret,
    clientIp,
    config.system.bindSessionToIp,
  );

  // ★ 管理员身份**每次请求从配置里现查**，不信票据里带的任何东西。
  //   这是无状态票据下唯一能同时做到「改了权限立刻生效」和「删了账号立刻失效」
  //   的办法：票据里只有账号 id，角色和权限每次都重新算。
  const account =
    session !== null && session.k === 'admin' ? accountById(config, session.a ?? '') : undefined;
  const viewer = account !== undefined && account.enabled ? viewerOf(config, account) : null;

  const ctx: Ctx = {
    req, res, url, lang, theme, nonce, clientIp,
    isHttps: isSecure,
    config,
    adminPath,
    sub,
    sessionToken,
    session,
    form: {},
    account: account ?? null,
    viewer,
  };

  // ---- ③ 路由策略（fail-closed）----
  // ★ 放在所有业务判断之前。查不到策略就直接 404，于是 dispatch 里任何
  //   没配策略的路由都是不可达的死代码 —— 新加后台路由时忘了配权限，
  //   表现是「打不开」，而不是「对所有登录用户敞开」。
  const policy = resolveRoute(sub, (req.method ?? 'GET').toUpperCase());
  if (policy === null) return await denyAdmin(req);

  // ---- ④ 主题 / 语言 cookie（无需登录）----
  // 主题在登录之前处理：登录页自己也要跟主题，否则深色站点上会闪一张白页
  setThemeCookieIfChosen(res, url, isSecure);
  if (sub === '/lang') {
    const requested = url.searchParams.get('set');
    const next = safeRedirectPath(url.searchParams.get('next'), adminPath);
    const target: Lang = requested === 'en-US' ? 'en-US' : requested === 'zh-CN' ? 'zh-CN' : lang;
    setLangCookie(res, target, isSecure);
    sendRedirect(res, next);
    return true;
  }

  // ---- ⑤ 首次设置 ----
  // 「还没初始化」的判据从「adminPassword 为空」换成了「没有超级管理员账号」。
  // 顺带得到一个恢复路径：超级管理员账号一旦没了（被误删、密码记录损坏），
  // 本机打开后台就会重新看到设置页。这是单超级管理员模型的安全网。
  if (superAccount(config) === undefined) {
    // 只有根路径渲染设置表单、/setup 接收提交，其余子路径一律重定向过去。
    // 否则 /admin/directories 这类地址也会直接吐出一个设置表单，
    // 既是错误的状态码语义，也让「后台有哪些页面」这件事泄露出去。
    //
    // 注意 /setup 必须放行：表单 action 指向它。把提交地址也一起重定向掉，
    // 会让用户填完密码后「点了没反应」—— 表单永远到不了处理函数。
    if (sub !== '' && sub !== '/' && sub !== '/setup') {
      sendRedirect(res, adminPath);
      return true;
    }
    await handleSetup(ctx, deps);
    return true;
  }

  // ---- ⑥ 登录 ----
  if (sub === '/login') {
    await handleLogin(ctx, deps);
    return true;
  }

  // ---- ⑦ 会话与账号闸门 ----
  // 票据有效但账号没了 / 被禁用 / 是升级前的旧版本，一律当未登录。
  if (viewer === null) {
    if (sub === '/logout') {
      clearSessionCookie(res, isSecure);
    }
    sendRedirect(res, `${adminPath}/login`);
    return true;
  }

  if (sub === '/logout') {
    clearSessionCookie(res, isSecure);
    sendRedirect(res, `${adminPath}/login`);
    return true;
  }

  // ---- ⑧ 能力：这个身份能不能走这条路由 ----
  // 拒绝用 404 而不是 403 —— 「不许」不能反过来告诉对方这个页面存在。
  if (!isAllowed(policy, viewer)) {
    return await denyAdmin(req);
  }

  // ---- ⑨ CSRF ----
  // ★ 表单体在这里**只解析一次**，结果存进 ctx.form 传给各 handler。
  //   parseFormBody 会消费请求流，第二次读只会拿到空对象；而范围检查要读
  //   表单里的目录 id —— 所以那次解析必须发生在这一层，不能散在 handler 里。
  //   （上传走 x-csrf 请求头，因为它的请求体就是文件原始字节，由 handler 自己校验。）
  if (policy.csrf === 'form') {
    ctx.form = await parseFormBody(req);
    requireCsrf(ctx, ctx.form);
  }

  // ---- ⑩ 对象归属：这个目录 / 这个路径是不是你的 ----
  // 走到这里 account 一定非空（viewer 非空就意味着 account 存在且已启用）
  if (account === undefined) throw notFound();
  const scope = checkScope(policy, {
    url,
    form: ctx.form,
    account,
    directoryIds: viewer.directoryIds,
    config,
  });
  if (!scope.ok) {
    // 这两种说的都是「你的请求本身不对」，不涉及某个对象存不存在，可以明说
    if (scope.reason === 'outOfRoots' || scope.reason === 'foreignPath') {
      await respondScopeRejected(ctx, policy, scope.reason);
      return true;
    }
    // 别人的目录一律按「不存在」处理，不确认它存在
    return await denyAdmin(req);
  }

  await dispatch(ctx, deps);
  return true;
}

/**
 * 范围检查没过时怎么回。
 *
 * 这两种情况可以明说 —— 越界的是**请求本身**，不涉及「某个对象存不存在」：
 *   outOfRoots  路径不在你被授权的父目录里
 *   foreignPath 路径落在别人名下的目录里
 *
 * 前端 fetch 的接口要回 JSON（它拿到 HTML 只会抛解析错误），
 * 上传接口还得先**把请求体读完**再回：不读完就响应，Node 会销毁连接，
 * 浏览器拿到的是网络错误而不是这条消息（这是文档里记着的一次真实事故）。
 */
async function respondScopeRejected(
  ctx: Ctx,
  policy: RoutePolicy,
  reason: 'outOfRoots' | 'foreignPath',
): Promise<void> {
  const message = t(ctx.lang, reason === 'outOfRoots' ? 'errs.outOfRoots' : 'errs.foreignPath');
  if (policy.format !== 'json') {
    throw new HttpError(403, message);
  }
  // 上传走的是「请求体即文件」，拒绝前必须把流读完 —— 见 drainBody 的注释。
  // 这里必须 await：不 await 的话响应会在 handleAdmin 返回之后才发出，
  // 而调用方已经读走了 res.statusCode，访问日志里会记成 200。
  if (policy.csrf === 'header') await drainBody(ctx.req);
  sendJson(ctx.res, { error: message }, 403);
}

// ---------------------------------------------------------------- 登录 / 设置

async function handleSetup(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const { req, res, lang, nonce, config, adminPath, theme } = ctx;

  // 首次设置只允许本机完成，避免公网抢注管理员密码
  const localOnly = ctx.clientIp === '127.0.0.1' || ctx.clientIp === '::1';
  if (!localOnly) {
    sendHtml(
      res,
      renderLoginPage({ lang, nonce, accentColor: config.appearance.accentColor, adminPath, theme, productName: config.appearance.productName,
        notice: { kind: 'err', text: t(lang, 'setup.onlyLocal') } }),
      403,
    );
    return;
  }

  if (req.method === 'GET') {
    sendHtml(res, renderSetupPage({ lang, nonce, accentColor: config.appearance.accentColor, adminPath, theme, productName: config.appearance.productName }));
    return;
  }

  if (req.method !== 'POST') throw notFound();

  const form = await parseFormBody(req);
  // 用户名缺省成 admin。这是刻意的：旧书签、脚本化的首启、以及
  // 「第一次打开就是设个密码」这个直觉都还成立，不用额外解释。
  const username = (form['username'] ?? '').trim() || DEFAULT_ADMIN_USERNAME;
  const password = form['password'] ?? '';
  const confirm = form['confirm'] ?? '';

  const fail = (text: string): void => {
    sendHtml(
      res,
      renderSetupPage({
        lang, nonce, accentColor: config.appearance.accentColor, adminPath, theme,
        productName: config.appearance.productName,
        username,
        notice: { kind: 'err', text },
      }),
      400,
    );
  };

  if (!ADMIN_USERNAME_RE.test(username)) {
    fail(t(lang, 'setup.badUsername'));
    return;
  }
  if (password.length < 8) {
    fail(t(lang, 'setup.tooShort'));
    return;
  }
  if (password !== confirm) {
    fail(t(lang, 'setup.mismatch'));
    return;
  }

  const record = await hashPassword(password);
  // 建的是**第一个超级管理员账号**。id 用 SUPER_ADMIN_ID（空串），
  // 与 DirectoryConfig.owner 的空串语义对齐 —— 老目录因此自动归它。
  const superAdmin: AdminAccount = {
    id: SUPER_ADMIN_ID,
    username,
    role: 'super',
    password: record,
    permissions: [],
    roots: [],
    enabled: true,
    note: '',
  };
  await deps.store.update((draft) => {
    draft.access.admins = [superAdmin, ...draft.access.admins.filter((a) => a.role !== 'super')];
  });

  const next = deps.store.get();
  setHashConcurrency(next.access.rateLimit.maxConcurrentHashes);

  // 设置完直接登录，省掉一次多余的登录操作
  const payload: SessionPayload = {
    k: 'admin',
    a: SUPER_ADMIN_ID,
    exp: Math.floor(Date.now() / 1000) + next.system.sessionTtlMinutes * 60,
    ...(next.system.bindSessionToIp ? { ip: ctx.clientIp } : {}),
  };
  setSessionCookie(res, signSession(payload, next.system.sessionSecret), next, ctx.isHttps);

  sendRedirect(res, `${adminPath}/`);
}

async function handleLogin(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const { req, res, lang, nonce, config, adminPath, theme } = ctx;

  if (req.method === 'GET') {
    sendHtml(res, renderLoginPage({ lang, nonce, accentColor: config.appearance.accentColor, adminPath, theme, productName: config.appearance.productName }));
    return;
  }
  if (req.method !== 'POST') throw notFound();

  const verdict = deps.rateLimiter.check(ctx.clientIp);
  if (verdict.locked) {
    sendHtml(res, renderLoginPage({ lang, nonce, accentColor: config.appearance.accentColor, adminPath, theme, productName: config.appearance.productName,
      notice: { kind: 'err', text: t(lang, 'login.locked', { minutes: Math.ceil(verdict.retryAfterSeconds / 60) }) } }), 429);
    return;
  }

  const form = await parseFormBody(req);
  const username = (form['username'] ?? '').trim();
  const password = form['password'] ?? '';

  // ★ 用户名不存在时**仍然跑一次完整的密码校验**（对 null 记录，verifyPassword
  //   会拿零盐做一次等价的 scrypt 运算）。不这么做的话，「用户不存在」会立刻返回、
  //   「密码错」要算 100ms —— 攻击者据此就能枚举出哪些用户名是真的。
  //   这是 auth.ts 里 verifyPassword 对 null 记录的刻意设计，别绕过它。
  const found = accountByUsername(config, username);
  const target = found !== undefined && found.enabled ? found : undefined;

  let ok = false;
  try {
    ok = await verifyPassword(password, target?.password ?? null);
  } catch {
    // 并发闸门满时返回 503，而不是让内存无界增长
    throw tooManyRequests('too many concurrent authentication attempts');
  }
  if (target === undefined) ok = false;

  if (!ok) {
    const after = deps.rateLimiter.recordFailure(ctx.clientIp);
    // 失败加一点随机延迟，把在线爆破速率压到每秒个位数。
    // 不用固定延迟 —— 那会让正常输错的用户也一起变慢。
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));

    const message = after.locked
      ? t(lang, 'login.locked', { minutes: Math.ceil(after.retryAfterSeconds / 60) })
      : t(lang, 'login.attemptsLeft', { n: after.remaining });

    sendHtml(res, renderLoginPage({ lang, nonce, accentColor: config.appearance.accentColor, adminPath, theme, productName: config.appearance.productName,
      notice: { kind: 'err', text: message } }), after.locked ? 429 : 401);
    return;
  }

  deps.rateLimiter.recordSuccess(ctx.clientIp);

  if (target === undefined) {
    // 走不到这里：target 为空时 ok 必为 false，上面已经返回了。
    // 这一行是给类型收窄用的，顺带保证将来改上面逻辑时不会漏掉这个前提。
    throw notFound();
  }

  // 票据里只放账号 id：角色与权限每次请求现查，改了立刻生效、删了立刻失效
  const payload: SessionPayload = {
    k: 'admin',
    a: target.id,
    exp: Math.floor(Date.now() / 1000) + config.system.sessionTtlMinutes * 60,
    ...(config.system.bindSessionToIp ? { ip: ctx.clientIp } : {}),
  };
  setSessionCookie(res, signSession(payload, config.system.sessionSecret), config, ctx.isHttps);
  sendRedirect(res, `${adminPath}/`);
}

// ---------------------------------------------------------------- 分发

async function dispatch(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const { sub, req } = ctx;
  const isPost = req.method === 'POST';

  // ---- 概览 ----
  if (sub === '' || sub === '/') {
    if (isPost) throw notFound();
    renderDashboardPage(ctx, deps);
    return;
  }

  if (sub === '/reload' && isPost) {
    const ok = await deps.store.reload();
    redirectWithNotice(ctx.res, ctx.config.system.adminPath, ok ? 'ok' : 'err',
      ok ? 'dash.reloadOk' : 'dash.reloadFailed');
    return;
  }

  if (sub === '/rotate-secret' && isPost) {
    await deps.store.update((draft) => {
      draft.system.sessionSecret = generateSessionSecret();
    });
    clearSessionCookie(ctx.res, ctx.isHttps);
    sendRedirect(ctx.res, `${ctx.config.system.adminPath}/login`);
    return;
  }

  // ---- 目录管理 ----
  if (sub === '/directories') {
    renderDirectories(ctx, deps);
    return;
  }
  if (sub === '/directories/picker') {
    await serveDirectoryPicker(ctx);
    return;
  }
  if (sub === '/directories/qr') {
    serveDirectoryQr(ctx);
    return;
  }
  if (sub.startsWith('/directories/') && isPost) {
    await handleDirectoryAction(ctx, deps, sub);
    return;
  }

  // ---- 文件管理 ----
  if (sub === '/files') {
    if (isPost) throw notFound();
    await renderFiles(ctx, deps);
    return;
  }
  if (sub === '/files/upload' && isPost) {
    await handleUpload(ctx, deps);
    return;
  }

  // ---- 访问控制 ----
  if (sub === '/access') {
    renderAccess(ctx, deps);
    return;
  }
  if (sub.startsWith('/access/') && isPost) {
    await handleAccessAction(ctx, deps, sub);
    return;
  }

  // ---- 管理员账号（策略表里全是 super，子管理员走到这里早被 404 了）----
  if (sub === '/users') {
    if (isPost) throw notFound();
    renderUsers(ctx, deps);
    return;
  }
  if (sub.startsWith('/users/') && isPost) {
    await handleUserAction(ctx, deps, sub);
    return;
  }

  // ---- 系统设置 ----
  if (sub === '/system') {
    renderSystem(ctx, deps);
    return;
  }
  if (sub === '/system/export') {
    sendJson(ctx.res, ctx.config);
    return;
  }

  // ---- 域名与证书 ----
  if (sub === '/domain') {
    if (isPost) throw notFound();
    await renderDomain(ctx, deps);
    return;
  }
  if (sub === '/domain/apply' && isPost) {
    await handleDomainApply(ctx, deps);
    return;
  }
  if (sub.startsWith('/system/') && isPost) {
    await handleSystemAction(ctx, deps, sub);
    return;
  }

  // ---- 外观设置 ----
  if (sub === '/appearance') {
    if (isPost) {
      await handleAppearanceSave(ctx, deps);
      return;
    }
    renderAppearance(ctx, deps);
    return;
  }

  // ---- 日志 ----
  if (sub === '/logs') {
    renderLogs(ctx, deps);
    return;
  }
  if (sub === '/logs/clear' && isPost) {
    deps.accessLog.clear();
    redirectWithNotice(ctx.res, `${ctx.config.system.adminPath}/logs`, 'ok', 'common.saved');
    return;
  }
  if (sub === '/logs/export') {
    serveLogsCsv(ctx, deps);
    return;
  }

  throw notFound();
}

// ---------------------------------------------------------------- 概览

function renderDashboardPage(ctx: Ctx, deps: AdminDeps): void {
  const config = ctx.config;
  const status = deps.store.getStatus();
  const viewer = currentViewer(ctx);
  const account = currentAccount(ctx);

  // ★ 统计口径跟着可见范围走。子管理员看到「3 / 5 个目录」而其中 4 个是别人的，
  //   等于把「这台机器上还有几个目录」告诉了他。
  const mine = visibleDirectories(config, account);
  const enabled = mine.filter((d) => d.enabled);
  const prepared = deps.directories();
  // 「不可用」只统计**启用着却出问题**的目录。停用的那些本来就查不到，
  // 算进来的话这个数字会永远虚高，把真正的故障淹掉。
  const unavailable = enabled.filter((d) => !prepared.get(d.name.toLowerCase())?.available).length;

  const canViewLogs = hasPermission(viewer, 'logs.view');
  // 最近访问同样按目录过滤：日志里记的是 URL 路径，第一段就是目录名。
  // directoryIdOfLogPath 不认识的路径（首页、后台、静态资源）对子管理员一律不显示 ——
  // 「还有一条你看不到的记录」这件事本身也是信息。
  const recent = !canViewLogs
    ? []
    : (viewer.super
        ? deps.accessLog.query({ limit: 20 })
        : deps.accessLog
            .query({ limit: 500 })
            .filter((entry) => {
              const id = directoryIdOfLogPath(config, entry.path);
              return id !== null && viewer.directoryIds.has(id);
            })
            .slice(-20)
      ).reverse();

  sendHtml(
    ctx.res,
    renderDashboard({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: status.pendingRestart,
      configIssues: status.issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      navKeys: navKeysFor(viewer),
      accountLabel: accountLabelOf(ctx, account),
      ...(noticeFromQuery(ctx.url, ctx.lang) === undefined ? {} : { notice: noticeFromQuery(ctx.url, ctx.lang) }),
      host: config.system.host,
      port: config.system.port,
      uptimeSeconds: (Date.now() - deps.startedAt) / 1000,
      configPath: status.filePath,
      configLoadedAt: status.loadedAt,
      configIssueCount: status.issues.length,
      directoryTotal: mine.length,
      directoryEnabled: enabled.length,
      directoryUnavailable: unavailable,
      logSize: deps.accessLog.size,
      logSummary: deps.accessLog.summarize(),
      lockedIps: deps.rateLimiter.lockedCount,
      recent,
      timeZone: config.appearance.timeZone,
      isSuper: viewer.super,
      canViewLogs,
      account: {
        username: account.username,
        role: account.role,
        permissions: account.permissions,
        roots: account.roots,
      },
    }),
  );
}

// ---------------------------------------------------------------- 目录管理

function renderDirectories(
  ctx: Ctx,
  deps: AdminDeps,
  extra?: { editing?: DirectoryFormState | null; notice?: Notice },
  status = 200,
): void {
  const config = ctx.config;
  const prepared = deps.directories();
  const viewer = currentViewer(ctx);

  // ★ 只列出这个身份看得见的目录。子管理员看不到别人的目录 ——
  //   连「存在一个叫某某的目录」这件事都不该知道。
  const rows: DirectoryRow[] = config.directories
    .filter((dir) => viewer.directoryIds.has(dir.id))
    .map((dir) => {
      const prep = prepared.get(dir.name.toLowerCase());
      return {
        id: dir.id,
        name: dir.name,
        path: dir.path,
        label: dir.label,
        enabled: dir.enabled,
        access: dir.access,
        // 两件事都要满足才算「真有密码」。只看 password 非空的话，
        // 手工改过配置（或旧版本留下）的目录会在列表上挂一把无效的锁。
        hasPassword: dir.access === 'password' && dir.password !== null,
        followSymlinks: dir.followSymlinks,
        note: dir.note,
        // ★ 停用的目录**不算「不可用」**。`prepareDirectories` 会跳过停用项，
        //   所以查不到它 —— 但那是「你把它关了」，不是「它坏了」。
        //   混在一起的话，列表上会给你自己关掉的目录挂一个刺眼的错误标记，
        //   概览页的「不可用 × N」也会跟着虚高，真正的故障反而淹在里面。
        available: dir.enabled ? (prep?.available ?? false) : true,
        reason: dir.enabled ? (prep?.reason ?? '') : '',
      };
    });

  // 目录浏览器、「扫描导入」和「新建」都靠父目录池起步，但子管理员只能在自己
  // 被授权的父目录里挑 —— 给他整份池子等于把超级管理员的浏览范围也告诉他了，
  // 而且他选了也提交不了（策略层会 403）。
  const parentRoots = viewer.super ? config.system.parentRoots : currentAccount(ctx).roots;

  // ?edit=<id> 打开编辑表单，?new=1 打开新增表单
  let editing = extra?.editing ?? null;
  // 「删除内容」弹窗要显示«将要删掉哪个文件夹»，那是按下永久删除前最后一眼确认的东西
  let editingPath = '';
  if (editing === null) {
    const editId = ctx.url.searchParams.get('edit');
    if (editId !== null) {
      // 归属检查在这里也要做一次：?edit=<别人的 id> 不该打开别人的表单。
      // （策略层的 dirs.update 已经挡了提交，但页面本身也不该吐出来。）
      const dir = visibleDirectories(config, currentAccount(ctx)).find((d) => d.id === editId);
      if (dir !== undefined) {
        editing = toFormState(dir);
        editingPath = path.resolve(dir.path);
      }
    } else if (
      ctx.url.searchParams.get('new') === '1' &&
      hasPermission(viewer, 'dirs.create') &&
      parentRoots.length > 0
    ) {
      // 没有 dirs.create 时连空表单都不吐：那个表单提交上去必然 404，
      // 让人白填一遍是最糟的一种「权限不足」。
      // 池子里一个位置都没有时同理 —— 表单里的父目录下拉是空的，填了也提交不了。
      editing = emptyDirectoryForm();
    }
  }

  // 表单校验失败后原样回填时，`editing` 是从 extra 传进来的，路径得按 id 找回来。
  // 找不到就留空 —— 「删除内容」弹窗里那行路径会是空的，但那一行的 id/名字还在，
  // 而且服务端是按 id 重新取路径的，不依赖这个显示值。
  const editingId = editing?.id ?? '';
  if (editingPath === '' && editingId !== '') {
    const dir = config.directories.find((d) => d.id === editingId);
    if (dir !== undefined) editingPath = path.resolve(dir.path);
  }

  // 归属下拉的候选：超级管理员自己（空 id）+ 全部子管理员。
  // 停用的账号也在列 —— 他名下可能还有目录，得能显示出来是谁的。
  const owners = [
    { id: SUPER_ADMIN_ID, username: t(ctx.lang, 'users.roleSuper') },
    ...config.access.admins
      .filter((a) => a.role === 'sub')
      .map((a) => ({ id: a.id, username: a.username })),
  ];

  sendHtml(
    ctx.res,
    renderDirectoriesPage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: deps.store.getStatus().pendingRestart,
      configIssues: deps.store.getStatus().issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      navKeys: navKeysFor(viewer),
      accountLabel: accountLabelOf(ctx, currentAccount(ctx)),
      ...(extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) ?? undefined) === undefined
        ? {}
        : { notice: extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) },
      rows,
      editing,
      editingPath,
      parentRoots,
      publicBaseUrl: config.system.publicBaseUrl,
      // 界面按权限收敛：按钮藏起来只是省得点了报错，真正的强制在策略层
      perms: {
        create: hasPermission(viewer, 'dirs.create'),
        update: hasPermission(viewer, 'dirs.update'),
        remove: hasPermission(viewer, 'dirs.delete'),
        qr: hasPermission(viewer, 'dirs.qr'),
        browse: hasPermission(viewer, 'dirs.browse'),
        // 删内容写死成超级管理员专属，不是一个可勾选的权限
        purge: viewer.super,
        isSuper: viewer.super,
        publicBase: hasPermission(viewer, 'sys.publicbase'),
      },
      owners,
    }),
    status,
  );
}

function toFormState(dir: DirectoryConfig): DirectoryFormState {
  // 把已有的绝对路径拆回「父目录 + 目录名」。dir.path 是归一化过的绝对路径，
  // dirname/basename 对它是无损的（除了根目录本身，而根目录不可能被发布）。
  const resolved = path.resolve(dir.path);
  return {
    id: dir.id,
    name: dir.name,
    parent: path.dirname(resolved),
    folder: path.basename(resolved),
    label: dir.label,
    enabled: dir.enabled,
    access: dir.access,
    followSymlinks: dir.followSymlinks,
    sort: dir.sort,
    order: dir.order,
    cidrs: arrayToLines(dir.allowedCidrs),
    note: dir.note,
    owner: dir.owner,
  };
}

/**
 * 读表单。
 *
 * `fallbackOwner` 是「表单里没有 owner 字段」时保留的原值 —— 子管理员的表单
 * 不渲染那个下拉，缺失即视为不变。这跟本地化文本那边「字段缺失 = 保留原值」
 * 是同一条约定，别改成 `?? ''`（那会在子管理员保存时把自己的目录送给超级管理员）。
 */
function readDirectoryForm(
  form: Record<string, string>,
  id: string,
  fallbackOwner: string,
): DirectoryFormState {
  return {
    id,
    name: (form['name'] ?? '').trim(),
    parent: (form['parent'] ?? '').trim(),
    folder: (form['folder'] ?? '').trim(),
    label: (form['label'] ?? '').trim(),
    enabled: formBool(form, 'enabled'),
    access: (['inherit', 'public', 'password'] as const).includes((form['access'] ?? '') as AccessLevel)
      ? ((form['access'] ?? 'inherit') as AccessLevel)
      : 'inherit',
    followSymlinks: formBool(form, 'followSymlinks'),
    sort: form['sort'] ?? '',
    order: form['order'] ?? '',
    cidrs: form['cidrs'] ?? '',
    note: (form['note'] ?? '').trim(),
    owner: form['owner'] === undefined ? fallbackOwner : (form['owner'] ?? '').trim(),
  };
}

/**
 * 表单 → 配置。`target` 是**调用方算好的**目标绝对路径。
 *
 * 刻意不让这个函数自己拼：拼接必须和 `checkScope` 的 joinPath 用同一套规则，
 * 两处各写一遍迟早会分叉，而分叉的方向一定是「闸门查的和落盘的不是一个路径」。
 */
function formToDirectory(
  state: DirectoryFormState,
  existing: DirectoryConfig | undefined,
  target: string,
): DirectoryConfig {
  return {
    id: state.id,
    name: state.name,
    path: target,
    label: state.label,
    enabled: state.enabled,
    access: state.access,
    password: existing?.password ?? null,
    allowedCidrs: linesToArray(state.cidrs),
    followSymlinks: state.followSymlinks,
    sort: (SORT_FIELDS as readonly string[]).includes(state.sort) ? (state.sort as SortField) : '',
    order: (SORT_ORDERS as readonly string[]).includes(state.order) ? (state.order as SortOrder) : '',
    hideDotfiles: existing?.hideDotfiles ?? null,
    note: state.note,
    // 归属：超级管理员在表单里显式选，子管理员由 readDirectoryForm 保留原值、
    // 新建时再由 handleDirectoryAction 盖上创建者的 id
    owner: state.owner,
  };
}

async function handleDirectoryAction(ctx: Ctx, deps: AdminDeps, sub: string): Promise<void> {
  const form = ctx.form;
  const adminPath = ctx.config.system.adminPath;
  const viewer = currentViewer(ctx);
  const account = currentAccount(ctx);

  if (sub === '/directories/create' || sub === '/directories/update') {
    const id = sub === '/directories/create' ? '' : (form['id'] ?? '');
    const existing = ctx.config.directories.find((d) => d.id === id);
    const state = readDirectoryForm(form, id, existing?.owner ?? '');

    // 表单报错时统一走这里：把用户填的东西原样回填，不让人重打一遍。
    // 越界用 403、填错用 400 —— 与策略层拒绝时的状态码保持一致，
    // 免得同一个「不在授权范围内」在两条路径上一个 403 一个 400。
    const fail = (text: string, failStatus = 400): void => {
      renderDirectories(ctx, deps, { editing: state, notice: { kind: 'err', text } }, failStatus);
    };

    // 父目录缺失 = 没选，不是「当前目录」。必须先拦下来：joinTarget 对空父目录
    // 返回空串，而空串喂给后面的 mkdir / 包含性判断是没有任何意义的输入。
    if (state.parent === '') {
      fail(t(ctx.lang, 'dirs.errorParentMissing'));
      return;
    }

    // ★ 拼接规则必须与 policy.ts 的 joinTarget 逐字一致，否则闸门查的路径
    //   和服务端真正落盘的路径会分叉 —— 那是最糟的一类漏洞：看着有检查，实际没有。
    const target = joinTarget(state.parent, state.folder);

    const folderError = validateDirectoryName(state.folder);
    if (folderError !== null) {
      fail(t(ctx.lang, 'dirs.errorFolderInvalid', { reason: folderError }));
      return;
    }

    // 目录名已经不许含斜杠了，这里再确认一次拼接结果没跑出父目录。
    // 双重保险的理由：这一步之下就是真的 mkdir，写错了是在服务器上乱建文件夹。
    if (!isWithin(path.resolve(state.parent), target)) {
      fail(t(ctx.lang, 'dirs.errorFolderInvalid', { reason: state.folder }));
      return;
    }

    // URL 前缀留空 = 跟目录名走。目录名本身已经过校验，所以这一步是安全的。
    if (state.name === '') state.name = state.folder;

    const nameError = validateDirectoryName(state.name);
    if (nameError !== null) {
      fail(t(ctx.lang, 'dirs.errorNameInvalid', { reason: nameError }));
      return;
    }

    // ★ 池子是硬边界，对超级管理员一样有效。
    //   isPathAuthorized 对 super 恒为真（他哪儿都去得），所以这一条必须自己查。
    //   唯一的例外是「路径没动」：老目录可能是池子收紧之前安排的，
    //   不能因为改个标题就被拒 —— 那等于让人没法维护历史数据。
    const pathUnchanged = existing !== undefined && path.resolve(existing.path) === target;
    if (!pathUnchanged) {
      const roots = viewer.super ? ctx.config.system.parentRoots : account.roots;
      if (!roots.some((root) => isWithin(path.resolve(root), target))) {
        fail(t(ctx.lang, 'dirs.errorParentNotAllowed'), 403);
        return;
      }
    }

    // ★ 「授权父目录」本身不能当内容目录发布 —— 见 isAuthorizedParent 的注释。
    //
    //   判据是「这次保存之后它会不会是启用状态」，而不是「路径有没有改」：
    //   已经存在的这种记录（历史上发布的、或有人手工加的）允许**停用**、改标题、
    //   删除，但**不许重新启用** —— 否则「容器不能发布」这条对老数据就是空的，
    //   点一下启用照样发布出去。
    if (state.enabled && isAuthorizedParent(ctx.config, target)) {
      fail(t(ctx.lang, 'dirs.errorIsParentRoot'));
      return;
    }

    const pathError = validateContentPath(target, [
      deps.protectedPaths.appDir,
      deps.protectedPaths.configFile,
    ]);
    if (pathError !== null) {
      fail(t(ctx.lang, 'dirs.errorPathInvalid', { reason: pathError }));
      return;
    }

    const taken = ctx.config.directories.some(
      (d) => d.name.toLowerCase() === state.name.toLowerCase() && d.id !== id,
    );
    if (taken) {
      fail(t(ctx.lang, 'dirs.errorNameTaken', { name: state.name }));
      return;
    }

    // ★ 本站第一个「在磁盘上建目录」的写操作（在此之前唯一的写入口是上传）。
    //   安全性完全靠上面这两道：池子 + 目录名校验，两道都留在服务端，
    //   界面上的下拉框只是省事，不算防线。
    //
    //   非递归 mkdir：父目录不存在就报错，绝不悄悄造出中间的层级 ——
    //   那会让「我选错了父目录」变成一个看不见的错误，直到文件被传到别处才发现。
    let createdFolder = false;
    try {
      await mkdir(target);
      createdFolder = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        fail(t(ctx.lang, 'dirs.errorFolderParentMissing', { path: path.resolve(state.parent) }));
        return;
      }
      // EEXIST = 目标已经在了，正是「发布一个已存在的文件夹」，不是错误。
      // 并发下两个请求同时进来也会走到这里，同样无害。
      if (code !== 'EEXIST') {
        fail(t(ctx.lang, 'dirs.errorFolderFailed', { reason: String((error as Error).message ?? error) }));
        return;
      }
    }

    const next = formToDirectory(state, existing, target);

    // 归属盖章。子管理员新建的目录归他自己 —— 这是他「能看到自己新建的目录」
    // 这条需求的落地点；编辑时 readDirectoryForm 已经保留了原值，这里不动。
    if (!viewer.super && existing === undefined) next.owner = account.id;

    if (id === '') {
      next.id = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`;
    }

    // ★ 不再是密码模式时**清掉**旧的哈希，而不是留着不管。
    //   留着会有两个后果：目录列表上一直挂着一把早就无效的锁（让人以为还要密码），
    //   以及日后切回密码模式时，某个谁都不记得的旧密码会突然复活。
    if (next.access !== 'password') {
      next.password = null;
    } else {
      const password = form['password'] ?? '';
      if (password !== '') next.password = await hashPassword(password);
      // 选了密码模式却没填、之前也没有 —— 界面上会提示，这里不额外拦
    }

    await deps.store.update((draft) => {
      const index = draft.directories.findIndex((d) => d.id === next.id);
      if (index >= 0) draft.directories[index] = next;
      else draft.directories.push(next);
    });

    // 提示里区分「建了」和「本来就有」：这是用户唯一能确认服务端真的动过磁盘的地方。
    redirectWithNotice(
      ctx.res,
      `${adminPath}/directories`,
      'ok',
      createdFolder ? 'dirs.noticeFolderCreated' : 'dirs.noticeFolderAdopted',
    );
    return;
  }

  if (sub === '/directories/delete') {
    const id = form['id'] ?? '';
    await deps.store.update((draft) => {
      draft.directories = draft.directories.filter((d) => d.id !== id);
    });
    redirectWithNotice(ctx.res, `${adminPath}/directories`, 'ok', 'common.saved');
    return;
  }

  /**
   * ★ 删除目录**及其内容** —— 全站唯一一个不可撤销地删真实文件的操作。
   *
   * 几道闸门缺一不可：
   *   1. 策略表里写死超级管理员（不是一个可勾选的权限）
   *   2. 要手打一遍目录名 —— 这一步拦的是「点错了行的那个删除按钮」，
   *      而那种误操作恰恰是最可能发生的
   *   3. 位置安全检查：盘符根、程序目录、配置文件、以及**授权父目录本身**
   *      一律不许删（授权父目录是「放东西的容器」，删掉等于把里面所有人的东西一起删）
   *   4. 顺序是**先删文件、后改配置**：反过来的话，文件删失败就留下一条
   *      「配置里没了、磁盘上还在」的幽灵数据，而用户以为已经清干净了
   */
  if (sub === '/directories/purge') {
    const id = form['id'] ?? '';
    const dir = ctx.config.directories.find((d) => d.id === id);
    if (dir === undefined) throw notFound();

    const refuse = (text: string): void => {
      renderDirectories(ctx, deps, { notice: { kind: 'err', text } }, 400);
    };

    const target = path.resolve(dir.path);

    if (target === path.parse(target).root) {
      refuse(t(ctx.lang, 'dirs.purgeBlockedRoot', { path: target }));
      return;
    }
    const pathError = validateContentPath(target, [
      deps.protectedPaths.appDir,
      deps.protectedPaths.configFile,
    ]);
    if (pathError !== null) {
      refuse(t(ctx.lang, 'dirs.purgeBlockedProtected', { reason: pathError }));
      return;
    }
    if (isAuthorizedParent(ctx.config, target)) {
      refuse(t(ctx.lang, 'dirs.purgeBlockedParent', { path: target }));
      return;
    }

    if ((form['confirm'] ?? '').trim() !== dir.name) {
      refuse(t(ctx.lang, 'dirs.purgeNameMismatch', { name: dir.name }));
      return;
    }

    const info = await stat(target).catch(() => null);
    if (info !== null && !info.isDirectory()) {
      refuse(t(ctx.lang, 'dirs.purgeNotADirectory', { path: target }));
      return;
    }
    if (info !== null) {
      try {
        await rm(target, { recursive: true, force: false });
      } catch (error) {
        refuse(
          t(ctx.lang, 'dirs.purgeFailed', {
            reason: String((error as Error).message ?? error),
          }),
        );
        return;
      }
    }

    await deps.store.update((draft) => {
      draft.directories = draft.directories.filter((d) => d.id !== id);
    });
    // 文件夹本来就不存在时也走这里 —— 对用户来说结果一样（那个目录没内容了）
    redirectWithNotice(ctx.res, `${adminPath}/directories`, 'ok', 'dirs.purgeDone');
    return;
  }

  if (sub === '/directories/scan') {
    const root = form['root'] ?? '';
    // 策略层已经查过一遍，这里是第二道：扫描导入是**批量**建目录，
    // 万一闸门那边将来放宽了范围检查，这一步还能独立挡住越界扫描。
    const allowed =
      root !== '' &&
      (viewer.super
        ? ctx.config.system.parentRoots.some((r) => path.resolve(r) === path.resolve(root))
        : isPathAuthorized(account, root));
    if (!allowed) {
      redirectWithNotice(ctx.res, `${adminPath}/directories`, 'err', 'dirs.errorPathInvalid');
      return;
    }

    // 勾选的名字编码在**字段名**里：`pick:<目录名>`，值恒为 '1'。
    // 不用「同名多值」的复选框 —— 手写的 urlencoded 解析器把重复的键折叠成
    // 最后一个，那样勾十个只会导入一个，而且不报错（见过一次就够）。
    const picked = new Set(
      Object.keys(form)
        .filter((key) => key.startsWith(SCAN_PICK_PREFIX) && form[key] === '1')
        .map((key) => key.slice(SCAN_PICK_PREFIX.length)),
    );
    if (picked.size === 0) {
      redirectWithNotice(ctx.res, `${adminPath}/directories`, 'err', 'dirs.scanNothingPicked');
      return;
    }

    const taken = new Set(ctx.config.directories.map((d) => d.name.toLowerCase()));
    const created: DirectoryConfig[] = [];
    try {
      // ★ 以磁盘上的实际内容为准，而不是以提交上来的名字为准：
      //   列表是渲染时取的，中间可能有人把文件夹删了/改名了；更要紧的是
      //   「名字」是客户端说了算的东西，拿它直接拼路径就等于让客户端指定路径。
      //   这里只认 readdir 真实返回、且确实是个目录的那些项。
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!picked.has(entry.name)) continue;
        // 保留名、含斜杠、尾随点等等，一律不收 —— 扫描导入以前会跳过它们，
        // 现在也不能因为「勾选列表里出现了」就放行
        if (validateDirectoryName(entry.name) !== null) continue;
        if (taken.has(entry.name.toLowerCase())) continue;
        // 候选里已经过滤过一遍「授权父目录」，这里再拦一次：上面那一步是界面收敛，
        // 这一步才是强制（而且 handleDirectoryAction 也不会收，两层各自独立成立）
        if (isAuthorizedParent(ctx.config, path.join(root, entry.name))) continue;
        created.push({
          id: `${Date.now().toString(16)}${created.length.toString(16)}`,
          name: entry.name,
          path: path.join(root, entry.name),
          label: '',
          enabled: true,
          access: 'inherit',
          password: null,
          allowedCidrs: [],
          followSymlinks: false,
          sort: '',
          order: '',
          hideDotfiles: null,
          note: '',
          // 扫出来的目录归发起这次扫描的人 —— 与单条新建保持一致
          owner: viewer.super ? SUPER_ADMIN_ID : account.id,
        });
      }
    } catch {
      redirectWithNotice(ctx.res, `${adminPath}/directories`, 'err', 'dirs.errorPathMissing');
      return;
    }

    if (created.length === 0) {
      // 勾了但一个都没建出来：多半是勾中了别人已经发布的（那些名字对他不可见，
      // 所以界面上没标成「已发布」）。说清楚，别让人以为按钮坏了。
      redirectWithNotice(ctx.res, `${adminPath}/directories`, 'err', 'dirs.scanNothingCreated');
      return;
    }

    await deps.store.update((draft) => {
      draft.directories.push(...created);
    });
    redirectWithNotice(ctx.res, `${adminPath}/directories`, 'ok', 'common.saved');
    return;
  }

  throw notFound();
}

/**
 * 服务端目录浏览器：在**调用者自己的**可用范围内逐层展开。
 *
 * ★ 边界跟着身份走，不能一律用 `system.parentRoots`：
 *   父目录池是超级管理员的浏览范围，原样拿给子管理员看，
 *   他会看到一堆别人文件夹的名字；而且空路径时默认落在池子的第一项，
 *   子管理员从一个自己根本没权限的目录开始浏览，往上走立刻 403 ——
 *   前端只会显示一句 "failed"，看着像坏了。
 */
async function serveDirectoryPicker(ctx: Ctx): Promise<void> {
  const requested = ctx.url.searchParams.get('path') ?? '';
  const viewer = currentViewer(ctx);
  const roots = (viewer.super ? ctx.config.system.parentRoots : currentAccount(ctx).roots).map((r) =>
    path.resolve(r),
  );

  if (roots.length === 0) {
    sendJson(
      ctx.res,
      { error: t(ctx.lang, viewer.super ? 'dirs.browseNoParentRoots' : 'dirs.browseNoRoots') },
      400,
    );
    return;
  }

  const target = requested === '' ? (roots[0] ?? '') : path.resolve(requested);

  // 必须落在自己的某个根之内，否则越权浏览整个文件系统
  const allowed = roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!allowed) {
    sendJson(ctx.res, { error: t(ctx.lang, 'errs.outOfRoots') }, 403);
    return;
  }

  try {
    const st = await stat(target);
    if (!st.isDirectory()) {
      sendJson(ctx.res, { error: t(ctx.lang, 'dirs.browseNotADirectory') }, 400);
      return;
    }
    const entries = await readdir(target, { withFileTypes: true });
    const directories = entries
      // ★ 过滤掉「授权父目录」本身。这个接口的两个用处都是「挑一个来发布」——
      //   新增表单的浏览按钮、扫描导入的候选列表 —— 而这类位置是放东西的容器，
      //   发布它在服务端会被拒（见 isAuthorizedParent）。不在这里滤掉的话，
      //   用户会看到一个可选、点了却报错的选项。
      .filter(
        (entry) =>
          entry.isDirectory() && !isAuthorizedParent(ctx.config, path.join(target, entry.name)),
      )
      .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(ctx.res, { path: target, directories });
  } catch {
    sendJson(ctx.res, { error: t(ctx.lang, 'dirs.browseUnreadable') }, 400);
  }
}

// ---------------------------------------------------------------- 二维码

/**
 * 二维码里用的地址前缀（域名或 IP 和端口）。
 *
 * 优先级：查询参数 `base` → 系统设置里的「对外访问地址」→ 当前请求的 Host。
 * 中间那层是关键：后台常常是从 127.0.0.1 打开的，服务端推断不出访客
 * 实际用哪个公网域名，只能由人填一次并记住。
 */
function qrBaseOf(ctx: Ctx): string | null {
  const scheme = ctx.isHttps ? 'https' : 'http';

  const override = (ctx.url.searchParams.get('base') ?? '').trim();
  if (override !== '') return normalizeBaseUrl(override, scheme);

  if (ctx.config.system.publicBaseUrl !== '') return ctx.config.system.publicBaseUrl;

  return normalizeBaseUrl(ctx.req.headers.host ?? '', scheme);
}

/**
 * 目录二维码：`GET /admin/directories/qr?dir=<id>[&base=…][&format=svg|png][&download=1]`
 *
 * 二维码内容 = 对外地址 + `/目录名/`，也就是访客点开这个目录时用的完整网址。
 * 目录名走 encodeURIComponent —— 二维码里编百分比编码比编原始 UTF-8 更稳，
 * 老扫描器拿到 UTF-8 字节流往往直接乱码。
 *
 * 这个接口挂在后台路径下，因此天然要求已登录会话：二维码等于一把
 * 直达受密码保护目录的钥匙，不能匿名可取。
 */
function serveDirectoryQr(ctx: Ctx): void {
  const id = ctx.url.searchParams.get('dir') ?? '';
  const dir = ctx.config.directories.find((item) => item.id === id);
  if (dir === undefined) throw notFound();

  const base = qrBaseOf(ctx);
  if (base === null) {
    sendJson(ctx.res, { error: t(ctx.lang, 'sys.publicBaseInvalid') }, 400);
    return;
  }

  const target = `${base}/${encodeURIComponent(dir.name)}/`;

  let qr: QrCode;
  try {
    qr = encodeQr(target);
  } catch {
    // 只有网址长得离谱才会走到这里：版本 10 的字节模式容量是 213 字节
    sendJson(ctx.res, { error: t(ctx.lang, 'dirs.qrFailed') }, 400);
    return;
  }

  const wantsPng = ctx.url.searchParams.get('format') === 'png';
  const download = ctx.url.searchParams.get('download') === '1';
  // 目录名已经过校验（无斜杠），这里再挡一次 Windows 文件名里的非法字符
  const filename = `${dir.name.replace(/[\\/:*?"<>|]/g, '_')}.${wantsPng ? 'png' : 'svg'}`;

  const body = wantsPng
    ? renderQrPng(qr, { title: target })
    : Buffer.from(renderQrSvg(qr, { title: target }), 'utf8');

  ctx.res.setHeader('Content-Type', wantsPng ? 'image/png' : 'image/svg+xml; charset=utf-8');
  ctx.res.setHeader(
    'Content-Disposition',
    contentDisposition(download ? 'attachment' : 'inline', filename),
  );
  ctx.res.setHeader('Content-Length', String(body.length));
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.res.writeHead(200);
  ctx.res.end(body);
}

// ---------------------------------------------------------------- 访问控制

function renderAccess(ctx: Ctx, deps: AdminDeps, extra?: { notice?: Notice }, status = 200): void {
  const config = ctx.config;
  const testIp = ctx.url.searchParams.get('testIp') ?? '';

  let testIpResult: string | undefined;
  if (testIp !== '') {
    const list = parseCidrList(config.access.adminIpAllowlist);
    const allowed = list.length === 0 || ipInAny(list, testIp);
    testIpResult = `<div class="banner ${allowed ? 'ok' : 'err'}">${allowed ? t(ctx.lang, 'access.ipTestAllowed', { ip: testIp }) : t(ctx.lang, 'access.ipTestDenied', { ip: testIp })}</div>`;
  }

  sendHtml(
    ctx.res,
    renderAccessPage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: deps.store.getStatus().pendingRestart,
      configIssues: deps.store.getStatus().issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      ...(extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang)) === undefined
        ? {}
        : { notice: extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) },
      siteMode: config.access.siteMode,
      hasSitePassword: config.access.sitePassword !== null,
      hasAdminPassword: config.access.adminPassword !== null,
      ipAllowlist: arrayToLines(config.access.adminIpAllowlist),
      currentIp: ctx.clientIp,
      ...(testIp === '' ? {} : { testIp }),
      ...(testIpResult === undefined ? {} : { testIpResult }),
      rateLimit: config.access.rateLimit,
      sessionTtlMinutes: config.system.sessionTtlMinutes,
      bindSessionToIp: config.system.bindSessionToIp,
      hideDotfiles: config.access.hideDotfiles,
      deniedExtensions: arrayToLines(config.access.deniedExtensions),
      deniedFilenames: arrayToLines(config.access.deniedFilenames),
    }),
    status,
  );
}

async function handleAccessAction(ctx: Ctx, deps: AdminDeps, sub: string): Promise<void> {
  const form = ctx.form;
  const adminPath = ctx.config.system.adminPath;

  if (sub === '/access/site') {
    const mode = form['siteMode'] === 'password' ? 'password' : 'public';
    const password = form['sitePassword'] ?? '';
    let record = ctx.config.access.sitePassword;
    if (password !== '') record = await hashPassword(password);
    if (mode === 'public') record = null;

    await deps.store.update((draft) => {
      draft.access.siteMode = mode;
      draft.access.sitePassword = record;
    });
    redirectWithNotice(ctx.res, `${adminPath}/access`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/access/password') {
    const password = form['password'] ?? '';
    const confirm = form['confirm'] ?? '';
    if (password !== '' && password.length < 8) {
      renderAccess(ctx, deps, { notice: { kind: 'err', text: t(ctx.lang, 'access.passwordTooShort') } }, 400);
      return;
    }
    if (password !== confirm) {
      renderAccess(ctx, deps, { notice: { kind: 'err', text: t(ctx.lang, 'access.passwordMismatch') } }, 400);
      return;
    }
    if (password !== '') {
      const record = await hashPassword(password);
      await deps.store.update((draft) => {
        draft.access.adminPassword = record;
      });
      setHashConcurrency(deps.store.get().access.rateLimit.maxConcurrentHashes);
    }
    redirectWithNotice(ctx.res, `${adminPath}/access`, 'ok', 'access.passwordChanged');
    return;
  }

  if (sub === '/access/ip') {
    const list = formLines(form, 'allowlist');
    const invalid = findInvalidCidrs(list);
    // ★ 先校验再落盘。
    //   反过来（先写再报错）会让一个被明确判为「非法」的白名单留在配置里 ——
    //   页面弹了红字，配置却已经变了，下次进来看见的是那份错的。
    //   本项目其它保存路径都是「校验不过就不写」，这里是唯一的例外，已改正。
    if (invalid.length > 0) {
      renderAccess(ctx, deps, {
        notice: { kind: 'err', text: t(ctx.lang, 'access.invalidCidr', { list: invalid.join(', ') }) },
      }, 400);
      return;
    }
    await deps.store.update((draft) => {
      draft.access.adminIpAllowlist = list;
    });
    redirectWithNotice(ctx.res, `${adminPath}/access`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/access/ratelimit') {
    await deps.store.update((draft) => {
      draft.access.rateLimit = {
        loginMaxAttempts: formInt(form, 'loginMaxAttempts', 5, 1, 1000),
        loginWindowMinutes: formInt(form, 'loginWindowMinutes', 15, 1, 1440),
        lockoutMinutes: formInt(form, 'lockoutMinutes', 15, 1, 10080),
        lockoutMaxMinutes: formInt(form, 'lockoutMaxMinutes', 1440, 1, 43200),
        maxConcurrentHashes: formInt(form, 'maxConcurrentHashes', 4, 1, 64),
      };
    });
    const next = deps.store.get();
    deps.rateLimiter.reconfigure(next.access.rateLimit);
    setHashConcurrency(next.access.rateLimit.maxConcurrentHashes);
    redirectWithNotice(ctx.res, `${adminPath}/access`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/access/session') {
    await deps.store.update((draft) => {
      draft.system.sessionTtlMinutes = formInt(form, 'sessionTtlMinutes', 720, 5, 43200);
      draft.system.bindSessionToIp = formBool(form, 'bindSessionToIp');
    });
    // 只影响**之后**签发的会话：已经发出去的那张票到期前仍然有效，
    // 否则改一次时长就会把当前这个人踢下线。
    redirectWithNotice(ctx.res, `${adminPath}/access`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/access/files') {
    await deps.store.update((draft) => {
      draft.access.hideDotfiles = formBool(form, 'hideDotfiles');
      draft.access.deniedExtensions = formLines(form, 'deniedExtensions');
      draft.access.deniedFilenames = formLines(form, 'deniedFilenames');
    });
    redirectWithNotice(ctx.res, `${adminPath}/access`, 'ok', 'common.saved');
    return;
  }

  throw notFound();
}

// ---------------------------------------------------------------- 管理员账号

/**
 * 管理员列表页。
 *
 * 列表里**始终包含超级管理员那一行**（哪怕它不在 `access.admins` 里 ——
 * 没有 admins 数组的老配置就是这种情况），否则页面会看着像「一个账号都没有」。
 */
function renderUsers(
  ctx: Ctx,
  deps: AdminDeps,
  extra?: { editing?: AdminUserFormState | null; notice?: Notice },
  status = 200,
): void {
  const config = ctx.config;
  const me = currentAccount(ctx);
  const superAdmin = superAccount(config);

  const ownedCount = (id: string): number =>
    config.directories.filter((d) => d.owner === id).length;

  const rows: AdminUserRow[] = [];
  if (superAdmin !== undefined) {
    rows.push({
      id: superAdmin.id,
      username: superAdmin.username,
      role: 'super',
      enabled: superAdmin.enabled,
      permissions: [],
      ownedCount: ownedCount(superAdmin.id),
      note: superAdmin.note,
    });
  }
  for (const account of config.access.admins) {
    if (account.role === 'super') continue; // 上面已经单独列过了
    rows.push({
      id: account.id,
      username: account.username,
      role: 'sub',
      enabled: account.enabled,
      permissions: account.permissions,
      ownedCount: ownedCount(account.id),
      note: account.note,
    });
  }

  // ?edit=<id> 打开编辑表单，?new=1 打开新增表单
  let editing = extra?.editing ?? null;
  if (editing === null) {
    const editId = ctx.url.searchParams.get('edit');
    if (editId !== null) {
      const target = accountById(config, editId);
      // 超级管理员那条也能「编辑」，但只改得了用户名与密码 —— 权限与目录范围
      // 由角色决定，本来就给不了（表单里那两块对 super 不渲染）。
      if (target !== undefined) editing = toUserFormState(target);
    } else if (ctx.url.searchParams.get('new') === '1') {
      editing = emptyUserForm();
    }
  }

  sendHtml(
    ctx.res,
    renderUsersPage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: deps.store.getStatus().pendingRestart,
      configIssues: deps.store.getStatus().issues.length > 0,
      theme: ctx.theme,
      productName: config.appearance.productName,
      navKeys: navKeysFor(currentViewer(ctx)),
      accountLabel: accountLabelOf(ctx, me),
      ...(extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) ?? undefined) === undefined
        ? {}
        : { notice: extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) },
      currentUsername: me.username,
      rows,
      editing,
      availableRoots: config.system.parentRoots,
    }),
    status,
  );
}

/** 从 `perm_<键>` 复选框读出权限集合。没勾的键压根不在表单里，所以要遍历全集 */
function readPermissions(form: Record<string, string>): AdminPermission[] {
  return ADMIN_PERMISSIONS.filter((permission) => form[`perm_${permission}`] !== undefined);
}

/**
 * 读出授权父目录，并丢掉不在 `system.parentRoots` 里的那些。
 *
 * 返回被拒的条目而不只是静默过滤：填了个无效路径的人得知道，
 * 否则他会以为「保存成功了」，然后困惑于自己为什么建不了目录。
 */
function readRoots(raw: string, parentRoots: readonly string[]): { roots: string[]; rejected: string[] } {
  const roots: string[] = [];
  const rejected: string[] = [];
  for (const line of linesToArray(raw)) {
    // 与 normalizeRoots 同一套判据：解析成绝对路径后必须落在某个 scanRoot 之内
    const resolved = path.resolve(line);
    const inside = parentRoots.some((root) => {
      const rel = path.relative(path.resolve(root), resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (inside) roots.push(resolved);
    else rejected.push(line);
  }
  return { roots, rejected };
}

async function handleUserAction(ctx: Ctx, deps: AdminDeps, sub: string): Promise<void> {
  const form = ctx.form;
  const adminPath = ctx.config.system.adminPath;
  const me = currentAccount(ctx);

  if (sub === '/users/delete') {
    const id = form['id'] ?? '';
    const victim = accountById(ctx.config, id);

    // 三种「不许删」：不存在、是超级管理员、是自己。
    // 超级管理员删不掉 —— 系统必须始终有一个能进后台的账号；
    // 自己也删不掉 —— 删完这一页就再也打不开了。
    if (victim === undefined || victim.role === 'super' || victim.id === me.id) {
      redirectWithNotice(ctx.res, `${adminPath}/users`, 'err', 'users.deleteRefused');
      return;
    }

    await deps.store.update((draft) => {
      draft.access.admins = draft.access.admins.filter((a) => a.id !== id);
      // ★ 名下目录改归超级管理员，**和删账号在同一次写入里**完成。
      //   分成两次写的话，中间那一刻配置里就存在悬空的 owner，
      //   而校验器会把悬空归属当成问题报出来 —— 热重载可能因此拒绝这份配置。
      for (const dir of draft.directories) {
        if (dir.owner === id) dir.owner = SUPER_ADMIN_ID;
      }
    });
    redirectWithNotice(ctx.res, `${adminPath}/users`, 'ok', 'common.saved');
    return;
  }

  if (sub !== '/users/create' && sub !== '/users/update') throw notFound();

  const isNew = sub === '/users/create';
  const id = isNew ? '' : (form['id'] ?? '');
  const existing = isNew ? undefined : accountById(ctx.config, id);
  if (!isNew && existing === undefined) throw notFound();

  const username = (form['username'] ?? '').trim();
  const enabled = formBool(form, 'enabled');
  const note = (form['note'] ?? '').trim();
  const password = form['password'] ?? '';

  // 超级管理员那一行只允许改用户名和密码：角色、权限、目录范围都由角色决定，
  // 表单里根本没渲染那几块，硬读会读出空集合，把超级管理员降级成没有权限的子管理员。
  const isSuperRow = existing?.role === 'super';
  const permissions = isSuperRow ? [] : readPermissions(form);
  const { roots, rejected } = isSuperRow
    ? { roots: [] as string[], rejected: [] as string[] }
    : readRoots(form['roots'] ?? '', ctx.config.system.parentRoots);

  const state: AdminUserFormState = {
    id: existing?.id ?? '',
    isNew,
    username,
    enabled,
    permissions,
    roots: roots.join('\n'),
    note,
  };

  const fail = (text: string): void => {
    renderUsers(ctx, deps, { editing: state, notice: { kind: 'err', text } }, 400);
  };

  if (!ADMIN_USERNAME_RE.test(username)) {
    fail(t(ctx.lang, 'setup.badUsername'));
    return;
  }

  // 用户名唯一，大小写不敏感（登录时就是这么找的）
  const clash = accountByUsername(ctx.config, username);
  if (clash !== undefined && clash.id !== id) {
    fail(t(ctx.lang, 'users.usernameTaken', { name: username }));
    return;
  }

  // 新建必须给密码；编辑时留空表示不改
  if (isNew && password.length < 8) {
    fail(t(ctx.lang, 'setup.tooShort'));
    return;
  }
  if (!isNew && password !== '' && password.length < 8) {
    fail(t(ctx.lang, 'setup.tooShort'));
    return;
  }

  if (rejected.length > 0) {
    fail(t(ctx.lang, 'users.rootsRejected', { list: rejected.join('  |  ') }));
    return;
  }

  // ★ 授权即承诺：把某个父目录授权给这个人，等于承诺了「他能在这里建东西」。
  //   磁盘上没有就当场建出来，否则他填完表单只会拿到一句「父目录不存在」，
  //   还得回来找人 —— 那正是这一步要消掉的那种体验。
  //   建不出来就**拦住这次保存**：宁可让超管当场把路径改对，也不留一个
  //   「配置里有、磁盘上没有」的半截状态，那种状态只有在别人用的时候才会暴露。
  const ensured = await ensureDirectories(roots);
  if (!ensured.ok) {
    fail(describeEnsureFailure(ctx.lang, ensured));
    return;
  }

  const record = password === '' ? null : await hashPassword(password);
  // 新建时密码必填（上面校验过长度），这里把「一定非空」收窄出来给类型系统看
  const created: AdminAccount | null =
    isNew && record !== null
      ? {
          // id 只用来在票据和 owner 字段里指认账号，不需要 UUID 那种强度
          id: `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`,
          username,
          role: 'sub',
          password: record,
          permissions,
          roots,
          enabled,
          note,
        }
      : null;

  await deps.store.update((draft) => {
    if (created !== null) {
      draft.access.admins.push(created);
      return;
    }

    const target = draft.access.admins.find((a) => a.id === id);
    if (target === undefined) return;
    target.username = username;
    target.enabled = enabled;
    target.note = note;
    if (record !== null) target.password = record;
    // 超级管理员那一行只改得了用户名和密码 —— 别把它的角色覆盖掉
    if (target.role !== 'super') {
      target.permissions = permissions;
      target.roots = roots;
    }
  });

  redirectWithNotice(ctx.res, `${adminPath}/users`, 'ok', 'common.saved');
}

// ---------------------------------------------------------------- 系统设置

/**
 * `status` 只在「输入被拒绝、把表单原样渲染回去」时传 400。
 * 默认 200 —— 正常打开页面时不能是错误码。
 */
function renderSystem(ctx: Ctx, deps: AdminDeps, extra?: { notice?: Notice; status?: number }): void {
  const config = ctx.config;
  const status = deps.store.getStatus();
  const viewer = currentViewer(ctx);

  // ★ 这一页只有两种来客：超级管理员（全部卡片）和持有 sys.publicbase 的子管理员
  //   （只剩「对外访问地址」一张）。卡片在这里就裁掉，不让它渲染出一个
  //   提交必然 404 的表单 —— 那比看不到更让人困惑。
  //   `isSuper` 之外那几项权限在策略表里全是 super，所以直接用 viewer.super 判断。
  const canEdit = viewer.super;

  sendHtml(
    ctx.res,
    renderSystemPage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: canEdit && status.pendingRestart,
      configIssues: status.issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      navKeys: navKeysFor(viewer),
      accountLabel: accountLabelOf(ctx, currentAccount(ctx)),
      canEdit,
      ...(extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang)) === undefined
        ? {}
        : { notice: extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) },
      host: config.system.host,
      port: config.system.port,
      adminPathValue: config.system.adminPath,
      trustProxy: config.system.trustProxy,
      trustedProxyCidrs: arrayToLines(config.system.trustedProxyCidrs),
      logLevel: config.system.logLevel,
      logEnabled: config.system.accessLog.enabled,
      logRingSize: config.system.accessLog.ringSize,
      logPersist: config.system.accessLog.persistToFile,
      logFilePath: config.system.accessLog.filePath,
      logAnonymize: config.system.accessLog.anonymizeIp,
      parentRoots: arrayToLines(config.system.parentRoots),
      publicBaseUrl: config.system.publicBaseUrl,
      uploadEnabled: config.system.upload.enabled,
      uploadMaxSizeMb: config.system.upload.maxSizeMb,
      uploadOverwrite: config.system.upload.allowOverwrite,
    }),
    extra?.status ?? 200,
  );
}

async function handleSystemAction(ctx: Ctx, deps: AdminDeps, sub: string): Promise<void> {
  const form = ctx.form;
  const adminPath = ctx.config.system.adminPath;

  if (sub === '/system/server') {
    const host = (form['host'] ?? '').trim() || '127.0.0.1';
    const port = formInt(form, 'port', 8080, 0, 65535);
    let nextAdminPath = (form['adminPath'] ?? '').trim();
    if (!nextAdminPath.startsWith('/')) nextAdminPath = `/${nextAdminPath}`;
    while (nextAdminPath.length > 1 && nextAdminPath.endsWith('/')) nextAdminPath = nextAdminPath.slice(0, -1);
    if (nextAdminPath === '/') nextAdminPath = '/admin';

    await deps.store.update((draft) => {
      draft.system.host = host;
      draft.system.port = port;
      draft.system.adminPath = nextAdminPath;
    });
    // 后台路径可能已变，跳转到新路径
    redirectWithNotice(ctx.res, `${nextAdminPath}/system`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/system/proxy') {
    await deps.store.update((draft) => {
      draft.system.trustProxy = formBool(form, 'trustProxy');
      draft.system.trustedProxyCidrs = formLines(form, 'trustedProxyCidrs');
    });
    redirectWithNotice(ctx.res, `${adminPath}/system`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/system/log') {
    await deps.store.update((draft) => {
      draft.system.accessLog.enabled = formBool(form, 'logEnabled');
      draft.system.accessLog.ringSize = formInt(form, 'logRingSize', 500, 1, 100000);
      draft.system.accessLog.persistToFile = formBool(form, 'logPersist');
      draft.system.accessLog.filePath = (form['logFilePath'] ?? '').trim() || 'logs/access.log';
      draft.system.accessLog.anonymizeIp = formBool(form, 'logAnonymize');
      const level = form['logLevel'] ?? 'info';
      draft.system.logLevel = (['debug', 'info', 'warn', 'error'] as const).includes(level as never)
        ? (level as Config['system']['logLevel'])
        : 'info';
    });
    const next = deps.store.get();
    deps.accessLog.reconfigure(next.system.accessLog);
    redirectWithNotice(ctx.res, `${adminPath}/system`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/system/publicbase') {
    const raw = (form['publicBaseUrl'] ?? '').trim();
    // 留空是合法输入 —— 表示「跟随当前访问地址」
    const normalized = raw === '' ? '' : normalizeBaseUrl(raw, ctx.isHttps ? 'https' : 'http');
    if (normalized === null) {
      renderSystem(ctx, deps, {
        notice: { kind: 'err', text: t(ctx.lang, 'sys.publicBaseInvalid') },
        status: 400,
      });
      return;
    }
    await deps.store.update((draft) => {
      draft.system.publicBaseUrl = normalized;
    });
    // 这个动作在「系统设置」和「目录管理 → 二维码」两处都能触发，
    // 用 hidden 的 return 把用户送回他原来那一页；值必须过安全校验，
    // 否则就是一个开放重定向。
    const back = safeRedirectPath(form['return'], `${adminPath}/system`);
    redirectWithNotice(ctx.res, back, 'ok', 'sys.publicBaseSaved');
    return;
  }

  if (sub === '/system/upload') {
    await deps.store.update((draft) => {
      draft.system.upload.enabled = formBool(form, 'uploadEnabled');
      draft.system.upload.allowOverwrite = formBool(form, 'uploadOverwrite');
      draft.system.upload.maxSizeMb = formInt(form, 'uploadMaxSizeMb', 512, 1, 102400);
    });
    redirectWithNotice(ctx.res, `${adminPath}/system`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/system/parentroots') {
    const pool = formLines(form, 'parentRoots');

    // 和「授权子管理员」同一条规则：池子里的位置要真的存在。
    // 池子是浏览、扫描、建目录三件事共同的边界，里面摆着一个不存在的路径，
    // 子管理员选到它就会撞上一句「父目录不存在」，而超管这边看起来一切正常。
    const ensured = await ensureDirectories(pool);
    if (!ensured.ok) {
      renderSystem(ctx, deps, {
        notice: { kind: 'err', text: describeEnsureFailure(ctx.lang, ensured) },
        status: 400,
      });
      return;
    }

    await deps.store.update((draft) => {
      draft.system.parentRoots = pool;
    });
    redirectWithNotice(ctx.res, `${adminPath}/system`, 'ok', 'common.saved');
    return;
  }

  if (sub === '/system/import') {
    const raw = form['json'] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      renderSystem(ctx, deps, {
        notice: { kind: 'err', text: t(ctx.lang, 'sys.importInvalid') },
        status: 400,
      });
      return;
    }
    try {
      await deps.store.update((draft) => {
        const incoming = parsed as Partial<Config>;
        if (incoming.system) {
          // ★ 旧版导出的 JSON 里这个字段还叫 scanRoots。直接 Object.assign 会被
          //   draft 里**已有的** parentRoots 盖掉 —— 表现为「导入了一份配置，
          //   父目录池却没变」。所以先翻译成新键再合并。
          const incomingSystem = incoming.system as Record<string, unknown>;
          if (incomingSystem['parentRoots'] === undefined && incomingSystem['scanRoots'] !== undefined) {
            incomingSystem['parentRoots'] = incomingSystem['scanRoots'];
          }
          delete incomingSystem['scanRoots'];
          Object.assign(draft.system, incomingSystem);
        }
        if (incoming.appearance) Object.assign(draft.appearance, incoming.appearance);
        if (incoming.access) Object.assign(draft.access, incoming.access);
        if (Array.isArray(incoming.directories)) draft.directories = incoming.directories;
      });
    } catch (error) {
      renderSystem(ctx, deps, {
        notice: { kind: 'err', text: error instanceof Error ? error.message : 'import failed' },
      });
      return;
    }
    redirectWithNotice(ctx.res, `${adminPath}/system`, 'ok', 'sys.importDone');
    return;
  }

  throw notFound();
}

// ---------------------------------------------------------------- 域名与证书

/**
 * 域名与证书页。
 *
 * `?check=1` 时额外连本机 443 取一次证书 —— 那是唯一能证明「证书真的签下来了」
 * 的证据。其余情况不取：探测最长要等 5 秒，不该让人每次开页面都等。
 */
async function renderDomain(ctx: Ctx, deps: AdminDeps, extra?: { notice?: Notice }): Promise<void> {
  const config = ctx.config;
  const tls = config.system.tls;

  let caddyfile: string | null = null;
  let caddyfileError = '';
  try {
    caddyfile = buildCaddyfile(config);
  } catch (error) {
    caddyfileError = error instanceof Error ? error.message : String(error);
  }

  const caddyReachable = await probeAdminApi(tls.adminApi);

  let port80 = false;
  let port443 = false;
  if (tls.enabled) {
    [port80, port443] = await Promise.all([
      isPortListening('127.0.0.1', 80),
      isPortListening('127.0.0.1', 443),
    ]);
  }

  let probe: ProbeResult | null = null;
  const primary = tls.domains[0];
  if (ctx.url.searchParams.get('check') === '1' && primary !== undefined) {
    probe = await probeCertificate({ host: '127.0.0.1', port: 443, servername: primary });
  }

  const fromQuery = extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang);
  sendHtml(
    ctx.res,
    renderDomainPage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: deps.store.getStatus().pendingRestart,
      configIssues: deps.store.getStatus().issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      ...(fromQuery === undefined ? {} : { notice: fromQuery }),
      tls,
      caddyfile,
      caddyfileError,
      caddyReachable,
      caddyBinaryPath: resolveCaddyBinary(tls.caddyBinary),
      port80,
      port443,
      probe,
    }),
  );
}

async function handleDomainApply(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const form = ctx.form;
  const adminPath = ctx.config.system.adminPath;

  const domains = textToDomains(form['domains'] ?? '');
  const enabled = formBool(form, 'enabled');

  // 校验交给 store：域名非法、开了 HTTPS 却没填域名，都会在这里抛出来，
  // 页面上显示具体哪一项错了，且**一个字节都不会写盘**
  await deps.store.update((draft) => {
    draft.system.tls = {
      enabled,
      domains,
      email: (form['email'] ?? '').trim(),
      staging: formBool(form, 'staging'),
      caddyBinary: (form['caddyBinary'] ?? '').trim(),
      caddyConfigPath: (form['caddyConfigPath'] ?? '').trim() || 'caddy/Caddyfile',
      adminApi: (form['adminApi'] ?? '').trim() || 'http://127.0.0.1:2019',
    };

    // 这两项是让 HTTPS 真正可用的配套设置，不是可有可无的便利：
    //   publicBaseUrl —— 二维码要编绝对地址，不设就还是 http 的内网地址
    //   trustProxy    —— 不设的话来源 IP 全是 127.0.0.1、协议一律判成 http，
    //                    HSTS / Secure cookie / IP 白名单会一起失效
    if (enabled && domains[0] !== undefined) {
      draft.system.publicBaseUrl = `https://${domains[0]}`;
      draft.system.trustProxy = true;
    }
  });

  const next = deps.store.get();
  if (!next.system.tls.enabled) {
    redirectWithNotice(ctx.res, `${adminPath}/domain`, 'ok', 'domain.savedDisabled');
    return;
  }

  const fail = async (reason: string): Promise<void> => {
    await renderDomain(ctx, deps, {
      notice: { kind: 'err', text: t(ctx.lang, 'domain.applyFailed', { reason }) },
    });
  };

  let caddyfile: string;
  try {
    caddyfile = buildCaddyfile(next);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }

  // 落盘：Caddy 下次用 --config 启动时要读它。相对路径按项目根目录解析。
  const configPath = path.resolve(deps.protectedPaths.appDir, next.system.tls.caddyConfigPath);
  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, caddyfile, 'utf8');
  } catch (error) {
    await fail(`写入 Caddyfile 失败：${String(error)}`);
    return;
  }

  const result = await applyCaddyfile({
    adminApi: next.system.tls.adminApi,
    caddyfile,
    domains: next.system.tls.domains,
  });

  if (!result.ok) {
    await fail(result.error);
    return;
  }
  if (result.warnings.length > 0) {
    await renderDomain(ctx, deps, {
      notice: {
        kind: 'warn',
        text: t(ctx.lang, 'domain.appliedWithWarnings', { warnings: result.warnings.join(' / ') }),
      },
    });
    return;
  }

  redirectWithNotice(ctx.res, `${adminPath}/domain`, 'ok', 'domain.applied');
}

// ---------------------------------------------------------------- 外观

function renderAppearance(ctx: Ctx, deps: AdminDeps, extra?: { notice?: Notice }): void {
  const config = ctx.config;
  const first = config.directories.find((d) => d.enabled);

  sendHtml(
    ctx.res,
    renderAppearancePage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: deps.store.getStatus().pendingRestart,
      configIssues: deps.store.getStatus().issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      navKeys: navKeysFor(currentViewer(ctx)),
      accountLabel: accountLabelOf(ctx, currentAccount(ctx)),
      canEdit: hasPermission(currentViewer(ctx), 'appearance.edit'),
      ...(extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang)) === undefined
        ? {}
        : { notice: extra?.notice ?? noticeFromQuery(ctx.url, ctx.lang) },
      appearance: config.appearance,
      previewPath: first === undefined ? null : `/${encodeURIComponent(first.name)}/`,
    }),
  );
}

async function handleAppearanceSave(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const form = ctx.form;

  // 颜色只接受 #rrggbb；非法值直接丢弃，让校验器回退到默认色
  const hex = (key: string, fallback: string): string => {
    const value = (form[key] ?? '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  };

  const current = ctx.config.appearance;

  // 双语文案在表单里是两个平铺字段 nameZh / nameEn。
  // 字段整个缺失（旧表单、手工构造的请求）时保留原值；存在但为空则是「清空，用内置文案」，
  // 所以这里用 ?? 而不是 || —— 空串是有意义的值。
  const localized = (name: string, fallback: LocalizedText): LocalizedText => ({
    zh: (form[`${name}Zh`] ?? fallback.zh).trim(),
    en: (form[`${name}En`] ?? fallback.en).trim(),
  });

  const next: AppearanceConfig = {
    ...current,
    // 留空交给校验器回退到默认产品名，避免后台抬头变成「管理后台 · 」这样的半截标题
    productName: (form['productName'] ?? '').trim(),
    siteTitle: (form['siteTitle'] ?? '').trim(),
    footerText: (form['footerText'] ?? '').trim(),
    rootBehavior: form['rootBehavior'] === 'notFound' ? 'notFound' : 'welcome',
    welcomeTitle: localized('welcomeTitle', current.welcomeTitle),
    welcomeMessage: localized('welcomeMessage', current.welcomeMessage),
    welcomeImage: (form['welcomeImage'] ?? '').trim(),
    welcomeImageAlt: localized('welcomeImageAlt', current.welcomeImageAlt),
    welcomeImageWidth: formInt(form, 'welcomeImageWidth', 0, 0, 4000),
    welcomeHint: localized('welcomeHint', current.welcomeHint),
    listingLanguage: (['auto', 'zh-CN', 'en-US'] as const).includes((form['listingLanguage'] ?? '') as never)
      ? ((form['listingLanguage'] ?? 'auto') as AppearanceConfig['listingLanguage'])
      : 'auto',
    accentColor: hex('accentColor', current.accentColor),
    folderColor: hex('folderColor', current.folderColor),
    theme: (['auto', 'light', 'dark'] as const).includes((form['theme'] ?? '') as never)
      ? ((form['theme'] ?? 'auto') as AppearanceConfig['theme'])
      : 'auto',
    density: form['density'] === 'compact' ? 'compact' : 'comfortable',
    showBreadcrumbs: formBool(form, 'showBreadcrumbs'),
    showFileSize: formBool(form, 'showFileSize'),
    showModTime: formBool(form, 'showModTime'),
    showFilterBox: formBool(form, 'showFilterBox'),
    showSummary: formBool(form, 'showSummary'),
    defaultSort: (SORT_FIELDS as readonly string[]).includes(form['defaultSort'] ?? '')
      ? (form['defaultSort'] as SortField)
      : current.defaultSort,
    defaultOrder: (SORT_ORDERS as readonly string[]).includes(form['defaultOrder'] ?? '')
      ? (form['defaultOrder'] as SortOrder)
      : current.defaultOrder,
    timeZone: (form['timeZone'] ?? '').trim(),
    previewExtensions: formLines(form, 'previewExtensions'),
    forceDownloadExtensions: formLines(form, 'forceDownloadExtensions'),
    customCss: form['customCss'] ?? '',
  };

  await deps.store.update((draft) => {
    draft.appearance = next;
  });
  redirectWithNotice(ctx.res, `${ctx.config.system.adminPath}/appearance`, 'ok', 'common.saved');
}

// ---------------------------------------------------------------- 文件管理

/**
 * 把 path 查询参数解析成「已校验的相对路径段」。
 *
 * 这里不复用 resolveSafe：那个函数吃的是 URL pathname（百分号编码状态），
 * 而查询参数已经被 URLSearchParams 解码过了。直接对每一段跑同一套
 * validateSegment，语义一致且更直观。
 */
function parseRelPath(raw: string): string[] {
  const parts = raw.split('/').filter((part) => part !== '');
  for (const part of parts) validateSegment(part);
  return parts;
}

/** 把错误消息映射成用户能看懂的双语文案 */
function uploadErrorMessage(message: string, lang: Lang, maxSizeMb: number): string {
  if (message.includes('already exists')) return t(lang, 'files.exists');
  if (message.includes('size limit')) return t(lang, 'files.tooLarge', { mb: maxSizeMb });
  if (message.includes('deny rules')) return t(lang, 'files.denied');
  if (message.includes('permission')) return t(lang, 'files.noPermission');
  if (message.includes('not found')) return t(lang, 'files.cannotList');
  return message;
}

async function renderFiles(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const config = ctx.config;
  const prepared = deps.directories();
  const viewer = currentViewer(ctx);

  // 下拉框里只出现这个身份看得见的目录。选中的那个由策略层的 dir 范围检查兜住，
  // 这里过滤是让界面不至于列出一堆选了就 404 的选项。
  const dirs = config.directories
    .filter((dir) => dir.enabled && viewer.directoryIds.has(dir.id))
    .map((dir) => ({
      id: dir.id,
      name: dir.name,
      label: dir.label,
      available: prepared.get(dir.name.toLowerCase())?.available ?? false,
    }));

  const requestedId = ctx.url.searchParams.get('dir') ?? '';
  const selected = dirs.find((dir) => dir.id === requestedId) ?? dirs[0];
  const notice = noticeFromQuery(ctx.url, ctx.lang);

  const common = {
    lang: ctx.lang,
    nonce: ctx.nonce,
    accentColor: config.appearance.accentColor,
    adminPath: config.system.adminPath,
    csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
    siteTitle: config.appearance.siteTitle,
    pendingRestart: deps.store.getStatus().pendingRestart,
    configIssues: deps.store.getStatus().issues.length > 0,
    theme: ctx.theme,
    productName: ctx.config.appearance.productName,
    navKeys: navKeysFor(viewer),
    accountLabel: accountLabelOf(ctx, currentAccount(ctx)),
    ...(notice === undefined ? {} : { notice }),
    dirs,
    uploadEnabled: config.system.upload.enabled,
    canUpload: hasPermission(viewer, 'files.upload'),
    maxSizeMb: config.system.upload.maxSizeMb,
    allowOverwrite: config.system.upload.allowOverwrite,
    timeZone: config.appearance.timeZone,
  };

  if (selected === undefined) {
    sendHtml(
      ctx.res,
      renderFilesPage({
        ...common,
        selectedDirId: '',
        relPath: '',
        relPathEncoded: '',
        entries: [],
        listError: '',
      }),
    );
    return;
  }

  const preparedDir = prepared.get(selected.name.toLowerCase());
  const rawPath = ctx.url.searchParams.get('path') ?? '';

  let parts: string[] = [];
  let entries: Awaited<ReturnType<typeof listForAdmin>> = [];
  let listError = '';

  if (preparedDir === undefined || !preparedDir.available) {
    listError = t(ctx.lang, 'files.cannotList');
  } else {
    try {
      parts = parseRelPath(rawPath);
      const abs = resolveSafe(preparedDir.root, `/${parts.map(encodeURIComponent).join('/')}`);
      const real = await resolveRealSafe(preparedDir.realRoot, abs);
      if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
      entries = await listForAdmin(real);
    } catch {
      // 路径非法或不可读：退回该目录根部，并提示
      parts = [];
      listError = t(ctx.lang, 'files.cannotList');
    }
  }

  sendHtml(
    ctx.res,
    renderFilesPage({
      ...common,
      selectedDirId: selected.id,
      relPath: parts.join('/'),
      relPathEncoded: parts.map(encodeURIComponent).join('/'),
      entries,
      listError,
    }),
  );
}

async function handleUpload(ctx: Ctx, deps: AdminDeps): Promise<void> {
  const config = ctx.config;

  // ★ 提前拒绝时**必须把请求体读完**再回响应。
  //   只调 req.resume() 是不够的：响应发出时请求体往往还没读完，
  //   Node 发现请求未消费完会直接销毁 socket，客户端拿到 ECONNRESET ——
  //   浏览器只显示「网络错误」，而「同名文件已存在」这类提示根本到不了用户眼前。
  const reject = async (body: unknown, status: number): Promise<void> => {
    await drainBody(ctx.req);
    sendJson(ctx.res, body, status);
  };

  if (!config.system.upload.enabled) {
    await reject({ error: t(ctx.lang, 'files.disabled') }, 403);
    return;
  }

  // CSRF 走请求头 —— 上传的请求体就是文件原始字节，塞不下表单字段
  const rawToken = ctx.req.headers['x-csrf'];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (!verifyCsrf(config.system.sessionSecret, ctx.sessionToken ?? '', token)) {
    await reject({ error: 'CSRF check failed' }, 403);
    return;
  }

  const dirId = ctx.url.searchParams.get('dir') ?? '';
  const dirConfig = config.directories.find((dir) => dir.id === dirId);
  const preparedDir =
    dirConfig === undefined ? undefined : deps.directories().get(dirConfig.name.toLowerCase());

  if (preparedDir === undefined || !preparedDir.available) {
    await reject({ error: t(ctx.lang, 'files.cannotList') }, 404);
    return;
  }

  const rawHeader = ctx.req.headers['x-filename'];
  const encodedName = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof encodedName !== 'string' || encodedName === '') {
    await reject({ error: 'missing x-filename header' }, 400);
    return;
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    await reject({ error: 'invalid filename encoding' }, 400);
    return;
  }

  try {
    const rawPath = ctx.url.searchParams.get('path') ?? '';
    const relPath = `/${parseRelPath(rawPath).map(encodeURIComponent).join('/')}`;

    const plan = await planUpload(preparedDir, relPath, fileName);
    const bytes = await receiveUpload(ctx.req, plan, {
      maxBytes: config.system.upload.maxSizeMb * 1024 * 1024,
      allowOverwrite: config.system.upload.allowOverwrite,
    });

    sendJson(ctx.res, {
      ok: true,
      name: fileName,
      bytes,
      message: t(ctx.lang, 'files.uploadedOne', { name: fileName }),
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const raw = error instanceof Error ? error.message : String(error);
    if (status >= 500) log.error('upload failed', error);

    // 上传被中途打断（超限、写入失败）时请求体没读完，这条连接已经不可复用。
    // 不明确告知的话，客户端的连接池会继续复用它，下一个请求会平白拿到
    // ECONNRESET —— 表现为「上传一个大文件之后，页面上的下一个操作莫名其妙失败」。
    if (!ctx.req.readableEnded) {
      ctx.res.setHeader('Connection', 'close');
    }

    sendJson(
      ctx.res,
      { error: uploadErrorMessage(raw, ctx.lang, config.system.upload.maxSizeMb) },
      status,
    );
  }
}

// ---------------------------------------------------------------- 日志

function renderLogs(ctx: Ctx, deps: AdminDeps): void {
  const config = ctx.config;
  const filter: LogsFilter = {
    status: ctx.url.searchParams.get('status') ?? '',
    keyword: ctx.url.searchParams.get('q') ?? '',
    onlyNotOk: ctx.url.searchParams.get('notOk') === '1',
  };

  // ★ 按目录范围过滤：子管理员只该看到自己目录的访问记录。
  //   不过滤的话，日志页会把其它客户目录的存在与访问情况全暴露出去 ——
  //   那正是「看不到别人的目录」想避免的事。
  const viewer = currentViewer(ctx);
  const inScope = (logPath: string): boolean => {
    if (viewer.super) return true;
    const dirId = directoryIdOfLogPath(config, logPath);
    // 站点根（/）与目录名都对不上的路径，子管理员一律看不到
    return dirId !== null && viewer.directoryIds.has(dirId);
  };

  // 先按范围切一刀，再套筛选条件。total 取自**这一刀之后**的数量 ——
  // 拿整个环形缓冲的大小当分母，等于告诉子管理员「还有 300 条你看不到」。
  const visible = deps.accessLog.query().filter((entry) => inScope(entry.path));
  const filtered = visible.filter((entry) => {
    if (filter.status !== '' && !String(entry.status).startsWith(filter.status.trim())) return false;
    if (filter.onlyNotOk && entry.status === 200) return false;
    if (filter.keyword !== '' && !entry.path.toLowerCase().includes(filter.keyword.toLowerCase())) return false;
    return true;
  });

  sendHtml(
    ctx.res,
    renderLogsPage({
      lang: ctx.lang,
      nonce: ctx.nonce,
      accentColor: config.appearance.accentColor,
      adminPath: config.system.adminPath,
      csrfToken: csrfToken(config.system.sessionSecret, ctx.sessionToken ?? ''),
      siteTitle: config.appearance.siteTitle,
      pendingRestart: deps.store.getStatus().pendingRestart,
      configIssues: deps.store.getStatus().issues.length > 0,
      theme: ctx.theme,
      productName: ctx.config.appearance.productName,
      navKeys: navKeysFor(viewer),
      accountLabel: accountLabelOf(ctx, currentAccount(ctx)),
      ...(noticeFromQuery(ctx.url, ctx.lang) === undefined ? {} : { notice: noticeFromQuery(ctx.url, ctx.lang) }),
      entries: filtered.slice(-500).reverse(),
      total: visible.length,
      filter,
      timeZone: config.appearance.timeZone,
      canExport: hasPermission(viewer, 'logs.export'),
      canClear: viewer.super,
    }),
  );
}

function serveLogsCsv(ctx: Ctx, deps: AdminDeps): void {
  // 导出的范围与页面上看到的必须一致 —— 否则「页面上做了过滤」就是假的，
  // 导出一下全都出去了
  const viewer = currentViewer(ctx);
  const rows = deps.accessLog.query().filter((entry) => {
    if (viewer.super) return true;
    const dirId = directoryIdOfLogPath(ctx.config, entry.path);
    return dirId !== null && viewer.directoryIds.has(dirId);
  });
  const header = 'time,ip,method,path,status,bytes,durationMs,userAgent';
  const csvEscape = (value: string | number): string => `"${String(value).replace(/"/g, '""')}"`;
  const lines = rows.map((entry) =>
    [
      new Date(entry.time).toISOString(),
      entry.ip,
      entry.method,
      entry.path,
      entry.status,
      entry.bytes,
      entry.durationMs,
      entry.userAgent,
    ]
      .map(csvEscape)
      .join(','),
  );

  const body = Buffer.from(`﻿${[header, ...lines].join('\n')}\n`, 'utf8');
  ctx.res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  ctx.res.setHeader('Content-Disposition', 'attachment; filename="qrfolder-access-log.csv"');
  ctx.res.setHeader('Content-Length', String(body.length));
  ctx.res.writeHead(200);
  ctx.res.end(body);
}

