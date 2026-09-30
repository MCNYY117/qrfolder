[English](README.md) · **中文**

---

<div align="center">

# QRFolder

**Turn a folder into a scannable file site — by NYY**

*零依赖的文件站点系统：把服务器上的目录变成可浏览、可管理、带密码的文件站点*

[![CI](https://github.com/MCNYY117/qrfolder/actions/workflows/ci.yml/badge.svg)](https://github.com/MCNYY117/qrfolder/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[功能特性](#-功能特性) · [快速开始](#-快速开始) · [配置](#-配置) · [后台](#-后台) · [HTTPS](#-反向代理与-https) · [安全](#-安全须知必读) · [文档](#-文档) · [常见问题](#-常见问题)

</div>

---

## 它解决什么问题

你有一堆产品手册、图纸、资料放在服务器上，想让客户通过浏览器直接翻看和下载。用 nginx 的 `autoindex` 太丑、没法管；用网盘又要上传一遍；自己写一个又得处理 Range 请求、中文文件名、路径穿越这些琐碎但要命的事。

QRFolder 就是干这个的：**把一个目录映射成一个网址**，列表页外观干净、可自定义，后台点几下就能改配置，改完立即生效不用重启。

### 和其他方案的区别

| | QRFolder | nginx `autoindex` | Caddy `file_server` | 网盘 |
|---|---|---|---|---|
| 运行时依赖 | **0** | nginx 本体 | caddy 本体 | 大量 |
| 页面外观可定制 | ✅ 后台可改 | ❌ 硬编码 | ⚠️ 要写 Go 模板 | ✅ |
| 改配置需要重启 | ❌ 即时生效 | 需要 reload | 需要 reload | — |
| 页面含第三方标识 | **无** | nginx 页脚 | Caddy logo 页脚 | 有 |
| 只读暴露（无法写入） | ✅ | ✅ | ✅ | ❌ 需权限模型 |
| 默认文档不覆盖列表 | ✅ 架构保证 | 需配 `index` 空值 | 需 `index` 技巧 | 不适用 |

---

## 功能特性

### 内容面

- **强制显示目录列表** —— 目录里就算有 `index.html` 也照样列文件，不是靠配置压制，而是代码里根本没有"默认文档"这个概念
- **不做根目录总览** —— 根路径只显示欢迎信息、不列任何目录，别人猜不到你有哪些目录；也可设为直接返回 404
- **Range 分段传输** —— PDF 翻页、视频拖进度条都正常
- **中文文件名** —— 按 RFC 5987 双写 `Content-Disposition`，下载不乱码
- **明亮 / 黑暗模式** —— 默认跟随系统，访客也可以自己点按钮切换（就放在语言切换边上），选择记在 cookie 里，前后台一致
- **筛选框与排序** —— 按名称/大小/时间排序，纯前端筛选
- **响应式** —— 窄屏自动收起次要列

### 后台

- **多管理员** —— 一个**超级管理员** + 任意多个**子管理员**，用户名 + 密码登录。超级管理员看全部目录与全部系统设置；子管理员只看得到自己创建的、或被分配给他的目录，以及逐项勾选的功能（13 项权限分 5 组）
- **目录边界只有两级** —— 系统设置里的「允许的父级目录」是全局唯一的边界，子管理员从池子里被勾选几个作为自己的活动范围。**浏览、扫描、建目录都止于此，超级管理员也不例外**。新建目录时选一个父目录 + 填一个目录名即可，**文件夹不存在的话服务器会替你建出来**（授权父目录时同理）
- **目录管理** —— 增删改，支持「扫描导入」勾选批量发布已存在的文件夹，带服务端目录浏览器。删除在编辑弹窗的「危险操作」区，分两种：**取消发布**（只删配置，磁盘不动）和**删除内容**（连文件夹一起删，超管专属、要手打目录名确认）
- **二维码** —— 每个目录一键生成访问二维码，可下载 SVG / PNG。地址取「系统设置 → 对外访问地址」，填域名或 IP 和端口即可；编码器本项目自己实现，没有引入任何依赖
- **文件管理** —— 在选定目录中浏览并**上传文件**，支持拖放、多选、子目录；可关闭
- **主界面可自定义** —— 根路径落地页的标题、正文、图片、底部提示语全部可改，**每一项都分中英两份**，按访客语言各取各的；图片可填站内路径或外链，外链会被自动加进该页的 CSP。页面刻意不提供任何链接：二维码是印在线下物料上的，不在网上发放
- **访问控制** —— 整站密码、每个目录独立密码、IP 白名单、登录限流、会话有效期与 IP 绑定
- **外观设置** —— 产品名（一处改名，后台抬头与登录页统一跟着变）、标题、主题色、显示哪些列、页脚文字，带实时预览
- **系统设置** —— 端口、后台路径、反向代理、上传开关与体积上限、日志、配置导入导出
- **访问日志** —— 内存环形缓冲，可按状态码和路径过滤，可导出 CSV

### 工程面

- **零运行时依赖** —— 部署就是拷贝源码，没有 `npm install`，没有 `node_modules`，没有供应链风险
- **TypeScript 且有类型检查** —— 靠 Node 原生的类型擦除直接跑 `.ts`，无需构建步骤；`tsc --noEmit` 保证类型安全
- **中英双语** —— 界面可切换，词条漏翻会被编译器拦下
- **配置热重载** —— 改配置文件或通过后台改，都立即生效（监听地址除外）

---

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 22.18**（需要原生 TypeScript 类型擦除支持） |
| 操作系统 | Windows / Linux / macOS |
| 开发时 | `npm install` 装 `typescript` 与 `@types/node`（**仅类型检查用，运行时不需要**） |

> 为什么必须 22.18+：QRFolder 直接用 `node src/main.ts` 运行，依赖 Node 内置的类型擦除。低版本会报 `ERR_UNKNOWN_FILE_EXTENSION`。

---

## 快速开始

**开箱即用，不需要先写任何配置文件。** 拿到代码直接启动，剩下的全在浏览器里点：

```bash
# 1. 获取代码
git clone <repo-url> qrfolder
cd qrfolder

# 2. 启动（不需要 npm install —— 本项目零运行时依赖）
node src/main.ts
```

```
[2026-09-23T12:00:44.891Z] INFO  已生成会话密钥并写入 D:\...\config\config.json
[2026-09-23T12:00:44.891Z] INFO  配置文件不存在，已使用默认配置（未落盘）：D:\...\config\config.json
[2026-09-30T09:15:02.117Z] INFO  QRFolder v1.0.0 已启动
[2026-09-23T12:00:44.901Z] INFO  监听      http://127.0.0.1:8080
[2026-09-23T12:00:44.902Z] INFO  已启用目录 0 个
```

**3. 打开 <http://127.0.0.1:8080/admin>**，按提示走完首次配置：

| 步骤 | 在哪一页 | 做什么 |
|---|---|---|
| ① | 首次访问 | **建超级管理员账号**：用户名（默认 `admin`）加密码。首次设置只允许从服务器本机完成，防止公网抢注 |
| ② | 目录管理 | 添加要对外发布的目录：填一个名字 + 服务器上的路径 |
| ③ | 系统设置 → 对外访问地址 | 填域名或 `IP:端口` —— 二维码要靠它拼出绝对地址 |
| ④ | 外观设置 | 改产品名、标题、主题色、落地页文案（中英文各一份） |
| ⑤ | 访问控制 | 按需开启整站密码、目录密码、后台 IP 白名单 |
| ⑥ | 域名与证书 | 有域名的话填上，自动申请并续签 HTTPS 证书 |
| ⑦ | 管理员 | 需要多人分工时，建子管理员并逐项勾选权限 |

第 ② 步做完之前站点是空的（"已启用目录 0 个"），这是**刻意的**：初始配置不指向任何目录，避免误开一个你还没准备好的目录。

> **不需要 `npm install` 就能跑。** 依赖只有 `typescript` 和 `@types/node`，仅用于 `npx tsc --noEmit` 类型检查。想跑类型检查时才执行 `npm install`。

常用命令：

```bash
node src/main.ts                    # 启动
node src/main.ts --port 9000        # 临时换端口（不写回配置）
node src/main.ts --config other.json
node src/main.ts --check            # 只校验配置并退出
node --test                         # 跑测试
npx tsc --noEmit                    # 类型检查
```

### Windows 一键启动

`node src/main.ts` 是**前台**运行：它会占着你当前的命令行窗口，窗口关掉服务就没了。不想让窗口一直挂着的话，双击项目根目录里的这两个文件即可：

| 文件 | 作用 |
|---|---|
| **`start.bat`** | 启动。服务在后台无窗口运行，脚本自己立刻退出，不留任何窗口 |
| **`stop.bat`** | 停止 |

也可以在命令行里调用同一个脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 stop
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status    # PID、端口、运行时长
```

启动器把 PID 记在 `logs\qrfolder.pid`，停止时先核对「进程名是 node 且命令行含 main.ts」再动手，不会误杀别的 Node 进程；对**手动** `node src/main.ts` 起的实例也能识别（按端口反查）。

---

## 配置

完整示例见 [`config/config.example.json`](config/config.example.json)。

### 生效方式

| 配置块 | 生效方式 |
|---|---|
| `directories`、`appearance`、`access`、`logLevel`、`adminPath`、`trustProxy` | **热生效**，改完立即起作用 |
| `system.host`、`system.port` | **需重启**（监听套接字无法热改），后台会显示"待重启"提示 |
| `system.sessionSecret` | **需重启**，等价于让所有人登出 |

> 配置文件被改坏时（JSON 语法错误或字段非法），服务会**保留上一份有效配置并继续运行**，绝不会降级成默认值 —— 否则一次手滑就可能把整站从"需密码"变成"公开"。问题会在后台顶部以红条提示。

### 目录配置

每个目录项把一段 URL 路径映射到一个磁盘路径：

```json
{
  "name": "ExampleCorp",              // 访客访问 /ExampleCorp/
  "path": "/srv/documents/ExampleCorp",
  "label": "",                        // 页面大标题，留空用 name
  "enabled": true,
  "access": "inherit",                // inherit | public | password
  "password": null,                   // access=password 时填 scrypt 记录
  "allowedCidrs": [],                 // 该目录专属 IP 白名单
  "followSymlinks": false,
  "sort": "",                         // 留空跟随外观设置
  "hideDotfiles": null,               // null 跟随全局
  "note": "",
  "owner": ""                         // 归属的管理员账号 id，空串 = 超级管理员
}
```

管理员账号在 `access.admins` 里（一般是后台建，不用手写）：

```json
{
  "id": "a1b2c3d4",
  "username": "alice",
  "role": "sub",                      // super | sub，超级管理员只能有一个
  "password": { "...": "..." },       // scrypt 记录，和目录密码同一种形状
  "permissions": ["dirs.view", "files.view"],   // 仅 sub 生效，13 项可勾
  "roots": ["/srv/documents"],        // 仅 sub 生效，必须是 system.parentRoots 的子目录
  "enabled": true,
  "note": ""
}
```

**新增目录不用改配置**：把文件夹放进内容根目录，在后台点「扫描导入」即可。

---

## 后台

访问 `http://<你的地址>/admin`。

| 页面 | 能做什么 |
|---|---|
| **概览** | 运行状态、请求统计、最近访问、当前登录身份与自己的权限。运维快捷操作（重载配置、清空日志、轮换会话密钥）**只有超级管理员看得到** |
| **管理员** | 新建/编辑/删除子管理员，逐项勾选权限、分配授权父目录、重置密码。**只有超级管理员能打开** |
| **目录管理** | 增删改目录、扫描导入、逐目录设置密码与 IP 白名单、**生成并下载该目录的二维码**。超级管理员多一个「归属管理员」下拉框 |
| **文件管理** | 浏览目录内容、上传文件（拖放或多选）。上传默认开启，可在系统设置中关闭 |
| **访问控制** | 整站密码、**超级管理员自己的密码**、后台 IP 白名单（含当前 IP 提示与测试工具）、登录限流、**登录有效期与 IP 绑定**、敏感文件规则。**只有超级管理员能打开** |
| **系统设置** | 监听地址端口、**对外访问地址（二维码里用的域名或 IP 和端口）**、后台路径、反向代理信任设置、**上传开关、体积上限与覆盖策略**、日志、配置导入导出。子管理员只能看到并修改「对外访问地址」一张卡片 |
| **域名与证书** | 填域名与邮箱，保存即生成 Caddyfile 并让 Caddy 热加载；显示**实际正在服用的证书**（颁发者、有效期、剩余天数）。证书由 Caddy 自动申请与续签。**只有超级管理员能打开** |
| **外观设置** | 标题、主题色、显示项、排序默认值、预览/下载扩展名、自定义 CSS，带 iframe 实时预览。没有「修改外观设置」权限的子管理员打开它是**只读**的 |
| **访问日志** | 按状态码/路径过滤，自动刷新，导出 CSV。子管理员只看到自己名下目录的记录 |

侧边栏**只显示你有权限打开的页面** —— 没有的页面连入口都不出现，直接输网址也是 404。

### 多管理员是怎么回事

- **超级管理员有且只有一个。** 它是升级时老的管理员密码自动迁移过来的那个账号（用户名 `admin`，密码不变）。丢了密码的恢复办法：在服务器本机上打开后台，会重新看到首次设置页
- **子管理员按「能力 + 范围」两个维度授权。** 能力是 13 项逐项勾选的权限；范围是目录归属（每个目录有一个「归属管理员」）和授权父目录（从系统设置那个池子里勾）
- **授权即承诺。** 给子管理员勾一个还不存在的父目录、或者往池子里加一个还不存在的路径，服务器会当场把文件夹建出来；建不出来（上一级不存在、没权限、写成了相对路径）就拦住这次保存。所以不会出现「配置里授权了、磁盘上却没有」这种只有别人用的时候才暴露的状态
- **「允许的父级目录」是硬边界。** 池子外面的文件夹不能直接发布，要先加进池子；超级管理员也一样。唯一的例外是**路径没改动**的老目录 —— 池子收紧之前安排的位置仍然可以改标题、改排序，但不能改到池子外面去
- **容器本身不发布。** 一个位置要么是「允许的父级目录」（放东西的容器），要么是「一个对外发布的内容目录」，不能兼着 —— 池子里的路径、子管理员的工作区，本身都不出现在扫描候选里，提交也会被拒。子文件夹不受影响，那才是常规用法
- **权限改动立刻生效，不需要重新登录。** 会话票据里只存账号 id，每次请求从配置里现查权限 —— 撤销权限、停用账号、删掉账号，下一跳就生效
- **账号管理、访问控制、系统设置全局项、配置导入导出、域名证书、轮换密钥** 这些**不是勾选项**，写死为超级管理员专属。原因都在 `docs/security.zh-CN.md` 第 4 节
- **一个目录只能归一个管理员**，不支持多人共管

### 改后台路径

默认是 `/admin`。改成一个不容易猜的路径（如 `/manage-8f3a`）能显著减少扫描器噪音 —— 扫描器会不断请求 `/admin`，这些请求会出现在日志里。

---

## 反向代理与 HTTPS

QRFolder 本身只监听 `127.0.0.1`，由反向代理对外提供 HTTPS。这样证书的申请与续期交给成熟工具，QRFolder 保持零依赖。

### Caddy（推荐，自动证书）

**推荐做法：不用手写配置。** 在后台的「域名与证书」页填上域名和邮箱，保存时 QRFolder 会生成
Caddyfile 并让 Caddy 热加载；证书的申请、续签、HTTP→HTTPS 跳转都由 Caddy 完成，
页面上能直接看到正在服用的那张证书。

想自己写的话，站点块长这样：

```
files.example.com {
    reverse_proxy 127.0.0.1:8080
    header -Server
}
```

两个容易写错的地方：

- **要删的是 `Server` 头，写法是站点级的 `header -Server`。** Caddy 会给自己产生的响应
  （重定向、错误页）加上 `Server: Caddy`。注意 `header_down` **不是**站点级指令 ——
  它只在 `reverse_proxy` 块内合法，写在站点块里 Caddy 会直接以
  `unrecognized directive: header_down` 拒绝加载。
- **不需要手写 `header_up X-Forwarded-For`。** Caddy 的默认行为已经是
  **替换**而不是追加（实测带 `X-Forwarded-For: 1.2.3.4` 请求，上游收到的是真实来源 IP），
  `X-Forwarded-Proto` 也是默认就设好的。写上它只会换回一条「Unnecessary header_up」警告。

然后在 QRFolder 后台的「系统设置 → 反向代理」里：

1. 打开「信任 X-Forwarded-* 头」
2. 把 `127.0.0.1/32` 和 `::1/128` 留在「可信代理地址」里

> 不开这个开关的话，QRFolder 看到的来源 IP 全是 `127.0.0.1`，IP 白名单和登录限流会退化成"全局开关"。

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    server_tokens off;                     # 隐藏 nginx 版本
    more_clear_headers Server;             # 需要 headers-more 模块

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;               # 大文件下载不要缓冲
    }
}
```

---

## 安全须知（必读）

暴露到公网前请逐项确认：

- [ ] **改了超级管理员的密码**，且不是弱口令
- [ ] **如果建了子管理员，每人给一个独立账号** —— 不要共用一个，否则日志里分不清是谁做的
- [ ] **考虑改掉后台路径**（`/admin` → 一个难猜的路径）
- [ ] **配置了后台 IP 白名单**，或者至少确认后台密码足够强
- [ ] **验证响应头没有 `Server`**：`curl -sI https://你的域名/不存在的路径 | grep -i server` 应当无输出
- [ ] **确认内容目录不含敏感文件** —— QRFolder 默认屏蔽 `.env`、`.key`、`.pem`、`.sql` 等，但你的目录里可能还有别的
- [ ] **确认没有把项目目录或盘符根配成内容目录** —— 校验器会拦，但值得自己确认一遍
- [ ] **反向代理侧已删掉 `Server` 头** —— Caddy 用站点级的 `header -Server`（**不是** `header_down`），
      三处都要写：站点块、`handle_errors`、`:80` 块。详见 [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md)

### 内置的防护

| 威胁 | 应对 |
|---|---|
| 路径穿越（`..`、`%2f`、`%5c`、NUL、盘符、UNC、保留设备名、符号链接逃逸） | 五层校验，见 [docs/security.zh-CN.md](docs/security.zh-CN.md) |
| 内容目录里的 HTML/SVG 在你自己源上执行脚本 | 强制降级为下载 + `nosniff` |
| 并发登录打爆内存（单次 scrypt 占 16MiB） | 哈希并发闸门 |
| 密码爆破 | 按 IP 失败计数 + 指数退避锁定 |
| 后台被 iframe 嵌套点击劫持 | CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY` |
| 配置值注入 XSS | 颜色等值经白名单校验后才拼进 `<style>` |
| 子管理员越权访问别人的目录 | 路由表 fail-closed + 内容面按归属拦截，越权一律 404 |
| 回滚到旧版本把子管理员悄悄提升成超级管理员 | 令牌版本号 v1 → v2，旧代码对新票据一律拒绝 |
| 搜索引擎收录 | `robots.txt` + `<meta name="robots" content="noindex">` |

---

## 常见问题

<details>
<summary><b>中文文件名下载后变成乱码或叫 download？</b></summary>

QRFolder 按 RFC 5987 同时写了 `filename=` 和 `filename*=UTF-8''` 两个字段。如果仍然乱码，多半是中间的代理或 CDN 改写了 `Content-Disposition`。用 `curl -sI` 看一下实际发出的响应头。

</details>

<details>
<summary><b>GBK 编码的 .txt 打开是乱码</b></summary>

Node 只认 UTF-8。这是已知限制，建议把文本文件转成 UTF-8。同目录的 PDF、Office 文档不受影响。

</details>

<details>
<summary><b>视频拖进度条不生效</b></summary>

检查反向代理是否做了缓冲。nginx 需要 `proxy_buffering off;`；Caddy 默认不缓冲，无需配置。用 `curl -sI -H "Range: bytes=0-99" <文件地址>` 应返回 `206`。

</details>

<details>
<summary><b>改了配置没反应</b></summary>

1. 先看后台顶部有没有红色提示条（配置校验未通过时会保留旧配置）
2. 如果改的是 `host` / `port`，需要重启
3. 用 `node src/main.ts --check` 单独校验配置文件

</details>

<details>
<summary><b>端口被占用</b></summary>

```
Error: listen EADDRINUSE
```

用 `node src/main.ts --port 9000` 临时换端口，或找出占用者：

- Linux/macOS：`lsof -i :8080`
- Windows：`netstat -ano | findstr :8080`

</details>

<details>
<summary><b>Windows 上防火墙挡住了</b></summary>

只监听 `127.0.0.1` 时无需放行。若要让反向代理从另一台机器访问，才需要放行端口：

```powershell
New-NetFirewallRule -DisplayName "QRFolder" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

</details>

---

## 项目结构

```
qrfolder/
├── src/
│   ├── main.ts              入口：参数解析、启动、优雅退出
│   ├── config/              配置的类型定义、校验、读写、热重载
│   ├── http/                服务器、请求解析、响应下发、安全响应头
│   ├── serving/             路径防护、目录扫描、MIME、文件传输
│   ├── views/               列表页、错误页、后台各页面
│   ├── admin/               认证、会话、CSRF、账号、权限策略、后台路由
│   ├── access/              CIDR 匹配、登录限流、内容面目录闸门
│   ├── logging/             环形缓冲、访问日志、应用日志
│   └── i18n/                中英词条
├── test/                    测试（node:test，含两个起真实服务进程的集成套件）
├── scripts/service.ps1      Windows 启动器（可选，同时管 Caddy）
├── config/                  配置与示例
└── docs/                    专题文档，见下
```

---

## 文档

| 文档 | 给谁看 | 内容 |
|---|---|---|
| [docs/features.zh-CN.md](docs/features.zh-CN.md) | **不写代码的人** —— 客户、老板 | 通俗版功能说明：这东西是什么、能干什么、能改到什么程度 |
| [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md) | 甲方 / 客户 | 需求书：把上面的能力写成可逐条对照验收的需求条目，含验收清单与明确不做的事 |
| [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md) · [EN](docs/deployment.md) | 运维 | 从零部署：Node 安装、反向代理、HTTPS、开机自启、性能与故障排查 |
| [docs/security.zh-CN.md](docs/security.zh-CN.md) · [EN](docs/security.md) | 要审安全的人 | 威胁模型、防住了什么、**没防什么**（同样重要）、自查清单 |
| [SECURITY.md](SECURITY.md) | 安全研究者 | 漏洞上报渠道与范围界定 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 想改代码的人 | 两条硬规矩（零依赖、必须能过类型擦除）与提交流程 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 所有参与者 | issue、PR 以及别处的行为准则 |

---

## 开发

### 为什么零依赖

这个项目会长期无人值守地跑在公网上。零依赖意味着：没有 `npm install` 会失败、没有依赖升级导致的破坏性变更、没有供应链投毒面、部署就是拷贝文件夹。

代价是表单解析、会话签名、scrypt 密码、Range 传输、MIME 表、环形缓冲、i18n 全部要手写。这是有意识的取舍。

### 类型擦除的四个限制

Node 直接执行 `.ts` 时只做类型擦除、不做代码生成，因此**不能使用**：

- `enum`（改用 `const X = [...] as const` + `type T = typeof X[number]`）
- `namespace`
- 构造函数参数属性（`constructor(private x: number)`）
- `import x = require('y')`

`tsconfig.json` 里的 `erasableSyntaxOnly: true` 会让 `tsc` 提前拦下这些写法，否则要到运行时才崩。

另外：**相对导入必须带 `.ts` 后缀**，且不能用 `paths` 别名（Node 不认）。

### 加一条词条

1. 在 `src/i18n/zh-CN.ts` 加键（这是权威来源）
2. 在 `src/i18n/en-US.ts` 加对应英文
3. 漏翻的话 `npx tsc --noEmit` 会直接报错

### 跑测试

```bash
npm run check     # tsc --noEmit
npm test          # node --test，无测试框架依赖
node --test test/safePath.test.ts    # 单跑一个文件
```

改过 `src/serving/`、`src/config/validate.ts` 或 `src/admin/` 之后请务必跑全量 ——
回归往往只在集成测试里现形。

### 参与开发

动手之前请读 [`CONTRIBUTING.md`](CONTRIBUTING.md)：里面有两条硬规矩
（零运行时依赖、必须能过类型擦除）。发现安全问题请走
[`SECURITY.md`](SECURITY.md) 里的私下渠道，不要开公开 issue。

---

## 从其他方案迁移

### 从 Caddy `file_server` 迁移

1. QRFolder 先跑在另一个端口（如 8081），与现有 Caddy 并列
2. 用同一批 URL 对拍两边，确认状态码与响应头一致
3. 确认无误后，把 Caddy 配置改成反向代理指向 QRFolder
4. Caddy 保留，只负责 TLS

### 从 nginx `autoindex` 迁移

1. 把 `root` 指向的目录配成 QRFolder 的一个目录项
2. 注意 nginx 的 `autoindex` 不隐藏 `.env` 之类的文件，QRFolder 默认会隐藏

---

## 许可

[MIT](LICENSE)
