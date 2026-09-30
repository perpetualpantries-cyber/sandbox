// Approval notifications and outbound email for PPcanopy (Canopy asks staff to approve a step).
// Push: Web Push with a VAPID key pair the server generates once and keeps in server_settings.
// Email: Resend (same account as scheduled POs); if it isn't configured the routes say so.
import { Router } from 'express';
import { z } from 'zod';
import webpush from 'web-push';
import { q } from '../lib/db.js';
import { requireStaff } from '../lib/auth.js';
import { wrap, bad } from '../lib/errors.js';
import { emailConfigured, sendEmail } from '../lib/mailer.js';

export const notify = Router();

let vapidCache = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  let { rows: [r] } = await q(`SELECT value FROM server_settings WHERE key='vapid'`);
  if (!r) {
    const k = webpush.generateVAPIDKeys();
    await q(`INSERT INTO server_settings(key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(k)]);
    ({ rows: [r] } = await q(`SELECT value FROM server_settings WHERE key='vapid'`));   // another instance may have won the race
  }
  vapidCache = r.value;
  return vapidCache;
}

notify.get('/api/pp/notify/config', requireStaff(), wrap(async (_req, res) => {
  res.json({ email: emailConfigured(), push_public_key: (await vapid()).publicKey });
}));

const Sub = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().min(10).max(400), auth: z.string().min(4).max(200) }) });
notify.post('/api/pp/push/subscribe', requireStaff(), wrap(async (req, res) => {
  const s = Sub.parse(req.body?.subscription || req.body);
  await q(`INSERT INTO push_subscriptions(staff_id, endpoint, keys) VALUES ($1,$2,$3)
           ON CONFLICT (endpoint) DO UPDATE SET staff_id=EXCLUDED.staff_id, keys=EXCLUDED.keys`, [req.staff.id, s.endpoint, JSON.stringify(s.keys)]);
  res.status(201).json({ ok: true });
}));
notify.post('/api/pp/push/unsubscribe', requireStaff(), wrap(async (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  await q('DELETE FROM push_subscriptions WHERE endpoint=$1 AND staff_id=$2', [endpoint, req.staff.id]);
  res.json({ ok: true });
}));

// Tell the people who approve (Owner + Sales Managers) that something needs them.
const NotifyBody = z.object({ title: z.string().min(1).max(120), body: z.string().max(1000).default(''), url: z.string().max(500).optional(), tag: z.string().max(120).optional() });
notify.post('/api/pp/notify', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const n = NotifyBody.parse(req.body || {});
  const { rows: staff } = await q(`SELECT id, email FROM pp_staff WHERE active AND role IN ('Owner','Sales Manager')`);
  const out = { emailed: 0, email_error: null, pushed: 0, push_failed: 0 };
  if (emailConfigured() && staff.length) {
    try {
      await sendEmail({ to: staff.map(s => s.email), subject: n.title, text: `${n.body}\n\nOpen PPcanopy to approve or decline: ${n.url || 'https://pp-apps.vercel.app/ppcanopy.html'}` });
      out.emailed = staff.length;
    } catch (e) { out.email_error = e.message; }
  } else if (!emailConfigured()) out.email_error = 'email not configured';
  const { rows: subs } = await q('SELECT id, endpoint, keys FROM push_subscriptions WHERE staff_id = ANY($1)', [staff.map(s => s.id)]);
  if (subs.length) {
    const v = await vapid();
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url || '/ppcanopy.html', tag: n.tag || 'canopy-approval' });
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload,
          { vapidDetails: { subject: 'https://pp-apps.vercel.app', publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 86400 });
        out.pushed++; await q('UPDATE push_subscriptions SET last_ok_at=now() WHERE id=$1', [s.id]);
      } catch (e) {
        out.push_failed++;
        if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);   // device gone
      }
    }));
  }
  res.json(out);
}));

// Email a quote (or anything else) to a client, with an optional PDF attachment.
const EmailBody = z.object({
  to: z.string().email().max(320), subject: z.string().min(1).max(200), text: z.string().min(1).max(20000),
  reply_to: z.string().email().max(320).optional(),
  attachment: z.object({ filename: z.string().min(1).max(120), content_base64: z.string().max(7_000_000) }).optional(),
});
notify.post('/api/pp/email', requireStaff('Sales Manager'), wrap(async (req, res) => {
  const b = EmailBody.parse(req.body || {});
  if (!emailConfigured()) return res.status(503).json({ error: 'email not configured on the server' });
  try {
    const r = await sendEmail({ to: b.to, subject: b.subject, text: b.text, replyTo: b.reply_to || req.staff.email, attachments: b.attachment ? [b.attachment] : [] });
    res.json({ ok: true, id: r.id || null });
  } catch (e) { throw bad('email failed: ' + e.message); }
}));
