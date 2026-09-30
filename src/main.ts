/**
 * QRFolder 入口。
 *
 * 用法：
 *   node src/main.ts                       # 用 config/config.json 启动
 *   node src/main.ts --config other.json   # 指定配置文件
 *   node src/main.ts --port 9000           # 临时覆盖端口（不写回配置）
 *   node src/main.ts --lang en-US          # 命令行输出用英文
 *   node src/main.ts --check               # 只校验配置后退出
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadConfigFile, writeConfigAtomic, generateSessionSecret } from './config/load.ts';
import { ConfigStore } from './config/store.ts';
import { startServer } from './http/server.ts';
import { AccessLog } from './logging/accessLog.ts';
import { log, setLogLevel } from './logging/appLog.ts';
import type { PreparedDirectory, ProtectedPaths } from './serving/resolveTarget.ts';
import { LoginRateLimiter } from './access/rateLimit.ts';
import { setHashConcurrency } from './admin/auth.ts';
import { superAccount } from './admin/accounts.ts';
import { handleAdmin, type AdminDeps } from './admin/routes.ts';
import { t } from './i18n/index.ts';
import type { Lang } from './config/schema.ts';

const VERSION = '1.0.0';

/** 项目根目录（src/ 的上一级） */
const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(APP_DIR, 'config', 'config.json');

type CliOptions = {
  configPath: string;
  host: string | null;
  port: number | null;
  lang: Lang;
  check: boolean;
  help: boolean;
};

/**
 * 决定命令行输出用什么语言。
 *
 * 优先级：--lang 参数 → 系统区域设置 → 英文。
 * 用 Intl 而非 LANG 环境变量，因为 Windows 上 LANG 通常不存在。
 */
function resolveCliLang(explicit: string | null): Lang {
  const pick = (value: string): Lang | null => {
    const lower = value.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('en')) return 'en-US';
    return null;
  };

  if (explicit !== null) {
    const chosen = pick(explicit);
    if (chosen !== null) return chosen;
  }

  try {
    const system = pick(Intl.DateTimeFormat().resolvedOptions().locale);
    if (system !== null) return system;
  } catch {
    // 某些精简运行时没有完整 ICU，落到英文
  }
  return 'en-US';
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    configPath: DEFAULT_CONFIG_PATH,
    host: null,
    port: null,
    lang: resolveCliLang(null),
    check: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--config':
      case '-c': {
        const value = argv[i + 1];
        if (value !== undefined) {
          options.configPath = path.resolve(value);
          i += 1;
        }
        break;
      }
      case '--port':
      case '-p': {
        const value = Number(argv[i + 1]);
        if (Number.isInteger(value) && value >= 0 && value <= 65535) {
          options.port = value;
          i += 1;
        }
        break;
      }
      case '--host': {
        const value = argv[i + 1];
        if (value !== undefined) {
          options.host = value;
          i += 1;
        }
        break;
      }
      case '--lang': {
        const value = argv[i + 1];
        if (value !== undefined) {
          options.lang = resolveCliLang(value);
          i += 1;
        }
        break;
      }
      case '--check':
        options.check = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        break;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const lang = options.lang;

  if (options.help) {
    console.log(t(lang, 'cli.help', { version: VERSION }));
    return;
  }

  // 受保护路径：内容目录绝不能与之重叠，否则会把配置或源码发布出去
  const protectedPaths: ProtectedPaths = {
    appDir: APP_DIR,
    configFile: options.configPath,
  };
  const validateOptions = { protectedPaths: [APP_DIR, options.configPath] };

  const loaded = await loadConfigFile(options.configPath, validateOptions);

  const printIssues = (): void => {
    console.error(t(lang, 'cli.configIssues', { n: loaded.issues.length }));
    for (const issue of loaded.issues) {
      console.error(
        t(lang, 'cli.issueLine', {
          at: issue.at === '' ? t(lang, 'cli.rootLabel') : issue.at,
          message: issue.message,
        }),
      );
    }
  };

  if (options.check) {
    if (loaded.parseError !== undefined) {
      console.error(t(lang, 'cli.parseFailed', { error: loaded.parseError }));
      process.exitCode = 1;
      return;
    }
    if (loaded.issues.length > 0) {
      printIssues();
      process.exitCode = 1;
      return;
    }
    console.log(t(lang, 'cli.configValid', { path: options.configPath }));
    console.log(t(lang, 'cli.directoryCount', { n: loaded.config.directories.length }));
    return;
  }

  if (loaded.parseError !== undefined) {
    console.error(t(lang, 'cli.parseFailed', { error: loaded.parseError }));
    console.error(t(lang, 'cli.fixOrDelete'));
    process.exitCode = 1;
    return;
  }

  if (loaded.issues.length > 0) {
    log.warn(t(lang, 'cli.issuesWarn', { n: loaded.issues.length }));
    for (const issue of loaded.issues.slice(0, 20)) {
      log.warn(
        t(lang, 'cli.issueLine', {
          at: issue.at === '' ? t(lang, 'cli.rootLabel') : issue.at,
          message: issue.message,
        }),
      );
    }
  }

  const config = loaded.config;
  setLogLevel(config.system.logLevel);

  // 首次运行：生成会话密钥并落盘，避免每次重启都让所有人掉线
  if (config.system.sessionSecret === '') {
    config.system.sessionSecret = generateSessionSecret();
    try {
      await writeConfigAtomic(options.configPath, config);
      log.info(t(lang, 'cli.secretGenerated', { path: options.configPath }));
    } catch (error) {
      log.warn(t(lang, 'cli.secretWriteFailed', { error: String(error) }));
    }
  }

  if (!loaded.existed) {
    log.info(t(lang, 'cli.configMissing', { path: options.configPath }));
  }

  const store = new ConfigStore(options.configPath, config, validateOptions);
  const accessLog = new AccessLog(config.system.accessLog, APP_DIR);

  const rateLimiter = new LoginRateLimiter(config.access.rateLimit);
  // 内容面密码用独立的限流器：否则有人爆破某个目录的密码，
  // 会把管理员一起锁在后台外面
  const contentRateLimiter = new LoginRateLimiter(config.access.rateLimit);
  setHashConcurrency(config.access.rateLimit.maxConcurrentHashes);

  store.subscribe((next) => {
    setLogLevel(next.system.logLevel);
    accessLog.reconfigure(next.system.accessLog);
    rateLimiter.reconfigure(next.access.rateLimit);
    contentRateLimiter.reconfigure(next.access.rateLimit);
    setHashConcurrency(next.access.rateLimit.maxConcurrentHashes);
  });

  // 目录映射由服务器持有，后台通过这个引用读取同一份数据
  let currentDirectories: Map<string, PreparedDirectory> = new Map();
  const startedAt = Date.now();

  const adminDeps: AdminDeps = {
    store,
    accessLog,
    rateLimiter,
    protectedPaths,
    startedAt,
    directories: () => currentDirectories,
  };

  const host = options.host ?? config.system.host;
  const port = options.port ?? config.system.port;

  let running;
  try {
    running = await startServer(
      {
        store,
        protectedPaths,
        recordAccess: (entry) => accessLog.record(entry),
        handleAdmin: (req, res, opts) => handleAdmin(adminDeps, req, res, opts),
        onDirectoriesPrepared: (dirs) => {
          currentDirectories = dirs;
        },
        rateLimiter: contentRateLimiter,
        startedAt,
      },
      host,
      port,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      log.error(t(lang, 'cli.portInUse', { port }));
    } else if (code === 'EACCES') {
      log.error(t(lang, 'cli.portDenied', { host, port }));
    } else {
      log.error(t(lang, 'cli.startFailed', { error: String(error) }));
    }
    process.exitCode = 1;
    return;
  }

  store.markActive(host, port);
  store.startWatching();

  const shownHost = host === '0.0.0.0' || host === '::' ? t(lang, 'cli.allInterfaces') : host;
  const adminUrl = `http://${shownHost === t(lang, 'cli.allInterfaces') ? '127.0.0.1' : host}:${port}${config.system.adminPath}`;

  // 产品名取自配置：后台改一处，启动日志也跟着变
  log.info(t(lang, 'cli.started', { product: config.appearance.productName, version: VERSION }));
  log.info(t(lang, 'cli.listening', { url: `http://${shownHost}:${port}` }));
  log.info(t(lang, 'cli.configFile', { path: options.configPath }));
  log.info(t(lang, 'cli.enabledDirs', { n: config.directories.filter((d) => d.enabled).length }));
  // ★ 判据是「有没有超级管理员账号」，**不是**「有没有设过密码」：
  //   升级时旧密码会被迁移进 admins 并置空，拿 adminPassword 判断会永远为真，
  //   于是每次启动都提示「尚未设置管理员密码」，而实际上早就设好了。
  if (superAccount(config) === undefined) {
    log.warn(t(lang, 'cli.noSuperAdmin', { url: adminUrl }));
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(t(lang, 'cli.shuttingDown', { signal }));
    store.stopWatching();
    void running.close().then(() => accessLog.close()).then(() => {
      process.exit(0);
    });
    // 兜底：5 秒内没关干净就强退
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
