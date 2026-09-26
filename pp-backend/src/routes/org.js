// Endpoints called by an org's PP Command console (Ronin). Auth: X-Org-Key.
import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../lib/db.js';
import { requireOrg, siteOrOrg, linkCode } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { wrap, notFound, conflict, forbidden, bad } from '../lib/errors.js';
import { needsApprovalByRule, projectSnapshot } from '../lib/rules.js';

export const org = Router();

// Serializer whitelist: this is the only shape a Command console ever receives about a site.
async function serializeSite(s) {
  const { rows: [snap] } = await q('SELECT * FROM site_snapshots WHERE site_id=$1 ORDER BY received_at DESC LIMIT 1', [s.id]);
  const { rows: menu } = await q('SELECT name, price, category FROM menu_items WHERE site_id=$1 AND active ORDER BY category, name', [s.id]);
  const { rows: [pay] } = await q('SELECT lines FROM site_shared_payroll WHERE site_id=$1', [s.id]);
  return {
    id: s.id, name: s.name, venue_id: s.external_venue_id, suburb: s.suburb, state: s.state, tier: s.tier,
    linked_at: s.linked_at, org_may_approve: s.org_may_approve,
    snapshot: projectSnapshot(snap),
    ocData: { oc_menu_data: menu.map(m => ({ name: m.name, sellingPrice: Number(m.price || 0), category: m.category || '' })) },
    sharedPayroll: s.share_payroll && pay ? pay.lines : [],
  };
}

// ── 4.1 Sites + link codes ─────────────────────────────────────────────────
org.get('/api/org', requireOrg, wrap(async (req, res) => res.json({ id: req.org.id, name: req.org.name, sector: req.org.sector, command_tier: req.org.command_tier })));

org.get('/api/org/sites', requireOrg, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM sites WHERE org_id=$1 ORDER BY linked_at', [req.org.id]);
  res.json({ sites: await Promise.all(rows.map(serializeSite)) });
}));

org.post('/api/org/link-codes', requireOrg, wrap(async (req, res) => {
  const hint = String(req.body?.hint || '').slice(0, 120) || null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows: [c] } = await q(`INSERT INTO link_codes(org_id, code, hint, expires_at) VALUES ($1,$2,$3, now() + interval '24 hours') RETURNING id, code, hint, status, created_at, expires_at`, [req.org.id, linkCode(8), hint]);
      return res.status(201).json(c);
    } catch (e) { if (e.code !== '23505') throw e; } // unique collision — retry
  }
  throw new Error('could not allocate a unique code');
}));
org.get('/api/org/link-codes', requireOrg, wrap(async (req, res) => {
  await q(`UPDATE link_codes SET status='expired' WHERE org_id=$1 AND status='pending' AND expires_at < now()`, [req.org.id]);
  const { rows } = await q('SELECT id, code, hint, status, created_at, expires_at, used_at, site_id FROM link_codes WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100', [req.org.id]);
  res.json({ codes: rows });
}));
org.delete('/api/org/link-codes/:id', requireOrg, wrap(async (req, res) => {
  const { rowCount } = await q(`UPDATE link_codes SET status='revoked' WHERE id=$1 AND org_id=$2 AND status='pending'`, [req.params.id, req.org.id]);
  if (!rowCount) throw notFound('pending code not found');
  res.json({ ok: true });
}));
org.patch('/api/org/sites/:id', requireOrg, wrap(async (req, res) => {
  // Only org-level knobs; a site's own details come from its snapshot.
  const b = z.object({ tier: z.enum(['T1', 'T2', 'T3', 'T4']).optional() }).parse(req.body || {});
  const { rows: [s] } = await q('UPDATE sites SET tier=COALESCE($3,tier) WHERE id=$1 AND org_id=$2 RETURNING *', [req.params.id, req.org.id, b.tier ?? null]);
  if (!s) throw notFound('site not found');
  res.json(await serializeSite(s));
}));

// ── 4.2 Overview (revenue-weighted, server-side) ───────────────────────────
org.get('/api/org/overview', requireOrg, wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT s.id, sn.* FROM sites s
    LEFT JOIN LATERAL (SELECT * FROM site_snapshots WHERE site_id=s.id ORDER BY received_at DESC LIMIT 1) sn ON true
    WHERE s.org_id=$1`, [req.org.id]);
  const reporting = rows.filter(r => r.received_at);
  const acc = { revenue_week: 0, gp_w: 0, gp_sum: 0, labour_w: 0, labour_sum: 0, covers_week: 0, stock_out: 0, stock_low: 0, stock_value: 0, loyalty_members: 0, open_orders: 0 };
  for (const r of reporting) {
    const rev = Number(r.revenue_week || 0);
    acc.revenue_week += rev; acc.gp_w += Number(r.gp_pct || 0) * rev; acc.gp_sum += Number(r.gp_pct || 0);
    acc.labour_w += Number(r.labour_pct || 0) * rev; acc.labour_sum += Number(r.labour_pct || 0);
    acc.covers_week += r.covers_week || 0; acc.stock_out += r.stock_out || 0; acc.stock_low += r.stock_low || 0;
    acc.stock_value += Number(r.stock_value || 0); acc.loyalty_members += (r.loyalty && r.loyalty.total_members) || 0; acc.open_orders += r.open_orders || 0;
  }
  const n = reporting.length || 1, R = acc.revenue_week;
  res.json({
    site_count: rows.length, reporting_sites: reporting.length,
    totals: {
      revenue_week: R, avg_gp_pct: Math.round(R > 0 ? acc.gp_w / R : acc.gp_sum / n), avg_labour_pct: Math.round(R > 0 ? acc.labour_w / R : acc.labour_sum / n),
      covers_week: acc.covers_week, stock_out: acc.stock_out, stock_low: acc.stock_low, stock_value: acc.stock_value, loyalty_members: acc.loyalty_members, open_orders: acc.open_orders,
    },
  });
}));

// ── 4.3 Ronin → Gavin messages ─────────────────────────────────────────────
async function createMessage(c, orgId, siteId, intent, note, requiresApproval, coordinationId) {
  const { rows: [s] } = await c.query('SELECT id, name FROM sites WHERE id=$1 AND org_id=$2', [siteId, orgId]);
  if (!s) throw notFound('site not found in this org');
  if (needsApprovalByRule(intent, note)) requiresApproval = true;  // the gate, server-side
  const status = requiresApproval ? 'awaiting_approval' : 'sent';
  const { rows: [m] } = await c.query(
    `INSERT INTO ronin_gavin_messages(org_id, site_id, direction, intent, note, requires_manager_approval, status, coordination_id)
     VALUES ($1,$2,'ronin_to_gavin',$3,$4,$5,$6,$7) RETURNING *`, [orgId, s.id, intent, note || null, !!requiresApproval, status, coordinationId || null]);
  if (requiresApproval) await c.query(`INSERT INTO org_notifications(org_id,type,subject,body) VALUES ($1,'ronin_approval_request',$2,$3)`, [orgId, `Awaiting ${s.name} manager approval`, `${intent}: ${note || ''}`]);
  return m;
}
const MsgBody = z.object({ site_id: z.string().uuid(), intent: z.string().min(1).max(120).regex(/^[a-z0-9_]+$/i, 'snake_case intent'), note: z.string().max(2000).optional(), requires_manager_approval: z.boolean().optional(), coordination_id: z.string().uuid().optional() });
org.post('/api/org/messages', requireOrg, idempotent, wrap(async (req, res) => {
  const b = MsgBody.parse(req.body);
  const m = await tx(c => createMessage(c, req.org.id, b.site_id, b.intent.toLowerCase(), b.note, !!b.requires_manager_approval, b.coordination_id));
  res.status(201).json({ message: m });
}));
const CoordBody = z.object({ site_a_id: z.string().uuid(), site_b_id: z.string().uuid(), request: z.string().min(1).max(2000), requires_manager_approval: z.boolean().optional() });
org.post('/api/org/messages/coordinate', requireOrg, idempotent, wrap(async (req, res) => {
  const b = CoordBody.parse(req.body);
  if (b.site_a_id === b.site_b_id) throw bad('site_a and site_b must differ');
  const out = await tx(async c => {
    const { rows: names } = await c.query('SELECT id, name FROM sites WHERE org_id=$1 AND id = ANY($2)', [req.org.id, [b.site_a_id, b.site_b_id]]);
    if (names.length !== 2) throw notFound('one or both sites not found in this org');
    const nm = Object.fromEntries(names.map(s => [s.id, s.name]));
    const slug = n => 'coordinate_with_' + n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const { rows: [{ gen_random_uuid: coordId }] } = await c.query('SELECT gen_random_uuid()');
    const a = await createMessage(c, req.org.id, b.site_a_id, slug(nm[b.site_b_id]), b.request, !!b.requires_manager_approval, coordId);
    const m2 = await createMessage(c, req.org.id, b.site_b_id, slug(nm[b.site_a_id]), b.request, !!b.requires_manager_approval, coordId);
    return { coordination_id: coordId, messages: [a, m2] };
  });
  res.status(201).json(out);
}));
org.get('/api/org/messages', requireOrg, wrap(async (req, res) => {
  const params = [req.org.id]; let where = 'org_id=$1';
  if (req.query.site_id) { params.push(String(req.query.site_id)); where += ` AND site_id=$${params.length}`; }
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND status=$${params.length}`; }
  if (req.query.cursor) { params.push(String(req.query.cursor)); where += ` AND created_at < $${params.length}`; }
  const limit = Math.min(Number(req.query.limit) || 100, 500); params.push(limit);
  const { rows } = await q(`SELECT * FROM ronin_gavin_messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  res.json({ messages: rows, next_cursor: rows.length === limit ? rows[rows.length - 1].created_at : null });
}));

// Approve/decline: site token for that site (real path), or org key only if the site allows it.
async function decide(req, res, status) {
  const { rows: [m] } = await q('SELECT m.*, s.org_may_approve, s.name AS site_name FROM ronin_gavin_messages m JOIN sites s ON s.id=m.site_id WHERE m.id=$1', [req.params.id]);
  if (!m) throw notFound('message not found');
  let by;
  if (req.site) { if (req.site.id !== m.site_id) throw forbidden('not your site'); by = 'site'; }
  else { if (req.org.id !== m.org_id) throw forbidden('not your org'); if (!m.org_may_approve) throw forbidden('this site has not allowed org-side approval (sites.org_may_approve)'); by = 'org'; }
  const { rowCount } = await q(`UPDATE ronin_gavin_messages SET status=$2, approved_by=$3, approved_at=now() WHERE id=$1 AND status='awaiting_approval'`, [m.id, status, by]);
  if (!rowCount) throw conflict(`message is ${m.status}, not awaiting approval`);
  res.json({ ok: true, status, approved_by: by });
}
org.post('/api/org/messages/:id/approve', siteOrOrg, wrap((req, res) => decide(req, res, 'approved')));
org.post('/api/org/messages/:id/decline', siteOrOrg, wrap((req, res) => decide(req, res, 'declined')));

// ── 4.4 Notifications, finance, labour ─────────────────────────────────────
org.get('/api/org/notifications', requireOrg, wrap(async (req, res) => {
  const params = [req.org.id]; let where = 'org_id=$1';
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND status=$${params.length}`; }
  const { rows } = await q(`SELECT * FROM org_notifications WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  res.json({ notifications: rows });
}));
org.post('/api/org/notifications/:id/read', requireOrg, wrap(async (req, res) => {
  await q(`UPDATE org_notifications SET status='read' WHERE id=$1 AND org_id=$2`, [req.params.id, req.org.id]);
  res.json({ ok: true });
}));
org.get('/api/org/labour', requireOrg, wrap(async (req, res) => {
  const { rows } = await q(`SELECT s.id, s.name, p.lines FROM sites s JOIN site_shared_payroll p ON p.site_id=s.id WHERE s.org_id=$1 AND s.share_payroll`, [req.org.id]);
  const lines = rows.flatMap(r => r.lines.map(l => ({ site_id: r.id, site_name: r.name, ...l, gross_cents: Math.round((l.hourly_rate_cents || 0) * (l.hours_this_period || 0)) })));
  res.json({ sites_sharing: rows.length, lines, note: 'Hours/rates shared by sites that opted in. Pay runs, PAYG and super are calculated inside each site\'s own PP payroll, not here.' });
}));

// ── 4.5 Requests from Canopy ───────────────────────────────────────────────
org.get('/api/org/canopy-requests', requireOrg, wrap(async (req, res) => {
  const params = [req.org.id]; let where = 'org_id=$1';
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND status=$${params.length}`; }
  const { rows } = await q(`SELECT id, request_text, requires_approval, status, response_text, created_at, responded_at FROM canopy_ronin_requests WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  res.json({ requests: rows });
}));
const Respond = z.object({ status: z.enum(['approved', 'declined', 'answered']), response_text: z.string().max(4000).optional() });
org.post('/api/org/canopy-requests/:id/respond', requireOrg, wrap(async (req, res) => {
  const b = Respond.parse(req.body);
  const { rows: [r] } = await q(`UPDATE canopy_ronin_requests SET status=$3, response_text=COALESCE($4,response_text), responded_at=now()
                                 WHERE id=$1 AND org_id=$2 AND status IN ('awaiting_approval','approved') RETURNING *`, [req.params.id, req.org.id, b.status, b.response_text ?? null]);
  if (!r) throw conflict('request not open');
  res.json({ ok: true, request: r });
}));
