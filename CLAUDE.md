# Perpetual Pantries — sandbox

This repo holds **three related single-file HTML apps plus a backend that
links them**, not one standalone app. It's a more advanced/active
workspace than the sibling `pp-refactored` repo — treat the two as
separate, currently-diverged codebases rather than copies of each other
(see "Relationship to `pp-refactored`" below).

## The three apps

Per `pp-backend`'s own README, these three apps ("agents") talk to each
other through the backend, using in-app codenames:

| File | App | Codename | Role |
|---|---|---|---|
| `Perpetual_Pantries_v1.html` | PP | **Gavin** | A café's own app — inventory, POS, orders, payroll, BAS. Links to an org with a code, pushes a promoted weekly snapshot, receives/acks requests from Ronin. |
| `pp-command-ronin.html` | PP Command | **Ronin** | An org's console — issues link codes to sites, reads promoted site data, sends approval-gated requests to sites, answers requests from Canopy. |
| `ppcanopy.html` | PPcanopy | **Canopy** | PP's own internal console — creates clients (=orgs) and their one-time org key, reads client menu/aggregates, queues operator-gated asks to a client's Ronin. |

Each is a self-contained HTML file (own inline `<style>`/`<script>`, no
build step) and each **falls back to standalone/local behaviour** when no
backend server is configured — the backend is additive, not required to
run any of them.

## `pp-backend.zip` — the linking server

A Node (ESM) + Express + Postgres service (`argon2`, `jsonwebtoken`, `pg`,
`zod`) implementing the API that connects the three apps. **It ships
zipped, not unpacked** — there is no `package.json` at the repo root, so
`npm install` etc. won't work until you unzip it:

```bash
unzip pp-backend.zip   # produces ./pp-backend/
cd pp-backend && npm install
```

Its own `pp-backend/README.md` (inside the zip) documents the run steps
(`createdb`, migrations, env vars `JWT_SECRET`/`BACKUP_KEY`/`DATABASE_URL`),
the full endpoint table, and what's *not* yet implemented (quotes/billing/
team/orders still browser-only, escalation cron, `sales_records` roll-up,
inbox OAuth, server-side payroll). Read it before making backend changes
rather than re-deriving the API surface from the route files.

It references `PP_Backend_API_Spec.md` as the source-of-truth spec for the
"agents talking" milestone — **that file is not present in this repo**
(not at root, not inside the zip). Don't assume it doesn't exist elsewhere;
ask the user before treating the backend's implemented behavior as the
spec.

**Keep the unpacked `pp-backend/` directory out of git** if you unzip it
to work locally — re-zip and replace `pp-backend.zip` when committing
backend changes, or ask the user whether they'd rather the backend live
unpacked in the repo going forward (that's a real option worth raising,
just not one to make unilaterally).

## `pp-fix.bundle` — currently unusable as-is

A git bundle containing a branch `fix/audit-sept-2026` (tip commit
`2f016d1...`). **Its prerequisite base commit
(`8304ea69d90344c6774a1624df1adf49d2167589`) is not present in this repo's
history**, so `git bundle verify pp-fix.bundle` fails and it cannot be
cloned or fetched from directly here. Don't assume its contents are
reflected in the current HTML/backend files. Before acting on it: ask the
user where the base commit might be recoverable from (another local clone,
another remote, a different branch) — don't try to force-apply it or
guess at its diff by hand.

## Relationship to `pp-refactored`

Both repos contain a `Perpetual_Pantries_v1.html`, but they have
**diverged** — this repo's copy was updated on 2026-09-21 (1500+ lines
added) by a separate Claude session, after `pp-refactored`'s copy was last
touched (2026-09-09). Don't assume either one is a stale copy of the
other, and don't sync/copy the file between the two repos without asking
the user which direction (if any) is correct — they may be intentionally
separate (e.g. sandbox = active dev, pp-refactored = a snapshot/mirror) or
one may simply be behind.

## Working in this codebase

- No build tooling for the HTML apps (same as `pp-refactored`): inline
  CSS/JS, no bundler. Use `grep`/`rg` to jump to a section of a given app
  file rather than reading it whole — each is 100KB–1.8MB.
- The backend (once unzipped) has real tooling: `npm test` runs
  `node --test test/*.test.js` (an e2e suite that needs `DATABASE_URL`
  pointed at a scratch DB — it truncates data, never point it at anything
  real), and `npm run migrate` applies `migrations/*.sql`.
- This repo already has real PR history from other Claude sessions — check
  `git log` before assuming a clean slate, and don't overwrite recent work
  without checking what changed and why.
