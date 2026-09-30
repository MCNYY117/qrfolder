/**
 * 配置仓库：单例持有当前配置，支持热重载与串行写入。
 *
 * 三条不可动摇的规则：
 *
 * 1. **校验不通过时保留旧配置，绝不降级为默认值。**
 *    否则一个手滑的 `siteMode` 就会把整站从「需密码」变成「公开」——
 *    这是配置文件热重载最危险的失效模式。
 *
 * 2. **监听配置所在目录，而不是文件本身。**
 *    Windows 上编辑器保存多为「写临时文件 + 原子改名」，
 *    文件级 fs.watch 在改名后句柄失效，会静默不再触发，
 *    表现为「改配置没反应」且极难排查。
 *
 * 3. **写入串行化。**
 *    后台两个标签页同时保存时，后写不能覆盖先读。
 *
 * 4. **订阅者可以是异步的，而且 `update()` 会等它们跑完。**
 *    服务端收到配置变更后要重建「目录映射」（里面带着 deny 规则、根路径等
 *    每次请求都要用的东西），那是一次带 fs I/O 的异步操作。以前这里是
 *    `void refresh()` —— 不等它跑完就返回，于是**保存成功后紧接着的那一两个请求
 *    仍然按旧配置处理**：刚禁掉的扩展名还能下载、刚停用的目录还能打开。
 *    窗口很短，表现为「偶尔复现」，测试里是 50% 的概率挂。
 */

import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import type { Config } from './schema.ts';
import { loadConfigFile, writeConfigAtomic, getMtimeMs } from './load.ts';
import { validateConfig, type ValidationIssue, type ValidateOptions } from './validate.ts';

const RELOAD_DEBOUNCE_MS = 150;

export type ConfigStatus = {
  filePath: string;
  /** 最近一次成功加载的时间戳（ms） */
  loadedAt: number;
  /** 最近一次加载的问题列表；非空表示当前用的是旧配置 */
  issues: ValidationIssue[];
  /** 配置里的监听地址与进程实际监听的不一致 */
  pendingRestart: boolean;
};

export class ConfigStore {
  readonly filePath: string;
  readonly #configDir: string;
  readonly #validateOptions: ValidateOptions;

  #config: Config;
  #issues: ValidationIssue[] = [];
  #loadedAt = Date.now();
  #watcher: FSWatcher | null = null;
  #reloadTimer: NodeJS.Timeout | null = null;
  #writeQueue: Promise<void> = Promise.resolve();
  /** 订阅者可以返回 Promise，`#emit()` 会等它 —— 见文件头第 4 条 */
  #listeners = new Set<(config: Config) => void | Promise<void>>();

  /** 进程启动时实际绑定的地址，用于判断是否需要重启 */
  #activeHost: string;
  #activePort: number;

  constructor(filePath: string, config: Config, options: ValidateOptions = {}) {
    this.filePath = filePath;
    this.#configDir = path.dirname(filePath);
    this.#validateOptions = options;
    this.#config = config;
    this.#activeHost = config.system.host;
    this.#activePort = config.system.port;
  }

  get(): Config {
    return this.#config;
  }

  getStatus(): ConfigStatus {
    return {
      filePath: this.filePath,
      loadedAt: this.#loadedAt,
      issues: this.#issues,
      pendingRestart:
        this.#config.system.host !== this.#activeHost ||
        this.#config.system.port !== this.#activePort,
    };
  }

  /** 标记进程实际监听的地址（服务器成功 listen 后调用） */
  markActive(host: string, port: number): void {
    this.#activeHost = host;
    this.#activePort = port;
  }

  subscribe(listener: (config: Config) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 通知所有订阅者，**等它们全部跑完**。
   *
   * 顺序 await 而不是 Promise.all：订阅者只有两三个，而这里要的正是
   * 「新配置完全生效之后才继续」——并发反而让「谁先跑完」变得不确定。
   * 单个订阅者抛错不能让其余的收不到通知，所以逐个 try。
   */
  async #emit(): Promise<void> {
    for (const listener of this.#listeners) {
      try {
        await listener(this.#config);
      } catch (error) {
        console.error('[qrfolder] config listener failed:', error);
      }
    }
  }

  /**
   * 串行更新配置并落盘。
   * mutate 直接改传入的对象，抛异常则整次更新作废。
   */
  async update(mutate: (draft: Config) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const draft = structuredClone(this.#config);
      mutate(draft);

      // 写盘前必须过一遍校验：后台不能产出非法配置。
      // 校验同时做归一化，所以落盘的是 result.config 而不是 draft。
      const result = validateConfig(draft, this.#validateOptions);
      if (!result.ok) {
        const detail = result.issues.map((i) => `${i.at === '' ? '(root)' : i.at}: ${i.message}`).join('; ');
        throw new Error(`配置校验未通过：${detail}`);
      }

      await writeConfigAtomic(this.filePath, result.config);
      this.#config = result.config;
      this.#issues = [];
      this.#loadedAt = Date.now();
      // ★ 必须 await：派生数据（内容面的目录映射与 deny 规则）在这里重建，
      //   不等它跑完，`update()` 就会在「配置已换、映射还是旧的」这个窗口里返回。
      await this.#emit();
    };

    // 排队：后一次更新必须等前一次写完
    this.#writeQueue = this.#writeQueue.then(run, run);
    return this.#writeQueue;
  }

  /**
   * 从磁盘重新加载。
   * @returns 是否成功采用了新配置
   */
  async reload(): Promise<boolean> {
    const result = await loadConfigFile(this.filePath, this.#validateOptions);

    if (result.parseError !== undefined || result.issues.length > 0) {
      // ★ 保留旧配置。把问题记下来供后台展示。
      this.#issues = result.parseError !== undefined
        ? [{ at: '', message: `JSON 解析失败：${result.parseError}` }, ...result.issues]
        : result.issues;
      console.error(
        `[qrfolder] config rejected, keeping previous configuration (${this.#issues.length} issue(s))`,
      );
      for (const issue of this.#issues.slice(0, 10)) {
        console.error(`  - ${issue.at === '' ? '(root)' : issue.at}: ${issue.message}`);
      }
      return false;
    }

    this.#config = result.config;
    this.#issues = [];
    this.#loadedAt = Date.now();
    await this.#emit();
    return true;
  }

  /** 开始监听配置文件变化。监听目录而非文件，原因见文件头注释。 */
  startWatching(): void {
    if (this.#watcher !== null) return;

    const targetName = path.basename(this.filePath).toLowerCase();
    try {
      this.#watcher = watch(this.#configDir, { persistent: false }, (_event, filename) => {
        // filename 可能为 null（某些平台/场景不提供）
        if (filename !== null && String(filename).toLowerCase() !== targetName) return;
        this.#scheduleReload();
      });
      this.#watcher.on('error', (error) => {
        console.error('[qrfolder] config watcher error:', error);
      });
    } catch (error) {
      console.error('[qrfolder] failed to watch config directory:', error);
    }
  }

  stopWatching(): void {
    if (this.#reloadTimer !== null) {
      clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }
    if (this.#watcher !== null) {
      this.#watcher.close();
      this.#watcher = null;
    }
  }

  #scheduleReload(): void {
    // Windows 上一次保存常触发 2~3 个事件，需要去抖
    if (this.#reloadTimer !== null) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      void this.reload();
    }, RELOAD_DEBOUNCE_MS);
  }

  /** 文件是否在加载之后被外部改过（供后台提示「配置已被外部修改」） */
  async isExternallyModified(): Promise<boolean> {
    return (await getMtimeMs(this.filePath)) > this.#loadedAt;
  }
}
