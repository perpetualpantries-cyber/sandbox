// Fires on a schedule (Vercel Cron -> vercel.json), independent of any
// browser being open. Releases every scheduled PO whose release_date has
// arrived and sends the supplier email. Protected by CRON_SECRET, not user
// auth — this is a machine-to-machine endpoint.
import { Router } from 'express';
import { q } from '../lib/db.js';
import { wrap, unauth } from '../lib/errors.js';
import { sendPoEmail } from '../lib/mailer.js';

export const cron = Router();

cron.get('/api/cron/release-scheduled-pos', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw unauth('CRON_SECRET not configured');
  if (req.headers['authorization'] !== `Bearer ${secret}`) throw unauth('bad cron secret');

  const { rows: due } = await q(
    `SELECT * FROM scheduled_pos WHERE status='scheduled' AND release_date <= CURRENT_DATE`);

  let sent = 0, failed = 0;
  for (const po of due) {
    await q(`UPDATE scheduled_pos SET status='released', released_at=now() WHERE id=$1`, [po.id]);
    try {
      await sendPoEmail({ ...po, lines: po.lines });
      await q(`UPDATE scheduled_pos SET status='sent', sent_at=now() WHERE id=$1`, [po.id]);
      sent++;
    } catch (e) {
      await q(`UPDATE scheduled_pos SET status='failed', error=$2 WHERE id=$1`, [po.id, String(e.message || e).slice(0, 500)]);
      failed++;
    }
  }
  res.json({ ok: true, checked: due.length, sent, failed });
}));
