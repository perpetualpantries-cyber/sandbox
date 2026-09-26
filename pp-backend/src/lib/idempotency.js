import { q } from './db.js';

// Replays a previous response for the same (principal, Idempotency-Key) within 24h.
export function idempotent(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key || !req.principal) return next();
  q('SELECT status_code, body FROM idempotency_keys WHERE principal=$1 AND key=$2 AND created_at > now() - interval \'24 hours\'', [req.principal, key])
    .then(({ rows }) => {
      if (rows[0]) return res.status(rows[0].status_code).set('Idempotent-Replay', 'true').json(rows[0].body);
      const orig = res.json.bind(res);
      res.json = body => {
        q('INSERT INTO idempotency_keys(principal,key,status_code,body) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [req.principal, key, res.statusCode, body]).catch(() => {});
        return orig(body);
      };
      next();
    }).catch(next);
}
