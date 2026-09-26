// Endpoints called by a café's PP app (Gavin). Auth: site JWT.
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { q, tx } from '../lib/db.js';
import { requireSite, signSite } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { wrap, bad, notFound, conflict } from '../lib/errors.js';
import { SNAPSHOT_KEYS } from '../lib/rules.js';

export const site = Router();

// ── 3.1 Link a venue to an org ─────────────────────────────────────────────
const RedeemBody = z.object({
  code: z.string().min(4).max(16),
  venue: z.object({
    venue_id: z.string().min(1).max(120),
    cafe_name: z.string().min(1).max(200),
    suburb: z.string().max(120).optional(),
    state: z.string().max(10).optional(),
    timezone: z.string().max(60).optional(),
  }),
});
async function redeem(req, res) {
  const { code, venue } = RedeemBody.parse(req.body);
  const out = await tx(async c => {
    const { rows: [lc] } = await c.query('SELECT * FROM link_codes WHERE code=$1 FOR UPDATE', [code.trim().toUpperCase()]);
    if (!lc) throw notFound('unknown code');
    if (lc.status === 'used') throw conflict('code already used');
    if (lc.status === 'revoked') throw conflict('code revoked');
    if (lc.status === 'expired' || new Date(lc.expires_at) < new Date()) {
      await c.query("UPDATE link_codes SET status='expired' WHERE id=$1", [lc.id]);
      throw conflict('code expired');
    }
    const { rows: [dup] } = await c.query('SELECT id FROM sites WHERE external_venue_id=$1', [venue.venue_id]);
    if (dup) throw conflict('venue already linked');
    const { rows: [s] } = await c.query(
      `INSERT INTO sites(org_id, external_venue_id, name, suburb, state, timezone)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'Australia/Melbourne')) RETURNING *`,
      [lc.org_id, venue.venue_id, venue.cafe_name || lc.hint || 'New site', venue.suburb || null, venue.state || null, venue.timezone || null]);
    await c.query("UPDATE link_codes SET status='used', used_at=now(), site_id=$2 WHERE id=$1", [lc.id, s.id]);
    const { rows: [org] } = await c.query('SELECT id, name FROM orgs WHERE id=$1', [lc.org_id]);
    await c.query(`INSERT INTO org_notifications(org_id,type,subject,body) VALUES ($1,'site_linked',$2,$3)`,
      [org.id, `${s.name} linked`, `Venue ${venue.venue_id} redeemed code ${lc.code}.`]);
    return { s, org };
  });
  res.json({
    token: signSite(out.s), site_id: out.s.id, org_id: out.org.id, org_name: out.org.name,
    // Only these keys are merged into PP's cafeDetails — never overwrite the café's own details.
    venue: { id: out.s.id, name: out.s.name },
  });
}
site.post('/api/link/redeem', wrap(redeem));
// Legacy alias: PP_API.authenticate() posts { apiKey } to /auth/token. Treat apiKey as the link code
// and take venue details from the optional `venue` field (PP is updated to send it, §7.1).
site.post('/auth/token', wrap(async (req, res) => {
  req.body = { code: req.body.apiKey || req.body.code, venue: req.body.venue || { venue_id: req.body.venue_id, cafe_name: req.body.cafe_name } };
  return redeem(req, res);
}));

site.post('/api/link/refresh', requireSite, wrap(async (req, res) => {
  res.json({ token: signSite(req.site) });
}));

// ── 3.2 Promoted snapshot ──────────────────────────────────────────────────
const MenuItem = z.object({ name: z.string().min(1).max(200), sellingPrice: z.number().nonnegative().optional(), price: z.number().nonnegative().optional(), category: z.string().max(80).optional() });
const PayrollLine = z.object({ name: z.string().max(200), role: z.string().max(120).optional(), hourly_rate_cents: z.number().int().nonnegative(), hours_this_period: z.number().nonnegative() });
const Snapshot = z.object({
  venue_id: z.string().optional(), cafe_name: z.string().optional(), timestamp: z.string().optional(),
  revenue_week: z.number().optional(), gp_pct: z.number().optional(), labour_pct: z.number().optional(), covers_week: z.number().int().optional(),
  stock_out: z.number().int().optional(), stock_low: z.number().int().optional(),
  stock_out_items: z.array(z.string().max(200)).max(50).optional(), stock_low_items: z.array(z.string().max(200)).max(50).optional(),
  stock_value: z.number().optional(), open_orders: z.number().int().optional(),
  loyalty: z.object({ total_members: z.number().int().optional(), active_members: z.number().int().optional(), avg_points: z.number().optional(), redemptions: z.number().int().optional() }).optional(),
  menu_items: z.array(MenuItem).max(500).optional(),
  shared_payroll: z.array(PayrollLine).max(500).optional(),
}).strict();

site.post('/api/venue/snapshot', requireSite, wrap(async (req, res) => {
  // The boundary: unknown keys are a hard 400, not silently dropped.
  const extra = Object.keys(req.body || {}).filter(k => !SNAPSHOT_KEYS.has(k));
  if (extra.length) throw bad('snapshot contains keys that are not promoted to PP Command', { rejected_keys: extra });
  const s = Snapshot.parse(req.body);
  if (s.venue_id && s.venue_id !== req.site.external_venue_id) throw bad('venue_id does not match this site token');

  const received = await tx(async c => {
    const { rows: [snap] } = await c.query(
      `INSERT INTO site_snapshots(site_id, revenue_week, gp_pct, labour_pct, covers_week, stock_out, stock_low, stock_out_items, stock_low_items, stock_value, open_orders, loyalty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING received_at`,
      [req.site.id, s.revenue_week ?? null, s.gp_pct ?? null, s.labour_pct ?? null, s.covers_week ?? null, s.stock_out ?? null, s.stock_low ?? null,
       s.stock_out_items ?? null, s.stock_low_items ?? null, s.stock_value ?? null, s.open_orders ?? null, s.loyalty ?? null]);
    if (s.cafe_name && s.cafe_name !== req.site.name) await c.query('UPDATE sites SET name=$2 WHERE id=$1', [req.site.id, s.cafe_name]);
    if (s.menu_items) {
      await c.query('UPDATE menu_items SET active=false WHERE site_id=$1', [req.site.id]);
      for (const m of s.menu_items) {
        await c.query(`INSERT INTO menu_items(site_id,name,category,price,active,updated_at) VALUES ($1,$2,$3,$4,true,now())
                       ON CONFLICT (site_id,name) DO UPDATE SET category=EXCLUDED.category, price=EXCLUDED.price, active=true, updated_at=now()`,
          [req.site.id, m.name, m.category || null, m.sellingPrice ?? m.price ?? 0]);
      }
    }
    if (s.shared_payroll) {
      await c.query(`INSERT INTO site_shared_payroll(site_id,lines,updated_at) VALUES ($1,$2,now()) ON CONFLICT (site_id) DO UPDATE SET lines=EXCLUDED.lines, updated_at=now()`, [req.site.id, JSON.stringify(s.shared_payroll)]);
      await c.query('UPDATE sites SET share_payroll=true WHERE id=$1', [req.site.id]);
    } else {
      // Opt-out must stick: absent means clear.
      await c.query('DELETE FROM site_shared_payroll WHERE site_id=$1', [req.site.id]);
      await c.query('UPDATE sites SET share_payroll=false WHERE id=$1', [req.site.id]);
    }
    // Keep the table bounded: last 500 snapshots per site.
    await c.query(`DELETE FROM site_snapshots WHERE site_id=$1 AND id NOT IN (SELECT id FROM site_snapshots WHERE site_id=$1 ORDER BY received_at DESC LIMIT 500)`, [req.site.id]);
    return snap.received_at;
  });
  res.json({ ok: true, received_at: received });
}));

// ── 3.3 Ronin → Gavin inbox ────────────────────────────────────────────────
site.get('/api/venue/inbox', requireSite, wrap(async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const params = [req.site.id];
  let where = `site_id=$1 AND direction='ronin_to_gavin' AND status IN ('sent','approved','awaiting_approval')`;
  if (since && !isNaN(since)) { params.push(since.toISOString()); where += ` AND created_at > $${params.length}`; }
  const { rows } = await q(`SELECT id, direction, intent, note, requires_manager_approval, status, coordination_id, approved_at, created_at
                            FROM ronin_gavin_messages WHERE ${where} ORDER BY created_at ASC LIMIT 200`, params);
  // Gavin may act on sent/approved; awaiting_approval is shown so the site manager can approve on the café's screen.
  res.json({ messages: rows, actionable: rows.filter(m => m.status !== 'awaiting_approval').map(m => m.id) });
}));

const Ack = z.object({ status: z.enum(['completed', 'declined', 'failed']), note: z.string().max(2000).optional(), result: z.any().optional() });
site.post('/api/venue/inbox/:id/ack', requireSite, idempotent, wrap(async (req, res) => {
  const body = Ack.parse(req.body);
  await tx(async c => {
    const { rows: [m] } = await c.query(`SELECT * FROM ronin_gavin_messages WHERE id=$1 AND site_id=$2 FOR UPDATE`, [req.params.id, req.site.id]);
    if (!m) throw notFound('message not found');
    if (!['sent', 'approved'].includes(m.status)) throw conflict(`message is ${m.status}; only sent/approved messages can be acknowledged`);
    await c.query(`UPDATE ronin_gavin_messages SET status=$2, result=$3 WHERE id=$1`, [m.id, body.status, body.result ?? null]);
    await c.query(`INSERT INTO ronin_gavin_messages(org_id, site_id, direction, intent, note, requires_manager_approval, status, coordination_id, reply_to)
                   VALUES ($1,$2,'gavin_to_ronin',$3,$4,false,$5,$6,$7)`,
      [m.org_id, m.site_id, m.intent, body.note || (body.status === 'completed' ? `Done — ${m.note || m.intent}` : `${body.status} — ${m.note || m.intent}`), body.status, m.coordination_id, m.id]);
    await c.query(`INSERT INTO org_notifications(org_id,type,subject,body) VALUES ($1,$2,$3,$4)`,
      [m.org_id, body.status === 'completed' ? 'task_done' : 'task_failed', `${req.site.name} ${body.status}: ${m.intent}`, body.note || m.note || '']);
  });
  res.json({ ok: true });
}));

// Site-side approval of a Ronin request (the real path — the café's own manager approves on the café's screen).
site.post('/api/venue/inbox/:id/approve', requireSite, wrap(async (req, res) => {
  const { rowCount } = await q(`UPDATE ronin_gavin_messages SET status='approved', approved_by='site', approved_at=now()
                                WHERE id=$1 AND site_id=$2 AND status='awaiting_approval'`, [req.params.id, req.site.id]);
  if (!rowCount) throw conflict('message not awaiting approval');
  res.json({ ok: true, status: 'approved' });
}));
site.post('/api/venue/inbox/:id/decline', requireSite, wrap(async (req, res) => {
  const { rows: [m] } = await q(`UPDATE ronin_gavin_messages SET status='declined', approved_by='site', approved_at=now()
                                 WHERE id=$1 AND site_id=$2 AND status='awaiting_approval' RETURNING org_id, intent`, [req.params.id, req.site.id]);
  if (!m) throw conflict('message not awaiting approval');
  await q(`INSERT INTO org_notifications(org_id,type,subject,body) VALUES ($1,'request_declined',$2,$3)`, [m.org_id, `${req.site.name} declined: ${m.intent}`, String(req.body?.note || '')]);
  res.json({ ok: true, status: 'declined' });
}));

// ── 3.4 Encrypted full backup ──────────────────────────────────────────────
const KEY = crypto.createHash('sha256').update(process.env.BACKUP_KEY || process.env.JWT_SECRET || 'dev-secret-change-me').digest();
function encrypt(obj) {
  const iv = crypto.randomBytes(12); const ci = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([ci.update(JSON.stringify(obj), 'utf8'), ci.final()]);
  return Buffer.concat([iv, ci.getAuthTag(), enc]);
}
function decrypt(buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const de = crypto.createDecipheriv('aes-256-gcm', KEY, iv); de.setAuthTag(tag);
  return JSON.parse(Buffer.concat([de.update(enc), de.final()]).toString('utf8'));
}
site.post('/api/venue/sync', requireSite, wrap(async (req, res) => {
  if (!req.body || typeof req.body.data !== 'object') throw bad('data object required');
  const pushed = req.body.pushed_at ? new Date(req.body.pushed_at) : new Date();
  await q(`INSERT INTO site_backups(site_id,ciphertext,key_id,pushed_at) VALUES ($1,$2,'k1',$3)
           ON CONFLICT (site_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, pushed_at=EXCLUDED.pushed_at`, [req.site.id, encrypt(req.body.data), pushed]);
  res.json({ ok: true, pushed_at: pushed });
}));
site.get('/api/venue/sync', requireSite, wrap(async (req, res) => {
  const { rows: [b] } = await q('SELECT ciphertext, pushed_at FROM site_backups WHERE site_id=$1', [req.site.id]);
  if (!b) return res.json({ data: null });
  res.json({ data: decrypt(b.ciphertext), pushed_at: b.pushed_at });
}));

// ── 3.5 Onboarding stubs + health ──────────────────────────────────────────
site.get('/api/onboard/pending', requireSite, wrap(async (_req, res) => res.json({ submissions: [] })));
site.post('/api/onboard/:id/import', requireSite, wrap(async (_req, res) => res.json({ ok: true })));
site.get('/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
