import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/lib/db.js';

let server, base;
const api = async (method, path, { body, headers } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, headers: r.headers };
};

before(async () => {
  await migrate();
  await pool.query('TRUNCATE orgs, pp_staff, idempotency_keys RESTART IDENTITY CASCADE');
  server = createApp().listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await pool.end(); });

const S = {};   // shared state across tests, in order

test('bootstrap owner, add sales manager', async () => {
  const r = await api('POST', '/api/pp/staff/bootstrap', { body: { name: 'Josh', email: 'josh@pp.example', password: 'correct-horse-battery' } });
  assert.equal(r.status, 201); S.owner = r.json.token;
  const again = await api('POST', '/api/pp/staff/bootstrap', { body: { name: 'X', email: 'x@pp.example', password: 'password123' } });
  assert.equal(again.status, 409);
  const sm = await api('POST', '/api/pp/staff', { headers: { Authorization: 'Bearer ' + S.owner }, body: { name: 'Sam', email: 'sam@pp.example', password: 'password123', role: 'Sales Manager' } });
  assert.equal(sm.status, 201);
  const login = await api('POST', '/api/pp/staff/login', { body: { email: 'sam@pp.example', password: 'password123' } });
  assert.equal(login.status, 200); S.sales = login.json.token;
  const bad = await api('POST', '/api/pp/staff/login', { body: { email: 'sam@pp.example', password: 'nope' } });
  assert.equal(bad.status, 401);
});

test('Canopy creates a client → org + one-time org-level link code (no raw key handed out); Sales Manager cannot rotate keys', async () => {
  const r = await api('POST', '/api/pp/clients', { headers: { Authorization: 'Bearer ' + S.sales }, body: { name: 'Harbour Cafés', sector: 'Cafés' } });
  assert.equal(r.status, 201); assert.match(r.json.linkCode.code, /^[A-HJ-NP-Z2-9]{8}$/);
  S.orgId = r.json.client.id; S.orgLinkCode = r.json.linkCode.code;
  const rot = await api('POST', `/api/pp/clients/${S.orgId}/rotate-key`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(rot.status, 403);
});

test('PP Command claims the org code once and receives the org key; a second claim fails', async () => {
  const bad = await api('POST', '/api/org/link/claim', { body: { code: 'ZZZZZZZZ' } });
  assert.equal(bad.status, 404);
  const claim = await api('POST', '/api/org/link/claim', { body: { code: S.orgLinkCode.toLowerCase() } });
  assert.equal(claim.status, 200); assert.equal(claim.json.org_name, 'Harbour Cafés'); assert.match(claim.json.api_key, /^ppo_/);
  S.orgKey = claim.json.api_key;
  const again = await api('POST', '/api/org/link/claim', { body: { code: S.orgLinkCode } });
  assert.equal(again.status, 409); assert.equal(again.json.error, 'code already used');
  // Once claimed, the org-level code can't be regenerated (the link is permanent, no unlink).
  const regen = await api('POST', `/api/pp/clients/${S.orgId}/link-code`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(regen.status, 409);
});

test('Command authenticates with the org key and issues a link code', async () => {
  const me = await api('GET', '/api/org', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(me.status, 200); assert.equal(me.json.name, 'Harbour Cafés');
  const badKey = await api('GET', '/api/org', { headers: { 'X-Org-Key': 'ppo_nope' } });
  assert.equal(badKey.status, 401);
  const c = await api('POST', '/api/org/link-codes', { headers: { 'X-Org-Key': S.orgKey }, body: { hint: 'Pier' } });
  assert.equal(c.status, 201); assert.match(c.json.code, /^[A-HJ-NP-Z2-9]{8}$/); S.code = c.json.code;
  const c2 = await api('POST', '/api/org/link-codes', { headers: { 'X-Org-Key': S.orgKey }, body: { hint: 'Wharf' } });
  S.code2 = c2.json.code;
});

test('PP redeems the code (once), gets a site token; second venue links via legacy /auth/token', async () => {
  const r = await api('POST', '/api/link/redeem', { body: { code: S.code.toLowerCase(), venue: { venue_id: 'venue_8841', cafe_name: 'Pier Café', suburb: 'Collingwood', state: 'VIC' } } });
  assert.equal(r.status, 200); assert.ok(r.json.token); assert.equal(r.json.org_name, 'Harbour Cafés');
  assert.deepEqual(Object.keys(r.json.venue).sort(), ['id', 'name']);   // never overwrites cafeDetails
  S.siteTok = r.json.token; S.siteId = r.json.site_id;
  const twice = await api('POST', '/api/link/redeem', { body: { code: S.code, venue: { venue_id: 'venue_x', cafe_name: 'X' } } });
  assert.equal(twice.status, 409); assert.equal(twice.json.error, 'code already used');
  const dupVenue = await api('POST', '/api/link/redeem', { body: { code: S.code2, venue: { venue_id: 'venue_8841', cafe_name: 'Dup' } } });
  assert.equal(dupVenue.status, 409); assert.equal(dupVenue.json.error, 'venue already linked');
  const legacy = await api('POST', '/auth/token', { body: { apiKey: S.code2, venue: { venue_id: 'venue_2290', cafe_name: 'Wharf Café' } } });
  assert.equal(legacy.status, 200); S.siteTok2 = legacy.json.token; S.siteId2 = legacy.json.site_id;
  const unknown = await api('POST', '/api/link/redeem', { body: { code: 'ZZZZZZZZ', venue: { venue_id: 'v', cafe_name: 'v' } } });
  assert.equal(unknown.status, 404);
});

test('snapshot: accepted, projected to Command; unknown keys rejected; opt-out clears payroll', async () => {
  const snap = { venue_id: 'venue_8841', cafe_name: 'Pier Café', timestamp: new Date().toISOString(), revenue_week: 18420, gp_pct: 64, labour_pct: 29, covers_week: 1240,
    stock_out: 1, stock_low: 3, stock_out_items: ['Oat Milk'], stock_low_items: ['Espresso Blend'], stock_value: 6120.5, open_orders: 2,
    loyalty: { total_members: 84, active_members: 31, avg_points: 210, redemptions: 12 },
    menu_items: [{ name: 'Flat White', sellingPrice: 5.5, category: 'Coffee' }, { name: 'Smashed Avo', sellingPrice: 22, category: 'Food' }],
    shared_payroll: [{ name: 'Sarah Chen', role: 'Barista', hourly_rate_cents: 2585, hours_this_period: 24 }] };
  const r = await api('POST', '/api/venue/snapshot', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: snap });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const leak = await api('POST', '/api/venue/snapshot', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { ...snap, oc_inventory: [{ x: 1 }] } });
  assert.equal(leak.status, 400); assert.deepEqual(leak.json.rejected_keys, ['oc_inventory']);
  const wrongVenue = await api('POST', '/api/venue/snapshot', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { ...snap, venue_id: 'venue_2290' } });
  assert.equal(wrongVenue.status, 400);
  await api('POST', '/api/venue/snapshot', { headers: { Authorization: 'Bearer ' + S.siteTok2 }, body: { revenue_week: 14980, gp_pct: 61, labour_pct: 33, stock_out: 0, stock_low: 1, open_orders: 1 } });

  const sites = await api('GET', '/api/org/sites', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(sites.status, 200); assert.equal(sites.json.sites.length, 2);
  const pier = sites.json.sites.find(s => s.venue_id === 'venue_8841');
  assert.equal(pier.snapshot.revenue_week, 18420); assert.deepEqual(pier.snapshot.stock_out_items, ['Oat Milk']);
  assert.deepEqual(Object.keys(pier.ocData), ['oc_menu_data']);                 // the boundary
  assert.equal(pier.ocData.oc_menu_data[0].sellingPrice, 5.5);
  assert.equal(pier.sharedPayroll.length, 1);
  const ov = await api('GET', '/api/org/overview', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(ov.json.totals.revenue_week, 33400); assert.equal(ov.json.totals.avg_gp_pct, 63);   // revenue-weighted
  assert.equal(ov.json.totals.open_orders, 3);

  // opt out of payroll sharing → cleared
  await api('POST', '/api/venue/snapshot', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { revenue_week: 18420, gp_pct: 64, labour_pct: 29 } });
  const after = await api('GET', '/api/org/sites', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(after.json.sites.find(s => s.venue_id === 'venue_8841').sharedPayroll.length, 0);
  const labour = await api('GET', '/api/org/labour', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(labour.json.sites_sharing, 0);
});

test('Ronin → Gavin: keyword gate forces approval; café approves on its own screen; Gavin acks; org sees reply', async () => {
  // Ronin says no approval needed, but "stock" in the intent forces it.
  const m = await api('POST', '/api/org/messages', { headers: { 'X-Org-Key': S.orgKey, 'Idempotency-Key': 'msg-1' }, body: { site_id: S.siteId, intent: 'check_stock_levels', note: 'Pier: check oat milk par before the promo', requires_manager_approval: false } });
  assert.equal(m.status, 201); assert.equal(m.json.message.status, 'awaiting_approval'); assert.equal(m.json.message.requires_manager_approval, true);
  const replay = await api('POST', '/api/org/messages', { headers: { 'X-Org-Key': S.orgKey, 'Idempotency-Key': 'msg-1' }, body: { site_id: S.siteId, intent: 'check_stock_levels', note: 'dup' } });
  assert.equal(replay.headers.get('idempotent-replay'), 'true'); assert.equal(replay.json.message.id, m.json.message.id);
  const id = m.json.message.id;

  // Read-only request goes straight to 'sent'
  const ro = await api('POST', '/api/org/messages', { headers: { 'X-Org-Key': S.orgKey }, body: { site_id: S.siteId, intent: 'weekly_summary', note: 'how did the week go', requires_manager_approval: false } });
  assert.equal(ro.json.message.status, 'sent');

  // Café inbox shows both; only the sent one is actionable
  const inbox = await api('GET', '/api/venue/inbox', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(inbox.json.messages.length, 2); assert.deepEqual(inbox.json.actionable, [ro.json.message.id]);

  // Org tries to approve — refused unless the site allows it; the wrong site can't approve either
  const orgApprove = await api('POST', `/api/org/messages/${id}/approve`, { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(orgApprove.status, 403);
  const wrongSite = await api('POST', `/api/org/messages/${id}/approve`, { headers: { Authorization: 'Bearer ' + S.siteTok2 } });
  assert.equal(wrongSite.status, 403);
  // Café approves
  const ok = await api('POST', `/api/venue/inbox/${id}/approve`, { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(ok.status, 200);
  // Gavin can't ack before doing it twice; acks once
  const ack = await api('POST', `/api/venue/inbox/${id}/ack`, { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { status: 'completed', note: 'Par raised to 30 L', result: { par: 30 } } });
  assert.equal(ack.status, 200);
  const ack2 = await api('POST', `/api/venue/inbox/${id}/ack`, { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { status: 'completed' } });
  assert.equal(ack2.status, 409);

  const log = await api('GET', '/api/org/messages', { headers: { 'X-Org-Key': S.orgKey } });
  const reply = log.json.messages.find(x => x.direction === 'gavin_to_ronin' && x.reply_to === id);
  assert.ok(reply); assert.equal(reply.note, 'Par raised to 30 L');
  assert.equal(log.json.messages.find(x => x.id === id).status, 'completed');
  const notif = await api('GET', '/api/org/notifications?status=unread', { headers: { 'X-Org-Key': S.orgKey } });
  assert.ok(notif.json.notifications.some(n => n.type === 'task_done'));
});

test('coordination creates two linked, gated messages', async () => {
  const c = await api('POST', '/api/org/messages/coordinate', { headers: { 'X-Org-Key': S.orgKey }, body: { site_a_id: S.siteId, site_b_id: S.siteId2, request: 'Pier to send two crates of oat milk to Wharf', requires_manager_approval: false } });
  assert.equal(c.status, 201); assert.equal(c.json.messages.length, 2);
  assert.ok(c.json.messages.every(m => m.coordination_id === c.json.coordination_id && m.status === 'awaiting_approval'));
  assert.equal(c.json.messages[0].intent, 'coordinate_with_wharf_cafe');
});

test('Canopy → Ronin ask: operator-gated; Canopy can only withdraw', async () => {
  const a = await api('POST', '/api/pp/ronin-asks', { headers: { Authorization: 'Bearer ' + S.sales }, body: { org_id: S.orgId, message: 'Can we schedule a check-in about Q4 menu changes?', canopy_ask_id: 'local-1' } });
  assert.equal(a.status, 201); assert.equal(a.json.status, 'awaiting_approval');
  const seen = await api('GET', '/api/org/canopy-requests?status=awaiting_approval', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(seen.json.requests.length, 1);
  const resp = await api('POST', `/api/org/canopy-requests/${a.json.id}/respond`, { headers: { 'X-Org-Key': S.orgKey }, body: { status: 'answered', response_text: 'Yes — Tuesday works.' } });
  assert.equal(resp.status, 200);
  const back = await api('GET', `/api/pp/ronin-asks?org_id=${S.orgId}`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(back.json.asks[0].status, 'answered'); assert.equal(back.json.asks[0].response_text, 'Yes — Tuesday works.');
  const w = await api('POST', `/api/pp/ronin-asks/${a.json.id}/withdraw`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(w.status, 409);
});

test('boundary: Canopy products = menu items only; IT Staff refused', async () => {
  const p = await api('GET', `/api/pp/clients/${S.orgId}/products`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(p.status, 200); assert.deepEqual(Object.keys(p.json.products[0]).sort(), ['category', 'name', 'price', 'site_id', 'site_name']);
  const it = await api('POST', '/api/pp/staff', { headers: { Authorization: 'Bearer ' + S.owner }, body: { name: 'Ida', email: 'ida@pp.example', password: 'password123', role: 'IT Staff' } });
  const login = await api('POST', '/api/pp/staff/login', { body: { email: 'ida@pp.example', password: 'password123' } });
  const denied = await api('GET', '/api/pp/clients', { headers: { Authorization: 'Bearer ' + login.json.token } });
  assert.equal(denied.status, 403);
});

test('client list reports real claimed status, not just sites_linked', async () => {
  const unclaimed = await api('POST', '/api/pp/clients', { headers: { Authorization: 'Bearer ' + S.sales }, body: { name: 'Unclaimed Co' } });
  const list = await api('GET', '/api/pp/clients', { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(list.status, 200);
  const claimedRow = list.json.clients.find(c => c.id === S.orgId);
  assert.equal(claimedRow.claimed, true);
  const unclaimedRow = list.json.clients.find(c => c.id === unclaimed.json.client.id);
  assert.equal(unclaimedRow.claimed, false);
  assert.equal(unclaimedRow.sites_linked, 0);
});

test('encrypted backup round-trips and is not readable via any org route', async () => {
  const data = { oc_inventory: { itm_avo: { stock: 24 } }, oc_staff: [{ name: 'Sarah', tfn: '123 456 782' }] };
  const up = await api('POST', '/api/venue/sync', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { data, pushed_at: new Date().toISOString() } });
  assert.equal(up.status, 200);
  const down = await api('GET', '/api/venue/sync', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.deepEqual(down.json.data, data);
  const { rows: [b] } = await pool.query('SELECT ciphertext FROM site_backups WHERE site_id=$1', [S.siteId]);
  assert.ok(!b.ciphertext.toString('utf8').includes('123 456 782'));
  const sites = await api('GET', '/api/org/sites', { headers: { 'X-Org-Key': S.orgKey } });
  assert.ok(!JSON.stringify(sites.json).includes('tfn'));
});

test('expired and revoked codes cannot be redeemed', async () => {
  const c = await api('POST', '/api/org/link-codes', { headers: { 'X-Org-Key': S.orgKey }, body: { hint: 'Old' } });
  await pool.query(`UPDATE link_codes SET expires_at = now() - interval '1 minute' WHERE id=$1`, [c.json.id]);
  const r = await api('POST', '/api/link/redeem', { body: { code: c.json.code, venue: { venue_id: 'venue_old', cafe_name: 'Old' } } });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'code expired');
  const c2 = await api('POST', '/api/org/link-codes', { headers: { 'X-Org-Key': S.orgKey }, body: { hint: 'Rev' } });
  await api('DELETE', `/api/org/link-codes/${c2.json.id}`, { headers: { 'X-Org-Key': S.orgKey } });
  const r2 = await api('POST', '/api/link/redeem', { body: { code: c2.json.code, venue: { venue_id: 'venue_rev', cafe_name: 'Rev' } } });
  assert.equal(r2.status, 409); assert.equal(r2.json.error, 'code revoked');
});

test('org-level code: expires, and can be freely regenerated before it is ever claimed', async () => {
  const created = await api('POST', '/api/pp/clients', { headers: { Authorization: 'Bearer ' + S.sales }, body: { name: 'Second Site Co', sector: 'Cafés' } });
  const orgId = created.json.client.id;
  await pool.query(`UPDATE link_codes SET expires_at = now() - interval '1 minute' WHERE org_id=$1 AND kind='org'`, [orgId]);
  const staleClaim = await api('POST', '/api/org/link/claim', { body: { code: created.json.linkCode.code } });
  assert.equal(staleClaim.status, 409); assert.equal(staleClaim.json.error, 'code expired');
  // Regenerating is fine pre-claim — no unlink needed since nothing was ever linked.
  const fresh = await api('POST', `/api/pp/clients/${orgId}/link-code`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(fresh.status, 201); assert.notEqual(fresh.json.code, created.json.linkCode.code);
  const claimFresh = await api('POST', '/api/org/link/claim', { body: { code: fresh.json.code } });
  assert.equal(claimFresh.status, 200); assert.equal(claimFresh.json.org_name, 'Second Site Co');
  // And now that it's claimed, regenerating again is refused.
  const again = await api('POST', `/api/pp/clients/${orgId}/link-code`, { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(again.status, 409);
});

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

test('auth boundaries: missing, malformed, expired and wrong-kind tokens are all 401', async () => {
  // requireStaff
  const noTok = await api('GET', '/api/pp/staff');
  assert.equal(noTok.status, 401);
  const badTok = await api('GET', '/api/pp/staff', { headers: { Authorization: 'Bearer garbage' } });
  assert.equal(badTok.status, 401);
  const expired = jwt.sign({ kind: 'staff', sub: S.orgId, role: 'Owner' }, SECRET, { expiresIn: -10 });
  const expiredRes = await api('GET', '/api/pp/staff', { headers: { Authorization: 'Bearer ' + expired } });
  assert.equal(expiredRes.status, 401);
  const wrongKind = jwt.sign({ kind: 'site', sub: S.siteId, site_id: S.siteId, org_id: S.orgId }, SECRET, { expiresIn: '1h' });
  const wrongKindRes = await api('GET', '/api/pp/staff', { headers: { Authorization: 'Bearer ' + wrongKind } });
  assert.equal(wrongKindRes.status, 401);

  // requireSite
  const noSiteTok = await api('GET', '/api/venue/inbox');
  assert.equal(noSiteTok.status, 401);
  const staffAsSite = jwt.sign({ kind: 'staff', sub: S.orgId, role: 'Owner' }, SECRET, { expiresIn: '1h' });
  const staffAsSiteRes = await api('GET', '/api/venue/inbox', { headers: { Authorization: 'Bearer ' + staffAsSite } });
  assert.equal(staffAsSiteRes.status, 401);

  // requireOrg
  const noOrgKey = await api('GET', '/api/org');
  assert.equal(noOrgKey.status, 401);

  // siteOrOrg — neither a bearer token nor an org key
  const neither = await api('POST', `/api/org/messages/${S.siteId}/approve`);
  assert.equal(neither.status, 401);
});

test('staff: list, self password reset, Owner resets others, non-owner cannot reset others', async () => {
  const list = await api('GET', '/api/pp/staff', { headers: { Authorization: 'Bearer ' + S.sales } });
  assert.equal(list.status, 200); assert.ok(list.json.staff.some(s => s.email === 'sam@pp.example'));

  const selfReset = await api('POST', '/api/pp/staff/password', { headers: { Authorization: 'Bearer ' + S.sales }, body: { password: 'new-password-1' } });
  assert.equal(selfReset.status, 200);
  const reLogin = await api('POST', '/api/pp/staff/login', { body: { email: 'sam@pp.example', password: 'new-password-1' } });
  assert.equal(reLogin.status, 200); S.sales = reLogin.json.token;

  const samId = list.json.staff.find(s => s.email === 'sam@pp.example').id;
  // Sales Manager resetting someone else (the Owner) must fail.
  const owner = list.json.staff.find(s => s.role === 'Owner');
  const crossResetOwner = await api('POST', '/api/pp/staff/password', { headers: { Authorization: 'Bearer ' + S.sales }, body: { staff_id: owner.id, password: 'whatever12' } });
  assert.equal(crossResetOwner.status, 401);

  const ownerResetsSales = await api('POST', '/api/pp/staff/password', { headers: { Authorization: 'Bearer ' + S.owner }, body: { staff_id: samId, password: 'owner-set-this-1' } });
  assert.equal(ownerResetsSales.status, 200);
  const loginWithOwnerSet = await api('POST', '/api/pp/staff/login', { body: { email: 'sam@pp.example', password: 'owner-set-this-1' } });
  assert.equal(loginWithOwnerSet.status, 200); S.sales = loginWithOwnerSet.json.token;
});

test('rotate-key (Owner) issues a working key directly, bypassing the code-claim flow', async () => {
  const created = await api('POST', '/api/pp/clients', { headers: { Authorization: 'Bearer ' + S.sales }, body: { name: 'Rotate Test Co' } });
  assert.equal(created.status, 201);
  const rot = await api('POST', `/api/pp/clients/${created.json.client.id}/rotate-key`, { headers: { Authorization: 'Bearer ' + S.owner } });
  assert.equal(rot.status, 200); assert.match(rot.json.org.api_key, /^ppo_/);
  const me = await api('GET', '/api/org', { headers: { 'X-Org-Key': rot.json.org.api_key } });
  assert.equal(me.status, 200); assert.equal(me.json.name, 'Rotate Test Co');
  const missing = await api('POST', '/api/pp/clients/00000000-0000-0000-0000-000000000000/rotate-key', { headers: { Authorization: 'Bearer ' + S.owner } });
  assert.equal(missing.status, 404);
});

test('org site tier patch: happy path, invalid enum, not found', async () => {
  const patched = await api('PATCH', `/api/org/sites/${S.siteId}`, { headers: { 'X-Org-Key': S.orgKey }, body: { tier: 'T3' } });
  assert.equal(patched.status, 200); assert.equal(patched.json.tier, 'T3');
  const badTier = await api('PATCH', `/api/org/sites/${S.siteId}`, { headers: { 'X-Org-Key': S.orgKey }, body: { tier: 'T9' } });
  assert.equal(badTier.status, 400);
  const notFound = await api('PATCH', '/api/org/sites/00000000-0000-0000-0000-000000000000', { headers: { 'X-Org-Key': S.orgKey }, body: { tier: 'T2' } });
  assert.equal(notFound.status, 404);
});

test('Canopy client-level overview and weekly sales trend (org aggregate only)', async () => {
  const auth = { Authorization: 'Bearer ' + S.sales };
  const ov = await api('GET', `/api/pp/clients/${S.orgId}/overview`, { headers: auth });
  assert.equal(ov.status, 200); assert.equal(ov.json.site_count, 2); assert.equal(ov.json.revenue_week, 33400);
  assert.equal(ov.json.reporting_sites, 2); assert.equal(ov.json.stale_sites, 0); assert.ok(ov.json.last_snapshot_at);
  assert.equal(typeof ov.json.avg_labour_pct, 'number'); assert.equal(typeof ov.json.menu_items, 'number');

  // A snapshot from two weeks ago lands in its own week; the current week keeps only each site's latest.
  await pool.query(`INSERT INTO site_snapshots(site_id, revenue_week, gp_pct, labour_pct, covers_week, received_at) VALUES ($1, 10000, 60, 30, 700, now() - interval '14 days')`, [S.siteId]);
  const trend = await api('GET', `/api/pp/clients/${S.orgId}/sales-trend`, { headers: auth });
  assert.equal(trend.status, 200, JSON.stringify(trend.json));
  assert.equal(trend.json.weeks.length, 2);
  const [older, current] = trend.json.weeks;
  assert.ok(older.week_start < current.week_start);
  assert.equal(older.revenue, 10000); assert.equal(older.reporting_sites, 1); assert.equal(older.gp_pct, 60); assert.equal(older.covers, 700);
  assert.equal(current.revenue, 33400); assert.equal(current.reporting_sites, 2);
  assert.equal(current.gp_pct, Math.round((18420 * 64 + 14980 * 61) / 33400));   // revenue-weighted
  assert.deepEqual(Object.keys(current).sort(), ['covers', 'gp_pct', 'labour_pct', 'reporting_sites', 'revenue', 'week_start']); // no per-site data

  const oneWeek = await api('GET', `/api/pp/clients/${S.orgId}/sales-trend?weeks=1`, { headers: auth });
  assert.equal(oneWeek.json.weeks.length, 1); assert.equal(oneWeek.json.weeks[0].revenue, 33400);
  const badWeeks = await api('GET', `/api/pp/clients/${S.orgId}/sales-trend?weeks=0`, { headers: auth });
  assert.equal(badWeeks.status, 400);
  const missing = await api('GET', '/api/pp/clients/00000000-0000-0000-0000-000000000000/sales-trend', { headers: auth });
  assert.equal(missing.status, 404);
  const siteCannot = await api('GET', `/api/pp/clients/${S.orgId}/sales-trend`, { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(siteCannot.status, 401);
});

test('health check and onboarding stubs', async () => {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200); assert.equal(health.json.ok, true);
  const pending = await api('GET', '/api/onboard/pending', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(pending.status, 200); assert.deepEqual(pending.json.submissions, []);
  const imported = await api('POST', '/api/onboard/some-id/import', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(imported.status, 200); assert.equal(imported.json.ok, true);
});

test('site token refresh issues a new working token', async () => {
  const r = await api('POST', '/api/link/refresh', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(r.status, 200); assert.ok(r.json.token);
  const inbox = await api('GET', '/api/venue/inbox', { headers: { Authorization: 'Bearer ' + r.json.token } });
  assert.equal(inbox.status, 200);
  S.siteTok = r.json.token;
});

test('decline paths: site declines its own message, wrong site refused, double-decline conflicts', async () => {
  const m = await api('POST', '/api/org/messages', { headers: { 'X-Org-Key': S.orgKey }, body: { site_id: S.siteId, intent: 'reorder_stock', note: 'top up oat milk', requires_manager_approval: false } });
  assert.equal(m.json.message.status, 'awaiting_approval');
  const id = m.json.message.id;
  const wrongSite = await api('POST', `/api/venue/inbox/${id}/decline`, { headers: { Authorization: 'Bearer ' + S.siteTok2 } });
  assert.equal(wrongSite.status, 409); // not awaiting approval for that site's own row lookup -> site_id mismatch means UPDATE affects 0 rows
  const declined = await api('POST', `/api/venue/inbox/${id}/decline`, { headers: { Authorization: 'Bearer ' + S.siteTok }, body: { note: 'no oat milk left in supplier catalog' } });
  assert.equal(declined.status, 200); assert.equal(declined.json.status, 'declined');
  const again = await api('POST', `/api/venue/inbox/${id}/decline`, { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(again.status, 409);
  const notif = await api('GET', '/api/org/notifications', { headers: { 'X-Org-Key': S.orgKey } });
  assert.ok(notif.json.notifications.some(n => n.type === 'request_declined'));
});

test('org-side approval succeeds when the site has opted in (org_may_approve)', async () => {
  await pool.query('UPDATE sites SET org_may_approve=true WHERE id=$1', [S.siteId2]);
  const m = await api('POST', '/api/org/messages', { headers: { 'X-Org-Key': S.orgKey }, body: { site_id: S.siteId2, intent: 'check_stock_levels', note: 'confirm par', requires_manager_approval: false } });
  assert.equal(m.json.message.status, 'awaiting_approval');
  const id = m.json.message.id;
  const approved = await api('POST', `/api/org/messages/${id}/approve`, { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(approved.status, 200); assert.equal(approved.json.approved_by, 'org');
  const again = await api('POST', `/api/org/messages/${id}/approve`, { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(again.status, 409);
  await pool.query('UPDATE sites SET org_may_approve=false WHERE id=$1', [S.siteId2]);
});

test('coordinate validation: same site rejected, unknown site 404', async () => {
  const same = await api('POST', '/api/org/messages/coordinate', { headers: { 'X-Org-Key': S.orgKey }, body: { site_a_id: S.siteId, site_b_id: S.siteId, request: 'x' } });
  assert.equal(same.status, 400);
  const unknown = await api('POST', '/api/org/messages/coordinate', { headers: { 'X-Org-Key': S.orgKey }, body: { site_a_id: S.siteId, site_b_id: '00000000-0000-0000-0000-000000000000', request: 'x' } });
  assert.equal(unknown.status, 404);
});

test('messages list filters: site_id, status, limit + cursor pagination', async () => {
  const bySite = await api('GET', `/api/org/messages?site_id=${S.siteId2}`, { headers: { 'X-Org-Key': S.orgKey } });
  assert.ok(bySite.json.messages.every(m => m.site_id === S.siteId2));
  const byStatus = await api('GET', '/api/org/messages?status=approved', { headers: { 'X-Org-Key': S.orgKey } });
  assert.ok(byStatus.json.messages.every(m => m.status === 'approved'));
  const page1 = await api('GET', '/api/org/messages?limit=1', { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(page1.json.messages.length, 1); assert.ok(page1.json.next_cursor);
  const page2 = await api('GET', `/api/org/messages?limit=1&cursor=${encodeURIComponent(page1.json.next_cursor)}`, { headers: { 'X-Org-Key': S.orgKey } });
  assert.equal(page2.json.messages.length, 1);
  assert.notEqual(page1.json.messages[0].id, page2.json.messages[0].id);
});

test('canopy-requests: respond conflict once already answered; ronin-asks unknown org 404', async () => {
  const unknownOrg = await api('POST', '/api/pp/ronin-asks', { headers: { Authorization: 'Bearer ' + S.sales }, body: { org_id: '00000000-0000-0000-0000-000000000000', message: 'hi' } });
  assert.equal(unknownOrg.status, 404);
  // The earlier ask for S.orgId was already answered in an earlier test — responding again must conflict.
  const a = await api('GET', `/api/org/canopy-requests`, { headers: { 'X-Org-Key': S.orgKey } });
  const already = a.json.requests.find(r => r.status === 'answered');
  assert.ok(already);
  const respondAgain = await api('POST', `/api/org/canopy-requests/${already.id}/respond`, { headers: { 'X-Org-Key': S.orgKey }, body: { status: 'declined' } });
  assert.equal(respondAgain.status, 409);
});

test('idempotency keys are scoped per-principal; invalid body returns zod issues', async () => {
  const a = await api('POST', '/api/pp/ronin-asks', { headers: { Authorization: 'Bearer ' + S.sales, 'Idempotency-Key': 'shared-key-1' }, body: { org_id: S.orgId, message: 'first message under shared key' } });
  assert.equal(a.status, 201);
  const b = await api('POST', '/api/pp/ronin-asks', { headers: { Authorization: 'Bearer ' + S.owner, 'Idempotency-Key': 'shared-key-1' }, body: { org_id: S.orgId, message: 'second message, different principal, same key' } });
  assert.equal(b.status, 201); assert.notEqual(b.json.id, a.json.id); // different principal — not replayed

  const invalid = await api('POST', '/api/pp/ronin-asks', { headers: { Authorization: 'Bearer ' + S.sales }, body: { org_id: S.orgId } });
  assert.equal(invalid.status, 400); assert.ok(Array.isArray(invalid.json.issues));
});

test('scheduled POs: create, list, site isolation, cancel', async () => {
  const create = await api('POST', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: {
    event_name: 'Acme Corp Lunch', event_date: '2026-12-01', po_number: 'EVT-0001',
    supplier_name: 'Fresh Produce Co', supplier_email: 'orders@freshproduce.example',
    lines: [{ name: 'Chicken Breast', qty: 6.4, unit: 'kg', unit_cost: 11.5 }, { name: 'Cherry Tomatoes', qty: 1.2, unit: 'kg', unit_cost: 5.5 }],
    release_date: '2026-11-26',
  } });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  assert.equal(create.json.status, 'scheduled');
  assert.equal(Number(create.json.total), 6.4 * 11.5 + 1.2 * 5.5);
  S.scheduledPoId = create.json.id;

  const badDate = await api('POST', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: {
    event_name: 'x', supplier_name: 'y', lines: [{ name: 'z', qty: 1, unit: 'ea' }], release_date: 'not-a-date',
  } });
  assert.equal(badDate.status, 400);

  const list = await api('GET', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(list.status, 200); assert.ok(list.json.scheduled_pos.some(p => p.id === S.scheduledPoId));

  // A different site can't see or cancel another site's scheduled PO.
  const otherList = await api('GET', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok2 } });
  assert.ok(!otherList.json.scheduled_pos.some(p => p.id === S.scheduledPoId));
  const otherCancel = await api('DELETE', `/api/venue/scheduled-pos/${S.scheduledPoId}`, { headers: { Authorization: 'Bearer ' + S.siteTok2 } });
  assert.equal(otherCancel.status, 404);

  const cancel = await api('DELETE', `/api/venue/scheduled-pos/${S.scheduledPoId}`, { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(cancel.status, 200);
  const cancelAgain = await api('DELETE', `/api/venue/scheduled-pos/${S.scheduledPoId}`, { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(cancelAgain.status, 404); // already cancelled, not 'scheduled' anymore
});

test('cron: requires a valid secret; only releases due POs; sends when configured, fails clearly when not', async () => {
  const noAuth = await api('GET', '/api/cron/release-scheduled-pos');
  assert.equal(noAuth.status, 401);
  const wrongAuth = await api('GET', '/api/cron/release-scheduled-pos', { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(wrongAuth.status, 401);

  // A future-dated PO must not be touched by the cron run.
  const future = await api('POST', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: {
    event_name: 'Future Event', supplier_name: 'Later Supplies', supplier_email: 'later@example.com',
    lines: [{ name: 'Flour', qty: 5, unit: 'kg', unit_cost: 2 }], release_date: '2099-01-01',
  } });
  assert.equal(future.status, 201);

  // A due PO with no email provider configured should fail clearly, not silently "succeed".
  const dueNoProvider = await api('POST', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: {
    event_name: 'Due Event A', supplier_name: 'No Provider Co', supplier_email: 'noprovider@example.com',
    lines: [{ name: 'Milk', qty: 10, unit: 'L', unit_cost: 1.8 }], release_date: '2000-01-01',
  } });
  const run1 = await api('GET', '/api/cron/release-scheduled-pos', { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(run1.status, 200); assert.equal(run1.json.failed, 1); assert.equal(run1.json.sent, 0);
  const list1 = await api('GET', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  const failedRow = list1.json.scheduled_pos.find(p => p.id === dueNoProvider.json.id);
  assert.equal(failedRow.status, 'failed'); assert.match(failedRow.error, /not configured/);
  const futureRow = list1.json.scheduled_pos.find(p => p.id === future.json.id);
  assert.equal(futureRow.status, 'scheduled'); // untouched — not due yet

  // Now simulate a configured provider (mock fetch) and confirm the send path marks 'sent'.
  process.env.RESEND_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).includes('resend.com')
    ? { ok: true, json: async () => ({ id: 'mock-email-id' }) }
    : realFetch(url, opts); // pass through — the test harness's own HTTP calls use fetch too
  const dueWithProvider = await api('POST', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok }, body: {
    event_name: 'Due Event B', supplier_name: 'Provider Co', supplier_email: 'provider@example.com',
    lines: [{ name: 'Eggs', qty: 5, unit: 'dozen', unit_cost: 6 }], release_date: '2000-01-01',
  } });
  const run2 = await api('GET', '/api/cron/release-scheduled-pos', { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(run2.json.sent, 1);
  const list2 = await api('GET', '/api/venue/scheduled-pos', { headers: { Authorization: 'Bearer ' + S.siteTok } });
  assert.equal(list2.json.scheduled_pos.find(p => p.id === dueWithProvider.json.id).status, 'sent');
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;

  // A second cron run must not re-send already-'sent'/'failed' rows.
  const run3 = await api('GET', '/api/cron/release-scheduled-pos', { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(run3.json.checked, 0);
});
