# pp-backend

The service that connects the three Perpetual Pantries apps so their agents can talk:

- **PP** (a café's app, Gavin) → links to an org with a code, pushes a promoted weekly snapshot, receives Ronin's requests in an inbox, acks them.
- **PP Command** (an org's console, Ronin) → issues link codes, reads promoted site data, sends requests to sites (approval-gated), answers requests from Canopy.
- **PPcanopy** (PP's own console, Canopy) → creates clients (= orgs) and a one-time org-level link code, reads menu items and org aggregates, queues operator-gated asks to a client's Ronin.

Implements steps 1–4 of `PP_Backend_API_Spec.md` (the "agents talking" milestone) plus staff auth and the encrypted site backup. The data boundary is enforced **server-side**: the snapshot endpoint rejects any key that isn't promoted, the Command serializer whitelists what Ronin can see, and site backups are AES-GCM encrypted per site and never readable by any org or PP route.

## Run it

```bash
createdb pp && psql pp -c 'CREATE EXTENSION pgcrypto; CREATE EXTENSION citext;'
cp .env.example .env            # set JWT_SECRET and BACKUP_KEY to long random strings
npm install
npm run migrate                  # applies migrations/*.sql (idempotent)
npm start                        # :8080 — GET /health
npm test                         # end-to-end suite (needs DATABASE_URL to point at a scratch DB; it truncates)
```

First run: create the Owner once — `POST /api/pp/staff/bootstrap { name, email, password }` (refuses if any staff exist).

## Pointing the apps at it

| App | Where | What |
|---|---|---|
| PPcanopy | Settings (this device) → PP server URL + staff email/password | logs in; `add_client` then shows the client's **one-time, 24h org-level link code** (not a raw key — nothing to leak if the screen is closed before it's copied, just regenerate) |
| PP Command | Settings → PP server URL + link code | code from PPcanopy → claims it once via `POST /api/org/link/claim`, gets back the org key, stores it and switches to server mode — same as before from here on |
| PP | Settings → PP Server URL + link code | code from PP Command → Sites → Generate link code; "Share staff hours" is the opt-in for org-level labour |

Both tiers work the same way: an 8-char, single-use, 24h-expiry code minted by the parent, redeemed once by the child to get its real credential. Once claimed, a link is permanent — there is deliberately no unlink/revoke. If a code is lost or expires before anyone claims it, regenerate a new one (`POST /api/pp/clients/:id/link-code` for org-level, `POST /api/org/link-codes` for site-level); regenerating only works pre-claim — once a link exists, that endpoint refuses rather than silently invalidating a live console.

The three HTML files in this repo (`../Perpetual_Pantries_v1.html`, `../pp-command-ronin.html`, `../ppcanopy.html`) are already wired; each falls back to standalone/local behaviour when no server is configured.

## Endpoints

| Auth | Route | Purpose |
|---|---|---|
| — | `POST /api/link/redeem` (alias `POST /auth/token`) | café redeems a code → site JWT |
| — | `POST /api/org/link/claim` | PP Command redeems an **org**-level code → org API key (once) |
| site | `POST /api/venue/snapshot` | promoted weekly snapshot (+ `menu_items`, opt-in `shared_payroll`); unknown keys → 400 |
| site | `GET /api/venue/inbox`, `POST /api/venue/inbox/:id/approve|decline|ack` | Ronin→Gavin requests; café manager approves on the café's screen |
| site | `POST|GET /api/venue/sync` | encrypted full backup, venue-only |
| org | `GET /api/org`, `/sites`, `/overview`, `/labour`, `/notifications` | promoted data only |
| org | `POST|GET|DELETE /api/org/link-codes` | 8-char, 24h, single-use, crypto-random |
| org | `POST /api/org/messages`, `/messages/coordinate`, `GET /api/org/messages` | keyword gate applied server-side |
| site or org | `POST /api/org/messages/:id/approve|decline` | org only if `sites.org_may_approve` |
| org | `GET /api/org/canopy-requests`, `POST …/:id/respond` | operator answers Canopy |
| staff | `POST /api/pp/staff/login|bootstrap`, `GET|POST /api/pp/staff`, `POST /api/pp/staff/password` | argon2, roles Owner / Sales Manager / IT Staff |
| staff | `POST|GET /api/pp/clients`, `POST …/:id/link-code` (regenerate, pre-claim only), `POST …/:id/rotate-key` (Owner) | client = org; `create` returns an org-level link code, not a key |
| staff | `GET /api/pp/clients/:id/products|overview|sales-trend` | menu items and aggregates only |
| staff | `POST|GET /api/pp/ronin-asks`, `POST …/:id/withdraw` | Canopy→Ronin queue |

Writes accept an `Idempotency-Key` header (24 h replay). All lists page with `?limit=&cursor=`.

## Not in this build (spec §8 steps 5–6)

PPcanopy's remaining collections (quotes, billing, team, orders) still live in the browser; the escalation cron; the `sales_records` roll-up (needs POS); real inbox OAuth; a shared server-side payroll engine. `pp_schema.sql` tables for those already exist and aren't touched here.
