// PPcanopy's collections, stored server-side. Auth: PP staff JWT.
// Each collection is one JSON value under a fixed key, versioned for optimistic concurrency.
import { Router } from 'express';
import { z } from 'zod';
import { q } from '../lib/db.js';
import { requireStaff } from '../lib/auth.js';
import { wrap, bad, forbidden, HttpError } from '../lib/errors.js';

export const canopyStore = Router();

// Minimum role to read / write each collection. Mirrors PPcanopy's tab permissions:
// IT Staff only sees team, schedule, ordering, hours and comms; pricing is Owner-only to change.
const RANK = { 'IT Staff': 1, 'Sales Manager': 2, 'Owner': 3 };
const KEYS = {
  clients: ['Sales Manager', 'Sales Manager'], prospects: ['Sales Manager', 'Sales Manager'], approvals: ['Sales Manager', 'Sales Manager'], quotes: ['Sales Manager', 'Sales Manager'], requests: ['Sales Manager', 'Sales Manager'],
  salesRecords: ['Sales Manager', 'Sales Manager'], meetings: ['Sales Manager', 'Sales Manager'], escalations: ['Sales Manager', 'Sales Manager'],
  invoices: ['Sales Manager', 'Sales Manager'], invoiceSettings: ['Sales Manager', 'Sales Manager'], canopy_ronin_asks: ['Sales Manager', 'Sales Manager'],
  pricing: ['Sales Manager', 'Owner'], pipelineStages: ['Sales Manager', 'Owner'],
  teamMembers: ['IT Staff', 'IT Staff'], scheduleItems: ['IT Staff', 'IT Staff'], orders: ['IT Staff', 'IT Staff'], suppliers: ['IT Staff', 'IT Staff'],
  nextPoNumber: ['IT Staff', 'IT Staff'], hoursLog: ['IT Staff', 'IT Staff'], internalComms: ['IT Staff', 'IT Staff'],
};
const can = (staff, key, mode) => (RANK[staff.role] || 0) >= RANK[KEYS[key][mode === 'read' ? 0 : 1]];

canopyStore.get('/api/pp/store', requireStaff(), wrap(async (req, res) => {
  const readable = Object.keys(KEYS).filter(k => can(req.staff, k, 'read'));
  const { rows } = await q(`SELECT c.key, c.value, c.version, c.updated_at, s.name AS updated_by
                            FROM canopy_store c LEFT JOIN pp_staff s ON s.id=c.updated_by WHERE c.key = ANY($1)`, [readable]);
  res.json({ items: Object.fromEntries(rows.map(r => [r.key, { value: r.value, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by }])), readable });
}));

const PutBody = z.object({ value: z.any().refine(v => v !== undefined, 'value is required'), version: z.number().int().min(0) });
canopyStore.put('/api/pp/store/:key', requireStaff(), wrap(async (req, res) => {
  const key = req.params.key;
  if (!KEYS[key]) throw bad('unknown PPcanopy collection', { key });
  if (!can(req.staff, key, 'write')) throw forbidden(`${KEYS[key][1]} role required to change ${key}`);
  const b = PutBody.parse(req.body);
  // version = the version the client last saw; 0 means "creating it".
  const { rows: [row] } = b.version === 0
    ? await q(`INSERT INTO canopy_store(key, value, version, updated_by) VALUES ($1,$2,1,$3) ON CONFLICT (key) DO NOTHING RETURNING version, updated_at`, [key, JSON.stringify(b.value), req.staff.id])
    : await q(`UPDATE canopy_store SET value=$2, version=version+1, updated_at=now(), updated_by=$4 WHERE key=$1 AND version=$3 RETURNING version, updated_at`, [key, JSON.stringify(b.value), b.version, req.staff.id]);
  if (!row) {
    const { rows: [cur] } = await q(`SELECT c.value, c.version, c.updated_at, s.name AS updated_by FROM canopy_store c LEFT JOIN pp_staff s ON s.id=c.updated_by WHERE c.key=$1`, [key]);
    throw new HttpError(409, `${key} was changed by someone else`, { current: cur || null });
  }
  res.json({ key, version: row.version, updated_at: row.updated_at });
}));
