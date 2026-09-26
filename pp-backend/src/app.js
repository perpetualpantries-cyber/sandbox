import express from 'express';
import { site } from './routes/site.js';
import { org } from './routes/org.js';
import { pp } from './routes/pp.js';
import { link } from './routes/link.js';
import { scheduledPos } from './routes/scheduled-pos.js';
import { cron } from './routes/cron.js';
import { errorMiddleware } from './lib/errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));   // /api/venue/sync carries a full backup

  // CORS — the three frontends are static HTML served from anywhere (file://, artifact, S3).
  const allow = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
  app.use((req, res, next) => {
    const o = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', allow.includes('*') ? '*' : (allow.includes(o) ? o : 'null'));
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Org-Key, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Very small in-memory rate limiter per principal-ish key (IP until authenticated). Replace with Redis in prod.
  const buckets = new Map();
  app.use((req, res, next) => {
    const k = req.headers['x-org-key'] ? 'org:' + String(req.headers['x-org-key']).slice(-8) : (req.headers.authorization ? 'tok:' + req.headers.authorization.slice(-16) : 'ip:' + req.ip);
    const now = Date.now(); const b = buckets.get(k) || { n: 0, t: now };
    if (now - b.t > 60000) { b.n = 0; b.t = now; }
    b.n++; buckets.set(k, b);
    const limit = k.startsWith('org:') ? 300 : k.startsWith('tok:') ? 600 : 60;
    if (b.n > limit) return res.status(429).json({ error: 'rate limited' });
    next();
  });
  // Never log bodies for the backup route.
  app.use((req, _res, next) => { if (process.env.LOG_REQUESTS && !req.path.startsWith('/api/venue/sync')) console.log(req.method, req.path); next(); });

  app.use(site); app.use(org); app.use(pp); app.use(link); app.use(scheduledPos); app.use(cron);
  app.use((_req, res) => res.status(404).json({ error: 'no such route' }));
  app.use(errorMiddleware);
  return app;
}
