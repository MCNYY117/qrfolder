**English** · [中文](README.zh-CN.md)

---

<div align="center">

# QRFolder

**Turn a folder into a scannable file site — by NYY**

*Zero-dependency file-site server: turn a directory on your server into a browsable, manageable, password-protected file site*

[![CI](https://github.com/MCNYY117/qrfolder/actions/workflows/ci.yml/badge.svg)](https://github.com/MCNYY117/qrfolder/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Admin panel](#admin-panel) · [HTTPS](#reverse-proxy--https) · [Security](#security-notes-read-this-first) · [Docs](#docs) · [FAQ](#faq)

</div>

---

## What it solves

You have a pile of product manuals, drawings, and reference material sitting on a server, and you want clients to browse and download it straight from a browser. nginx's `autoindex` is ugly and can't be managed; a cloud drive means uploading everything a second time; writing your own means handling Range requests, non-ASCII filenames, and path traversal — fiddly details that are easy to get wrong and expensive when you do.

That is exactly what QRFolder does: **map a directory to a URL**. The listing looks clean and is fully customizable, configuration is a few clicks in the admin panel, and changes take effect immediately with no restart.

### How it compares

| | QRFolder | nginx `autoindex` | Caddy `file_server` | Cloud drive |
|---|---|---|---|---|
| Runtime dependencies | **0** | nginx itself | caddy itself | Many |
| Customizable page appearance | ✅ via admin | ❌ hardcoded | ⚠️ needs Go templates | ✅ |
| Restart needed to apply config | ❌ applies live | requires reload | requires reload | — |
| Third-party branding on the page | **None** | nginx footer | Caddy logo footer | Yes |
| Read-only exposure (no writes) | ✅ | ✅ | ✅ | ❌ needs a permission model |
| Default document can't override the listing | ✅ guaranteed by design | requires an empty `index` | requires an `index` trick | n/a |

---

## Features

### Content

- **Listings are mandatory** — a directory is listed even when it contains an `index.html`. This isn't a config flag suppressing something; the code simply has no concept of a "default document"
- **No root overview** — `/` shows a welcome page that lists nothing, so visitors can't enumerate your directories (switchable to a plain 404)
- **Range requests** — PDF page-jumping and video seeking both work
- **Non-ASCII filenames** — `Content-Disposition` is written per RFC 5987 with both the plain and encoded forms, so downloads aren't garbled
- **Light / dark mode** — follows the system setting by default, and visitors can also flip it themselves with a button next to the language switch. The choice is remembered in a cookie and applies to both the site and the admin panel
- **Filter box and sorting** — sort by name, size, or time; filtering is entirely client-side
- **Responsive** — secondary columns collapse on narrow screens

### Admin

- **Multiple administrators** — one **super admin** plus any number of **sub admins**, signing in with username + password. The super admin sees every directory and every system setting; a sub admin sees only the directories they created or were assigned, plus the features ticked for them (13 permissions in 5 groups)
- **One boundary, two levels** — "Allowed parent directories" in System settings is the single global boundary; each sub admin is ticked a few of those as their own range. **Browsing, scanning, and creating all stop there — the super admin included.** Adding a directory means picking a parent and typing a name; **if the folder does not exist, the server creates it** (same when you authorize a parent for someone)
- **Directory management** — add, edit, and remove entries, plus "scan and import" that tick-lists the folders already on disk, with a server-side directory browser. Deleting lives in the edit dialog's **Danger zone** and comes in two flavours: **unpublish** (config only, nothing on disk is touched) and **delete contents** (removes the folder too — super admin only, and it makes you type the directory name)
- **QR codes** — one click per directory to generate a scannable QR code for its URL, downloadable as SVG or PNG. The address comes from "System settings → Public address" — a bare domain or IP:port is enough. The encoder is written in-house: still no dependencies
- **File management** — browse and **upload files** into any directory: drag & drop, multi-select, subfolders; can be turned off
- **Customizable landing page** — the site root's title, body text, image and footer note are all configurable, each with **separate Chinese and English versions** picked by the visitor's language. The image can be a site-relative path or an external URL (external origins are added to that page's CSP automatically). The page deliberately links nowhere: its QR codes are printed on physical material, not handed out online
- **Access control** — site-wide password, per-directory passwords, IP allowlists, login rate limiting, session lifetime and optional IP binding
- **Appearance** — product name (rename once and the admin header and login page follow), title, accent colors, which columns to show, footer text, with live preview
- **System settings** — port, admin path, reverse proxy, upload on/off and size limit, logging, config import/export
- **Access log** — in-memory ring buffer, filterable by status code and path, exportable to CSV

### Engineering

- **Zero runtime dependencies** — deployment is copying the source. No `npm install`, no `node_modules`, no supply-chain risk
- **TypeScript, actually type-checked** — runs `.ts` directly via Node's native type stripping, so there's no build step, while `tsc --noEmit` keeps the types honest
- **Bilingual UI** — switchable at runtime; a missing translation fails the compiler
- **Hot config reload** — editing the config file or changing settings in the admin panel both apply immediately (the bind address excepted)

---

## Requirements

| | Requirement |
|---|---|
| Node.js | **≥ 22.18** (needs native TypeScript type stripping) |
| OS | Windows / Linux / macOS |
| For development | `npm install` pulls in `typescript` and `@types/node` (**type checking only — not needed at runtime**) |

> Why 22.18+: QRFolder runs via `node src/main.ts` and relies on Node's built-in type stripping. Older versions fail with `ERR_UNKNOWN_FILE_EXTENSION`.

---

## Quick start

**Nothing to configure up front.** Get the code, start it, and do the rest in the browser:

```bash
# 1. Get the code
git clone <repo-url> qrfolder
cd qrfolder

# 2. Start it (no npm install — this project has zero runtime dependencies)
node src/main.ts
```

```
[2026-09-23T12:00:44.891Z] INFO  Session secret generated and written to D:\...\config\config.json
[2026-09-23T12:00:44.891Z] INFO  Config file not found, using defaults (not written): D:\...\config\config.json
[2026-09-30T09:15:02.117Z] INFO  QRFolder v1.0.0 started
[2026-09-23T12:00:44.901Z] INFO  Listening  http://127.0.0.1:8080
[2026-09-23T12:00:44.902Z] INFO  Directories enabled: 0
```

**3. Open <http://127.0.0.1:8080/admin>** and work through the first-run setup:

| Step | Page | What to do |
|---|---|---|
| ① | First visit | **Create the super admin account**: a username (default `admin`) and a password. First-time setup only works from the server itself (`127.0.0.1`), so nobody on the public internet can claim the instance before you do |
| ② | Directories | Add the directories you want to publish: a name plus the path on this server |
| ③ | System settings → Public address | Enter the domain or `IP:port` — QR codes need it to build absolute URLs |
| ④ | Appearance | Product name, title, accent colours, landing-page copy (separate Chinese and English) |
| ⑤ | Access control | Turn on a site password, per-directory passwords, an admin IP allowlist, as needed |
| ⑥ | Domains & certs | If you have a domain, enter it and the HTTPS certificate is obtained and renewed for you |
| ⑦ | Admins | When work needs to be split, create sub admins and tick their permissions one by one |

Until step ② the site is empty ("Directories enabled: 0"), and that is **deliberate**: a fresh
install points at no directory at all, so you can't accidentally publish something you haven't
prepared yet.

> **`npm install` is not needed to run it.** The only dependencies are `typescript` and
> `@types/node`, used solely by `npx tsc --noEmit`. Install them only if you want type checking.

Common commands:

```bash
node src/main.ts                    # start
node src/main.ts --port 9000        # use a different port (not written back to the config)
node src/main.ts --config other.json
node src/main.ts --check            # validate the config and exit
node --test                         # run the tests
npx tsc --noEmit                    # type check
```

### One-click start on Windows

`node src/main.ts` runs in the **foreground**: it holds your console window open, and closing that window kills the service. If you would rather not have a window sitting there, double-click one of these in the project root:

| File | What it does |
|---|---|
| **`start.bat`** | Starts the service with **no console window**; the script exits immediately and leaves nothing behind |
| **`stop.bat`** | Stops it |

The same script is also callable from the command line:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 stop
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status    # PID, port, uptime
```

The launcher records the PID in `logs\qrfolder.pid` and re-checks that the process really is `node` running `main.ts` before stopping it, so it will not kill an unrelated Node process. It also recognises an instance you started by hand (found via the listening port).

---

## Configuration

See [`config/config.example.json`](config/config.example.json) for the full example.

### When changes take effect

| Config block | Applies |
|---|---|
| `directories`, `appearance`, `access`, `logLevel`, `adminPath`, `trustProxy` | **Hot** — effective immediately |
| `system.host`, `system.port` | **Restart required** (the listening socket can't be rebound live); the admin panel shows a "restart pending" notice |
| `system.sessionSecret` | **Restart required**; equivalent to logging everyone out |

> If the config file is broken (invalid JSON or an illegal field), the server **keeps the last valid configuration and carries on** — it never falls back to defaults. Otherwise a single slip of the hand could turn the whole site from "password required" into "wide open". Problems are reported in a red banner at the top of the admin panel.

### Directory entries

Each entry maps a URL path to a directory on disk:

```json
{
  "name": "ExampleCorp",              // visitors browse /ExampleCorp/
  "path": "/srv/documents/ExampleCorp",
  "label": "",                        // page heading; falls back to name when empty
  "enabled": true,
  "access": "inherit",                // inherit | public | password
  "password": null,                   // scrypt record when access=password
  "allowedCidrs": [],                 // IP allowlist specific to this directory
  "followSymlinks": false,
  "sort": "",                         // empty = follow the appearance settings
  "hideDotfiles": null,               // null = follow the global setting
  "note": "",
  "owner": ""                         // id of the admin it belongs to; "" = the super admin
}
```

Admin accounts live in `access.admins` (normally created in the panel, not by hand):

```json
{
  "id": "a1b2c3d4",
  "username": "alice",
  "role": "sub",                      // super | sub; there can be only one super
  "password": { "...": "..." },       // scrypt record, same shape as a directory password
  "permissions": ["dirs.view", "files.view"],   // sub only; 13 of them
  "roots": ["/srv/documents"],        // sub only; must be inside system.parentRoots
  "enabled": true,
  "note": ""
}
```

**Adding a directory doesn't mean editing the config**: drop the folder into a content root and click "Scan and import" in the admin panel.

---

## Admin panel

Visit `http://<your-address>/admin`.

| Page | What you can do |
|---|---|
| **Overview** | Uptime, request statistics, recent visits, who you're signed in as and what you may do. The operator quick actions (reload config, clear logs, rotate the session secret) are **super-admin-only** |
| **Admins** | Create, edit, and delete sub admins, tick their permissions one by one, assign authorized parent directories, reset passwords. **Super admin only** |
| **Directories** | Add, edit, and remove directories, scan and import, per-directory passwords and IP allowlists, **generate and download a QR code for any directory**. The super admin gets an extra "owned by" dropdown |
| **Files** | Browse a directory and upload files into it (drag & drop or multi-select). Uploads are on by default and can be disabled in System settings |
| **Access control** | Site password, **the super admin's own password**, admin IP allowlist (with your current IP and a test tool), login rate limiting, **session lifetime and IP binding**, sensitive-file rules. **Super admin only** |
| **System settings** | Bind address and port, **public address (the domain or IP:port encoded into QR codes)**, admin path, reverse-proxy trust settings, **upload on/off, size limit and overwrite policy**, logging, config import/export. A sub admin sees only the public-address card, and can change only that |
| **Domains & certs** | Enter a domain and email; saving generates a Caddyfile and hot-loads it into Caddy. Shows the certificate **actually being served** (issuer, validity, days left). Caddy obtains and renews it automatically. **Super admin only** |
| **Appearance** | Title, accent colors, which columns to show, default sort, preview/download extensions, custom CSS, with a live iframe preview. Without the "edit appearance" permission it opens **read-only** |
| **Access log** | Filter by status code and path, auto-refresh, export to CSV. A sub admin only sees entries for their own directories |

The sidebar **lists only the pages you may open** — the rest have no entry point at all, and
typing their URL directly gives a 404.

### How the multiple administrators work

- **There is exactly one super admin.** It's the account an existing admin password is
  migrated into on upgrade (username `admin`, same password). Lost the password? Open the
  panel from the server itself and the first-time setup page comes back
- **A sub admin is authorized along two dimensions.** Capability: 13 permissions, ticked
  individually. Scope: directory ownership (every directory has an "owned by") and authorized
  parent directories, ticked from the pool in System settings
- **Authorizing is a promise.** Ticking a sub admin an authorized parent that doesn't exist
  yet — or adding such a path to the pool — makes the server create the folder on the spot.
  If it can't (the parent is missing, no permission, the path isn't absolute) the save is
  refused. So you never end up with "authorized in the config, absent on disk", a state that
  only shows itself to the person trying to use it
- **"Allowed parent directories" is a hard boundary.** A folder outside the pool can't be
  published directly — add it to the pool first, and that goes for the super admin too. The
  one exception is a directory whose **path is unchanged**: a location arranged before the
  pool was tightened can still have its title or sorting edited, but it cannot be pointed
  somewhere outside the pool
- **A container isn't published.** A location is either an allowed parent folder (a
  container you put things in) or a published content directory — never both. Pool roots and
  sub-admin workspaces are kept out of the scan list and refused on submit. Folders *inside*
  them are unaffected, which is the normal way to use this
- **Permission changes take effect immediately, with no re-login.** The session token holds
  nothing but an account id; permissions are looked up from the config on every request — so
  revoking a permission, disabling an account, or deleting one lands on the very next request
- **Account management, access control, the global system switches, config import/export,
  domains & certs, and rotating the session secret are not tickable options.** They are
  hard-wired to the super admin. The reasoning is in
  [docs/security.md](docs/security.md) Section 4
- **A directory belongs to exactly one admin**; shared ownership isn't supported

### Changing the admin path

The default is `/admin`. Moving it to something hard to guess (such as `/manage-8f3a`) cuts scanner noise significantly — scanners request `/admin` continuously, and every one of those requests ends up in your log.

---

## Reverse proxy & HTTPS

QRFolder itself only listens on `127.0.0.1`; a reverse proxy serves HTTPS to the outside world. That leaves certificate issuance and renewal to mature tooling and keeps QRFolder dependency-free.

### Caddy (recommended, automatic certificates)

**You don't have to write this by hand.** Fill in the domain and email on the admin panel's
"Domains & certs" page; saving generates the Caddyfile and hot-loads it into Caddy. Caddy handles
issuance, renewal and the HTTP→HTTPS redirect, and the page shows you the certificate that is
actually being served.

If you would rather write it yourself, the site block looks like this:

```
files.example.com {
    reverse_proxy 127.0.0.1:8080
    header -Server
}
```

Two things that are easy to get wrong:

- **The directive is the site-level `header -Server`.** Caddy adds `Server: Caddy` to responses it
  generates itself (redirects, error pages). Note that `header_down` is **not** a site-level
  directive — it is only valid inside a `reverse_proxy` block, and putting it at site level makes
  Caddy refuse the config outright with `unrecognized directive: header_down`.
- **You do not need `header_up X-Forwarded-For`.** Caddy's default already *replaces* the header
  rather than appending (verified: a request carrying `X-Forwarded-For: 1.2.3.4` arrives upstream
  with the real client IP), and it sets `X-Forwarded-Proto` by default too. Adding it only earns
  you an "Unnecessary header_up" warning.

Then, in the QRFolder admin panel under "System settings → Reverse proxy":

1. Turn on "Trust X-Forwarded-* headers"
2. Leave `127.0.0.1/32` and `::1/128` in "Trusted proxy addresses"

> With that switch off, every source IP QRFolder sees is `127.0.0.1`, and IP allowlists plus login rate limiting degrade into a global on/off switch.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    server_tokens off;                     # hide the nginx version
    more_clear_headers Server;             # requires the headers-more module

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;               # don't buffer large downloads
    }
}
```

For a full production walkthrough, see [docs/deployment.md](docs/deployment.md).

---

## Security notes (read this first)

Confirm every item below before exposing QRFolder to the internet:

- [ ] **You changed the super admin password**, and it isn't a weak one
- [ ] **If you created sub admins, each one has their own account** — don't share a login, or the log won't tell you who did what
- [ ] **You considered changing the admin path** (`/admin` → something hard to guess)
- [ ] **You configured an admin IP allowlist**, or at least confirmed the admin password is strong enough
- [ ] **You verified there's no `Server` header**: `curl -sI https://your-domain/nonexistent | grep -i server` should print nothing
- [ ] **Your content directories hold no sensitive files** — QRFolder blocks `.env`, `.key`, `.pem`, `.sql` and friends by default, but your directories may contain others
- [ ] **You're not serving your project directory or a drive root** — the validator rejects this, but it's worth confirming yourself
- [ ] **The `Server` header is stripped at the reverse proxy** — with Caddy that means a site-level
      `header -Server` (**not** `header_down`), written in three places: the site block, `handle_errors`,
      and the `:80` block. See [docs/deployment.md](docs/deployment.md)

### Built-in protections

| Threat | Mitigation |
|---|---|
| Path traversal (`..`, `%2f`, `%5c`, NUL, drive letters, UNC, reserved device names, symlink escapes) | Five layers of validation — see [docs/security.md](docs/security.md) |
| HTML/SVG in content directories executing script on your own origin | Forced downgrade to download + `nosniff` |
| Concurrent logins exhausting memory (one scrypt hash costs 16 MiB) | Hash concurrency gate |
| Password brute force | Per-IP failure counting with exponential-backoff lockout |
| Clickjacking of the admin panel via an iframe | CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY` |
| XSS injected through config values | Colors and similar values are allowlist-validated before they reach `<style>` |
| Search engine indexing | `robots.txt` + `<meta name="robots" content="noindex">` |

---

## FAQ

<details>
<summary><b>A non-ASCII filename downloads as mojibake, or the file is just called "download"</b></summary>

QRFolder writes both `filename=` and `filename*=UTF-8''` per RFC 5987. If names are still garbled, something in between — a proxy or a CDN — is most likely rewriting `Content-Disposition`. Use `curl -sI` to inspect the headers actually being sent.

</details>

<details>
<summary><b>A GBK-encoded .txt file opens as mojibake</b></summary>

Node only understands UTF-8. This is a known limitation; convert your text files to UTF-8. PDFs and Office documents in the same directory are unaffected.

</details>

<details>
<summary><b>Seeking in a video doesn't work</b></summary>

Check whether the reverse proxy is buffering. nginx needs `proxy_buffering off;`; Caddy doesn't buffer by default and needs no configuration. `curl -sI -H "Range: bytes=0-99" <file-url>` should return `206`.

</details>

<details>
<summary><b>I changed the config and nothing happened</b></summary>

1. First check for a red banner at the top of the admin panel (when config validation fails, the old config is kept)
2. If you changed `host` or `port`, a restart is required
3. Validate the config file on its own with `node src/main.ts --check`

</details>

<details>
<summary><b>Port already in use</b></summary>

```
Error: listen EADDRINUSE
```

Use `node src/main.ts --port 9000` to switch ports temporarily, or find the current occupant:

- Linux/macOS: `lsof -i :8080`
- Windows: `netstat -ano | findstr :8080`

</details>

<details>
<summary><b>The Windows firewall is blocking it</b></summary>

Listening on `127.0.0.1` only needs no firewall rule. You only need to open the port if a reverse proxy on another machine has to reach it:

```powershell
New-NetFirewallRule -DisplayName "QRFolder" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

</details>

---

## Project layout

```
qrfolder/
├── src/
│   ├── main.ts              entry point: argument parsing, startup, graceful shutdown
│   ├── config/              config type definitions, validation, read/write, hot reload
│   ├── http/                server, request parsing, response writing, security headers
│   ├── serving/             path guards, directory scanning, MIME, file transfer
│   ├── views/               listing page, error pages, admin pages
│   ├── admin/               authentication, sessions, CSRF, accounts, permission policy, admin routes
│   ├── access/              CIDR matching, login rate limiting, the content-side directory gate
│   ├── logging/             ring buffer, access log, application log
│   └── i18n/                English and Chinese strings
├── test/                    tests (node:test, including two integration suites
│                            that boot a real server process)
├── scripts/service.ps1      optional Windows launcher (also manages Caddy)
├── config/                  configuration and example
└── docs/                    topic guides, see below
```

---

## Docs

| Document | Written for | What's in it |
|---|---|---|
| [docs/features.zh-CN.md](docs/features.zh-CN.md) | **Non-technical readers** — clients, management | A plain-language tour: what this is, what it does, how far it can be customised *(Chinese)* |
| [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md) | Clients / procurement | A requirements spec with individually checkable acceptance criteria, plus an explicit out-of-scope list *(Chinese)* |
| [docs/deployment.md](docs/deployment.md) · [中文](docs/deployment.zh-CN.md) | Whoever runs the server | Deployment from scratch: Node, reverse proxy, HTTPS, autostart, performance, troubleshooting |
| [docs/security.md](docs/security.md) · [中文](docs/security.zh-CN.md) | Anyone reviewing security | Threat model, what's defended, **what deliberately isn't** (just as important), and a self-check list |
| [SECURITY.md](SECURITY.md) | Security researchers | How to report a vulnerability, and what counts as one |
| [CONTRIBUTING.md](CONTRIBUTING.md) | People changing the code | The two hard rules (zero deps, must survive type stripping) and the workflow |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Everyone taking part | The bar for behaviour in issues, pull requests, and anywhere else |

---

## Development

### Why zero dependencies

This project is built to run unattended on the public internet for years. Zero dependencies means: no `npm install` that can fail, no breaking changes from a dependency bump, no supply-chain poisoning surface, and a deployment that is nothing more than copying a folder.

The cost is that form parsing, session signing, scrypt passwords, Range transfers, the MIME table, the ring buffer, and i18n are all written by hand. That trade-off is deliberate.

### The four restrictions of type stripping

When Node executes `.ts` directly it only strips types — it generates no code — so you **cannot** use:

- `enum` (use `const X = [...] as const` plus `type T = typeof X[number]` instead)
- `namespace`
- constructor parameter properties (`constructor(private x: number)`)
- `import x = require('y')`

`erasableSyntaxOnly: true` in `tsconfig.json` makes `tsc` reject these constructs up front instead of letting them crash at runtime.

One more thing: **relative imports must carry the `.ts` extension**, and `paths` aliases are unusable (Node doesn't understand them).

### Adding a translation string

1. Add the key to `src/i18n/zh-CN.ts` (this is the authoritative source)
2. Add the matching English text to `src/i18n/en-US.ts`
3. Miss one and `npx tsc --noEmit` fails outright

### Running the tests

```bash
npm run check     # tsc --noEmit
npm test          # node --test, no test framework
node --test test/safePath.test.ts    # a single file
```

If you changed anything under `src/serving/`, `src/config/validate.ts`, or
`src/admin/`, run the whole suite — regressions there tend to surface only in
the integration tests.

### Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before you start; it leads with the
two hard rules (no runtime dependencies, and the code must survive type
stripping). For security problems, use the private channel described in
[`SECURITY.md`](SECURITY.md) rather than a public issue.

---

## Migrating from other setups

### From Caddy `file_server`

1. Run QRFolder on a separate port (e.g. 8081) alongside your existing Caddy
2. Hit the same URLs against both and confirm the status codes and response headers match
3. Once you're satisfied, change the Caddy config to reverse-proxy to QRFolder
4. Keep Caddy — it now only handles TLS

### From nginx `autoindex`

1. Configure the directory behind `root` as a QRFolder directory entry
2. Note that nginx's `autoindex` doesn't hide files like `.env`, whereas QRFolder hides them by default

---

## License

[MIT](LICENSE)
