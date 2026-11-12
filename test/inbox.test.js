/**
 * Admin inbox actions (read/unread, scam, delete/restore, bulk, admin-only),
 * the scam check, and Jarvis's per-role allowlist.
 * No email is sent: provider keys are blanked by helpers.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
const created = [];

async function seedMessage(extra = {}) {
  const { query } = require('../src/config/database');
  const { rows } = await query(
    `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status, is_read, is_scam)
     VALUES ($1, $2, $3, $4, $5, 'pending', FALSE, $6) RETURNING id`,
    [
      `<test-${Date.now()}-${Math.random()}@example.invalid>`,
      extra.from || 'client@example.invalid',
      'Test Sender',
      extra.subject || 'Website quote',
      extra.body || 'Hello, can you send a quote for a website?',
      Boolean(extra.scam),
    ]
  );
  created.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  await start();
  users = await roleUsers();
});

after(async () => {
  const { query } = require('../src/config/database');
  if (created.length) await query('DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[])', [created]);
  await stop();
});

test('inbox is admin only', async () => {
  const r = await call(users.director || users.sales, '/api/admin/inbox');
  assert.equal(r.status, 403);
});

test('opening an email marks it read; bulk unread / scam / delete / restore work', async () => {
  const admin = users.admin;
  const a = await seedMessage();
  const b = await seedMessage({ subject: 'Second' });

  const open = await call(admin, `/api/admin/inbox/${a}`);
  assert.equal(open.status, 200);
  assert.equal(open.body.data.is_read, true);

  let r = await call(admin, '/api/admin/inbox/bulk', { method: 'POST', body: { ids: [a, b], action: 'unread' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.changed, 2);

  r = await call(admin, '/api/admin/inbox/bulk', { method: 'POST', body: { ids: [a], action: 'scam' } });
  assert.equal(r.body.data.changed, 1);
  const scamTab = await call(admin, '/api/admin/inbox?status=scam');
  assert.ok(scamTab.body.data.some((m) => m.id === a));
  const activeTab = await call(admin, '/api/admin/inbox?status=active');
  assert.ok(!activeTab.body.data.some((m) => m.id === a), 'scam mail leaves Active');

  r = await call(admin, `/api/admin/inbox/${b}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const del = await call(admin, '/api/admin/inbox?status=deleted');
  assert.ok(del.body.data.some((m) => m.id === b));

  r = await call(admin, '/api/admin/inbox/bulk', { method: 'POST', body: { ids: [b], action: 'restore' } });
  assert.equal(r.body.data.changed, 1);

  // purge only removes mail that is already in Deleted
  r = await call(admin, '/api/admin/inbox/bulk', { method: 'POST', body: { ids: [a], action: 'purge' } });
  assert.equal(r.body.data.changed, 0);

  const bad = await call(admin, '/api/admin/inbox/bulk', { method: 'POST', body: { ids: [a], action: 'explode' } });
  assert.equal(bad.status, 400);
});

test('decline without sending marks it declined; handled mail cannot be re-sent', async () => {
  const admin = users.admin;
  const id = await seedMessage();
  const r = await call(admin, `/api/admin/inbox/${id}/decline`, { method: 'POST', body: { send: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'declined');
  const again = await call(admin, `/api/admin/inbox/${id}/approve`, { method: 'POST', body: { body: 'hi' } });
  assert.equal(again.status, 409);
});

test('draft edits save without sending', async () => {
  const id = await seedMessage();
  const r = await call(users.admin, `/api/admin/inbox/${id}/draft`, { method: 'PATCH', body: { body: 'Thanks, we will send a quote.' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ai_draft, 'Thanks, we will send a quote.');
  assert.equal(r.body.data.status, 'drafted');
});

test('scam check flags phishing and leaves real bank mail alone', () => {
  const { assessScam } = require('../src/services/inboxGuard');
  const phish = assessScam({
    fromEmail: 'support@m-pesa-help.xyz',
    fromName: 'Safaricom M-PESA',
    replyTo: 'x@gmail.com',
    subject: 'Urgent: verify your account',
    bodyText: 'Dear customer, your password will expire. Click here http://10.0.0.1/login within 24 hours.',
  });
  assert.equal(phish.likely, true);
  const real = assessScam({ fromEmail: 'businessonline_kenya@stanbic.com', fromName: 'Stanbic Bank', subject: 'Statement', bodyText: 'Your statement is attached.' });
  assert.equal(real.likely, false);
  assert.ok(real.score < 30);
});

test('Jarvis lookups: a developer gets no finance, payroll or HR endpoints', () => {
  const { allowedEndpoints } = require('../src/services/jarvisAssistant');
  const ids = allowedEndpoints({ id: users.developer, role: 'developer', permissions: [] }).map((e) => e.id);
  for (const forbidden of ['finance_overview', 'payments', 'balances', 'salaries', 'hr_dashboard', 'admin_inbox', 'cash_flow_report']) {
    assert.ok(!ids.includes(forbidden), `developer must not get ${forbidden}`);
  }
});

test('test addresses are never emailed (no bounces)', async () => {
  const { sendWithFailover } = require('../src/services/emailService');
  const r = await sendWithFailover({ to: 'dev@cresdynamics.local', subject: 'x', body: 'y' });
  assert.equal(r.skipped, true);
});
