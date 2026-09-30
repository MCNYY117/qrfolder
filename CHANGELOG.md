# Changelog

Notable changes to QRFolder, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are written for people running the thing, not for people reading the diff.

## [Unreleased]

## [1.0.0] — 2026-09-30

First public release.

### Added

- **Deleting a directory can now delete its contents too.** Unpublishing (the old
  delete) leaves the folder alone; there is now a separate **Delete contents**
  action that removes the folder and everything in it. Both live in the edit
  dialog's **Danger zone** rather than on the table row — with five buttons the
  row overflowed its cell and the panel clipped the last two, so the delete
  button was literally invisible. Delete-contents is deliberately hard to fire by
  accident: super-admin only (not a tickable permission), behind a dialog that
  shows the exact path and makes you type the directory name, and refused
  outright for a filesystem root, the app directory, the config file, or an
  allowed parent folder. The files go first and the config entry second, so a
  failed deletion never leaves a phantom entry behind.
- **A folder that is an allowed parent can no longer be published as a
  directory.** Those folders are containers — publishing one means everyone's
  files inside it go public, and the same path ends up being both "a workspace
  someone drops things into" and "a site that is live". Sub-folders are
  unaffected. Such folders are also filtered out of the scan list and the Browse
  button, so you never see an option that would be refused.
- **One directory boundary instead of three overlapping ones.** "Allowed parent
  directories" in System settings is now the single global boundary; each sub
  admin is ticked a few of those as their own range. Browsing, scanning and
  creating all stop there, and that goes for the super admin too — a folder
  outside the pool has to be added to the pool before it can be published. The
  old `system.scanRoots` key is read and migrated silently; nothing to do on
  upgrade.
- **Creating a directory creates the folder.** Pick an allowed parent, type a
  name, and if the folder isn't there the server makes it. An empty URL prefix
  now falls back to the folder name. The Browse button lists the folders that
  already exist under the chosen parent so you can pick one instead of typing.
- **Authorizing is a promise.** Ticking a sub admin a parent that doesn't exist
  yet — or adding such a path to the pool — creates the folder on the spot. If
  it can't (parent missing, no permission, a relative path) the save is refused
  with a message saying which level is missing. Non-recursive on purpose: a typo
  in a path should be an error, not a silently created chain of empty folders.
- Scan and import is now a real tick-list. It used to import *everything* under
  the chosen root while the label said "tick the ones to create"; now you tick
  what you want, entries already published are marked and skipped, and there's a
  select-all.
- **The admin panel was rebuilt on the content page's visual language.** Tables
  share one definition with the listing page (fixed layout, header band, row
  hover, ellipsis, narrow-screen column folding), the file manager uses the same
  icons and breadcrumbs, dialogs go full-screen on a phone, and the sidebar
  becomes a slide-in drawer under 780px with a working no-JS fallback. Every
  inline `style="…"` is gone — there were ~30 of them and the CSP silently
  dropped all of them, so those pages were showing the "stylesheet didn't load"
  version of themselves.

- **Administrator accounts: one super admin, any number of sub admins.** Sign-in
  is now username + password. The super admin sees every directory and every
  system setting. A sub admin sees only the directories they created or were
  assigned, and only the features ticked for them one by one. There are 13
  permissions in five groups (directories, files, access log, appearance,
  system); everything else — access control, the domain/certificate page,
  config import/export, the global system switches, and account management
  itself — stays super-admin-only by construction, not by convention.
  Sub admins can only create directories under parent paths the super admin
  authorized for them, and each directory carries an owner.
  Reach it at **Admins** in the sidebar. An upgrade with an existing admin
  password migrates it to a super admin named `admin` with the same password.
- **Session settings are now editable in the admin panel** (Access control →
  Login sessions): how long an admin login lasts, and whether a session is bound
  to the source IP. Both were config-file-only before.
- **Upload settings are now editable in the admin panel** (System settings →
  File uploads): turn uploading off entirely, cap the size per file, and choose
  whether overwriting an existing file is allowed. The Files page already told
  you to "disable this in System settings" — now that setting exists.
- `SECURITY.md`, `CONTRIBUTING.md`, and this changelog.

### Changed

- **The quick start no longer tells you to create a config file first.** A fresh clone is
  configured entirely in the browser now: start it, open `/admin`, set the admin password, add
  your directories. The default config points at no directory at all, so a new install can't
  accidentally publish something you haven't prepared. (`npm install` was never needed to run
  it either — the docs now say so where it used to be implied otherwise.)
- **The directory browser no longer descends.** The parent dropdown says where,
  the list says what; having both able to navigate made it ambiguous which one a
  click changed.
- Deleting a directory now says plainly that the folder and its files stay on
  disk — that was worth spelling out once creating a directory started making
  folders.

### Security

- **A logged-in admin used to bypass every per-directory rule on the content
  side.** That was correct while there was exactly one admin; with sub admins it
  became a way to read someone else's directories just by typing the URL, no
  matter how carefully the panel was locked down. Admins now carry a scope, and
  a sub admin hitting another tenant's directory gets a 404 — before the
  password branch, so the response doesn't even confirm the directory exists.
- **A directory session cookie could be renamed into another directory's
  cookie.** The directory id is part of the cookie *name*, and the check only
  asked whether a token verified — so holding a ticket for directory A, you
  could rename the cookie to directory B's name and walk in. The token's own
  directory id is now compared too.
- **`/system/export` had no method check.** A plain `POST` handed over the whole
  config, password hashes and `sessionSecret` included — enough to forge a
  super-admin session. Method checks are now declared per route, and anything
  not listed 404s.
- **Early admin-panel rejections didn't drain the request body.** Besides the
  connection-reset problem already documented for uploads, the unread bytes stay
  on the same keep-alive connection and desynchronize the *next* request — which
  showed up in testing as "signed in as admin, got alice's session".

### Fixed

- **A config save didn't take effect for the next request or two.** The content
  side's directory map (which carries the deny rules) is rebuilt asynchronously,
  and `store.update()` returned without waiting for it. For a few dozen
  milliseconds a just-denied extension was still downloadable and a
  just-disabled directory was still reachable. It surfaced as a test that failed
  about half the time.
- **Windows reserved device names were creatable as directories.** `CON`, `NUL`,
  `COM1` and friends can now neither be published nor created — the server makes
  folders now, so the check that used to be Explorer's job is ours.
- **An empty subdirectory never said it was empty.** The check counted rows
  after the "go up" row had already been pushed, so in any subdirectory the
  message was unreachable — you saw a lone "up" link and couldn't tell an empty
  folder from a failed listing.
- Narrow-screen column folding dropped header cells without dropping the matching
  body cells, so the header and data were offset by a column on a phone.
- **The delete button on the directories page was invisible.** The table is
  `table-layout: fixed`, so the actions column got one fifth of the width — 206px
  on the usual layout — while its five buttons needed 338px. The overflow was
  hidden by the panel, so the last two buttons were simply not there. Row
  actions now wrap (so nothing can ever be clipped again) and the two delete
  actions moved into the edit dialog.
- **A disabled directory was labelled "Published" in the scan list and
  "Unavailable" in the directory list.** Neither was true: it is not live, and it
  is not broken — you turned it off. The scan list now says Disabled (the URL
  prefix is genuinely taken, so it still can't be imported), and the Unavailable
  badge and the dashboard's "Unavailable × N" count now only cover directories
  that are switched on and actually failing.
- **An invalid IP allowlist was saved to the config anyway.** The handler wrote
  the list and *then* reported the syntax error, so you got a red banner and a
  corrupted allowlist. Validation now runs first and a rejected value leaves the
  old one untouched — the same "never write a config we just called invalid"
  rule every other save path follows.
- **Rejecting an invalid public address or invalid imported JSON returned HTTP
  200.** Both now return 400, consistent with the rest of the admin panel (they
  were the only two paths that rendered an error page with a success code).
- Pages can no longer be repainted by the browser's own forced-dark /
  auto-dark-theme feature. The stylesheets advertise `color-scheme`, which is
  the documented opt-out; without it a dark page could be inverted back to light
  by the browser, making the theme switch look broken. Scrollbars, dropdowns and
  date pickers now also follow the dark theme, and navigation no longer flashes
  the wrong background colour.

### The 0.1.0 baseline, folded in

0.1.0 was an internal milestone: it was never tagged, and there is no code state
anyone could check out for it. Its feature list belongs to 1.0.0, so it lives here
rather than as a version page that would 404.

#### Content side

- Directory listings with no default-document override: even a directory
  containing `index.html` is listed.
- Range requests (PDF page jumps, video seeking), RFC 5987 filenames for
  non-ASCII downloads, ETag/If-None-Match.
- Light / dark theme, `auto` by default; visitors can override it with a button
  next to the language switch, and the choice is remembered in a cookie.
- A root landing page that lists nothing, so the site cannot be enumerated from
  `/`. It can also be switched to a plain 404.
- Site-wide password and per-directory passwords, each with its own gate.
- Built-in protections: path traversal, symlink escapes, denied extensions and
  filenames, optional dotfile hiding, CSP with a per-response nonce, and no
  `Server` / `X-Powered-By` fingerprints.

#### Admin panel

- Directory management with add/edit/remove, bulk "scan and import" and a
  server-side directory browser.
- **QR codes** — a scannable code per directory, downloadable as SVG or PNG. The
  encoder is written in-house (byte mode, ECC level M, versions 1–10); no
  dependency was added for it.
- File management with drag-and-drop upload (no `multipart` parsing — the file
  body is the request body, the name rides in a header).
- Appearance settings with a live iframe preview: product name, title, accent
  and folder colours, density, which columns to show, default sort, time zone,
  preview/download extension lists, footer text, custom CSS.
- Landing-page content is **bilingual** — title, body, image alt text and the
  footer hint each have a Chinese and an English version, picked by the
  visitor's language. The two do not fall back into each other.
- Access control: site password, admin password, IP allowlist, login rate
  limiting, sensitive-file rules.
- System settings: bind address/port, admin path, public address (used to build
  QR codes), reverse-proxy trust, logging, config import/export.
- Access log: in-memory ring buffer, filterable, exportable to CSV.
- **Domains and certificates**: enter a domain and an ACME email and the server
  writes a Caddyfile and hot-loads it into Caddy, which obtains and renews the
  certificate. The page shows the certificate actually being served, read back
  over a real TLS handshake.

#### Engineering

- **Zero runtime dependencies.** Deployment is copying the source.
- TypeScript executed directly by Node's type stripping; no build step.
- Config hot-reload that refuses to fall back to defaults when validation fails
  (falling back would silently turn a password-protected site public).
- 387 tests on `node:test`, including an integration suite that boots a real
  server and walks the whole admin flow over HTTP, and a second one that boots a
  two-tenant fixture and verifies a sub admin can reach nothing they weren't
  given. CI runs the whole suite on Node 22.18 and 24.x, on both Linux and
  Windows.
- **Admin routes are fail-closed by table.** Every route is declared once in
  `src/admin/policy.ts` with the methods it accepts, who may reach it, and which
  object it touches. A route that isn't in the table 404s, so adding an
  `if (sub === '/newthing')` without a policy entry produces dead code rather
  than an unprotected page. A test scans the source for route literals and fails
  if any of them lacks an entry.
- Windows one-click start/stop launcher that also manages Caddy when TLS is on.

[Unreleased]: https://github.com/MCNYY117/qrfolder/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MCNYY117/qrfolder/releases/tag/v1.0.0
