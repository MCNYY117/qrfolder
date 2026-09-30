# Security Policy

QRFolder is a file server meant to sit on the public internet and serve real
business documents. Security bugs here are not theoretical, so they are taken
seriously and fixed quickly.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's [private vulnerability reporting][gh-report] on this repository
(Security → Report a vulnerability). If that is unavailable, open a minimal
public issue that says only "security report — please contact me" and wait for
a reply; do not include the details there.

[gh-report]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

Helpful in a report:

- what an attacker can do (read a file outside the content directories? bypass a
  password? forge a session?)
- the exact request or configuration that triggers it
- the version or commit you tested, and the platform

You will get an acknowledgement, an assessment, and — if it is a real
vulnerability — a fix and credit (unless you would rather stay anonymous).

## Scope

**In scope** — anything that breaks one of the guarantees below:

| Guarantee | Where it lives |
|---|---|
| No path traversal: nothing outside a configured directory can be read | `src/serving/safePath.ts` |
| Protected paths (the app source, `config/config.json`) are never served | `src/serving/resolveTarget.ts` |
| Passwords and session cookies cannot be bypassed or forged | `src/admin/session.ts`, `src/admin/auth.ts`, `src/access/guard.ts` |
| CSRF tokens are required for every state-changing admin request | `src/admin/csrf.ts` |
| Content directories cannot execute script on the site's origin | `src/serving/mime.ts`, `src/http/response.ts` (CSP) |
| Denied extensions and filenames always 404, and don't confirm existence | `src/serving/resolveTarget.ts` |

**Out of scope**

- Anything that requires an already-compromised admin session or write access to
  the config file — an admin can already serve any directory they like.
- Denial of service through sheer request volume. There is no rate limiting on
  the content side by design; put it in the reverse proxy.
- Missing hardening headers, TLS ciphers, and similar — that layer belongs to
  the reverse proxy (see `docs/deployment.md`).
- The bundled QR encoder producing an unscannable image. That is a bug, not a
  vulnerability — but please do report it, with the exact text you encoded.

## The security model in one paragraph

QRFolder assumes it is **the only thing listening on its port, reachable only
through a reverse proxy, and running as a user that has read access to the
content directories and nothing more**. If you bind it to `0.0.0.0` without a
proxy, terminating TLS itself is impossible (it speaks plain HTTP only) and
`X-Forwarded-*` headers become forgeable — see `trustProxy` in the README before
doing that.

The full model, including the threats that were deliberately *not* defended
against, is in [`docs/security.md`](docs/security.md) (English) and
[`docs/security.zh-CN.md`](docs/security.zh-CN.md) (中文).

## Supported versions

This project is pre-1.0 and ships from `main`. Fixes land there; there are no
maintenance branches. If you are running a fork with local changes, please
reproduce against a clean checkout before reporting.
