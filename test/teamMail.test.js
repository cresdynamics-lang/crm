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

test('replies are matched to the sender by header, then Ref code, then address', async () => {
  const { query } = require('../src/config/database');
  const tm = require('../src/services/teamMail');
  const sender = users.developer || users.admin;
  const ref = tm.newRefCode();
  assert.match(ref, /^CR-[A-HJ-NP-Z2-9]{6}$/);
  const mid = `<${ref.toLowerCase()}.test@cresdynamics.com>`;
  const { rows: sent } = await query(
    `INSERT INTO team_mail_sent (user_id, team_label, to_email, subject, body, ref_code, message_id)
     VALUES ($1,'Developer Team','tracked@example.invalid','Proposal','Body',$2,$3) RETURNING id`,
    [sender, ref, mid]
  );
  const mk = async (extra) => {
    const { rows } = await query(
      `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status, in_reply_to, reference_ids)
       VALUES ($1, $2, 'Someone', $3, $4, 'pending', $5, $6) RETURNING id, from_email, is_scam`,
      [`<tr-${Math.random()}@example.invalid>`, extra.from, extra.subject, extra.body, extra.inReplyTo || null, extra.refs || []]
    );
    cleanup.inbox.push(rows[0].id);
    return rows[0];
  };
  // 1) header match works even from a different address (e.g. a colleague replies)
  const a = await mk({ from: 'colleague@other.invalid', subject: 'Re: Proposal', body: 'ok', inReplyTo: mid });
  // 2) Ref code in the body works when the mail client dropped the headers
  const b = await mk({ from: 'someone-else@other.invalid', subject: 'Question', body: `Thanks!\n\nRef ${ref} - please keep this line when you reply` });
  // 3) unrelated mail from a stranger is not routed
  const c = await mk({ from: 'stranger@nowhere.invalid', subject: 'Hello', body: 'Hi' });
  const routed = await tm.routeReplies([a, b, c]);
  assert.deepEqual(new Set(routed), new Set([a.id, b.id]));
  const { rows } = await query(`SELECT id, routed_to, routed_by FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`, [[a.id, b.id, c.id]]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by[a.id].routed_by, 'header');
  assert.equal(by[b.id].routed_by, 'reference');
  assert.equal(by[c.id].routed_to, null);
  assert.equal(by[a.id].routed_to, sender);
  // routing twice does not duplicate
  assert.deepEqual(await tm.routeReplies([a]), []);
  await query(`DELETE FROM team_mail WHERE sent_ref_id = $1`, [sent[0].id]);
  await query(`DELETE FROM team_mail_sent WHERE id = $1`, [sent[0].id]);
});

test('every outgoing email carries a unique Ref line and Message-ID', async () => {
  const { query } = require('../src/config/database');
  const r1 = await call(users.developer || users.admin, '/api/mail/send', { method: 'POST', body: { to: 'a@example.invalid', subject: 'One', body: 'First' } });
  const r2 = await call(users.developer || users.admin, '/api/mail/send', { method: 'POST', body: { to: 'a@example.invalid', subject: 'Two', body: 'Second' } });
  assert.equal(r1.status, 201);
  assert.match(r1.body.data.body, /Ref CR-[A-HJ-NP-Z2-9]{6}/);
  assert.notEqual(r1.body.data.ref_code, r2.body.data.ref_code);
  assert.match(r1.body.data.message_id, /^<cr-[a-z0-9]{6}\..+@.+>$/);
  await query(`DELETE FROM team_mail_sent WHERE id = ANY($1::uuid[])`, [[r1.body.data.id, r2.body.data.id]]);
});
