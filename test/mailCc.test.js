/**
 * CC inside CRES OS: @mention a colleague, they get a copy, and replies from the
 * outside are shared with them and the sender. Recipients are *.invalid so nothing is delivered.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
let cc; // { id, name }
const inbox = [];

before(async () => {
  await start();
  users = await roleUsers();
  const { query } = require('../src/config/database');
  const { rows } = await query(`SELECT id, name FROM users WHERE id = $1`, [users.sales]);
  cc = rows[0];
});

after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM team_mail WHERE inbox_message_id = ANY($1::uuid[]) OR subject LIKE 'CCTEST%'`, [inbox]);
  await query(`DELETE FROM team_mail_sent WHERE subject LIKE 'CCTEST%'`);
  await query(`DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`, [inbox]);
  await stop();
});

const handle = () => cc.name.toLowerCase().replace(/[^a-z0-9]+/g, '.');

test('recipient parser splits outside addresses from @mentions', () => {
  const tm = require('../src/services/teamMail');
  const p = tm.parseRecipients('a@x.com, @nelson.ochieng; b@y.org @Jane');
  assert.deepEqual(p.emails, ['a@x.com', 'b@y.org']);
  assert.deepEqual(p.mentions, ['nelson.ochieng', 'jane']);
});

test('unknown @name is rejected, not silently dropped', async () => {
  const r = await call(users.developer, '/api/mail/send', {
    method: 'POST',
    body: { to: 'buyer@example.invalid', cc: '@nobody.such.person', subject: 'CCTEST x', body: 'Hello there' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error?.message || JSON.stringify(r.body), /nobody\.such\.person/);
});

test('@CC gives the colleague a copy now and shares the later reply with them and the sender', async () => {
  const { query } = require('../src/config/database');
  const tm = require('../src/services/teamMail');
  const r = await call(users.developer, '/api/mail/send', {
    method: 'POST',
    body: { to: 'ccbuyer@example.invalid', cc: `@${handle()}`, subject: 'CCTEST proposal', body: 'Here is the proposal.' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
  assert.deepEqual(r.body.data.internal, [cc.name]);

  const mine = await call(users.sales, '/api/mail');
  const copy = mine.body.data.find((m) => m.subject === 'CCTEST proposal');
  assert.ok(copy, 'CC colleague has the email in Team mail');

  const ref = r.body.data.ref_code;
  const { rows } = await query(
    `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status)
     VALUES ($1,'ccbuyer@example.invalid','Buyer','Re: CCTEST proposal',$2,'pending') RETURNING id, from_email, is_scam`,
    [`<cc-${Date.now()}@example.invalid>`, `Looks good.\n\nRef ${ref} - please keep this line when you reply`]
  );
  inbox.push(rows[0].id);
  await tm.routeReplies(rows);
  const { rows: got } = await query(`SELECT to_user_id, is_cc FROM team_mail WHERE inbox_message_id = $1`, [rows[0].id]);
  assert.equal(got.length, 2, 'sender and the CC colleague both get the reply');
  assert.ok(got.some((g) => g.to_user_id === users.developer && !g.is_cc));
  assert.ok(got.some((g) => g.to_user_id === cc.id && g.is_cc));
});

test('@only email stays inside CRES OS and sends nothing outside', async () => {
  const r = await call(users.developer, '/api/mail/send', {
    method: 'POST',
    body: { to: `@${handle()}`, subject: 'CCTEST internal', body: 'Quick internal note.' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.internalOnly, true);
  const mine = await call(users.sales, '/api/mail');
  assert.ok(mine.body.data.find((m) => m.subject === 'CCTEST internal'));
});
