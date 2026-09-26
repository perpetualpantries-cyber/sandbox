// Endpoints called by PPcanopy (Canopy). Auth: PP staff JWT.
import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../lib/db.js';
import { requireStaff, signStaff, hash, verifyHash, orgApiKey, linkCode } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { wrap, unauth, notFound, conflict, bad } from '../lib/errors.js';

export const pp = Router();

// ── 5.6 Staff auth ─────────────────────────────────────────────────────────
pp.post('/api/pp/staff/login', wrap(async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const { rows: [s] } = await q('SELECT * FROM pp_staff WHERE email=$1 AND active', [b.email]);
  if (!s || !(await verifyHash(s.password_hash, b.password))) throw unauth('invalid email or password');
  res.json({ token: signStaff(s), role: s.role, name: s.name, id: s.id });
}));
// First-run bootstrap: creates the Owner when no staff exist yet. Refuses otherwise.
pp.post('/api/pp/staff/bootstrap', wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(8) }).parse(req.body);
  const { rows: [{ count }] } = await q('SELECT count(*)::int FROM pp_staff');
  if (count > 0) throw conflict('staff already exist — use /api/pp/staff (Owner) to add more');
  const { rows: [s] } = await q(`INSERT INTO pp_staff(name,email,password_hash,role) VALUES ($1,$2,$3,'Owner') RETURNING *`, [b.name, b.email, await hash(b.password)]);
  res.status(201).json({ token: signStaff(s), role: s.role, id: s.id });
}));
pp.get('/api/pp/staff', requireStaff(), wrap(async (_req, res) => {
  const { rows } = await q('SELECT id, name, email, role, active, created_at FROM pp_staff ORDER BY created_at');
  res.json({ staff: rows });
}));
pp.post('/api/pp/staff', requireStaff('Owner'), wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(8), role: z.enum(['Owner', 'Sales Manager', 'IT Staff']).default('Sales Manager') }).parse(req.body);
  const { rows: [s] } = await q(`INSERT INTO pp_staff(name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role`, [b.name, b.email, await hash(b.password), b.role]);
  res.status(201).json(s);
}));
pp.post('/api/pp/staff/password', requireStaff(), wrap(async (req, res) => {
  const b = z.object({ staff_id: z.string().uuid().optional(), password: z.string().min(8) }).parse(req.body);
  const target = b.staff_id || req.staff.id;
  if (target !== req.staff.id && req.staff.role !== 'Owner') throw unauth('only the Owner can reset another account');
  await q('UPDATE pp_staff SET password_hash=$2 WHERE id=$1', [target, await hash(b.password)]);
  res.json({ ok: true });
}));

// ── 5.1 Clients = orgs ─────────────────────────────────────────────────────
// Issues a single-use, 24h org-level link code (mirrors the site link_codes
// flow) instead of ever handing out the org's permanent key directly — PP
// Command exchanges the code once, via POST /api/org/link/claim, for the key.
async function issueOrgLinkCode(orgId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows: [c] } = await q(
        `INSERT INTO link_codes(org_id, code, kind, expires_at) VALUES ($1,$2,'org', now() + interval '24 hours')
         RETURNING id, code, status, created_at, expires_at`, [orgId, linkCode(8)]);
      return c;
    } catch (e) { if (e.code !== '23505') throw e; } // unique collision — retry
  }
  throw new Error('could not allocate a unique code');
}

const ClientBody = z.object({ name: z.string().min(1).max(200), sector: z.string().max(60).optional(), command_tier: z.enum(['compliance', 'multi_outlet']).optional() });
pp.post('/api/pp/clients', requireStaff('Sales Manager'), idempotent, wrap(async (req, res) => {
  const b = ClientBody.parse(req.body);
  const { rows: [o] } = await q(`INSERT INTO orgs(name, sector, command_tier) VALUES ($1,$2,COALESCE($3,'compliance')) RETURNING id, name, sector, command_tier, created_at`,
    [b.name, b.sector || null, b.command_tier ?? null]);
  const linkCodeRow = await issueOrgLinkCode(o.id);
  res.status(201).json({ client: o, linkCode: linkCodeRow });
}));
// Issue a fresh org-level link code — only while the org has never been claimed.
// Once PP Command has claimed one (org.api_key_hash is set), the link is
// permanent; this refuses rather than silently invalidating a live console.
pp.post('/api/pp/clients/:id/link-code', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const { rows: [o] } = await q('SELECT id, api_key_hash FROM orgs WHERE id=$1', [req.params.id]);
  if (!o) throw notFound('client not found');
  if (o.api_key_hash) throw conflict('client already linked — org-level codes are single-use and this org has already claimed its link');
  await q(`UPDATE link_codes SET status='expired' WHERE org_id=$1 AND kind='org' AND status='pending'`, [o.id]);
  res.status(201).json(await issueOrgLinkCode(o.id));
}));
pp.post('/api/pp/clients/:id/rotate-key', requireStaff('Owner'), wrap(async (req, res) => {
  const key = orgApiKey();
  const { rowCount } = await q('UPDATE orgs SET api_key_hash=$2, api_key_hint=$3 WHERE id=$1', [req.params.id, await hash(key), key.slice(-4)]);
  if (!rowCount) throw notFound('client not found');
  res.json({ org: { id: req.params.id, api_key: key } });
}));
pp.get('/api/pp/clients', requireStaff('Sales Manager'), wrap(async (_req, res) => {
  const { rows } = await q(`SELECT o.id, o.name, o.sector, o.command_tier, o.created_at, (o.api_key_hash IS NOT NULL) AS claimed,
                              (SELECT count(*)::int FROM sites s WHERE s.org_id=o.id) AS sites_linked,
                              (SELECT json_agg(json_build_object('id',s.id,'name',s.name,'tier',s.tier,'suburb',s.suburb,'state',s.state) ORDER BY s.linked_at) FROM sites s WHERE s.org_id=o.id) AS venues
                            FROM orgs o ORDER BY o.created_at`);
  res.json({ clients: rows.map(r => ({ ...r, venues: r.venues || [] })) });
}));

// ── 5.2 Products (menu items only — the boundary) ──────────────────────────
pp.get('/api/pp/clients/:id/products', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const { rows } = await q(`SELECT s.id AS site_id, s.name AS site_name, m.name, m.category, m.price
                            FROM menu_items m JOIN sites s ON s.id=m.site_id WHERE s.org_id=$1 AND m.active ORDER BY s.name, m.category, m.name`, [req.params.id]);
  res.json({ products: rows.map(r => ({ site_id: r.site_id, site_name: r.site_name, name: r.name, category: r.category || '', price: Number(r.price || 0) })) });
}));
// 5.3 Sales trend — org-level weekly series built from promoted snapshots (no per-item
// sales until a POS roll-up exists). Each site counts once per week (its latest snapshot
// that week, in the site's own timezone); weeks are then summed across the org, with GP
// and labour revenue-weighted. Org aggregate only — nothing per-site leaves this route.
const TrendQuery = z.object({ weeks: z.coerce.number().int().min(1).max(52).default(12) });
pp.get('/api/pp/clients/:id/sales-trend', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const { weeks } = TrendQuery.parse(req.query);
  const { rows: [o] } = await q('SELECT id FROM orgs WHERE id=$1', [req.params.id]);
  if (!o) throw notFound('client not found');
  const { rows } = await q(`
    WITH sw AS (
      SELECT DISTINCT ON (x.site_id, x.week_start) x.* FROM (
        SELECT sn.site_id, date_trunc('week', sn.received_at AT TIME ZONE s.timezone)::date AS week_start, sn.received_at,
               sn.revenue_week, sn.gp_pct, sn.labour_pct, sn.covers_week
        FROM site_snapshots sn JOIN sites s ON s.id=sn.site_id
        WHERE s.org_id=$1 AND sn.received_at >= date_trunc('week', now()) - (($2::int - 1) * interval '1 week')
      ) x ORDER BY x.site_id, x.week_start, x.received_at DESC
    )
    SELECT week_start, count(*)::int AS reporting_sites,
           COALESCE(sum(revenue_week), 0) AS revenue,
           sum(gp_pct * revenue_week) / NULLIF(sum(revenue_week) FILTER (WHERE gp_pct IS NOT NULL), 0) AS gp_pct,
           sum(labour_pct * revenue_week) / NULLIF(sum(revenue_week) FILTER (WHERE labour_pct IS NOT NULL), 0) AS labour_pct,
           sum(covers_week)::int AS covers
    FROM sw GROUP BY week_start ORDER BY week_start`, [o.id, weeks]);
  const out = rows.map(r => ({
    week_start: r.week_start.toISOString().slice(0, 10), reporting_sites: r.reporting_sites, revenue: Number(r.revenue),
    gp_pct: r.gp_pct == null ? null : Math.round(Number(r.gp_pct)), labour_pct: r.labour_pct == null ? null : Math.round(Number(r.labour_pct)),
    covers: r.covers,
  }));
  res.json({ weeks: out, ...(out.length ? {} : { note: 'No snapshots from linked venues in this period yet.' }) });
}));

// Org-level aggregate a Canopy dashboard may see: the same overview Ronin sees, nothing per-site below it.
const STALE_AFTER_DAYS = 8; // snapshots are weekly — older than this means a venue has stopped reporting
pp.get('/api/pp/clients/:id/overview', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT s.id, sn.revenue_week, sn.gp_pct, sn.labour_pct, sn.covers_week, sn.stock_out, sn.stock_low, sn.open_orders, sn.received_at FROM sites s
    LEFT JOIN LATERAL (SELECT * FROM site_snapshots WHERE site_id=s.id ORDER BY received_at DESC LIMIT 1) sn ON true WHERE s.org_id=$1`, [req.params.id]);
  const { rows: [{ menu_items }] } = await q('SELECT count(*)::int AS menu_items FROM menu_items m JOIN sites s ON s.id=m.site_id WHERE s.org_id=$1 AND m.active', [req.params.id]);
  const rep = rows.filter(r => r.received_at); const R = rep.reduce((a, r) => a + Number(r.revenue_week || 0), 0);
  const sum = k => rep.reduce((a, r) => a + Number(r[k] || 0), 0);
  const weighted = k => rep.length ? Math.round(R > 0 ? rep.reduce((a, r) => a + Number(r[k] || 0) * Number(r.revenue_week || 0), 0) / R : sum(k) / rep.length) : null;
  const staleCutoff = Date.now() - STALE_AFTER_DAYS * 86400000;
  const last = rep.reduce((a, r) => (!a || r.received_at > a ? r.received_at : a), null);
  res.json({ site_count: rows.length, reporting_sites: rep.length, revenue_week: R,
    avg_gp_pct: weighted('gp_pct'), avg_labour_pct: weighted('labour_pct'),
    covers_week: sum('covers_week'), stock_out: sum('stock_out'), stock_low: sum('stock_low'), open_orders: sum('open_orders'),
    menu_items, stale_sites: rep.filter(r => new Date(r.received_at).getTime() < staleCutoff).length,
    last_snapshot_at: last });
}));

// ── 5.4 Canopy → Ronin asks ────────────────────────────────────────────────
pp.post('/api/pp/ronin-asks', requireStaff('Sales Manager'), idempotent, wrap(async (req, res) => {
  const b = z.object({ org_id: z.string().uuid(), message: z.string().min(1).max(4000), canopy_ask_id: z.string().max(64).optional() }).parse(req.body);
  const { rows: [o] } = await q('SELECT id, name FROM orgs WHERE id=$1', [b.org_id]);
  if (!o) throw notFound('client not found');
  const { rows: [r] } = await q(`INSERT INTO canopy_ronin_requests(org_id, request_text, requires_approval, canopy_ask_id, asked_by) VALUES ($1,$2,true,$3,$4) RETURNING *`, [o.id, b.message, b.canopy_ask_id || null, req.staff.id]);
  await q(`INSERT INTO org_notifications(org_id,type,subject,body) VALUES ($1,'canopy_request',$2,$3)`, [o.id, 'Request from Perpetual Pantries (Canopy) — needs your approval', b.message.slice(0, 500)]);
  res.status(201).json({ id: r.id, clientId: o.id, clientName: o.name, message: r.request_text, askedAt: r.created_at, status: r.status });
}));
pp.get('/api/pp/ronin-asks', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const params = []; let where = 'true';
  if (req.query.org_id) { params.push(String(req.query.org_id)); where += ` AND r.org_id=$${params.length}`; }
  const { rows } = await q(`SELECT r.*, o.name AS org_name FROM canopy_ronin_requests r JOIN orgs o ON o.id=r.org_id WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`, params);
  res.json({ asks: rows.map(r => ({ id: r.id, clientId: r.org_id, clientName: r.org_name, message: r.request_text, askedAt: r.created_at, status: r.status, response_text: r.response_text, respondedAt: r.responded_at })) });
}));
// Canopy may only withdraw its own ask; status otherwise belongs to the org side (§4.5).
pp.post('/api/pp/ronin-asks/:id/withdraw', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const { rowCount } = await q(`UPDATE canopy_ronin_requests SET status='withdrawn', responded_at=now() WHERE id=$1 AND status='awaiting_approval'`, [req.params.id]);
  if (!rowCount) throw conflict('ask is not awaiting approval');
  res.json({ ok: true });
}));

// Admin convenience for tests/ops: issue a *site*-level link code as staff (Owner),
// same as an org would via POST /api/org/link-codes. Distinct from
// POST /api/pp/clients/:id/link-code (singular) above, which is org-level.
pp.post('/api/pp/clients/:id/link-codes', requireStaff('Owner'), wrap(async (req, res) => {
  const { rows: [c] } = await q(`INSERT INTO link_codes(org_id, code, kind, hint, expires_at) VALUES ($1,$2,'site',$3, now() + interval '24 hours') RETURNING id, code, hint, status, expires_at`, [req.params.id, linkCode(8), String(req.body?.hint || '').slice(0, 120) || null]);
  res.status(201).json(c);
}));
