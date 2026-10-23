/**
 * The security fixes stay fixed: uploads need a login, sign-in is rate
 * limited, other sites cannot call the API, payroll totals stay private,
 * bad input is a 400 (not a crash), and pages ship a strict CSP.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, stop, roleUsers, tokenFor, call } = require('./helpers');

let base;
before(async () => {
  base = await start();
});
after(stop);

test('uploaded files need a signed-in user', async () => {
  const dir = path.join(__dirname, '..', 'uploads', 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  const name = `test-${Date.now()}.txt`;
  fs.writeFileSync(path.join(dir, name), 'test');
  try {
    const anon = await fetch(`${base}/uploads/avatars/${name}`);
    assert.equal(anon.status, 401);

    const users = await roleUsers();
    const verify = await fetch(`${base}/api/auth/verify`, { headers: { Authorization: `Bearer ${tokenFor(users.admin)}` } });
    const cookie = (verify.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^cres_fs=/, 'sign-in should set the file cookie');
    const authed = await fetch(`${base}/uploads/avatars/${name}`, { headers: { Cookie: cookie } });
    assert.equal(authed.status, 200);

    const sneaky = await fetch(`${base}/uploads/avatars/..%2f..%2f.env`, { headers: { Cookie: cookie } });
    assert.ok([400, 403, 404].includes(sneaky.status), 'path traversal must not work');
  } finally {
    fs.unlinkSync(path.join(dir, name));
  }
});

test('sign-in locks after 5 wrong passwords', async () => {
  const email = `nobody-${Date.now()}@example.test`;
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call(null, '/api/auth/login', { method: 'POST', body: { email, password: 'wrong' } });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429);
  const { getRedis } = require('../src/config/redis');
  const keys = await getRedis().keys(`authlimit:login:${email}:*`).catch(() => []);
  if (keys.length) await getRedis().del(...keys);
});

test('other websites cannot call the API (CORS)', async () => {
  const evil = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('pages ship a strict Content-Security-Policy', async () => {
  const res = await fetch(`${base}/login`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/, 'scripts must be limited to this site');
  assert.match(csp, /object-src 'none'/);
});

test('company payroll totals are only for payroll roles', async () => {
  const users = await roleUsers();
  for (const role of ['sales', 'developer', 'pm']) {
    if (!users[role]) continue;
    const r = await call(users[role], '/api/salaries/funding/summary');
    assert.equal(r.status, 403, `${role} must not see company payroll`);
  }
  for (const role of ['hr', 'finance', 'admin']) {
    if (!users[role]) continue;
    const r = await call(users[role], '/api/salaries/funding/summary');
    assert.equal(r.status, 200, `${role} should see payroll`);
  }
});

test('malformed ids are a 400, not a server error', async () => {
  const users = await roleUsers();
  for (const p of ['/api/projects/not-an-id', '/api/leads/123', '/api/query/projects?client_id=xyz']) {
    const r = await call(users.admin, p);
    assert.equal(r.status, 400, `${p} -> ${r.status}`);
  }
});

test('reading payroll pages does not write payroll rows', async () => {
  const users = await roleUsers();
  const { query } = require('../src/config/database');
  const count = async () => (await query('SELECT COUNT(*)::int AS n FROM salary_payments')).rows[0].n;
  const before = await count();
  await call(users.hr || users.admin, '/api/salaries/employees');
  if (users.developer) await call(users.developer, '/api/salaries/me');
  assert.equal(await count(), before);
});
