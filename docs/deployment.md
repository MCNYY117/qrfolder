**English** · [中文](deployment.zh-CN.md)

# Deployment

## Deployment shape

A typical production deployment of QRFolder has two tiers:

```
browser ──HTTPS──> Caddy / nginx (TLS termination + reverse proxy)
                     │ 127.0.0.1:8080
                     ▼
                  QRFolder (Node, loopback only)
```

The reasoning behind the split: certificate issuance and renewal go to mature tooling (fully automatic with Caddy, semi-automatic with nginx + certbot), while QRFolder stays zero-dependency, stays out of the system, and needs no root privileges.

**QRFolder itself listens only on `127.0.0.1` and is never exposed directly.**

---

## 1. Preparation

```bash
git clone <repo-url> /opt/qrfolder
cd /opt/qrfolder
```

**That's all.** No config file to create, and no `npm install` — the project has zero runtime
dependencies, so `node` runs it as-is. `config/config.json` is written automatically on first
start (it holds nothing but a generated session secret and a copy of the defaults).

Directories, passwords and domains are all configured **in the admin panel** — see §1.5 below.

> Prefer to maintain the config by hand? Copy `config/config.example.json` to
> `config/config.json` and edit it; the two approaches are equivalent and the admin panel writes
> back to the same file. **That file holds the admin password hashes and the session secret — never commit
> it** (`.gitignore` already excludes it).

---

## 1.5 First-run configuration (in the browser)

Once it's running, open <http://127.0.0.1:8080/admin>:

| Order | Page | What to do |
|---|---|---|
| ① | First visit | Create the **super admin** account: a username (default `admin`) and a password. **First-time setup only accepts requests from `127.0.0.1`**, deliberately: it stops someone claiming your instance the moment it goes online |
| ② | Directories | Add the directories to publish. `name` is the URL prefix (visitors reach it at `/ExampleCorp/`); `path` is the absolute path on disk |
| ③ | System settings → Public address | Enter the domain or `IP:port` — QR codes need it to build absolute URLs |
| ④ | Access control / Appearance | Turn on passwords, adjust copy and colours as needed |
| ⑤ | Domains & certs | If you have a domain, enter it; the certificate is obtained and renewed automatically |
| ⑥ | Admins | When work needs to be split, create sub admins, tick their permissions, and scope which server paths they may use |

> A `path` that doesn't exist yet will not stop the server from starting — the admin UI flags it as "unavailable" and shows why.
> That lets you configure paths first and create the directories later.

> **Why must the first-run setup happen on the server itself?** Because no super admin account
> exists yet. If it could be completed over the public internet, whoever reached your IP first
> would own the instance. Once it's set, the restriction is gone.
> On a headless server, forward the port over SSH:
> `ssh -L 8080:127.0.0.1:8080 user@server`, then open `http://127.0.0.1:8080/admin` locally.

---

## 2. Starting

### Manual start (the default)

```bash
node src/main.ts
```

On first start, a session secret is generated automatically and written back to the config file.

This runs in the **foreground** — it holds the console window open, and closing that window stops the service.

### One-click start on Windows (recommended for a machine that stays up)

Double-click `start.bat` / `stop.bat` in the project root, or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 stop
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status
```

The service runs in the background with **no console window** and the launcher exits immediately, so nothing is left hanging. The PID is recorded in `logs\qrfolder.pid`, and the process identity is re-checked before stopping so an unrelated Node process can't be killed by mistake.

### Validate the config first

```bash
node src/main.ts --check
```

Example output:

```
Config OK: /opt/qrfolder/config/config.json
  Directories: 3
```

Problems are listed one per line, and the exit code is non-zero.

### Change the port temporarily

```bash
node src/main.ts --port 9000
```

This does **not** write back to the config file — handy for tracking down a port conflict.

---

## 3. Optional: start on boot

> QRFolder is designed for manual startup by default. If your server reboots, or you want it to stay resident, configure one of the options below.

### Linux (systemd)

`/etc/systemd/system/qrfolder.service`:

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

# Hardening: read-only filesystem + private temp directory
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
journalctl -u qrfolder -f          # tail the logs
```

> `ReadWritePaths` only needs `config` (to write configuration) and `logs` (if file logging is enabled). **Content directories should be read-only.**

### Windows (scheduled task)

Run as administrator:

```powershell
$action  = New-ScheduledTaskAction -Execute 'node.exe' `
           -Argument 'src/main.ts' -WorkingDirectory 'D:\qrfolder'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'qrfolder' -Action $action `
  -Trigger $trigger -Settings $settings -RunLevel Highest
```

To uninstall:

```powershell
Unregister-ScheduledTask -TaskName 'qrfolder' -Confirm:$false
```

---

## 4. Reverse proxy

### Caddy (recommended)

> **The admin panel's "Domains & certs" page generates exactly this config for
> you** (and hot-loads it into Caddy). The block below is here so you can see
> what it does, and copy it if you are wiring Caddy up by hand.

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

Caddy requests and renews Let's Encrypt certificates automatically; nothing else to do.

**Two traps this layout avoids — both found by testing against a real Caddy
(v2.11.4), not by reading the docs:**

1. **Use a site-level `header -Server`, not `header_down -Server`.**
   `header_down` is only valid *inside* a `reverse_proxy` block. And as it turns
   out, the proxied response never carried a `Server` header in the first place
   (Node doesn't send one) — what actually needs removing is **Caddy's own**
   header on responses it generates itself: error pages, redirects, static
   replies. Those are covered by the site-level `header`.
   There are **three** places to do it — the site block, `handle_errors`, and the
   explicit `:80` block. Miss one and it leaks on that path.

2. **`auto_https disable_redirects` plus an explicit `:80` block is required.**
   Otherwise the HTTP→HTTPS redirect is injected internally by Caddy and its
   `Server: Caddy` header cannot be removed at all.

Verify — check all three paths; error pages and port 80 are the easy ones to miss:

```bash
for u in https://files.example.com/ https://files.example.com/nonexistent-path http://files.example.com/; do
  echo "== $u"; curl -sI "$u" | grep -i '^server:' || echo "   no Server header ✅"
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
    more_clear_headers Server;          # requires headers-more-nginx-module

    client_max_body_size 0;             # no uploads here, but avoids accidental blocks

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;            # don't buffer large downloads or video seeking
        proxy_request_buffering off;
    }
}

server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}
```

### The easier path: let the admin panel do it

You can skip writing that Caddyfile entirely. On the admin panel's **"Domains & certs"** page:

1. Enter the domain (e.g. `files.example.com`) and an ACME email
2. For a first run, turn on "Use the staging environment"; once 80/443 are confirmed working, turn it off
3. Hit **Save and apply** — QRFolder generates the Caddyfile, writes it next to your config, and hot-loads it into Caddy
4. Hit **Check certificate** to fetch the certificate actually being served from local port 443 and confirm its issuer and days remaining

The page also takes care of two things that are easy to forget: it syncs "Public address" to
`https://<primary domain>` (QR codes need it) and turns on "Trust X-Forwarded-* headers" (without
which real client IPs and HTTPS detection both break).

> Prerequisite: Caddy must be started **with its admin API enabled**. Use this project's
> `start.bat` — it reads `system.tls` and starts Caddy alongside QRFolder when needed (no window).
> The old `C:\caddy\caddy.json` has `"admin": {"disabled": true}`; under that config the admin
> panel cannot reach Caddy, and it has been superseded by the generated Caddyfile.

### What you must do behind a proxy

In the QRFolder admin UI, under **System settings → Reverse proxy**:

1. Tick "Trust X-Forwarded-* headers"
2. Confirm that "Trusted proxy addresses" includes `127.0.0.1/32` and `::1/128`

> **Without this switch**, every source IP QRFolder sees is `127.0.0.1` —
> so the IP allowlist and login rate limiting degrade into a global on/off switch (either everything is allowed or everything is blocked).

Once it's on, check the **Access log** page to confirm the recorded IPs are real client IPs rather than `127.0.0.1`.

### Set the public address while you are here

Go to **System settings → Public address** and enter `https://your-domain`
(or `http://public-ip:port`).

This value exists for QR codes: a QR code has to encode an **absolute** URL, and the
admin panel is usually opened at `127.0.0.1:8080` — the server has no way to know which
domain visitors actually use. Leave it empty and QR codes still work, but they point at
whatever address you happened to be using; that is only correct if it is already the
public one. Set it once and every directory's QR code is right.

---

## 5. Firewall

If the reverse proxy and QRFolder run on the same machine, **port 8080 does not need to be open** — it only listens on loopback.

You only need to allow the proxy's ports:

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

Only if the reverse proxy runs on a different machine do you need to open QRFolder's port, and you must **change the config as well**:

```json
{ "system": { "host": "0.0.0.0", "trustProxy": true } }
```

> ⚠️ Listening on `0.0.0.0` means anyone on the LAN can connect directly and bypass the proxy.
> If the proxy is on the same machine, **keep `127.0.0.1`**.

---

## 6. Post-deployment checks

Run through these one by one:

```bash
BASE=https://files.example.com

# 1. Directory listing works
curl -sI $BASE/ExampleCorp/ | head -1
# expect: HTTP/2 200

# 2. A nonexistent path returns 404 and leaks no Server header
curl -sI $BASE/nope | grep -i server
# expect: no output

# 3. The error page is HTML, not plain text
curl -sI $BASE/nope | grep -i content-type
# expect: content-type: text/html; charset=utf-8

# 4. The root path does not list directories
curl -s $BASE/ | grep -c "文件夹\|folders"
# expect: 0

# 5. index.html does not replace the listing (if the directory has an index.html)
curl -s $BASE/ExampleCorp/ | grep -c 'class="label"'
# expect: greater than 0

# 6. Range requests work
curl -sI -H "Range: bytes=0-99" $BASE/ExampleCorp/some.pdf | head -1
# expect: HTTP/2 206

# 7. The source IP is the real one (check it directly, not via the log page)
#    Sign in to the admin panel → Access log, and confirm the IP column isn't 127.0.0.1
```

---

## 7. Upgrading

```bash
cd /opt/qrfolder
git pull
node src/main.ts --check      # verify the config is still compatible first
sudo systemctl restart qrfolder
```

The config schema carries a `version` field; future breaking changes will come with migration notes.

> Back up `config/config.json` before upgrading — it holds the admin password hashes and the session secret.

---

## 8. Backups

There are only two things to back up:

| Path | Contents |
|---|---|
| `config/config.json` | Directory configuration, admin password hashes, session secret |
| `logs/` | Access logs (if file logging is enabled) |

The content directories themselves follow your own backup policy.

**Treat `config.json` as a secret file** — it contains the admin password hashes and the session signing key.
`chmod 600` is recommended.

---

## 9. Troubleshooting

### Exits immediately on startup

```bash
node src/main.ts
```

Check stderr. Common causes:

| Output | Cause |
|---|---|
| `Port 8080 is already in use` | Pick another port, or find what's holding it: `lsof -i :8080` / `netstat -ano \| findstr :8080` |
| `Permission denied binding ...` | Ports below 1024 require privileges; use a higher port |
| `Failed to parse config` | JSON syntax error; use `--check` for details |

### Config changes made in the admin UI don't take effect

1. Look for a red banner at the top of the admin UI — when validation fails, the service keeps the old config
2. Check whether you changed `host` / `port` — those two require a restart
3. Validate on its own with `node src/main.ts --check`

### Garbled filenames when downloading Chinese filenames

Something in between rewrote `Content-Disposition`. Use `curl -sI` to inspect the headers actually sent, and confirm the `filename*=UTF-8''` part is still there.

### Video seeking doesn't respond

The proxy is buffering. Add `proxy_buffering off;` on nginx. Caddy doesn't buffer by default.

### The logs are full of 404s for `/admin`

Scanners are probing. Changing `system.adminPath` (e.g. to `/manage-8f3a`) cuts the noise considerably.

---

## 10. Migrating from other setups

### From Caddy `file_server`

1. Run QRFolder on a different port first (e.g. 8081), alongside the existing Caddy
2. Hit both with the same set of URLs and compare status codes and response headers
3. Once you're satisfied, switch Caddy over to a reverse proxy:

```
files.example.com {
    reverse_proxy 127.0.0.1:8081
    header -Server
    header -X-Powered-By
}
```

4. Configure the directories in the QRFolder admin UI and phase out Caddy's file serving

### From nginx `autoindex`

1. Point the existing `root` directory at one QRFolder directory entry
2. **Note**: nginx's `autoindex` doesn't hide files like `.env` and `.git` by default; QRFolder hides them
3. nginx's `index` directive makes `index.html` replace the listing; QRFolder behaves the same way with no configuration at all

---

## 11. Performance notes

QRFolder is a single-threaded Node process. That's more than enough for use cases like "product manual downloads", but it's worth knowing the edges:

| Scenario | Behavior |
|---|---|
| Directory listing (hundreds of entries) | `readdir` + a `stat` per entry on every request, concurrency capped at 32. Millisecond range |
| Directory listing (thousands of entries) | Same, but entries are capped at 5000 by default and the page says so when truncated |
| Large file downloads | Streamed, so memory use is constant; Range is supported |
| Many concurrent downloads | Limited by Node's single thread and the proxy configuration. `sendfile` on the reverse proxy helps |

If you need more throughput, put a CDN in front to cache static files (mind the pass-through of `Range` and `Content-Disposition`).
