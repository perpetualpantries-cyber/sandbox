// Head office ↔ region endpoints. Both sides are PP Command consoles (Auth: X-Org-Key).
// A head office is an org with command_tier 'head_office' (set in PPcanopy); it has no
// sites of its own. A region is any other org that has claimed a head office's
// one-time region code (orgs.parent_org_id).
//
// The boundary: head office reads each region's promoted site snapshots through the
// whitelist below — headline figures only, no stock item names, menus or payroll lines.
import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../lib/db.js';
import { requireOrg, linkCode } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { wrap, notFound, conflict, forbidden } from '../lib/errors.js';

export const group = Router();

const STALE_AFTER_DAYS = 8;   // snapshots are weekly
export const DEFAULT_POLICY = { gp_target_pct: 60, labour_cap_pct: 32, spend_approval_cents: 500000, approved_suppliers: [], notes: '' };

const isHeadOffice = o => o.command_tier === 'head_office';
function requireHeadOffice(req, _res, next) {
  next(isHeadOffice(req.org) ? undefined : forbidden('head-office PP Command only (command_tier head_office, set in PPcanopy)'));
}
function requireNotHeadOffice(req, _res, next) {
  next(isHeadOffice(req.org) ? forbidden('a head office cannot link to another head office') : undefined);
}
const num = v => (v == null ? 0 : Number(v));

// ── What head office sees of a region ──────────────────────────────────────
// Site rows carry headline figures only. Totals are revenue-weighted, matching /api/org/overview.
async function regionReport(region) {
  const { rows } = await q(`
    SELECT s.id, s.name, sn.revenue_week, sn.gp_pct, sn.labour_pct, sn.covers_week, sn.stock_out, sn.stock_low, sn.open_orders, sn.received_at
    FROM sites s LEFT JOIN LATERAL (SELECT * FROM site_snapshots WHERE site_id=s.id ORDER BY received_at DESC LIMIT 1) sn ON true
    WHERE s.org_id=$1 ORDER BY s.linked_at`, [region.id]);
  const { rows: [{ approvals_pending }] } = await q(`SELECT count(*)::int AS approvals_pending FROM ronin_gavin_messages WHERE org_id=$1 AND status='awaiting_approval'`, [region.id]);
  const { rows: [pay] } = await q(`SELECT count(*)::int AS sites_sharing,
      COALESCE(sum((SELECT sum(COALESCE((l->>'hourly_rate_cents')::numeric,0) * COALESCE((l->>'hours_this_period')::numeric,0)) FROM jsonb_array_elements(p.lines) l)),0) AS gross_cents
    FROM sites s JOIN site_shared_payroll p ON p.site_id=s.id WHERE s.org_id=$1 AND s.share_payroll`, [region.id]);
  const sites = rows.map(r => r.received_at
    ? { name: r.name, revenue_week: num(r.revenue_week), gp_pct: num(r.gp_pct), labour_pct: num(r.labour_pct), covers_week: r.covers_week ?? 0,
        stock_out: r.stock_out ?? 0, stock_low: r.stock_low ?? 0, open_orders: r.open_orders ?? 0, received_at: r.received_at }
    : { name: r.name, received_at: null });
  const rep = sites.filter(s => s.received_at);
  const R = rep.reduce((a, s) => a + s.revenue_week, 0);
  const sum = k => rep.reduce((a, s) => a + s[k], 0);
  const weighted = k => rep.length ? Math.round(R > 0 ? rep.reduce((a, s) => a + s[k] * s.revenue_week, 0) / R : sum(k) / rep.length) : 0;
  const last = rep.reduce((a, s) => (!a || s.received_at > a ? s.received_at : a), null);
  return {
    id: region.id, name: region.region_name || region.name, org_name: region.name, linked_at: region.parent_linked_at,
    site_count: sites.length, reporting_sites: rep.length, last_snapshot_at: last,
    stale: !last || (Date.now() - new Date(last).getTime()) > STALE_AFTER_DAYS * 86400000,
    totals: { revenue_week: R, avg_gp_pct: weighted('gp_pct'), avg_labour_pct: weighted('labour_pct'), covers_week: sum('covers_week'),
              stock_out: sum('stock_out'), stock_low: sum('stock_low'), open_orders: sum('open_orders') },
    sites,
    approvals_pending,
    payroll: { sites_sharing: pay.sites_sharing, gross_cents: Math.round(num(pay.gross_cents)) },
  };
}
const regionsOf = async hqId => (await q('SELECT * FROM orgs WHERE parent_org_id=$1 ORDER BY parent_linked_at', [hqId])).rows;
async function getRegion(hqId, regionId) {
  const { rows: [r] } = await q('SELECT * FROM orgs WHERE id=$1 AND parent_org_id=$2', [regionId, hqId]);
  if (!r) throw notFound('region not found for this head office');
  return r;
}
async function getPolicy(hqId) {
  const { rows: [p] } = await q('SELECT policy, version, updated_at FROM group_policies WHERE org_id=$1', [hqId]);
  return p ? { ...DEFAULT_POLICY, ...p.policy, version: p.version, updated_at: p.updated_at } : { ...DEFAULT_POLICY, version: 0, updated_at: null };
}
const notify = (c, orgId, type, subject, body) =>
  c.query(`INSERT INTO org_notifications(org_id,type,subject,body) VALUES ($1,$2,$3,$4)`, [orgId, type, subject.slice(0, 300), body ? String(body).slice(0, 2000) : null]);

// ════════════════════════════════════════════════════════════════════════════
// Head office side
// ════════════════════════════════════════════════════════════════════════════
group.post('/api/org/regions/link-codes', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  const hint = String(req.body?.hint || '').slice(0, 120) || null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows: [c] } = await q(`INSERT INTO link_codes(org_id, code, kind, hint, expires_at) VALUES ($1,$2,'region',$3, now() + interval '24 hours')
                                     RETURNING id, code, hint, status, created_at, expires_at`, [req.org.id, linkCode(8), hint]);
      return res.status(201).json(c);
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw new Error('could not allocate a unique code');
}));
group.get('/api/org/regions/link-codes', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  await q(`UPDATE link_codes SET status='expired' WHERE org_id=$1 AND kind='region' AND status='pending' AND expires_at < now()`, [req.org.id]);
  const { rows } = await q(`SELECT id, code, hint, status, created_at, expires_at, used_at, region_org_id FROM link_codes WHERE org_id=$1 AND kind='region' ORDER BY created_at DESC LIMIT 100`, [req.org.id]);
  res.json({ codes: rows });
}));
group.delete('/api/org/regions/link-codes/:id', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  const { rowCount } = await q(`UPDATE link_codes SET status='revoked' WHERE id=$1 AND org_id=$2 AND kind='region' AND status='pending'`, [req.params.id, req.org.id]);
  if (!rowCount) throw notFound('pending code not found');
  res.json({ ok: true });
}));

group.get('/api/org/regions', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  res.json({ regions: await Promise.all((await regionsOf(req.org.id)).map(regionReport)) });
}));
group.get('/api/org/regions/:id', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  res.json(await regionReport(await getRegion(req.org.id, req.params.id)));
}));

// Revenue-weighted across every reporting site in every region — a plain average of
// regional averages would let a small region count as much as a large one.
group.get('/api/org/group-overview', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  const regions = await Promise.all((await regionsOf(req.org.id)).map(regionReport));
  const sites = regions.flatMap(r => r.sites.filter(s => s.received_at));
  const R = sites.reduce((a, s) => a + s.revenue_week, 0);
  const weighted = k => sites.length ? Math.round(R > 0 ? sites.reduce((a, s) => a + s[k] * s.revenue_week, 0) / R : sites.reduce((a, s) => a + s[k], 0) / sites.length) : 0;
  const sum = k => regions.reduce((a, r) => a + r.totals[k], 0);
  res.json({
    region_count: regions.length, reporting_regions: regions.filter(r => r.reporting_sites).length,
    stale_regions: regions.filter(r => r.stale).map(r => r.name),
    site_count: regions.reduce((a, r) => a + r.site_count, 0),
    totals: { revenue_week: R, gp_pct: weighted('gp_pct'), labour_pct: weighted('labour_pct'), covers_week: sum('covers_week'),
              stock_out: sum('stock_out'), stock_low: sum('stock_low'), open_orders: sum('open_orders') },
  });
}));

const Policy = z.object({
  gp_target_pct: z.number().min(0).max(100),
  labour_cap_pct: z.number().min(0).max(100),
  spend_approval_cents: z.number().int().min(0),
  approved_suppliers: z.array(z.string().trim().min(1).max(200)).max(500),
  notes: z.string().max(4000).optional().default(''),
});
group.get('/api/org/group-policy', requireOrg, requireHeadOffice, wrap(async (req, res) => res.json(await getPolicy(req.org.id))));
// Stale `version` → 409 with the current copy, so two people saving at once can't overwrite each other.
group.put('/api/org/group-policy', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  const b = z.object({ policy: Policy, version: z.number().int().min(0) }).parse(req.body || {});
  const out = await tx(async c => {
    const { rows: [cur] } = await c.query('SELECT version FROM group_policies WHERE org_id=$1 FOR UPDATE', [req.org.id]);
    const curVersion = cur ? cur.version : 0;
    if (b.version !== curVersion) return null;
    const { rows: [p] } = await c.query(`
      INSERT INTO group_policies(org_id, policy, version, updated_at) VALUES ($1,$2,1,now())
      ON CONFLICT (org_id) DO UPDATE SET policy=EXCLUDED.policy, version=group_policies.version+1, updated_at=now()
      RETURNING policy, version, updated_at`, [req.org.id, JSON.stringify(b.policy)]);
    const { rows: regions } = await c.query('SELECT id FROM orgs WHERE parent_org_id=$1', [req.org.id]);
    for (const r of regions) await notify(c, r.id, 'group_policy', `Head office updated group policy (v${p.version})`, b.policy.notes || null);
    return { ...DEFAULT_POLICY, ...p.policy, version: p.version, updated_at: p.updated_at };
  });
  if (!out) return res.status(409).json({ error: 'policy changed since you loaded it', current: await getPolicy(req.org.id) });
  res.json(out);
}));

group.get('/api/org/escalations', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  const params = [req.org.id]; let where = 'e.hq_org_id=$1';
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND e.status=$${params.length}`; }
  const { rows } = await q(`SELECT e.*, COALESCE(o.region_name, o.name) AS region_name FROM hq_escalations e JOIN orgs o ON o.id=e.region_org_id
                            WHERE ${where} ORDER BY e.created_at DESC LIMIT 200`, params);
  res.json({ escalations: rows });
}));
async function decideEscalation(req, res, status) {
  const note = z.object({ note: z.string().max(2000).optional() }).parse(req.body || {}).note ?? null;
  const out = await tx(async c => {
    const { rows: [e] } = await c.query(`UPDATE hq_escalations SET status=$3, decision_note=$4, decided_at=now()
                                         WHERE id=$1 AND hq_org_id=$2 AND status='awaiting_decision' RETURNING *`, [req.params.id, req.org.id, status, note]);
    if (!e) return null;
    await notify(c, e.region_org_id, 'hq_decision', `Head office ${status}: ${e.subject}`, note);
    return e;
  });
  if (!out) throw conflict('escalation is not awaiting a decision');
  res.json({ ok: true, escalation: out });
}
group.post('/api/org/escalations/:id/approve', requireOrg, requireHeadOffice, wrap((req, res) => decideEscalation(req, res, 'approved')));
group.post('/api/org/escalations/:id/decline', requireOrg, requireHeadOffice, wrap((req, res) => decideEscalation(req, res, 'declined')));

const RegionRequest = z.object({ region_id: z.string().uuid(), intent: z.string().min(1).max(120).regex(/^[a-z0-9_]+$/i, 'snake_case intent'), note: z.string().max(2000).optional() });
group.post('/api/org/region-requests', requireOrg, requireHeadOffice, idempotent, wrap(async (req, res) => {
  const b = RegionRequest.parse(req.body || {});
  const region = await getRegion(req.org.id, b.region_id);
  const r = await tx(async c => {
    const { rows: [r] } = await c.query(`INSERT INTO hq_region_requests(hq_org_id, region_org_id, intent, note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.org.id, region.id, b.intent.toLowerCase(), b.note || null]);
    await notify(c, region.id, 'hq_request', `Request from head office: ${r.intent}`, r.note);
    return r;
  });
  res.status(201).json({ request: r });
}));
group.get('/api/org/region-requests', requireOrg, requireHeadOffice, wrap(async (req, res) => {
  const params = [req.org.id]; let where = 'r.hq_org_id=$1';
  if (req.query.region_id) { params.push(String(req.query.region_id)); where += ` AND r.region_org_id=$${params.length}`; }
  const { rows } = await q(`SELECT r.*, COALESCE(o.region_name, o.name) AS region_name FROM hq_region_requests r JOIN orgs o ON o.id=r.region_org_id
                            WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`, params);
  res.json({ requests: rows });
}));

// ════════════════════════════════════════════════════════════════════════════
// Region side
// ════════════════════════════════════════════════════════════════════════════
// Like every other link here, permanent once claimed — there is no unlink.
group.post('/api/org/head-office/claim', requireOrg, requireNotHeadOffice, wrap(async (req, res) => {
  const b = z.object({ code: z.string().min(4).max(16), region_name: z.string().trim().min(1).max(120).optional() }).parse(req.body || {});
  if (req.org.parent_org_id) throw conflict('this PP Command is already linked to a head office');
  const out = await tx(async c => {
    const { rows: [lc] } = await c.query(`SELECT * FROM link_codes WHERE code=$1 AND kind='region' FOR UPDATE`, [b.code.trim().toUpperCase()]);
    if (!lc) throw notFound('unknown code');
    if (lc.status === 'used') throw conflict('code already used');
    if (lc.status === 'revoked') throw conflict('code revoked');
    if (lc.status === 'expired' || new Date(lc.expires_at) < new Date()) {
      await c.query("UPDATE link_codes SET status='expired' WHERE id=$1", [lc.id]);
      throw conflict('code expired');
    }
    const regionName = b.region_name || lc.hint || req.org.name;
    const { rows: [o] } = await c.query(`UPDATE orgs SET parent_org_id=$2, region_name=$3, parent_linked_at=now() WHERE id=$1 AND parent_org_id IS NULL RETURNING *`,
      [req.org.id, lc.org_id, regionName]);
    if (!o) throw conflict('this PP Command is already linked to a head office');
    await c.query(`UPDATE link_codes SET status='used', used_at=now(), region_org_id=$2 WHERE id=$1`, [lc.id, req.org.id]);
    await notify(c, lc.org_id, 'region_linked', `${regionName} linked to head office`, null);
    const { rows: [hq] } = await c.query('SELECT id, name FROM orgs WHERE id=$1', [lc.org_id]);
    return { hq, regionName };
  });
  res.json({ ok: true, head_office: { id: out.hq.id, name: out.hq.name }, region_name: out.regionName });
}));

group.get('/api/org/head-office', requireOrg, wrap(async (req, res) => {
  if (isHeadOffice(req.org)) return res.json({ role: 'head_office', linked: false });
  if (!req.org.parent_org_id) return res.json({ role: 'standalone', linked: false });
  const { rows: [hq] } = await q('SELECT id, name FROM orgs WHERE id=$1', [req.org.parent_org_id]);
  const { rows: escalations } = await q(`SELECT id, subject, body, amount_cents, status, decision_note, created_at, decided_at FROM hq_escalations
                                         WHERE region_org_id=$1 AND hq_org_id=$2 ORDER BY created_at DESC LIMIT 100`, [req.org.id, req.org.parent_org_id]);
  const { rows: requests } = await q(`SELECT id, intent, note, status, response_text, created_at, answered_at FROM hq_region_requests
                                      WHERE region_org_id=$1 AND hq_org_id=$2 ORDER BY created_at DESC LIMIT 100`, [req.org.id, req.org.parent_org_id]);
  res.json({
    role: 'region', linked: true, head_office: hq, region_name: req.org.region_name, linked_at: req.org.parent_linked_at,
    policy: await getPolicy(req.org.parent_org_id),
    escalations, requests,
    visible_to_head_office: await regionReport(req.org),   // exactly what head office can see of this region
  });
}));

async function requireLinkedRegion(req, _res, next) {
  next(req.org.parent_org_id ? undefined : conflict('not linked to a head office'));
}
const EscBody = z.object({ subject: z.string().trim().min(1).max(300), body: z.string().max(4000).optional(), amount_cents: z.number().int().min(0).optional() });
group.post('/api/org/head-office/escalations', requireOrg, requireLinkedRegion, idempotent, wrap(async (req, res) => {
  const b = EscBody.parse(req.body || {});
  const e = await tx(async c => {
    const { rows: [e] } = await c.query(`INSERT INTO hq_escalations(hq_org_id, region_org_id, subject, body, amount_cents) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.org.parent_org_id, req.org.id, b.subject, b.body || null, b.amount_cents ?? null]);
    await notify(c, req.org.parent_org_id, 'escalation', `${req.org.region_name || req.org.name} escalated: ${b.subject}`, b.body);
    return e;
  });
  res.status(201).json({ escalation: e });
}));
group.post('/api/org/head-office/escalations/:id/withdraw', requireOrg, requireLinkedRegion, wrap(async (req, res) => {
  const { rowCount } = await q(`UPDATE hq_escalations SET status='withdrawn', decided_at=now() WHERE id=$1 AND region_org_id=$2 AND status='awaiting_decision'`, [req.params.id, req.org.id]);
  if (!rowCount) throw conflict('escalation is not awaiting a decision');
  res.json({ ok: true });
}));
group.post('/api/org/head-office/requests/:id/answer', requireOrg, requireLinkedRegion, wrap(async (req, res) => {
  const b = z.object({ response_text: z.string().trim().min(1).max(4000) }).parse(req.body || {});
  const r = await tx(async c => {
    const { rows: [r] } = await c.query(`UPDATE hq_region_requests SET status='answered', response_text=$3, answered_at=now()
                                         WHERE id=$1 AND region_org_id=$2 AND status='sent' RETURNING *`, [req.params.id, req.org.id, b.response_text]);
    if (!r) return null;
    await notify(c, r.hq_org_id, 'region_answer', `${req.org.region_name || req.org.name} answered: ${r.intent}`, b.response_text);
    return r;
  });
  if (!r) throw conflict('request is not open');
  res.json({ ok: true, request: r });
}));
