/** Click-to-reveal login password, masked email hint, and a password reset that really gets you back in. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call, clearAuthLimits } = require('./helpers');

let uid;
const email = `reveal-${Date.now()}@reveal-example.invalid`;

before(async () => {
  await start();
  await clearAuthLimits();
  const { query } = require('../src/config/database');
  const bcrypt = require('bcryptjs');
  const { rows: role } = await query(`SELECT id FROM roles WHERE name = 'developer'`);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role_id) VALUES ('Reveal Tester', $1, $2, $3) RETURNING id`,
    [email, await bcrypt.hash('First-Pass-123', 10), role[0].id]
  );
  uid = rows[0].id;
});
after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM credential_reveals WHERE user_id = $1`, [uid]);
  await query(`DELETE FROM password_reset_otps WHERE user_id = $1`, [uid]);
  await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [uid]);
  await query(`DELETE FROM users WHERE id = $1`, [uid]);
  await clearAuthLimits();
  await stop();
});

test('masked email hint: first two, five dots, last two, domain', () => {
  const { maskEmail } = require('../src/services/credentialReveal');
  assert.equal(maskEmail('ggxxxxx64@gmail.com'), 'gg.....64@gmail.com');
  assert.equal(maskEmail('ab@x.com'), 'a.....@x.com');
});

test('the link shows no password until the click; the click shows it once, with the hint', async () => {
  const cr = require('../src/services/credentialReveal');
  const { token } = await cr.createReveal({ userId: uid, password: 'First-Pass-123' });
  const st = await call(null, `/api/welcome/${token}`);
  assert.equal(st.status, 200);
  assert.equal(st.body.data.valid, true);
  assert.ok(!JSON.stringify(st.body).includes('First-Pass-123'), 'nothing secret before the click');
  assert.match(st.body.data.emailHint, /^re\.\.\.\.\.[\w]{2}@reveal-example\.invalid$/);

  const shown = await call(null, `/api/welcome/${token}/reveal`, { method: 'POST' });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.data.password, 'First-Pass-123');
  assert.equal(shown.body.data.emailHint, st.body.data.emailHint);

  // still there for a refresh within 15 minutes ...
  const again = await call(null, `/api/welcome/${token}/reveal`, { method: 'POST' });
  assert.equal(again.status, 200);
  // ... then erased
  const { query } = require('../src/config/database');
  await query(`UPDATE credential_reveals SET revealed_at = NOW() - INTERVAL '16 minutes' WHERE user_id = $1`, [uid]);
  const late = await call(null, `/api/welcome/${token}/reveal`, { method: 'POST' });
  assert.equal(late.status, 410);
  const { rows } = await query(`SELECT secret_enc FROM credential_reveals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid]);
  assert.equal(rows[0].secret_enc, null, 'the password is wiped from the database');
});

test('changing the password kills the link; junk tokens are refused', async () => {
  const cr = require('../src/services/credentialReveal');
  const { query } = require('../src/config/database');
  const bcrypt = require('bcryptjs');
  const { token } = await cr.createReveal({ userId: uid, password: 'First-Pass-123' });
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await bcrypt.hash('Changed-Pass-456', 10), uid]);
  const r = await call(null, `/api/welcome/${token}/reveal`, { method: 'POST' });
  assert.equal(r.status, 410);
  const junk = await call(null, `/api/welcome/${'z'.repeat(64)}`);
  assert.equal(junk.status, 404);
  const short = await call(null, `/api/welcome/abc`);
  assert.equal(short.status, 404);
});

test('the welcome email has the button and never the password', async () => {
  const { buildCredentialsEmail } = require('../src/services/staffCredentials');
  const m = buildCredentialsEmail({ name: 'Reveal Tester', role: 'developer', revealUrl: 'https://x.example.invalid/welcome/' + 'b'.repeat(64) });
  assert.match(m.html, /Click to see your login password/);
  assert.ok(!/temporary password/i.test(m.body) && !/temporary password/i.test(m.html), 'no plaintext password field');
});

test('locked out, then reset: the reset lifts the lock and signs you in', async () => {
  const { query } = require('../src/config/database');
  // lock the account with wrong passwords (6 failures)
  for (let i = 0; i < 6; i++) await call(null, '/api/auth/login', { method: 'POST', body: { email, password: 'wrong-wrong-1' } });
  const locked = await call(null, '/api/auth/login', { method: 'POST', body: { email, password: 'Changed-Pass-456' } });
  assert.equal(locked.status, 429, 'account is locked after repeated wrong passwords');

  // forgot -> code -> verify -> reset (the code is read from the database hash by issuing our own)
  const crypto = require('crypto');
  const f = await call(null, '/api/auth/forgot-password', { method: 'POST', body: { email } });
  assert.equal(f.status, 200);
  const code = '123456';
  await query(`UPDATE password_reset_otps SET code_hash = $1 WHERE user_id = $2 AND used_at IS NULL`, [crypto.createHash('sha256').update(code).digest('hex'), uid]);
  const v = await call(null, '/api/auth/verify-reset-code', { method: 'POST', body: { email, code } });
  assert.equal(v.status, 200, JSON.stringify(v.body).slice(0, 200));
  const r = await call(null, '/api/auth/reset-password', { method: 'POST', body: { email, resetToken: v.body.data.resetToken, newPassword: 'Brand-New-789' } });
  assert.equal(r.status, 200);
  const ok = await call(null, '/api/auth/login', { method: 'POST', body: { email, password: 'Brand-New-789' } });
  assert.equal(ok.status, 200, 'the lock was lifted by the reset');
  // the code works once
  const reuse = await call(null, '/api/auth/reset-password', { method: 'POST', body: { email, resetToken: v.body.data.resetToken, newPassword: 'Another-Pass-1' } });
  assert.equal(reuse.status, 400);
});
