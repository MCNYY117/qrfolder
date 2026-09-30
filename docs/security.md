**English** · [中文](security.zh-CN.md)

# Security Design

QRFolder is designed to do exactly one thing: **expose a directory to the public, read-only, and never act beyond what you explicitly authorized**.
This document explains what it defends against, how it defends against it, and **what it does not defend against**.

---

## 1. Threat Model

### Assumed to exist

- An attacker can send arbitrary HTTP requests, including malformed paths, forged headers, and oversized bodies
- The attacker knows or can guess that you run this service (though not necessarily the admin path)
- Filenames in the content directory are partially attacker-controlled (e.g. users are allowed to upload files there)
- The reverse proxy configuration is your responsibility; QRFolder cannot verify that it is trustworthy

### Assumed not to exist

- An attacker who already has arbitrary code execution on the server (at that point this service is beside the point)
- An attacker with physical access to the server
- A content directory that is itself untrusted (**this is an important assumption — see Section 6**)

### Explicit non-goals

- **Not a multi-tenant system.** There are multiple administrators (one super admin plus any
  number of sub admins — see Section 4), but that is **division of labour inside one operations
  team**, not isolation between mutually distrusting customers: every account shares one
  process, one config, and one content root, with no per-tenant quotas, no audit trail, and no
  "sub admins can create sub admins" hierarchy. For real multi-tenancy, run one instance per
  tenant.
- **No content encryption.** Files travel over HTTP in plaintext and rely on external TLS.
- **No antivirus.** Whatever is uploaded is what gets served (file types do get some download downgrading, see Section 6).

---

## 2. Path Traversal Defenses

This is where the project's risk is concentrated — a single oversight means arbitrary file read.

### Key findings (measured, not theorized)

```
new URL('http://h/a/%2e%2e/%2e%2e/x').pathname  ->  "/x"
    ↑ %2e%2e is normalized away for free by the WHATWG URL parser

new URL('http://h/a%2f..%2fb').pathname         ->  "/a%2f..%2fb"
    ↑ %2f passes straight through the URL parser

decodeURIComponent('/a%2f..%2fb')               ->  "/a/../b"
    ↑ a separator materializes out of nowhere at the moment of decoding

new URL('http://h/a/..%5c..%5cb').pathname      ->  "/a/..%5c..%5cb"
decodeURIComponent('/a/..%5c..%5cb')            ->  "/a/..\..\b"
    ↑ on Windows, \ is a separator

path.win32.resolve('D:/root', 'C:/x')           ->  "C:\x"
    ↑ resolve silently discards the root
```

**The core rule follows from this: split on `/` first, then decode each segment individually.**
Doing it the other way around (decode the whole string, then split) is an arbitrary file read vulnerability.
The implementation is in `src/serving/safePath.ts`, and the comments there state the same rule.

### Five layers of defense

| Layer | Mechanism | Attack blocked |
|---|---|---|
| ① | `new URL()` normalization | `%2e%2e`, `./`, duplicate slashes |
| ② | Per-segment validation | Separators smuggled in via `%2f` / `%5c`, NUL bytes, drive letters, NTFS data streams, Windows reserved device names, trailing dots/spaces |
| ③ | `path.join` instead of `path.resolve` | Root silently discarded by an absolute path segment (doesn't fire on Linux, only blows up on Windows) |
| ④ | `isInside()` containment check | UNC paths `//server/share` |
| ⑤ | Re-check after `fs.realpath` | Symlink / NTFS junction escape |

### Two details that are easy to get wrong

**First: `isInside` must not be written as `rel.startsWith('..')`**

```ts
// Wrong: a legitimate file named "..foo" in the directory gets rejected
if (rel.startsWith('..')) return false;

// Right
if (rel === '..') return false;
if (rel.startsWith('..' + path.sep)) return false;
return !path.isAbsolute(rel);
```

**Second: Windows silently strips trailing dots and spaces from path segments**

```ts
// ".. " both dodges the literal seg === '..' comparison
// and is resolved as ".." by the filesystem — a complete traversal path
if (/[. ]$/.test(seg)) throw new UnsafePathError('trailing dot or space');
```

By the same token, `foo.` and `foo` refer to the same file, which can be used to slip past an extension blacklist.

### Tests

`test/safePath.test.ts` contains 29 cases covering every vector above, plus regression tests that legitimate paths are not rejected (Chinese filenames, names with spaces, names like `..foo`).

```bash
node --test test/safePath.test.ts
```

### Residual risk: TOCTOU

There is a time window between layer ⑤ and the actual `open()` — an attacker who can swap the file for a link pointing elsewhere after validation passes but before the open can still get through.

**Node has no usable `O_NOFOLLOW` semantics** (especially not on Windows), so this window cannot be eliminated entirely.

Mitigation: the content directory should be **written only by operators**. If you can guarantee that, the risk reduces to "anyone who can write the content directory could already change the content anyway". If you need stricter guarantees, you can re-check size/mtime with `fh.stat()` after opening and compare them against the values captured during validation.

---

## 3. Authentication and Sessions

### Password storage

Uses Node's built-in `crypto.scrypt` with N=16384, r=8, p=1, keylen=64.

Three implementation pitfalls, all handled in `src/admin/auth.ts`:

1. **Never use `scryptSync`.** A single run takes ~50–120 ms and holds 16 MiB, so the synchronous version blocks the event loop — a few simultaneous logins and the server appears hung.
2. **Concurrency must be capped.** 500 concurrent login requests = 500 × 16 MiB = 8 GB, straight to OOM. **Time-window rate limiting does not stop this** — it permits bursts. So there is a dedicated semaphore (`maxConcurrentHashes`, default 4); excess requests queue, and once the queue is full the server returns 503.
3. **NFKC-normalize the password first.** With Chinese/full-width input methods, the same password can fail verification because of differing Unicode representations.

Also: when no password is set, a hash of equivalent cost still runs so that response times are indistinguishable, preventing an attacker from timing the server to learn "this site has no password yet".

### Sessions

Stateless signed cookie: `v2.<base64url(payload)>.<base64url(hmac-sha256)>`

- Nothing is stored server-side — restarts don't log anyone out, no memory overhead, no concurrent cleanup problem
- Revocation is done by rotating `sessionSecret` (there's a button in the admin UI, and it explicitly warns that everyone will be logged out)
- Optionally bound to the source IP (`bindSessionToIp`; this disconnects frequently on mobile networks, so it's off by default)

**The token carries an account id and nothing else — no role, no permissions.** Both are
looked up from the in-memory config on every request. That's what makes "change a permission,
it takes effect immediately" and "delete an account, it stops working on the next request"
true; putting permissions in the token would mean waiting out a 12-hour ticket instead.

**The version bump from `v1` to `v2` is a required part of adding accounts.** The old
verifier ignores fields it doesn't recognize, so a v1 token carrying an account id would be
accepted by the old code as a plain admin — roll back and every sub admin is silently
promoted to super admin. With the version mismatch, old code returns null for any new token.
The cost is that everyone signs in once more after upgrading.

**An admin token with no readable account id is rejected outright.** Letting it through
would be issuing a pass with no subject, and the caller would have to treat it as the super
admin — the worst possible outcome.

**One implementation detail you must not miss**: `timingSafeEqual` throws a `RangeError` when the lengths differ.
Without comparing lengths first, an attacker can send a forged signature of arbitrary length and make the server throw.

```ts
const expected = Buffer.from(sign(bodyB64, secret), 'utf8');
const given = Buffer.from(givenSig, 'utf8');
if (expected.length !== given.length) return null;   // ← compare lengths first
if (!timingSafeEqual(expected, given)) return null;
```

### CSRF

Two layers:

1. The session cookie uses `SameSite=Lax` — browsers won't attach it to cross-site POSTs
2. Double-submit token: an HMAC derived from the session token, submitted with every form and compared server-side with `timingSafeEqual`

Every POST is validated, logout included. A missing or incorrect token returns 403.

### Login rate limiting

| Mechanism | What it stops |
|---|---|
| Per-IP failure counter + exponential backoff lockout | Slow online brute force (15 min → 30 min → 60 min …, cap configurable) |
| scrypt concurrency semaphore | Concurrent credential stuffing blowing up memory |
| Random 200–500 ms delay on failure | Pushes the brute-force rate down further |
| Constant failure message | Doesn't reveal "N attempts remaining", doesn't disclose whether an account exists |

> Counters are held in memory and reset on restart. That's acceptable for a single-instance deployment; multiple instances would need external storage.

### Protecting first-time setup

On first run (the config has **no super admin account yet**), the setup page **is reachable
only from `127.0.0.1`**, preventing someone on the public internet from claiming the
instance first.

The test is "is there a super admin account", not "was a password ever set". That gives you a
recovery path as a side effect: if the super admin account ever disappears (deleted by
mistake, corrupted password record), opening the panel from the server itself shows the setup
page again. It's the safety net for the single-super-admin model.

---

## 4. Administrator Accounts and Permissions

### Two roles

| Role | What they can see |
|---|---|
| **Super admin** (exactly one) | Every directory, every system setting, every admin page |
| **Sub admin** (any number) | Only the directories they created or were assigned, and only the features ticked for them |

Sign-in is **username + password**. On upgrade, an existing `adminPassword` is silently
migrated into a super admin account named `admin`, with the same password.

### Two orthogonal dimensions

Doing only one of them leaves a hole:

- **Capability**: account-level permissions — 13 of them in 5 groups (directories, files,
  access log, appearance, system), ticked one by one
- **Scope**: directory ownership (every directory has an `owner`) plus authorized parent
  paths (a sub admin can only create directories under parents the super admin authorized,
  and cannot type an arbitrary server path)

### The single enforcement point: a fail-closed route table

`src/admin/policy.ts` lists every admin route once: which methods it accepts, who may reach
it, and which object it touches. **A route that isn't in the table 404s.** Adding an
`if (sub === '/newthing')` to the dispatcher therefore produces dead code until the table
entry exists — so "added a route, forgot the permission check, and it's open to every signed-in
user" is structurally impossible. Scattered checks can't promise that; they depend on
everyone remembering every time.

This also fixed a pre-existing hole: `/system/export` had **no method check**, so a plain
`POST` handed over the whole config (password hashes and session secret included). Every
route now declares the methods it accepts.

### Denial is always a 404

- **Somebody else's directory** → 404. It does not confirm the directory exists.
- **No permission for this route** → 404. It does not confirm the page exists.
- **Outside your authorized parent paths** → 403, saying so. That exception exists because
  what's wrong is the **request itself**, not whether some object exists.

The content side works the same way: a sub admin typing another tenant's directory URL gets a
404 — and that check runs **before** the directory-password branch. Reaching the password
branch would amount to admitting the directory exists.

### What a sub admin can never have

These are **not tickable options**; they are hard-wired to the super admin:

- `/access/*` (including the admin's own password, the IP allowlist, login rate limiting) —
  each one is either a privilege escalation or a way to lock the owner out
- `/system/export` (all password hashes and the session secret) and `/system/import`
  (replaces the whole config, i.e. promotes itself)
- `/system/server` (contains the admin path), `/system/proxy` (turning on `trustProxy` lets
  you forge the source IP, which is the same as bypassing the admin IP allowlist),
  `/system/parentroots` (it *is* the permission boundary)
- `/system/log`, `/system/upload` (global switches that affect every admin), `/logs/clear`
  (destroys the audit trail)
- `/domain/*` (changes the public TLS footprint), `/reload`, `/rotate-secret` (logs everyone
  out — handing a sub admin a denial-of-service button aimed at the owner)
- `/users/*` (account management itself)

### You cannot point a directory at somebody else's turf

When a sub admin creates or edits a directory, the path must be **inside their authorized
parent directories and not inside a directory owned by someone else**.

Checking only the first half leaves a complete privilege-escalation path:

1. The authorized parent covers another admin's directory — "root = the whole content root"
   is the least-effort configuration, and the most common one
2. The sub admin creates a directory whose path *is* that other directory
3. The new directory is owned by them, so the ownership check, the permission check, and the
   content-side 404 **all pass**
4. They read the other admin's files through it

So this check is load-bearing, not a nicety. One exception: **an unchanged path skips it** —
if a directory happens to sit underneath someone else's (as arranged by the super admin),
changing its title or sort order must not be rejected. The super admin is exempt entirely;
they can already see every directory.

### Action permissions pull in the "view" permission they depend on

`dirs.create` / `dirs.update` / `dirs.delete` / `dirs.browse` / `dirs.qr` automatically bring
`dirs.view` with them, `appearance.edit` brings `appearance.view`, and `logs.export` brings
`logs.view`.

This isn't for convenience — it removes a state that *sounds* reasonable but doesn't work:
every directory action ends by redirecting back to `/admin/directories`, and that page needs
`dirs.view`. Tick only `dirs.delete` and the delete succeeds, then the browser lands on a 404
— which reads as "the delete broke something". The fill-in happens in the config validator and
**produces no issue** (an issue would make `store.reload()` reject the config forever).

### Hiding the UI is not enforcement

The pages hide navigation entries and buttons you have no permission for, but that is
**only so nobody clicks into a 404**. Enforcement lives in the route table. The sidebar's
visible entries are computed from **that same table** rather than a second
"permission → menu" mapping — two lists drift apart eventually, and the drift is always
"it's in the menu, and clicking it 404s".

### Known gaps

- **Login rate limiting is per IP, not per account.** Distributed credential stuffing against
  one known account won't be throttled. Keying it by account would hand attackers a way to
  lock a known username out, so it stays as it is.
- **A directory belongs to exactly one admin**; shared ownership isn't supported.
- **There is exactly one super admin.** Lose the password and you recover it from the
  first-run setup page on the server itself.
- ~~Two sub admins whose authorized parents overlap can point a directory at each other's
  turf.~~ **That's closed now** (see "You cannot point a directory at somebody else's turf"
  above). The only operational responsibility left is: don't put two customers' material in
  the same folder — no per-directory isolation can survive that.
- **`/system/export` still exports password hashes and the session secret** (redacting them
  would break the import round-trip). It's just super-admin-only now.

---

## 5. Admin Attack Surface

### Default policy

`adminIpAllowlist` **defaults to empty (unrestricted)**. This is deliberate: an open-source project has to work out of the box, and a hard default would make the first deployment fail immediately.

The admin UI does, however:

- **Always show your current IP**, so you know what to put in the allowlist
- **Verify that you're still in the list** when you save it, and require a second confirmation if you're not (so you can't lock yourself out)
- Recommend `127.0.0.1/32` plus an SSH tunnel or VPN in the documentation

### Reducing noise

Scanners constantly probe paths like `/admin`, `/wp-admin`, and `/.env`. Pointing the admin path at an unguessable value via `adminPath` turns those requests into ordinary 404s.

### Unauthorized always means 404

On the content side, "file doesn't exist" and "no permission" return **the same 404**, with no distinction between them.
A non-matching admin path also returns 404, without confirming whether an admin exists at all.
Inside the admin panel, "you have no permission for this route" and "this directory isn't
yours" are 404s too (see Section 4).

403 appears in exactly two places: **CSRF validation failure** (at that point the requester
already holds a valid session, so there is no information leak), and **a path outside your
authorized parent directories** (what's wrong there is the request itself, not whether some
object exists).

---

## 6. HTML/SVG in the content directory — an underestimated risk

This is a problem specific to an information-publishing service and deserves its own section.

**Browsers parse and execute `.html` / `.svg` files in the content directory in the context of your own origin.**
And `/admin` lives on that same origin, the session cookie is `SameSite=Lax`, and same-origin scripts can issue same-origin requests — **which means they can pick up the CSRF token as well**.

In other words: if you (or anyone who can write into the content directory) drop in a malicious HTML file, it can drive your admin panel.

### Mitigation

1. These extensions are always **forced to download** (`Content-Disposition: attachment` + `Content-Type: application/octet-stream`):
   `.html .htm .xhtml .shtml .svg .svgz .xml .xsl .xslt .js .mjs .cjs`
2. **Every response carries `X-Content-Type-Options: nosniff`** — without it, the browser may ignore your `application/octet-stream` and sniff the content as HTML
3. Unknown extensions are forced to download too; the browser is never left to guess

### The thorough fix

**Put the content side on its own subdomain** (e.g. `files.example.com` for content, `admin.example.com` for the admin panel).
Being cross-origin from the admin panel, this is the only complete fix. It requires deploying admin and content on separate domains.

---

## 7. Response Headers

All responses (error responses included) are emitted through a single path:

```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY | SAMEORIGIN
Content-Security-Policy: default-src 'none'; img-src 'self' data:;
    style-src 'nonce-…'; script-src 'nonce-…'; base-uri 'none';
    form-action 'self'; frame-ancestors …; object-src 'none'
Permissions-Policy: geolocation=(), camera=(), microphone=()
Cross-Origin-Resource-Policy: same-origin
Strict-Transport-Security: max-age=31536000   (HTTPS only)
```

- Content pages use `frame-ancestors 'self'` (to allow same-site iframe previews); the admin panel uses `'none'`
- **`Server` and `X-Powered-By` are never sent** — Node's http module doesn't send them by default, so as long as you don't add them manually, they stay clean
- **The CSP nonce is regenerated on every response.** Generating it once at process start and reusing it is equivalent to having no CSP at all — an attacker only has to read one page to learn it

> ⚠️ **Re-verify after putting a reverse proxy in front.** Caddy adds `Server: Caddy` to the responses
> **it generates itself** (error pages, redirects, static replies), so it has to be removed at the
> site level. Note this is `header -Server`, **not** `header_down -Server` — the latter is only valid
> inside a `reverse_proxy` block, and the proxied response never carried the header anyway.
> Write it in three places: the site block, `handle_errors`, and the explicit `:80` block. The full
> config is in [deployment.md](deployment.md).
>
> Verify **all three paths** — error pages and port 80 are the ones people miss:
> ```bash
> for u in https://your-domain/ https://your-domain/nonexistent-path http://your-domain/; do
>   echo "== $u"; curl -sI "$u" | grep -i '^server:' || echo "   no Server header ✅"
> done
> ```

---

## 8. Configuration-Level Defenses

### The content directory must not overlap protected paths

Validated at startup and on every config save: the content directory cannot be a drive root, the application directory, or the directory containing the config file, **nor an ancestor of any of them**.

Otherwise a single misconfiguration publishes `config.json` — which holds `sessionSecret` and the password hash — to the public internet.

> This check was once written backwards: the overlap test had its direction inverted, so any **normal** content directory outside the protected directories was judged to be overlapping and discarded. A regression test now locks it down (`test/validate.test.ts`).

### Config values must not be interpolated into HTML directly

Config values such as `accentColor` are whitelist-validated against `/^#[0-9a-f]{6}$/i` before being inserted into `<style>`.
Otherwise a slip of the finger or a malicious config value (e.g. `#fff}</style><script>…`) is a route from the config surface to XSS — and the admin session cookie sits on the same origin.

### Keep the old config when a change breaks it

When the config file fails to parse or fails validation, the service **keeps the last valid config and continues running**; it never falls back to defaults.

The reason: the default is `siteMode: "public"`. A fallback could flip the entire site from "password required" to "public" on a single typo.

---

## 9. Known Limitations

| Limitation | Notes |
|---|---|
| TOCTOU window | See the end of Section 2. The content directory should be written only by operators |
| Rate-limit counters in memory | Reset on restart. Multi-instance deployments need external storage |
| Admin separation is division of labour, not multi-tenancy | One super admin plus sub admins, sharing a process, a config, and a content root. See Sections 1 and 4 |
| Login rate limiting is per IP, not per account | Distributed credential stuffing against a known account isn't throttled. The trade-off is explained at the end of Section 4 |
| GBK text renders as mojibake | Node only understands UTF-8 text; convert the files |
| Admin and content share an origin | See Section 6; separate domains fix it at the root |
| No built-in TLS | By design — leave it to Caddy/nginx, which do it better |

---

## 10. Reporting Security Issues

Please don't open a public issue for a security problem — contact the maintainers directly.

Include in your report: reproduction steps, impact, and how you'd like it handled.
