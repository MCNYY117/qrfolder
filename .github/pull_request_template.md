## What this changes

<!-- One or two sentences. If it fixes an issue, link it. -->

## Checklist

The first two are the hard rules from `CONTRIBUTING.md` — a patch that breaks
either one gets sent back regardless of what else it does.

- [ ] **No runtime dependency was added.** `dependencies` in `package.json` is still absent
- [ ] **The code survives type stripping** — no `enum`, no `namespace`, no constructor parameter properties, and relative imports carry the `.ts` extension (`npm run check` catches all of this)
- [ ] `npm run check` and `npm test` are both clean locally
- [ ] Tests come with the change, and they assert on things that do not move — form field names, `action=` attributes, status codes, the config on disk — rather than on user-visible copy, which changes whenever a translation is reworded
- [ ] A behaviour change (not just wording) has a line under `## [Unreleased]` in `CHANGELOG.md`
- [ ] **No real domains, IPs, customer names or machine-specific absolute paths.** The tests use `example.com` and `C:\Sites` on purpose; `CONTRIBUTING.md` says why

## Anything the reviewer should know

<!--
  A trap you hit, an alternative you tried and rejected, a follow-up you
  deliberately left out of scope. This section is the one that saves the most
  review round-trips.
-->
