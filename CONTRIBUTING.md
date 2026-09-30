# Contributing

Thanks for taking a look. This project has unusually strict rules on purpose —
please read the two hard ones before writing code, because a patch that breaks
either will be sent back.

## The two hard rules

### 1. No runtime dependencies. Ever.

`package.json` must keep `dependencies` empty (it currently has no such key at
all). `typescript` and `@types/node` live in `devDependencies` and are only used
by `tsc --noEmit` — the server itself runs on Node built-ins alone.

This is not minimalism for its own sake. The thing is designed to run
unattended on a public server for years; with no dependencies there is nothing
to upgrade, nothing to patch, and no supply-chain surface. A pull request that
adds a runtime dependency will be declined regardless of how useful it is.

### 2. The code must survive Node's type stripping

There is no build step. Node runs the `.ts` files directly, erasing types and
generating nothing. So these are unavailable:

- `enum` — use `const X = [...] as const` plus `type T = typeof X[number]`
- `namespace`
- constructor parameter properties (`constructor(private x: number)`)
- `import x = require('y')`

Relative imports **must** carry the `.ts` extension (`./y.ts`), and `paths`
aliases do not work (Node does not read them). `tsconfig.json` sets
`erasableSyntaxOnly: true` so `tsc` catches all of this before runtime — do not
remove that flag.

## Getting set up

```bash
npm install          # only for tsc; the server runs without it
npm start            # or: node src/main.ts
npm run check        # tsc --noEmit
npm test             # node --test
```

Node ≥ 22.18 is required (that is when type stripping became stable).

To run a single test file:

```bash
node --test test/safePath.test.ts
```

## What a good patch looks like

**Tests come with the change.** `test/adminFlow.test.ts` boots a real server on
a free port and walks the whole admin flow over HTTP — that is the model to
follow for anything user-facing. Prefer asserting on things that do not move
(form field names, `action=` attributes, status codes, config on disk) over
user-visible copy, which changes whenever someone rewords a translation.

**Comments explain *why*, not *what*.** The code already says what it does. The
valuable comment is the one recording the bug you nearly shipped, the platform
quirk you had to work around, or the reason an obvious-looking alternative is
wrong. Several files open with exactly that — see the header of
`src/serving/safePath.ts` and the note on `putModule` in `src/util/qrcode.ts`.

**Do not reference the deployment you happen to run.** No real domains, IPs,
customer names, or absolute paths from your own machine — the tests use
`example.com` and `files.example.com` for a reason. `.gitignore` already
excludes `config/config.json`, `logs/`, and `caddy/Caddyfile`; keep it that way.

**Match the surrounding style.** 2-space indent, single quotes, semicolons,
kebab-case filenames. The UI strings are Chinese-first: add the key to
`src/i18n/zh-CN.ts` (the authoritative list) and `src/i18n/en-US.ts`. The
latter is typed `Record<MsgKey, string>`, so a missing translation fails the
type check — that is the completeness guarantee, please don't loosen it.

## Before opening a pull request

```bash
npm run check && npm test
```

Both must be clean. If you touched `src/serving/`, `src/config/validate.ts`, or
`src/admin/`, run the full suite rather than a single file — the integration
tests are where the regressions actually show up.

CI runs those same two commands on both Linux and Windows, against Node 22.18
(the floor declared in `engines`) and the current 24.x. Running them locally
first is faster than learning it from the matrix.

For anything that changes behaviour (not just wording), add a line to
[`CHANGELOG.md`](CHANGELOG.md) under `## [Unreleased]`.

By taking part you agree to [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Reporting bugs

Open an issue with: what you expected, what happened, the exact URL or config
involved, and your Node version and platform. If it is a security problem, do
**not** open a public issue — see [`SECURITY.md`](SECURITY.md).
