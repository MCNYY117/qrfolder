[English](deployment.md) · **中文**

# 部署

## 部署形态

QRFolder 典型的生产部署是两段式：

```
浏览器 ──HTTPS──> Caddy / nginx（TLS 终结 + 反代）
                     │ 127.0.0.1:8080
                     ▼
                  QRFolder（Node，只监听回环）
```

这样分层的理由：证书的申请与续期交给成熟工具（Caddy 全自动，nginx + certbot 半自动），
而 QRFolder 保持零依赖、不碰系统、不需要 root 权限。

**QRFolder 本身只监听 `127.0.0.1`，不直接对外。**

---

## 1. 准备

```bash
git clone <repo-url> /opt/qrfolder
cd /opt/qrfolder
```

**就这些。不需要建配置文件，也不需要 `npm install`** —— 项目零运行时依赖，直接 `node`
就能跑。`config/config.json` 会在首次启动时自动生成（里面只有自动生成的会话密钥和一份默认值）。

目录、密码、域名这些**全部在后台里配**，见下面的「1.5 首次配置」。

> 想手工维护配置文件也可以：把 `config/config.example.json` 复制成 `config/config.json` 再改。
> 两种方式等价，后台改动会写回同一个文件。**注意这个文件里存着管理员密码哈希与会话密钥，
> 不要提交进版本库**（`.gitignore` 已经排除了它）。

---

## 1.5 首次配置（在浏览器里）

启动后打开 <http://127.0.0.1:8080/admin>：

| 顺序 | 页面 | 做什么 |
|---|---|---|
| ① | 首次访问 | 建**超级管理员**账号：用户名（默认 `admin`）+ 密码。**首次设置只接受来自 `127.0.0.1` 的请求**，这是刻意的：防止服务刚上线就被人抢注管理员 |
| ② | 目录管理 | 添加要发布的目录。`name` 是 URL 前缀（访客通过 `/ExampleCorp/` 访问），`path` 是磁盘上的绝对路径 |
| ③ | 系统设置 → 对外访问地址 | 填域名或 `IP:端口`，二维码靠它拼绝对地址 |
| ④ | 访问控制 / 外观设置 | 按需开密码、改文案与配色 |
| ⑤ | 域名与证书 | 有域名就填，自动申请并续签证书 |
| ⑥ | 管理员 | 需要多人分工时，建子管理员并逐项勾选权限、划定能用的服务器目录 |

> `path` 指向的目录不存在也不会导致启动失败，后台会把它标为「不可用」并显示原因。
> 这允许你先配路径、后建目录。

> **首次配置为什么必须在服务器本机做？** 因为此刻还没有超级管理员账号。如果允许从公网完成
> 首次设置，任何先扫到你 IP 的人都能把这个实例抢走。配好之后就不再有这个限制了。
> 服务器没有图形界面时，用 SSH 端口转发：`ssh -L 8080:127.0.0.1:8080 user@server`，
> 然后在自己电脑上打开 `http://127.0.0.1:8080/admin`。

---

## 2. 启动

### 手动启动（默认）

```bash
node src/main.ts
```

首次启动会自动生成会话密钥并写回配置文件。

这是**前台**运行 —— 它占着当前命令行窗口，窗口一关服务就停。

### Windows 一键启动（推荐给长期运行的机器）

双击项目根目录的 `start.bat` / `stop.bat`，或：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 stop
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status
```

服务以**无窗口**方式在后台运行，启动脚本立刻退出，不会留下挂着的命令行窗口。
PID 记在 `logs\qrfolder.pid`；停止前会核对进程身份，不会误杀其它 Node 进程。

### 先校验配置

```bash
node src/main.ts --check
```

输出示例：

```
配置有效：/opt/qrfolder/config/config.json
  目录数量：3
```

有问题时会逐条列出，退出码非 0。

### 临时改端口

```bash
node src/main.ts --port 9000
```

**不会**写回配置文件 —— 适合临时排查端口占用。

---

## 3. 可选：开机自启

> QRFolder 默认按手动启动设计。如果你的服务器会重启，或者希望它常驻，再按下面配置。

### Linux（systemd）

`/etc/systemd/system/qrfolder.service`：

```ini
[Unit]
Description=qrfolder
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/qrfolder
ExecStart=/usr/bin/node /opt/qrfolder/src/main.ts
Restart=on-failure
RestartSec=5

# 加固：只读文件系统 + 私有临时目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/qrfolder/config /opt/qrfolder/logs

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qrfolder
sudo systemctl status qrfolder
journalctl -u qrfolder -f          # 看日志
```

> `ReadWritePaths` 只需包含 `config`（写配置）和 `logs`（若开了落盘）。**内容目录应当只读**。

### Windows（计划任务）

以管理员身份运行：

```powershell
$action  = New-ScheduledTaskAction -Execute 'node.exe' `
           -Argument 'src/main.ts' -WorkingDirectory 'D:\qrfolder'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'qrfolder' -Action $action `
  -Trigger $trigger -Settings $settings -RunLevel Highest
```

卸载：

```powershell
Unregister-ScheduledTask -TaskName 'qrfolder' -Confirm:$false
```

---

## 4. 反向代理

### Caddy（推荐）

> **后台的「域名与证书」页会自动生成下面这份配置**（并让 Caddy 热加载），
> 这一段是给你理解它在做什么、以及手动配置时照抄用的。

```
{
	email you@example.com
	admin 127.0.0.1:2019
	auto_https disable_redirects
}

files.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8080

	header -Server
	header -X-Powered-By

	handle_errors {
		header -Server
		header -X-Powered-By
		header Content-Type "text/html; charset=utf-8"
		respond "..." {http.error.status_code}
	}
}

:80 {
	header -Server
	header -X-Powered-By
	redir https://{host}{uri} permanent
}
```

Caddy 会自动申请并续期 Let's Encrypt 证书，无需额外操作。

**踩过的两个坑，照抄上面的写法就能避开：**

1. **用站点级的 `header -Server`，不是 `header_down -Server`。**
   `header_down` 只在 `reverse_proxy` 块**内部**合法；而实测下来，代理到上游的响应
   本身并不带 `Server`（Node 不发），真正需要删的是 **Caddy 自己**产生的那一份 ——
   错误页、重定向、静态响应，那些属于站点级 `header`。
   要删的地方有**三处**：站点块、`handle_errors`、以及显式的 `:80` 块，少一处就在对应路径上漏出来。

2. **必须写 `auto_https disable_redirects` 并显式声明 `:80` 块。**
   否则 HTTP→HTTPS 跳转是 Caddy 内部注入的，那上面的 `Server: Caddy` 你无从删除。

验证（三条路径都要试，错误页和 80 端口是最容易漏的）：

```bash
for u in https://files.example.com/ https://files.example.com/不存在的路径 http://files.example.com/; do
  echo "== $u"; curl -sI "$u" | grep -i '^server:' || echo "   无 Server 头 ✅"
done
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    server_tokens off;
    more_clear_headers Server;          # 需要 headers-more-nginx-module

    client_max_body_size 0;             # 不需要上传，但避免误拦

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;            # 大文件下载/视频拖动不要缓冲
        proxy_request_buffering off;
    }
}

server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}
```

### 更省事的做法：让后台去配

上面的 Caddyfile 可以完全不手写。在 QRFolder 后台的 **「域名与证书」** 页：

1. 填域名（如 `files.example.com`）和 ACME 邮箱
2. 首次建议先打开「使用测试环境」，验证 80/443 通了再关掉
3. 点「保存并应用」—— QRFolder 会生成 Caddyfile、写入配置文件旁边、并让 Caddy 热加载
4. 点「检查证书」连本机 443 取回**实际正在服用的那张证书**，确认颁发者与剩余天数

页面上会一并处理好两件容易被忘掉的事：把「对外访问地址」同步成 `https://<主域名>`
（二维码要用），以及打开「信任 X-Forwarded-* 头」（不然来源 IP 与 HTTPS 判断都会失效）。

> 前提：Caddy 必须以**开着管理接口**的方式启动。用本项目的 `start.bat` 启动即可 ——
> 它会读 `system.tls` 配置，在需要时一并把 Caddy 拉起来（无窗口）。
> 旧的 `C:\caddy\caddy.json` 里写着 `"admin": {"disabled": true}`，那份配置下
> 后台改不动 Caddy，已被本项目生成的 Caddyfile 取代。

### 代理之后必须做的事

在 QRFolder 后台的 **系统设置 → 反向代理**：

1. 勾选「信任 X-Forwarded-* 头」
2. 确认「可信代理地址」包含 `127.0.0.1/32` 与 `::1/128`

> **不开这个开关的话**，QRFolder 看到的来源 IP 全是 `127.0.0.1` ——
> IP 白名单和登录限流会退化成"全局开关"（要么全放行、要么全拦截）。

开启后到「访问日志」页确认一下记录的 IP 是真实客户端 IP，而不是 `127.0.0.1`。

### 顺手把「对外访问地址」填上

在 **系统设置 → 对外访问地址** 里填 `https://你的域名`（或 `http://公网IP:端口`）。

这个值只用于生成二维码：二维码必须编码**绝对地址**，而后台往往是从
`127.0.0.1:8080` 打开的，服务端无从知道你对外用的是哪个域名。留空也能生成，
但二维码会指向你当时访问后台用的那个地址 —— 只有在「正好用公网域名访问后台」
时才是对的。填一次，之后每个目录的二维码都是对的。

---

## 5. 防火墙

若反向代理与 QRFolder 在同一台机器，**不需要对外开放 8080** —— 它只监听回环。

只需放行代理的端口：

```bash
# Linux (ufw)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

```powershell
# Windows
New-NetFirewallRule -DisplayName "HTTPS" -Direction Inbound -LocalPort 443 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "HTTP"  -Direction Inbound -LocalPort 80  -Protocol TCP -Action Allow
```

若反向代理在另一台机器，才需要放行 QRFolder 的端口，并**同时改配置**：

```json
{ "system": { "host": "0.0.0.0", "trustProxy": true } }
```

> ⚠️ 监听 `0.0.0.0` 意味着局域网内任何人都能直连并绕过代理。
> 如果代理在同一台机器，**保持 `127.0.0.1`**。

---

## 6. 部署后自检

逐项跑一遍：

```bash
BASE=https://files.example.com

# 1. 目录列表正常
curl -sI $BASE/ExampleCorp/ | head -1
# 期望：HTTP/2 200

# 2. 不存在的路径返回 404，且不泄露 Server 头
curl -sI $BASE/nope | grep -i server
# 期望：无输出

# 3. 错误页是 HTML 而不是纯文本
curl -sI $BASE/nope | grep -i content-type
# 期望：content-type: text/html; charset=utf-8

# 4. 根路径不列目录
curl -s $BASE/ | grep -c "文件夹\|folders"
# 期望：0

# 5. index.html 不覆盖列表（若目录里有 index.html）
curl -s $BASE/ExampleCorp/ | grep -c 'class="label"'
# 期望：大于 0

# 6. Range 分段可用
curl -sI -H "Range: bytes=0-99" $BASE/ExampleCorp/some.pdf | head -1
# 期望：HTTP/2 206

# 7. 来源 IP 是真实的（不是在日志页看，而是直接看）
#    登录后台 → 访问日志，确认 IP 列不是 127.0.0.1
```

---

## 7. 升级

```bash
cd /opt/qrfolder
git pull
node src/main.ts --check      # 先校验配置仍兼容
sudo systemctl restart qrfolder
```

配置结构有 `version` 字段，未来的不兼容变更会提供迁移说明。

> 升级前建议备份 `config/config.json` —— 它含管理员密码哈希与会话密钥。

---

## 8. 备份

需要备份的只有两样：

| 路径 | 内容 |
|---|---|
| `config/config.json` | 目录配置、管理员密码哈希、会话密钥 |
| `logs/` | 访问日志（若开启了落盘） |

内容目录本身按你自己的备份策略处理。

**`config.json` 应当当作机密文件对待** —— 它包含密码哈希和会话签名密钥。
权限建议 `chmod 600`。

---

## 9. 故障排查

### 启动即退出

```bash
node src/main.ts
```

看 stderr。常见原因：

| 输出 | 原因 |
|---|---|
| `端口 8080 已被占用` | 换端口，或找占用者：`lsof -i :8080` / `netstat -ano \| findstr :8080` |
| `没有权限绑定 ...` | 1024 以下端口需要特权，改用高位端口 |
| `配置解析失败` | JSON 语法错误，用 `--check` 看详情 |

### 后台改的配置没生效

1. 看后台顶部有没有红色提示条 —— 配置校验不通过时服务会保留旧配置
2. 检查改的是不是 `host` / `port` —— 这两个需要重启
3. `node src/main.ts --check` 单独校验

### 中文文件名下载乱码

中间有代理改写了 `Content-Disposition`。用 `curl -sI` 看实际发出的响应头，
确认 `filename*=UTF-8''` 部分还在。

### 视频拖进度条不动

代理做了缓冲。nginx 加 `proxy_buffering off;`。Caddy 默认不缓冲。

### 日志里全是 `/admin` 的 404

扫描器在扫。改掉 `system.adminPath`（如 `/manage-8f3a`）能显著减少噪音。

---

## 10. 从其他方案迁移

### 从 Caddy `file_server` 迁移

1. QRFolder 先跑在另一个端口（如 8081），与现有 Caddy 并列
2. 用同一批 URL 对拍两边，确认状态码与响应头一致
3. 确认无误后把 Caddy 改成反代：

```
files.example.com {
    reverse_proxy 127.0.0.1:8081
    header -Server
    header -X-Powered-By
}
```

4. 在 QRFolder 后台配好目录，逐步停用 Caddy 的文件服务

### 从 nginx `autoindex` 迁移

1. 把 `root` 指向的目录配成 QRFolder 的一个目录项
2. **注意**：nginx 的 `autoindex` 默认不隐藏 `.env`、`.git` 之类的文件，QRFolder 默认会隐藏
3. nginx 的 `index` 指令会让 `index.html` 覆盖列表，QRFolder 不需要任何配置就不会

---

## 11. 性能参考

QRFolder 是单线程 Node 进程。对"产品手册下载"这类场景绰绰有余，但要知道边界：

| 场景 | 表现 |
|---|---|
| 目录列表（百级条目） | 每次请求 `readdir` + 逐条 `stat`，并发上限 32。毫秒级 |
| 目录列表（千级条目） | 同上，但条目数上限默认 5000，超出会截断并在页面提示 |
| 大文件下载 | 流式传输，内存占用恒定；支持 Range |
| 大量并发下载 | 受 Node 单线程与代理配置限制。反向代理的 `sendfile` 会有帮助 |

需要更高吞吐时，可以在前面挂 CDN 缓存静态文件（注意 `Range` 与 `Content-Disposition` 的透传）。
