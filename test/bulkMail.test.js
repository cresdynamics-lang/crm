/** Sales, Director and Admin can mail many people at once; others keep the small limit. Addresses are *.invalid: nothing is delivered. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
const list = (n, tag) => Array.from({ length: n }, (_, i) => `bulk${tag}${i}@people-example.invalid`);

before(async () => { await start(); users = await roleUsers(); });
after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM team_mail_sent WHERE to_email LIKE '%@people-example.invalid' OR subject LIKE 'BULKTEST%'`);
  await stop();
});

test('Sales sends one email to many people (shared) - recipients on one email', async () => {
  const r = await call(users.sales, '/api/mail/send', { method: 'POST', body: { to: list(12, 'a').join(', '), subject: 'BULKTEST shared', body: 'Hello everyone.', individually: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.data.bulk.mode, 'shared');
  assert.equal(r.body.data.bulk.total, 12);
});

test('Director sends each person their own copy; each has its own tracked row', async () => {
  const to = list(4, 'b').join('\n'); // a pasted list, one per line
  const r = await call(users.director, '/api/mail/send', { method: 'POST', body: { to, subject: 'BULKTEST individual', body: 'Hello you.', individually: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.data.mode, 'individual');
  assert.equal(r.body.data.sent, 4);
  assert.equal(r.body.data.failed.length, 0);
  const { query } = require('../src/config/database');
  const { rows } = await query(`SELECT DISTINCT to_email, ref_code FROM team_mail_sent WHERE subject = 'BULKTEST individual'`);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((x) => x.ref_code)).size, 4, 'every person has their own reference, so replies are routed');
});

test('limits: more than 10 is for Sales/Director/Admin; more than 50 is refused', async () => {
  const big = list(11, 'c').join(', ');
  const dev = await call(users.developer, '/api/mail/send', { method: 'POST', body: { to: big, subject: 'BULKTEST dev', body: 'Hi there' } });
  assert.equal(dev.status, 403);
  const tooMany = await call(users.sales, '/api/mail/send', { method: 'POST', body: { to: list(51, 'd').join(', '), subject: 'BULKTEST big', body: 'Hi there' } });
  assert.equal(tooMany.status, 400);
});
