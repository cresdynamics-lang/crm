/**
 * Community chat rules: only the sender edits (within 30 minutes) or deletes
 * for everyone; "delete for me" and "clear chat" never touch the other
 * person's copy; reads turn into blue ticks.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let conv;
let a;
let b;
const created = [];

before(async () => {
  await start();
  const users = await roleUsers();
  a = users.sales || users.admin;
  b = users.developer || users.pm;
  const r = await call(a, '/api/messages/conversations', {
    method: 'POST',
    body: { participant_id: b },
    headers: { 'Idempotency-Key': `test-conv-${Date.now()}` },
  });
  conv = r.body.data.id;
});

after(async () => {
  const { query } = require('../src/config/database');
  if (created.length) await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [created]);
  await stop();
});

async function send(from, content) {
  const r = await call(from, `/api/messages/conversations/${conv}/messages`, {
    method: 'POST',
    body: { content },
    headers: { 'Idempotency-Key': `test-msg-${Date.now()}-${Math.random()}` },
  });
  assert.equal(r.status, 201);
  created.push(r.body.data.id);
  return r.body.data;
}

test('only the sender can edit, within 30 minutes', async () => {
  const m = await send(a, 'original (automated test)');
  assert.equal((await call(b, `/api/messages/${m.id}`, { method: 'PATCH', body: { content: 'hijack' } })).status, 403);
  const ok = await call(a, `/api/messages/${m.id}`, { method: 'PATCH', body: { content: 'edited (automated test)' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.data.edited_at);

  const { query } = require('../src/config/database');
  await query(`UPDATE messages SET sent_at = NOW() - INTERVAL '31 minutes' WHERE id = $1`, [m.id]);
  assert.equal((await call(a, `/api/messages/${m.id}`, { method: 'PATCH', body: { content: 'too late' } })).status, 409);
});

test('delete for everyone is sender-only and blanks the text', async () => {
  const m = await send(a, 'to be deleted (automated test)');
  assert.equal((await call(b, `/api/messages/${m.id}?scope=everyone`, { method: 'DELETE' })).status, 403);
  assert.equal((await call(a, `/api/messages/${m.id}?scope=everyone`, { method: 'DELETE' })).status, 200);
  const seen = (await call(b, `/api/messages/conversations/${conv}/messages`)).body.data.find((x) => x.id === m.id);
  assert.ok(seen.deleted_at);
  assert.equal(seen.content, '');
});

test('delete for me hides it only for me', async () => {
  const m = await send(a, 'hide for me (automated test)');
  assert.equal((await call(b, `/api/messages/${m.id}?scope=me`, { method: 'DELETE' })).status, 200);
  const bSees = (await call(b, `/api/messages/conversations/${conv}/messages`)).body.data.some((x) => x.id === m.id);
  const aSees = (await call(a, `/api/messages/conversations/${conv}/messages`)).body.data.some((x) => x.id === m.id);
  assert.equal(bSees, false);
  assert.equal(aSees, true);
});

test('opening the chat marks messages read (blue ticks)', async () => {
  const m = await send(a, 'read me (automated test)');
  assert.equal((await call(b, `/api/messages/conversations/${conv}/read`, { method: 'POST' })).status, 200);
  const after = (await call(a, `/api/messages/conversations/${conv}/messages`)).body.data.find((x) => x.id === m.id);
  assert.ok(after.read_at);
});
