// Public org-level linking: no auth (the code itself is the proof), same
// shape as the existing /api/link/redeem for sites. PP Command calls this
// once, with the code PPcanopy generated at client-creation time (or via
// POST /api/pp/clients/:id/link-codes if the first one was lost pre-claim).
import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../lib/db.js';
import { hash, orgApiKey } from '../lib/auth.js';
import { wrap, notFound, conflict } from '../lib/errors.js';

export const link = Router();

const ClaimBody = z.object({ code: z.string().min(4).max(16) });
link.post('/api/org/link/claim', wrap(async (req, res) => {
  const { code } = ClaimBody.parse(req.body);
  const out = await tx(async c => {
    const { rows: [lc] } = await c.query(`SELECT * FROM link_codes WHERE code=$1 AND kind='org' FOR UPDATE`, [code.trim().toUpperCase()]);
    if (!lc) throw notFound('unknown code');
    if (lc.status === 'used') throw conflict('code already used');
    if (lc.status === 'revoked') throw conflict('code revoked');
    if (lc.status === 'expired' || new Date(lc.expires_at) < new Date()) {
      await c.query("UPDATE link_codes SET status='expired' WHERE id=$1", [lc.id]);
      throw conflict('code expired');
    }
    const key = orgApiKey();
    const { rows: [o] } = await c.query(
      `UPDATE orgs SET api_key_hash=$2, api_key_hint=$3 WHERE id=$1 RETURNING id, name, sector, command_tier`,
      [lc.org_id, await hash(key), key.slice(-4)]);
    await c.query(`UPDATE link_codes SET status='used', used_at=now() WHERE id=$1`, [lc.id]);
    return { org: o, key };
  });
  res.json({ org_id: out.org.id, org_name: out.org.name, command_tier: out.org.command_tier, api_key: out.key });
}));
