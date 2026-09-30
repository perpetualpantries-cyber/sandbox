// Sends the actual supplier email for a server-managed (poAutoSend) PO.
// Uses Resend's plain HTTP API — no SDK dependency, just fetch. Mirrors the
// client-side PP test-mode pattern: PO_EMAIL_TEST_REDIRECT overrides every
// recipient address during a soak test, so nothing reaches a real supplier
// before go-live. Throws on failure — callers must handle it and record the
// error rather than silently marking the PO as sent.
function poEmailBody(po) {
  const lines = (po.lines || []).map(l => `  - ${l.name}: ${l.qty} ${l.unit} @ $${Number(l.unit_cost || 0).toFixed(2)}`).join('\n');
  return `Hi ${po.supplier_name},\n\nPURCHASE ORDER${po.po_number ? ': ' + po.po_number : ''}\n`
    + `For: ${po.event_name}${po.event_date ? ' (' + po.event_date + ')' : ''}\n\nORDER ITEMS:\n${lines}\n\n`
    + `ORDER TOTAL: $${Number(po.total || 0).toFixed(2)}\n\nThis order was scheduled in advance and sent automatically.`;
}

export async function sendPoEmail(po) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('email provider not configured (RESEND_API_KEY unset)');
  const from = process.env.RESEND_FROM_EMAIL || 'orders@resend.dev';
  const to = process.env.PO_EMAIL_TEST_REDIRECT || po.supplier_email;
  if (!to) throw new Error('no supplier email on file');

  const subject = `Purchase Order${po.po_number ? ' ' + po.po_number : ''} — ${po.event_name}`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text: poEmailBody(po) }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Resend API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

// General-purpose email for PPcanopy (approval notifications to staff, quotes to clients).
// RESEND_API_URL only exists so tests can point at a local fake.
export function emailConfigured() { return !!process.env.RESEND_API_KEY; }
export async function sendEmail({ to, subject, text, attachments, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('email provider not configured (RESEND_API_KEY unset)');
  const from = process.env.RESEND_FROM_EMAIL || 'orders@resend.dev';
  const body = { from, to: Array.isArray(to) ? to : [to], subject, text };
  if (replyTo) body.reply_to = replyTo;
  if (attachments && attachments.length) body.attachments = attachments.map(a => ({ filename: a.filename, content: a.content_base64 }));
  const resp = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend API ${resp.status}: ${t.slice(0, 300)}`);
  }
  return resp.json();
}
