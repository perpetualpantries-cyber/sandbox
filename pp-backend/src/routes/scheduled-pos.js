// Server-managed scheduled POs — only for events where the café has opted
// into poAutoSend (auto-email the supplier, no human review step). Draft-only
// scheduled POs stay entirely client-side; this table/route exists so an
// auto-send promise doesn't depend on the café's browser staying open.
import { Router } from 'express';
import { z } from 'zod';
import { q } from '../lib/db.js';
import { requireSite } from '../lib/auth.js';
import { wrap, notFound, bad } from '../lib/errors.js';

export const scheduledPos = Router();

const LineItem = z.object({ name: z.string().min(1).max(200), qty: z.number().nonnegative(), unit: z.string().max(20), unit_cost: z.number().nonnegative().optional() });
const CreateBody = z.object({
  event_name: z.string().min(1).max(200),
  event_date: z.string().optional(),
  po_number: z.string().max(60).optional(),
  supplier_name: z.string().min(1).max(200),
  supplier_email: z.string().email().optional(),
  lines: z.array(LineItem).min(1).max(200),
  release_date: z.string().min(1),
});

scheduledPos.post('/api/venue/scheduled-pos', requireSite, wrap(async (req, res) => {
  const b = CreateBody.parse(req.body);
  const total = b.lines.reduce((t, l) => t + l.qty * (l.unit_cost || 0), 0);
  if (isNaN(Date.parse(b.release_date))) throw bad('release_date must be a valid date (YYYY-MM-DD)');
  const { rows: [row] } = await q(
    `INSERT INTO scheduled_pos(site_id, event_name, event_date, po_number, supplier_name, supplier_email, lines, total, release_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.site.id, b.event_name, b.event_date || null, b.po_number || null, b.supplier_name, b.supplier_email || null, JSON.stringify(b.lines), total, b.release_date]);
  res.status(201).json(row);
}));

scheduledPos.get('/api/venue/scheduled-pos', requireSite, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM scheduled_pos WHERE site_id=$1 ORDER BY release_date, created_at', [req.site.id]);
  res.json({ scheduled_pos: rows });
}));

scheduledPos.delete('/api/venue/scheduled-pos/:id', requireSite, wrap(async (req, res) => {
  const { rowCount } = await q(
    `UPDATE scheduled_pos SET status='cancelled' WHERE id=$1 AND site_id=$2 AND status='scheduled'`,
    [req.params.id, req.site.id]);
  if (!rowCount) throw notFound('scheduled PO not found, not yours, or already released');
  res.json({ ok: true });
}));
