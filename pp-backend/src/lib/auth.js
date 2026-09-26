import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { q } from './db.js';
import { unauth, forbidden } from './errors.js';

const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me');
if (!SECRET) throw new Error('JWT_SECRET must be set in production');

export const hash = pw => argon2.hash(pw);
export const verifyHash = (h, pw) => argon2.verify(h, pw).catch(() => false);

// Crypto-random, unambiguous code (no 0/O/1/I) — same alphabet the Command UI uses.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function linkCode(len = 8) {
  const buf = crypto.randomBytes(len);
  return Array.from(buf, b => ALPHABET[b % ALPHABET.length]).join('');
}
export const orgApiKey = () => 'ppo_' + crypto.randomBytes(24).toString('base64url');

export const signSite = site => jwt.sign({ kind: 'site', sub: site.id, site_id: site.id, org_id: site.org_id }, SECRET, { expiresIn: '30d' });
export const signStaff = s => jwt.sign({ kind: 'staff', sub: s.id, role: s.role, name: s.name }, SECRET, { expiresIn: '12h' });

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Site JWT → req.site
export async function requireSite(req, _res, next) {
  try {
    const tok = bearer(req); if (!tok) throw unauth('site token required');
    const claims = jwt.verify(tok, SECRET);
    if (claims.kind !== 'site') throw unauth('site token required');
    const { rows } = await q('SELECT * FROM sites WHERE id=$1', [claims.site_id]);
    if (!rows[0]) throw unauth('site no longer linked');
    req.site = rows[0]; req.principal = 'site:' + rows[0].id;
    next();
  } catch (e) { next(e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError' ? unauth('invalid or expired token') : e); }
}

// X-Org-Key → req.org. Keys are argon2-hashed; we look up by hint (last 4) then verify.
export async function requireOrg(req, _res, next) {
  try {
    const key = req.headers['x-org-key']; if (!key) throw unauth('X-Org-Key required');
    const { rows } = await q('SELECT * FROM orgs WHERE api_key_hint=$1', [String(key).slice(-4)]);
    for (const org of rows) if (await verifyHash(org.api_key_hash, key)) { req.org = org; req.principal = 'org:' + org.id; return next(); }
    throw unauth('invalid org key');
  } catch (e) { next(e); }
}

// Staff JWT → req.staff; optional minimum role.
const RANK = { 'IT Staff': 1, 'Sales Manager': 2, 'Owner': 3 };
export const requireStaff = (minRole) => async (req, _res, next) => {
  try {
    const tok = bearer(req); if (!tok) throw unauth('staff token required');
    const claims = jwt.verify(tok, SECRET);
    if (claims.kind !== 'staff') throw unauth('staff token required');
    const { rows } = await q('SELECT id, name, email, role, active FROM pp_staff WHERE id=$1', [claims.sub]);
    if (!rows[0] || !rows[0].active) throw unauth('staff account disabled');
    if (minRole && (RANK[rows[0].role] || 0) < (RANK[minRole] || 0)) throw forbidden(`${minRole} role required`);
    req.staff = rows[0]; req.principal = 'staff:' + rows[0].id;
    next();
  } catch (e) { next(e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError' ? unauth('invalid or expired token') : e); }
};

// Accept either a site token for a given site, or an org key — used by message approval.
export async function siteOrOrg(req, res, next) {
  if (bearer(req)) return requireSite(req, res, next);
  if (req.headers['x-org-key']) return requireOrg(req, res, next);
  next(unauth('site token or X-Org-Key required'));
}
