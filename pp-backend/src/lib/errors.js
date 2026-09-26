export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (m, x) => new HttpError(400, m, x);
export const unauth = (m = 'unauthorized') => new HttpError(401, m);
export const forbidden = (m = 'forbidden') => new HttpError(403, m);
export const notFound = (m = 'not found') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

// Wrap async route handlers so thrown errors reach the error middleware.
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorMiddleware(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err && err.name === 'ZodError') return res.status(400).json({ error: 'invalid request', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
}
