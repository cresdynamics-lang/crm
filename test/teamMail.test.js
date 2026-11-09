/**
 * Team mail: forward inside CRES OS (person or team), only the recipient can
 * read it, only Admin forwards from the company inbox, outside emails carry
 * "<Name> - <Team>, Cres Dynamics Ltd" with replies to info@, and a reply from
 * that outside person is routed back to the staff member.
 * Recipient addresses are *.invalid, so nothing is ever delivered.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
let inboxId;
const cleanup = { inbox: [], mail: [], sent: [] };

before(async () => {
  await start();
  users = await roleUsers();
  const { query } = require('../src/config/database');
  const { rows } = await query(
    `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status)
     VALUES ($1, 'buyer@example.invalid', 'Jane Buyer', 'Need an app quote', 'Hi, please quote for a delivery app.', 'pending') RETURNING id`,
    [`<tm-${Date.now()}@example.invalid>`]
  );
  inboxId = rows[0].id;
  cleanup.inbox.push(inboxId);
});

after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM team_mail WHERE inbox_message_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])`, [cleanup.inbox, cleanup.mail]);
  await query(`DELETE FROM team_mail_sent WHERE to_email LIKE '%@example.invalid'`);
  await query(`DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`, [cleanup.inbox]);
  await stop();
});

test('only Admin forwards from the company inbox', async () => {
  const r = await call(users.sales, '/api/mail/forward', { method: 'POST', body: { inbox_message_id: inboxId, teams: ['developer'] } });
  assert.equal(r.status, 403);
});

test('admin forwards to the Developer team; only the developer can read it', async () => {
  if (!users.developer) return;
  const r = await call(users.admin, '/api/mail/forward', {
    method: 'POST',
    body: { inbox_message_id: inboxId, teams: ['developer'], subject: 'Fwd: Need an app quote', body: 'Edited copy', note: 'Please handle' },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.data.forwarded >= 1);

  const list = await call(users.developer, '/api/mail');
  const item = list.body.data.find((m) => m.subject === 'Fwd: Need an app quote');
  assert.ok(item, 'developer sees it in Team mail');
  cleanup.mail.push(item.id);
  assert.equal(item.note, 'Please handle');

  const open = await call(users.developer, `/api/mail/${item.id}`);
  assert.equal(open.status, 200);
  assert.equal(open.body.data.body, 'Edited copy');
  assert.equal(open.body.data.original_from_email, 'buyer@example.invalid');

  if (users.sales) {
    const peek = await call(users.sales, `/api/mail/${item.id}`);
    assert.equal(peek.status, 404, 'another staff member cannot read it');
  }
});

test('outside email: "<Name> - <Team>, Cres Dynamics Ltd", reply-to info@, signature added', async () => {
  const tm = require('../src/services/teamMail');
  const dev = { id: users.developer || users.admin, name: 'Allan Abere', role: 'developer' };
  assert.equal(tm.displayName(dev), 'Allan Abere - Developer Team, Cres Dynamics Ltd');
  assert.match(tm.withSignature('Hello', dev), /Allan Abere\nDeveloper Team, Cres Dynamics Ltd/);
  assert.equal(tm.withSignature('Hi\n\nDeveloper Team, Cres Dynamics Ltd', dev).match(/Developer Team, Cres Dynamics Ltd/g).length, 1, 'no double signature');
  assert.match(tm.replyToAddress(), /@/);

  const r = await call(users.developer || users.admin, '/api/mail/send', {
    method: 'POST',
    body: { to: 'buyer@example.invalid', subject: 'Quote', body: 'Here is our quote.' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.skipped, true, 'test address is never actually emailed');
  assert.match(r.body.data.from, / - .*Cres Dynamics Ltd$/);
});

test('a reply from that outside person is routed back to the staff member', async () => {
  const { query } = require('../src/config/database');
  const tm = require('../src/services/teamMail');
  const sender = users.developer || users.admin;
  const { rows } = await query(
    `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status)
     VALUES ($1, 'buyer@example.invalid', 'Jane Buyer', 'Re: Quote', 'Thanks, approved.', 'pending') RETURNING id, from_email, is_scam`,
    [`<tm-reply-${Date.now()}@example.invalid>`]
  );
  cleanup.inbox.push(rows[0].id);
  await tm.routeReplies(rows);
  const { rows: routed } = await query(`SELECT * FROM team_mail WHERE inbox_message_id = $1`, [rows[0].id]);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].to_user_id, sender);
  assert.equal(routed[0].auto_routed, true);
});

test('bad input is rejected cleanly', async () => {
  const r1 = await call(users.admin, '/api/mail/forward', { method: 'POST', body: { inbox_message_id: inboxId } });
  assert.equal(r1.status, 400);
  const r2 = await call(users.admin, '/api/mail/send', { method: 'POST', body: { to: 'not-an-email', subject: 'x', body: 'y' } });
  assert.equal(r2.status, 400);
  const r3 = await call(users.client || null, '/api/mail');
  assert.ok([401, 403].includes(r3.status));
});
