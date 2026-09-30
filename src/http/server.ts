/**
 * HTTP 服务器：路由与请求处理。
 *
 * 所有响应（含错误）都经过 applySecurityHeaders —— 这是修掉
 * 「404 响应泄露 Server 头」「错误页 Content-Type 是纯文本」两个既存缺陷的地方。
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ConfigStore } from '../config/store.ts';
import {
  SORT_FIELDS,
  SORT_ORDERS,
  type Config,
  type Lang,
  type SortField,
  type SortOrder,
  type ThemeMode,
} from '../config/schema.ts';
import { HttpError, notFound, tooManyRequests } from './errors.ts';
import { appendSetCookie, applySecurityHeaders, buildCookie, sendEmpty, sendHtml, sendRedirect, sendText } from './response.ts';
import { clientIp, isSecureRequest, parseCookies, parseFormBody, safeRedirectPath } from './request.ts';
import { parseCidrList } from '../access/cidr.ts';
import { evaluateAccess, siteGateRequired, type AccessDecision, type AdminScope } from '../access/guard.ts';
import { accountById, viewerOf } from '../admin/accounts.ts';
import type { LoginRateLimiter } from '../access/rateLimit.ts';
import { verifyPassword } from '../admin/auth.ts';
import { SESSION_COOKIE, signSession, verifySession, type SessionPayload } from '../admin/session.ts';
import {
  isThemeMode,
  langSwitchHref,
  newNonce,
  resolveTheme,
  THEME_COOKIE,
  themeSwitchHref,
} from '../views/html.ts';
import { renderErrorPage } from '../views/error.ts';
import { renderListing, type ListingBreadcrumb, type ListingItemView } from '../views/listing.ts';
import { renderPasswordGate } from '../views/adminLogin.ts';
import type { Notice } from '../views/adminLayout.ts';
import { renderWelcomePage } from '../views/welcome.ts';
import { fileExtension } from '../serving/mime.ts';
import { scanDirectory } from '../serving/listing.ts';
import {
  matchDirectory,
  prepareDirectories,
  resolveContentTarget,
  type PreparedDirectory,
  type ProtectedPaths,
} from '../serving/resolveTarget.ts';
import { resolveListingLang, t } from '../i18n/index.ts';
import { originOf } from '../util/safeUrl.ts';
import type { AccessLogEntry } from '../logging/types.ts';
import { log } from '../logging/appLog.ts';

/** 单次列出的条目上限，防止超大目录拖垮内存与渲染 */
const LIST_LIMIT = 5000;

export type AdminDispatch = (
  req: IncomingMessage,
  res: ServerResponse,
  options: { url: URL; nonce: string; clientIp: string; isSecure: boolean },
) => Promise<boolean>;

export type ServerDeps = {
  store: ConfigStore;
  protectedPaths: ProtectedPaths;
  recordAccess: (entry: AccessLogEntry) => void;
  /**
   * 后台请求的分发口。由 main.ts 注入，服务器本身不感知后台的实现细节。
   * 返回 false 表示该路径不归后台管，按内容面继续处理。
   */
  handleAdmin?: AdminDispatch;
  /**
   * 目录映射重建后回调（启动时与每次配置热重载后）。
   * 后台需要读取同一份映射，但它由服务器持有，所以在这里交出去。
   */
  onDirectoriesPrepared?: (directories: Map<string, PreparedDirectory>) => void;
  /**
   * 内容面密码的登录限流器。
   * 刻意与后台登录分开实例 —— 否则有人爆破某个目录的密码，
   * 会把管理员一起锁在后台外面。
   */
  rateLimiter: LoginRateLimiter;
  /** 进程启动时刻，供后台展示运行时长 */
  startedAt: number;
};

export type RunningServer = {
  server: Server;
  /** 配置变更后重新预处理目录 */
  refresh: () => Promise<void>;
  close: () => Promise<void>;
};

export async function startServer(
  deps: ServerDeps,
  host: string,
  port: number,
): Promise<RunningServer> {
  const { store } = deps;

  let directories = await prepareDirectories(
    store.get().directories,
    store.get().access,
    deps.protectedPaths,
  );
  deps.onDirectoriesPrepared?.(directories);

  async function refresh(): Promise<void> {
    const config = store.get();
    directories = await prepareDirectories(config.directories, config.access, deps.protectedPaths);
    deps.onDirectoriesPrepared?.(directories);
  }

  // 配置变更后重建目录映射。
  // ★ 返回这个 Promise（而不是 `void refresh()`）：store 会等订阅者跑完再让
  //   `update()` 返回。不返回的话，保存成功后紧接着的那个请求仍然按旧映射处理 ——
  //   刚禁掉的扩展名还能下载、刚停用的目录还能打开，窗口几十毫秒，只在高频
  //   连续请求时才看得见（测试里是 50% 概率挂，线上是「偶尔要刷新一次才对」）。
  store.subscribe(refresh);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, deps, () => directories);
  };

  const server = createHttpServer(handler);
  // 慢速攻击防护
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    refresh,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  getDirectories: () => Map<string, PreparedDirectory>,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const config = deps.store.get();

  const nonce = newNonce();
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const pathname = url.pathname;

  // 后台与内容面分属不同 CSP：后台禁止被嵌入，内容面允许自站预览
  const adminPath = config.system.adminPath;
  const isAdminRequest = pathname === adminPath || pathname.startsWith(`${adminPath}/`);

  // 客户端 IP 与协议只算一次，后台与访问日志共用
  const trustedProxies = config.system.trustProxy
    ? parseCidrList(config.system.trustedProxyCidrs)
    : [];
  const requestIp = clientIp(req, config.system.trustProxy, trustedProxies);
  const isSecure = isSecureRequest(req, config.system.trustProxy);

  // 主界面允许配外链图片，而本站 CSP 的 img-src 只有 'self' data: ——
  // 不把图片所在的源加进来，用户配的图片会被自己的策略静默拦掉，
  // 控制台只报一句「Refused to load the image」，很难联想到是 CSP。
  const welcomeImageOrigin =
    !isAdminRequest && pathname === '/' ? originOf(config.appearance.welcomeImage) : null;

  applySecurityHeaders(res, {
    nonce,
    frameAncestors: isAdminRequest ? "'none'" : "'self'",
    isHttps: isSecure,
    extraImgSrc: welcomeImageOrigin === null ? [] : [welcomeImageOrigin],
  });

  let status = 500;
  let bytes = 0;

  try {
    // 后台必须先于方法检查：它需要 POST，而内容面只接受 GET/HEAD
    if (isAdminRequest) {
      if (deps.handleAdmin !== undefined) {
        const handled = await deps.handleAdmin(req, res, {
          url,
          nonce,
          clientIp: requestIp,
          isSecure,
        });
        if (handled) {
          status = res.statusCode;
          return;
        }
      }
      // 未接后台或路径不属于后台 —— 一律 404，不确认后台存在
      throw notFound();
    }

    if (pathname === '/robots.txt') {
      status = 200;
      sendText(res, 'User-agent: *\nDisallow: /\n');
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const lang = resolveListingLang(req, url, cookies['lang'], config.appearance.listingLanguage);

    // 访客通过 ?lang= 显式选过语言时顺手种下 cookie，让选择保持住 ——
    // 否则点一次排序链接（不携带 lang）就退回自动判断了
    const explicitLang = url.searchParams.get('lang');
    if (explicitLang === 'zh-CN' || explicitLang === 'en-US') {
      appendSetCookie(
        res,
        buildCookie('lang', explicitLang, {
          path: '/',
          maxAgeSeconds: 31_536_000,
          httpOnly: false,
          secure: isSecure,
          sameSite: 'Lax',
        }),
      );
    }

    // 主题同理：?theme= 显式选过就种 cookie，并且**必须排在站点配置之前**，
    // 否则访客点过的切换按钮会被站点设置盖掉，按钮就成了摆设。
    const theme = resolveTheme(url.searchParams.get('theme'), cookies[THEME_COOKIE], config.appearance.theme);
    if (isThemeMode(url.searchParams.get('theme'))) {
      appendSetCookie(
        res,
        buildCookie(THEME_COOKIE, theme, {
          path: '/',
          maxAgeSeconds: 31_536_000,
          httpOnly: false,
          secure: isSecure,
          sameSite: 'Lax',
        }),
      );
    }
    const themeSwitch = {
      toLight: themeSwitchHref(url, 'light'),
      toDark: themeSwitchHref(url, 'dark'),
    };

    // ---- 内容面的会话凭证 ----
    const session = verifySession(
      cookies[SESSION_COOKIE],
      config.system.sessionSecret,
      requestIp,
      config.system.bindSessionToIp,
    );
    // ★ 管理员身份**从当前配置里现查**，不信票据里带的角色。
    //   于是「改了权限立刻生效」「删了账号立刻失效」在内容面也成立 ——
    //   否则一个被降权的子管理员能在票据过期前继续看别人的目录。
    const adminAccount =
      session !== null && session.k === 'admin' ? accountById(config, session.a ?? '') : undefined;
    const adminViewer =
      adminAccount !== undefined && adminAccount.enabled ? viewerOf(config, adminAccount) : null;
    const admin: AdminScope | null =
      adminViewer === null ? null : { super: adminViewer.super, directoryIds: adminViewer.directoryIds };
    const hasSiteSession = session !== null && session.k === 'site';

    // 每个目录用自己的 cookie，避免通过站点闸门后被目录闸门覆盖掉
    const directoryCookieName = (id: string): string => `${SESSION_COOKIE}_dir_${id}`;
    const hasDirectorySession = (id: string): boolean => {
      const payload = verifySession(
        cookies[directoryCookieName(id)],
        config.system.sessionSecret,
        requestIp,
        config.system.bindSessionToIp,
      );
      // ★ 以前这里只判了「非 null」。但 cookie 的**名字**里就嵌着目录 id，
      //   于是一个持有 A 目录票据的人，把 cookie 改名成 `..._dir_<B>`，
      //   那枚令牌照样验得过 —— 等于任意目录的闸门形同虚设。
      //   这里必须同时确认票据种类与它自带的目录 id 都对得上。
      return payload !== null && payload.k === 'dir' && payload.d === id;
    };

    const match = matchDirectory(pathname, getDirectories());

    // ---- 站点密码：最外层闸门 ----
    // 必须在「判断目录是否存在」之前。否则「弹密码」与「404」的差异
    // 会让攻击者枚举出哪些目录名是有效的。
    if (siteGateRequired({ config, admin }, hasSiteSession)) {
      await handlePasswordGate(req, res, {
        scope: 'site',
        dirId: '',
        dirName: '',
        config,
        lang,
        nonce,
        theme,
        productName: config.appearance.productName,
        isSecure,
        clientIp: requestIp,
        rateLimiter: deps.rateLimiter,
      });
      status = res.statusCode;
      return;
    }

    if (match.kind === 'unknown') throw notFound();

    // ---- 目录级决策：IP 白名单与目录密码 ----
    const decision: AccessDecision = evaluateAccess({
      config,
      dir: match.kind === 'match' ? match.dir : null,
      clientIp: requestIp,
      admin,
      hasDirectorySession,
    });

    if (decision.kind === 'deny') throw notFound();

    if (decision.kind === 'password') {
      await handlePasswordGate(req, res, {
        scope: 'directory',
        dirId: decision.dirId,
        dirName: decision.dirName,
        config,
        lang,
        nonce,
        theme,
        productName: config.appearance.productName,
        isSecure,
        clientIp: requestIp,
        rateLimiter: deps.rateLimiter,
      });
      status = res.statusCode;
      return;
    }

    // ---- 站点根路径 ----
    if (match.kind === 'root') {
      if (config.appearance.rootBehavior === 'notFound') throw notFound();
      status = 200;
      sendHtml(
        res,
        renderWelcomePage({
          lang,
          nonce,
          appearance: config.appearance,
          langSwitchHref: langSwitchHref(url, lang),
          theme,
          themeSwitch,
        }),
      );
      return;
    }

    // 密码校验通过之后，内容面只接受 GET/HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      status = 405;
      sendHtml(
        res,
        renderErrorPage({ status: 404, lang, accentColor: config.appearance.accentColor, nonce, theme }),
        405,
      );
      return;
    }

    const target = await resolveContentTarget(pathname, getDirectories(), deps.protectedPaths);

    if (target.kind === 'redirect') {
      status = 308;
      res.setHeader('Location', target.location);
      sendEmpty(res, 308);
      return;
    }

    if (target.kind === 'file') {
      const decision = decideDisposition(target.absPath, config);
      const { sendFile } = await import('../serving/sendFile.ts');
      const { stat } = await import('node:fs/promises');
      const st = await stat(target.absPath);
      status = req.headers.range === undefined ? 200 : 206;
      bytes = st.size;
      await sendFile(req, res, target.absPath, st, decision);
      return;
    }

    // ---- 目录列表 ----
    const entryConfig = target.dir.config;

    // 排序优先级：URL 查询参数 → 目录配置 → 外观默认值。
    // 列表页的排序表头就是靠 ?sort=&order= 驱动的，不读这里点击就没反应。
    const requestedSort = url.searchParams.get('sort') ?? '';
    const requestedOrder = url.searchParams.get('order') ?? '';
    const sort: SortField = (SORT_FIELDS as readonly string[]).includes(requestedSort)
      ? (requestedSort as SortField)
      : entryConfig.sort !== ''
        ? entryConfig.sort
        : config.appearance.defaultSort;
    const order: SortOrder = (SORT_ORDERS as readonly string[]).includes(requestedOrder)
      ? (requestedOrder as SortOrder)
      : entryConfig.order !== ''
        ? entryConfig.order
        : config.appearance.defaultOrder;

    const scan = await scanDirectory(target.absPath, {
      lang,
      rules: target.dir.denyRules,
      followSymlinks: entryConfig.followSymlinks,
      sort,
      order,
      limit: LIST_LIMIT,
    });

    const parts = pathname.split('/').filter((s) => s !== '');
    const breadcrumbs: ListingBreadcrumb[] = parts.map((raw, index) => ({
      text: safeDecode(raw),
      href: `/${parts.slice(0, index + 1).map((p) => encodeURIComponent(safeDecode(p))).join('/')}/`,
    }));

    const items: ListingItemView[] = scan.entries.map((entry) => ({
      name: entry.name,
      href: entry.isDir
        ? `${encodeURIComponent(entry.name)}/`
        : encodeURIComponent(entry.name),
      isDir: entry.isDir,
      size: entry.size,
      mtime: entry.mtime,
      ext: entry.isDir ? '' : fileExtension(entry.name).replace('.', ''),
    }));

    const currentName = breadcrumbs.at(-1)?.text ?? '';
    const heading = entryConfig.label !== '' ? entryConfig.label : currentName;
    const pageTitle =
      config.appearance.siteTitle !== '' ? `${heading} · ${config.appearance.siteTitle}` : heading;

    const html = renderListing({
      lang,
      appearance: config.appearance,
      nonce,
      title: pageTitle,
      breadcrumbs,
      items,
      numDirs: scan.numDirs,
      numFiles: scan.numFiles,
      // 站点根被封锁，所以只有进入第二层起才提供「返回上级」
      canGoUp: parts.length > 1,
      sort,
      order,
      truncated: scan.truncated,
      limit: LIST_LIMIT,
      // 排序链接要带上语言，否则点一次排序就把访客的语言选择丢了
      preservedQuery: `lang=${encodeURIComponent(lang)}`,
      langSwitchHref: langSwitchHref(url, lang),
      theme,
      themeSwitch,
    });

    status = 200;
    bytes = Buffer.byteLength(html, 'utf8');
    sendHtml(res, html);
    return;
  } catch (error) {
    status = await respondWithError(req, res, error, config, nonce);
  } finally {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    recordAccess(deps, req, config, requestIp, {
      status,
      bytes,
      durationMs,
    });
  }
}

/** 预览 / 强制下载的判定 */
function decideDisposition(
  absPath: string,
  config: ReturnType<ConfigStore['get']>,
): { disposition: 'inline' | 'attachment'; contentType?: string } {
  const name = absPath.split(/[\\/]/).pop() ?? '';
  const ext = fileExtension(name);

  // 强制下载优先：.html / .svg / .js 等能在本站源上执行脚本的类型，
  // 一律降级为二进制附件，且不让浏览器嗅探类型
  if (ext !== '' && config.appearance.forceDownloadExtensions.includes(ext)) {
    return { disposition: 'attachment', contentType: 'application/octet-stream' };
  }
  if (ext !== '' && config.appearance.previewExtensions.includes(ext)) {
    return { disposition: 'inline' };
  }
  // 未知类型：强制下载，绝不让浏览器去猜
  return { disposition: 'attachment' };
}

async function respondWithError(
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
  config: ReturnType<ConfigStore['get']>,
  nonce: string,
): Promise<number> {
  const status = error instanceof HttpError ? error.status : 500;

  if (status >= 500) {
    log.error('request failed', error);
  }

  if (res.headersSent) {
    res.destroy();
    return status;
  }

  const cookies = parseCookies(req.headers.cookie);
  const lang = resolveListingLang(req, new URL(req.url ?? '/', 'http://x'), cookies['lang'], config.appearance.listingLanguage);

  const requestUrl = req.url ?? '/';
  const onAdmin =
    requestUrl === config.system.adminPath ||
    requestUrl.startsWith(`${config.system.adminPath}/`) ||
    requestUrl.startsWith(`${config.system.adminPath}?`);

  // 后台保存配置时校验失败是**我们自己抛的**，应该把「具体哪一项填错了」
  // 告诉用户，而不是回一句「500 服务器内部错误」让人无从下手。
  // 仅限后台 —— 内容面不能泄露任何内部信息。
  const detail = error instanceof Error ? error.message : '';
  if (onAdmin && detail.startsWith('配置校验未通过')) {
    sendHtml(
      res,
      renderErrorPage({
        status: 400,
        lang,
        accentColor: config.appearance.accentColor,
        nonce,
        title: '400',
        message: detail.slice(0, 600),
      }),
      400,
    );
    return 400;
  }

  sendHtml(
    res,
    renderErrorPage({
      status,
      lang,
      accentColor: config.appearance.accentColor,
      nonce,
    }),
    status,
  );
  return status;
}

function recordAccess(
  deps: ServerDeps,
  req: IncomingMessage,
  config: ReturnType<ConfigStore['get']>,
  requestIp: string,
  result: { status: number; bytes: number; durationMs: number },
): void {
  if (!config.system.accessLog.enabled) return;

  deps.recordAccess({
    time: Date.now(),
    ip: requestIp,
    method: req.method ?? 'GET',
    path: (req.url ?? '/').slice(0, 512),
    status: result.status,
    bytes: result.bytes,
    durationMs: Math.round(result.durationMs),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 256),
  });
}

// ---------------------------------------------------------------- 内容面密码闸门

type PasswordGateOptions = {
  scope: 'site' | 'directory';
  dirId: string;
  dirName: string;
  config: Config;
  lang: Lang;
  nonce: string;
  /** 访客主题。密码页也要跟着，否则深色站点上会突然弹出一张白页 */
  theme: ThemeMode;
  /** 产品名，密码页标题上用 */
  productName: string;
  isSecure: boolean;
  clientIp: string;
  rateLimiter: LoginRateLimiter;
};

/** 限流桶的键。加前缀是为了与后台登录分开计数。 */
const contentLockKey = (ip: string): string => `content:${ip}`;

/**
 * 处理站点/目录密码闸门。
 *
 * GET 渲染密码页，POST 校验密码并种下对应作用域的会话 cookie。
 * 表单提交到**当前路径本身**，所以不需要额外的路由。
 */
async function handlePasswordGate(
  req: IncomingMessage,
  res: ServerResponse,
  options: PasswordGateOptions,
): Promise<void> {
  const { config, lang, nonce, scope, dirId, dirName, isSecure, clientIp, rateLimiter, theme, productName } = options;
  const returnTo = safeRedirectPath(req.url, '/');
  const ttlSeconds = config.system.sessionTtlMinutes * 60;

  const renderGate = (notice?: Notice, status = 401): void => {
    sendHtml(
      res,
      renderPasswordGate({
        lang,
        nonce,
        accentColor: config.appearance.accentColor,
        action: returnTo,
        title: scope === 'directory' && dirName !== '' ? dirName : t(lang, 'password.title'),
        csrfToken: '',
        theme,
        productName,
        ...(notice === undefined ? {} : { notice }),
      }),
      status,
    );
  };

  if (req.method !== 'POST') {
    renderGate();
    return;
  }

  const lockKey = contentLockKey(clientIp);
  const verdict = rateLimiter.check(lockKey);
  if (verdict.locked) {
    renderGate(
      {
        kind: 'err',
        text: t(lang, 'password.locked', {
          minutes: Math.ceil(verdict.retryAfterSeconds / 60),
        }),
      },
      429,
    );
    return;
  }

  const form = await parseFormBody(req);
  const record =
    scope === 'site'
      ? config.access.sitePassword
      : (config.directories.find((dir) => dir.id === dirId)?.password ?? null);

  let ok = false;
  try {
    ok = await verifyPassword(form['password'] ?? '', record);
  } catch {
    throw tooManyRequests('too many concurrent authentication attempts');
  }

  if (!ok) {
    const after = rateLimiter.recordFailure(lockKey);
    // 与后台登录相同的随机延迟，把在线爆破速率压到每秒个位数
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    renderGate(
      {
        kind: 'err',
        text: after.locked
          ? t(lang, 'password.locked', { minutes: Math.ceil(after.retryAfterSeconds / 60) })
          : t(lang, 'password.wrong'),
      },
      after.locked ? 429 : 401,
    );
    return;
  }

  rateLimiter.recordSuccess(lockKey);

  const base = {
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(config.system.bindSessionToIp ? { ip: clientIp } : {}),
  };
  const payload: SessionPayload =
    scope === 'site' ? { k: 'site', ...base } : { k: 'dir', d: dirId, ...base };

  // 目录会话用独立 cookie 名：共用一个的话，通过目录闸门会把站点会话覆盖掉
  const cookieName = scope === 'site' ? SESSION_COOKIE : `${SESSION_COOKIE}_dir_${dirId}`;
  appendSetCookie(
    res,
    buildCookie(cookieName, signSession(payload, config.system.sessionSecret), {
      path: '/',
      maxAgeSeconds: ttlSeconds,
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
    }),
  );

  sendRedirect(res, returnTo);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
