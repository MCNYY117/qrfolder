# CLAUDE.md

本文件为 Claude Code 等 AI 助手提供本仓库的工作指引。

## 项目概述

QRFolder 是一个**零运行时依赖**的目录列表服务，附带 Web 后台。
把服务器上的目录映射成可浏览的网址，只读对外，页面无任何第三方痕迹。

技术栈：TypeScript（由 Node 原生类型擦除直接执行，**无构建步骤**）+ Node 内置模块。

## 常用命令

```bash
# 运行（不需要 npm install 也能跑，但类型检查需要）
node src/main.ts
node src/main.ts --port 9000    # 临时换端口，不写回配置
node src/main.ts --check        # 只校验配置并退出

# Windows 上无窗口后台运行（双击 start.bat / stop.bat 等价）
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start|stop|restart|status

# 类型检查（需先 npm install 装 typescript 与 @types/node，二者均为 devDependencies）
npx tsc --noEmit

# 测试（用 Node 内置测试运行器，无测试框架依赖）
node --test
node --test test/safePath.test.ts    # 单跑一个文件
```

## 架构概览

```
src/
├── main.ts          入口：CLI 参数、配置加载、启动、优雅退出
├── config/          配置类型定义、校验、原子读写、热重载
├── http/            服务器、请求解析、响应下发、安全响应头
├── serving/         路径防护、目录扫描、MIME 映射、文件流传输
├── views/           页面渲染（列表页、错误页、后台各页）
├── admin/           认证、会话、CSRF、账号、权限策略表、后台路由
├── access/          CIDR 匹配、登录限流、内容面的目录闸门
├── logging/         环形缓冲、访问日志、应用日志
└── i18n/            中英词条
```

请求流转：`main.ts` → `http/server.ts` 路由 → 内容面走 `serving/resolveTarget.ts`，
后台面走 `admin/routes.ts`。

## 技术要点

### 类型擦除模式（最容易踩坑的地方）

Node 直接执行 `.ts` 时**只做类型擦除、不做代码生成**，因此以下语法一律不可用：

- `enum` → 改用 `const X = [...] as const` + `type T = typeof X[number]`
- `namespace`
- 构造函数参数属性 `constructor(private x: number)`
- `import x = require('y')`

`tsconfig.json` 里开了 `erasableSyntaxOnly: true`，`tsc` 会提前拦下这些写法。
**删掉这个选项会让错误推迟到运行时才暴露。**

另外两条硬约束：

- **相对导入必须带 `.ts` 后缀**（`import { x } from './y.ts'`）
- **不能用 `paths` 别名**（Node 不认，只有 tsc 认）

### 路径穿越防护

`src/serving/safePath.ts` 是全项目风险最集中的文件。核心规则：

> **必须先按 `/` 切分，再对每一段单独解码。**

顺序反了就是任意文件读取 —— 因为 `%2f` 能活着穿过 URL 解析器，
在 `decodeURIComponent` 那一刻才变成真正的分隔符。

修改这个文件前请先读它的文件头注释和 `docs/security.zh-CN.md`。

### 配置热重载

`config/store.ts` 有三条不可动摇的规则：

1. **校验不通过时保留旧配置，绝不降级为默认值。** 默认值是 `siteMode: "public"`，
   降级等于把整站从"需密码"变成"公开"。
2. **监听配置所在目录，而不是文件本身。** Windows 上编辑器保存是"写临时文件 + 原子改名"，
   文件级 `fs.watch` 在改名后句柄失效，会静默不再触发。
3. **写入串行化。** 后台两个标签页同时保存时，后写不能覆盖先读。
4. **订阅者可以是异步的，`update()` 会等它们跑完。** 服务端收到配置变更后要重建
   内容面的目录映射（里面带着 deny 规则、根路径），那是一次带 fs I/O 的异步操作。
   曾经这里写的是 `void refresh()` —— 不等它跑完就返回，于是**保存成功后紧接着的
   那一两个请求仍按旧配置处理**：刚禁掉的扩展名还能下载、刚停用的目录还能打开。
   窗口只有几十毫秒，表现为「偶尔要刷新一次才对」。

### 授权即承诺：授权时就把目录建出来

把某个父目录授权给子管理员、或者把它加进「允许的父级目录」池，等于承诺了
「这里能用」。磁盘上不存在就当场建出来（`src/admin/ensureDirs.ts`），
**建不出来就拦住这次保存** —— 宁可让超管当场把路径改对，也不留一个
「配置里有、磁盘上没有」的半截状态，那种状态只有在别人用的时候才会暴露。

`ensureDirectories` 刻意是**非递归**的：上级不存在就报错并点名是哪一级。
递归建目录会把「我把路径打错了一个字」变成一个看不见的错误。
它也只认绝对路径 —— 相对路径会被 `path.resolve` 解释成服务器进程的当前目录，
然后真的在那里建出文件夹来。

### 安全响应头

### 零依赖

`package.json` 的 `dependencies` 必须保持为空。`typescript` 和 `@types/node` 只放在
`devDependencies` —— 它们仅用于 `tsc --noEmit`，运行时不需要。

新增任何运行时依赖前请三思：这个项目会长期无人值守地跑在公网上，
没有依赖就没有供应链风险，也没有升级导致的破坏性变更。

### i18n

`src/i18n/zh-CN.ts` 是**键的权威来源**。`en-US.ts` 的类型是
`Record<MsgKey, string>`，漏翻一个键 `tsc` 会直接报错 —— 这是类型系统免费提供的
完整性保证，不要把它改成宽松类型。

### 站点内容的双语（LocalizedText）

界面词条走 `src/i18n/`，**访客可见的站点文案**是另一回事：主界面的标题、正文、
图片 alt、底部提示语存在配置里，类型是 `LocalizedText = { zh, en }`，
渲染时用 `pickLocalized(text, lang)` 按当前语言取一份。

一条不可动摇的规则：**两份互不回退**。中文没填就退回**中文**的内置文案，
绝不退到英文那份 —— 否则「只填了中文」的站点会让英文访客看到一句中文，
比看到通顺的英文默认文案更糟。回退链因此是「当前语言的自定义值 → 当前语言的内置值」。

表单侧对应 `views/forms.ts` 的 `localizedTextField()`：渲染成并排两栏，
提交为 `nameZh` / `nameEn` 两个平铺字段（手写 urlencoded 解析器不认识嵌套结构）。
保存时**字段缺失 = 保留原值**，存在但为空 = 清空用内置文案，
所以用 `??` 而不是 `||`，测试里要清空必须显式送空串。

旧配置里这些字段是纯字符串，`validate.ts` 的 `normalizeLocalizedText()`
负责把它们复制进两份，迁移后观感与升级前逐字一致。

### 二维码

`src/util/qrcode.ts` 是自己写的编码器（字节模式、纠错等级 M、版本 1–10），
之所以不引库，还是零依赖那条线。**改动它之前请先读 `test/qrcode.test.ts`
顶部的注释**：那两组「黄金矩阵」是逐模块写死的，任何一步回归都会当场炸掉。

一个真实踩过的坑写在 `putModule` 的注释里：画功能图形用的 `setModule`
会顺手打上「已占用」标记，如果数据填充与掩码也用它，掩码阶段就会认为
无处可掩，最终生成一张**未掩码的原始码面** —— 看上去完全正常，
但任何扫描器都读不出来。

### 明亮 / 黑暗模式

主题优先级：`?theme=` → `theme` cookie（访客点过切换按钮）→ `appearance.theme`（站点配置）。
**cookie 必须排在配置前面**，否则访客的选择会被站点设置盖掉，那个按钮就成了摆设。

`<html>` 上永远带 `data-theme="auto|light|dark"`，深色变量因此在样式表里写两遍：
`:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark) { :root[data-theme="auto"] }`。
两条规则互斥，不会打架。

两个容易踩的坑：

1. **切换按钮渲染两个链接**（切到明亮 / 切到黑暗），由 CSS 决定显示哪一个。
   「跟随系统」时服务端根本不知道访客的系统偏好，只有 CSS 的媒体查询知道 ——
   把判断放在样式表里，就不用为这个按钮引入脚本，也没有首屏闪烁。
   隐藏规则必须写 `:root .theme-switch { display: none }` **而不是** `.theme-switch`：
   各处补版式时会写 `.switch a { display:inline-flex }`（权重 0,1,1），
   单类选择器（0,1,0）压不住它，两个按钮会同时显示。
2. 后台的切换链接是只有查询串的相对链接 `?theme=dark`，而它**替换**整个查询串、
   不追加 —— `/admin/directories?edit=xxx` 点一下就会丢掉 edit。
   补回来的逻辑在 `adminLayout.ts` 的接线脚本里。

### 样式：共用基底与内容页基线

`src/views/baseCss.ts` 是**内容页与后台共用**的那层样式（变量、重置、面包屑、表格、
`.ic` 图标、空状态、通知条、窄屏折叠）。内容页专有的版式在 `styles.ts` 的
`listingCss`，后台专有的在 `adminStyles.ts` 的 `adminCss`，两者都是
`baseCss(...) + 自己那段`。

`test/css.test.ts` 冻结了 `listingCss` / `centeredCss` 的**规则基线**：
按「选择器 → 声明」比对，顺序无关（重构本来就会重排），但少一条规则、
改一个值都会当场炸。多出来的选择器只允许来自 `baseCss`；
`:root` 里允许新增自定义属性（没人引用就没有效果），已有的值不许变。

要**有意识地**改内容页样式时，连着基线一起改，并在提交信息里说明。

同文件里还钉着几条踩过的坑：

- **视图源码里不许出现内联 `style="..."`**（CSP 是 `style-src 'nonce-…'`，
  内联 style 属性会被浏览器直接丢掉，不报错也不警告）。仓库里曾经散着三十来处，
  全是「写了但没生效」的样子。需要间距/内联就用 `adminStyles.ts` 里那几个版式小工具类。
- 抽屉导航的规则必须挂在 `html.js` 下 —— 没有 JS 时导航是页首一条横向导航，
  直接 `translateX(-100%)` 会让它**彻底消失**，而不是「变朴素」。
- 表格的 `col-opt` 列折叠要求**表头和数据行标同样的列**。只标表头不标数据，
  宽屏上完全看不出来，手机上才会看到表头与数据错位一格。
  `adminFlow.test.ts` 里有一条逐表比对的用例。

### 安全响应头

所有响应都必须经过 `http/response.ts` 的 `applySecurityHeaders`。
**CSP nonce 必须每次响应重新生成**，在进程启动时生成一次并复用等于没有 CSP。

CSP 里每条指令都得**显式声明**：写了 `default-src 'none'`，没写的那些就一律
回退成「全禁」。已经踩过两次，都是同一个形状：

| 漏掉的指令 | 后果 |
|---|---|
| `connect-src` | 后台所有 `fetch` / XHR 被拒 —— 目录浏览器逐层展开、文件上传全都不通 |
| `frame-src` | 外观设置的实时预览 iframe 被拒 |

**这一类 bug 端到端测试发现不了**：`node --test` 用的是 Node 的 fetch，
不经过浏览器，CSP 根本不参与。所以 `test/adminFlow.test.ts` 里有一条专门断言
策略本身（`connect-src 'self'` / `frame-src 'self'` / 不许出现 `unsafe-inline`）。
改动 `buildCsp` 时请连着那条测试一起看。

其余两条：

- **内联 `style="…"` 属性会被浏览器直接拒绝**，不报错、不警告，就是不生效。
  需要样式就往 `views/adminStyles.ts` 的 `adminCss()` 里加类名。
  真实踩过：给只读页的 `<fieldset>` 写 `style="border:none"` 想清掉默认边框，
  结果 CSP 把它拦了，页面上凭空多出一圈 2px 凹槽框。
  （仓库里还散着一些 `style="display:inline"` 之类的写法，同样是无效的 ——
  它们恰好只是可有可无的版式，别照着抄。）
- **内联事件处理器（`onclick=`）同理**，交互一律走 `addEventListener` +
  带 nonce 的 `<script>`。

另外：**在 `adminStyles.ts` 里写注释不能用反引号** —— 那个文件整体是一个模板字符串，
反引号会把字符串截断，`tsc` 报的是一句很难懂的 `Expected ';', got 'ident'`。

`Server` 与 `X-Powered-By` 由 Node 默认不发送，因此代码里不需要显式删除 ——
但**也不要手动添加**。接入反向代理后，代理会给自己的响应加上 `Server` 头，
必须在反代侧删掉。

Caddy v2.11.4 上**实测**的注意点（和网上流传的写法不一样）：

- 用站点级的 `header -Server`，**不是** `header_down -Server`。
  `header_down` 只在 `reverse_proxy` 块内部合法；而实测代理到上游的响应本身
  并不带 `Server`（Node 不发），需要删的是 **Caddy 自己**产生的那一份
  （错误页、重定向、静态响应）—— 那属于站点级 `header`。
- 要删的地方有三处：站点块、`handle_errors` 块、以及显式的 `:80` 块。
  少一处就会在对应路径上漏出来。
- **必须写 `auto_https disable_redirects` 并显式声明 `:80` 块**。
  否则 HTTP→HTTPS 跳转是 Caddy 内部注入的，响应里的 `Server: Caddy` 无从删除。

## 权限模型（超级管理员 / 子管理员）

**唯一执行点是 `src/admin/policy.ts` 的那张路由表。** 每个后台路由在那里声明一次：
接受哪些方法、谁能走（public / firstRun / session / super / 权限数组）、碰哪个对象。
**没在表里的路由一律 404** —— 于是 `dispatch()` 里新加的 `if (sub === '/newthing')`
在补上表项之前是死代码，不可能出现「加了路由忘了配权限，结果对所有登录用户敞开」。
`test/adminPolicy.test.ts` 会扫源码里的路由字面量把这个要求钉住。

两个正交的维度，缺一不可：

- **能力**：账号级权限（13 项，逐项勾选），存在 `AdminAccount.permissions`
- **范围**：目录归属（`DirectoryConfig.owner`）+ 授权父目录（`AdminAccount.roots`）

### 目录范围只有两级

```
system.parentRoots   全局的「允许的父级目录」池，超级管理员维护，**唯一**的目录边界
  └─ AdminAccount.roots   子管理员从池子里被勾选出来的那几个（必须是池的子集）
       └─ DirectoryConfig.path   内容目录，只能落在授权父目录之下
```

浏览、扫描、建目录三件事都止于这个边界。**池子对超级管理员一样有效** ——
`isPathAuthorized` 对 super 恒为真（他确实哪儿都去得），所以「在不在池子里」
这一条由各处调用方自己查（`handleDirectoryAction` / `serveDirectoryPicker` /
`/directories/scan`）。唯一的例外是**路径没改动**：老目录可能是池子收紧之前
安排的，不能因为改个标题就被拒，否则历史数据没法维护。

新建/编辑目录的表单提交的是「父目录 + 目录名」两个字段，路径由服务端拼
（`policy.ts` 的 `joinTarget`，闸门与写盘用**同一个函数**）。
不让表单提交拼好的隐藏 `path`：那个字段只能由页面脚本维护，
脚本没跑起来时闸门校验的就是一个和真正落盘的路径毫无关系的值 ——
看上去在查，其实什么也没查住。

`joinTarget` 对空的父目录返回**空串**，不能写成 `path.resolve('')` ——
那是服务器的当前工作目录，碰上「池子恰好盖住 cwd」的部署，
一个空表单会被解析成池子里的某个位置。

### 容器不发布

一个位置要么是「放东西的容器」（池子里的路径、子管理员的授权根），要么是
「一个对外发布的内容目录」，不能兼着 —— 由 `accounts.ts` 的
`isAuthorizedParent()` 判定，只比**相等**不比包含（容器下面的子目录照常发布，
那才是常规用法）。Windows 上要折大小写再比，否则换个写法就绕过去了。

三处都要拦，缺一不可：`handleDirectoryAction`（强制）、`/directories/scan`
（批量建目录走的是另一条路）、以及 `serveDirectoryPicker`（候选列表 ——
不滤掉的话用户会看到一个可选、点了却报错的选项）。

### 删除内容：全站唯一不可撤销的操作

`/directories/purge` 会**真的删磁盘上的文件夹**。策略表里写死 `access: 'super'`，
不是一个可勾选的权限 —— 子管理员能做的永远只是「取消发布」。

四道闸门：超管专属 → 手打目录名（拦的是「点错了行」这种最可能发生的误操作）
→ 位置安全检查（盘符根、程序目录、配置文件、授权父目录一律不许删）
→ **先删文件、后改配置**（反过来的话，删失败会留下一条指向不存在路径的幽灵记录，
而用户以为已经清干净了）。

界面上「取消发布」和「删除内容」是两个分开的按钮，**不要在文案上合并**：
后果差别太大，都叫「删除」的话，想取消发布的人会点进那个删文件的。
它们待在**编辑弹窗底部的「危险操作」区**，不在列表行里 —— 见下一条。

### 表格里别塞太多行内按钮

目录页原来把五个动作（打开/二维码/编辑/取消发布/删除内容）都放在操作列里，
结果最后两个**根本看不见**：表格是 `table-layout: fixed`，每列只拿到
「宽度 ÷ 列数」，1080px 的版心上操作列是 206px，而五个按钮排一行要 338px；
溢出的部分被 `.panel` 的 `overflow: hidden` 裁掉了。宽屏窄屏都会发生。

两条约束，改这一块之前先读一遍：

1. **`.row-actions` 必须保留 `flex-wrap: wrap`。** 有了它，按钮排不下就换行，
   永远不会溢出单元格（`test/css.test.ts` 里有一条钉住它）。
2. **再往行里加第五个按钮之前，先想清楚它排不排得下。** 放不下的就往编辑弹窗的
   「危险操作」区挪 —— 那里天生适合放不可撤销的动作，而且你正看着这个目录的
   完整路径做决定。

几条不可动摇的约定：

1. **票据里只放账号 id，不放角色和权限。** 角色和权限每次请求从内存配置现查
   （`accountById` + `viewerOf`），所以「改了权限立刻生效」「删了账号立刻失效」
   才成立。把权限写进票据 = 改权限要等票据过期。
2. **令牌版本号 `v2` 不能退回 `v1`。** 旧版本的 `verifySession` 会忽略不认识的字段，
   一张带 `a` 的 v1 票据会被旧代码当成普通管理员接受 —— 回滚会把所有子管理员
   静默提升成超级管理员。版本号对不上，旧代码对新票据一律返回 null。
3. **拒绝一律用 404，不用 403**（「不许」不能反过来确认对象存在）。
   唯一的例外是「请求的路径不在你的授权父目录内」—— 那是请求本身不对，可以明说。
4. **归属判定必须排在目录密码分支之前**（`access/guard.ts`）。走到密码分支就等于
   承认了这个目录存在。
5. **`visibleDirectories()` 读 `config.directories`，不是 `deps.directories()`。**
   后者只含已启用的目录；用它过滤，子管理员会看不到自己那个被禁用的目录，
   于是永远没法重新启用。
6. **迁移必须零 issue。** 老配置的 `adminPassword` 静默迁移成超级管理员账号；
   迁移时报 issue 会让 `store.reload()` 永远保留旧配置、`--check` 退出码 1 ——
   等于每次升级都拒绝启动。

界面上的收敛（藏导航、藏按钮）**只是省得人点了撞 404**，强制始终在策略层。
`adminLayout.ts` 的 `navKeys` 由 `routes.ts` 用**同一张策略表**算出来
（`navKeysFor`），不另写一份「权限→菜单」映射 —— 两份名单迟早漂移，
漂移的方向一定是「菜单里有、点进去 404」。

## 测试

用 `node:test` + `node:assert/strict`，无测试框架。

| 文件 | 覆盖 |
|---|---|
| `test/safePath.test.ts` | 路径穿越全部向量 + 合法路径误杀回归 |
| `test/validate.test.ts` | 目录名与内容路径校验（含一次真实 bug 的回归） |
| `test/range.test.ts` | Range 解析与 Content-Disposition |
| `test/mime.test.ts` | MIME 映射 |
| `test/qrcode.test.ts` | 二维码：黄金矩阵、版本容量边界、PNG 块结构与 CRC、SVG 结构 |
| `test/adminFlow.test.ts` | **集成测试**：起真实进程，走完整后台流程 |
| `test/adminPolicy.test.ts` | 策略表纯单测 + 「路由字面量都有策略项」的源码扫描 |
| `test/adminScope.test.ts` | **集成测试**：两个租户，验证子管理员一处都越不过去 |
| `test/passwordGate.test.ts` | 内容面站点/目录密码闸门 |
| `test/css.test.ts` | 内容页 CSS 基线 + 共用基底的结构约束（抽屉、col-opt、不许内联 style） |
| `test/version.test.ts` | `src/main.ts` 的版本号常量与 `package.json` 一致（发版时两处独立维护，容易只改一处） |

改动 `serving/`、`config/validate.ts` 或 `admin/` 后请务必跑测试。

### 提前拒绝之前，先把请求体读完

`admin/routes.ts` 的 `denyAdmin()` 是**唯一**该用来在闸门阶段拒绝请求的出口。
不读完就回响应有两个后果，第二个是踩过的：

1. Node 发现请求未消费完会销毁 socket，客户端拿到网络错误而不是那条 404
   （上传接口尤其明显）。
2. **残留字节留在同一条 keep-alive 连接上，把下一个请求解析错位。**
   写 `adminScope.test.ts` 时出现过「用 admin 登录，却拿到 alice 的会话」，
   根因就是前面某个被拒绝的 POST 没读请求体 —— 服务端把上一个请求没消费完的
   表单字节当成了这次登录的表单体。看着像玄学，其实是连接层的确定行为。

### 集成测试里的复选框值是 `'1'`

`views/forms.ts` 的 `checkboxField` 渲染的是 `value="1"`，`formBool()` 也只认 `'1'`。
用 `'on'` 提交（HTML 的默认值、也是手写测试的直觉）会被判成**未勾选**，
表现是「账号建出来就是停用的」。权限复选框的名字是 `perm_` + 权限键本身，
而权限键里带点：`perm_dirs.view`，不是 `perm_dirs_view`。

### 集成测试的教训

`test/adminFlow.test.ts` 的存在源于一次真实事故：修「子路径不该吐设置表单」时，
把表单的提交地址 `/admin/setup` 也一并重定向掉了，用户填完密码「点了没反应」。
当时的验证**只测了 GET 子路径，没测提交本身**。

两条经验：

1. **改动路由守卫后，必须验证被放行的那条路径本身能走通**，而不只是验证被拦截的路径。
2. **断言不要依赖界面文案**。集成测试用表单 action（`action="/admin/setup"`）
   这类与语言无关的标记，否则改文案或切语言就会误报。

## 已知缺口

以下是当前有意识留下的不足，不是遗忘：

- **配置校验的问题描述仍是中文。** `src/config/validate.ts` 里约 25 条 issue 文案，
  以及 `src/config/store.ts` 的诊断日志，都没有走 i18n。
  它们出现在 `--check` 输出和启动日志里，英文用户会看到中文。
  命令行本身的输出（`src/main.ts`）已经是双语的。
  要补齐需要为每条 issue 建键 —— 机械但量不小。

- **无多实例支持。** 登录限流计数存内存，会话密钥在配置文件里。
  要跑多实例需要外部存储。

- **上传不支持 multipart。** `src/admin/upload.ts` 刻意绕开了 multipart/form-data：
  前端把 File 对象直接作为请求体发出，文件名放在 `x-filename` 请求头里。
  这是零依赖下最省心的做法 —— multipart 解析器是最容易被畸形输入打穿的部分。
  新增上传相关功能时**不要**引入 multipart 解析。

  两个必须保留的细节：
  1. 提前拒绝上传时（目录不存在、CSRF 失败、文件名非法）必须**先读完请求体再回响应**，
     否则 Node 会销毁连接，客户端拿到 ECONNRESET 而不是那条 JSON 错误。
  2. 上传中断（超限、写入失败）后要回 `Connection: close`，
     否则客户端的连接池会复用死连接，导致「上传大文件之后下一个操作莫名失败」。

## 代码风格

- 2 空格缩进，单引号，行尾分号
- 文件名 kebab-case（React 组件除外，本项目没有 React）
- 注释用中文，解释**为什么**而不是**是什么**
- 提交信息用 conventional commits 前缀
