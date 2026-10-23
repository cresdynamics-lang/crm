/**
 * Every read endpoint, as every role: nothing may crash (5xx), and clients
 * must only ever see their own records.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, stop, roleUsers, call } = require('./helpers');

/** All GET routes without :params, read from the route files and app mounts. */
function allGetPaths() {
  const root = path.join(__dirname, '..', 'src');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const mounts = {};
  for (const m of app.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)) mounts[m[2]] = m[1];
  const required = {};
  for (const m of app.matchAll(/const (\w+) = require\('\.\/routes\/(\w+)'\)/g)) required[m[2]] = m[1];
  const out = [];
  for (const f of fs.readdirSync(path.join(root, 'routes'))) {
    const mount = mounts[required[f.replace('.js', '')]];
    if (!mount) continue;
    const src = fs.readFileSync(path.join(root, 'routes', f), 'utf8');
    for (const m of src.matchAll(/router\.get\(\s*['"]([^'"]+)['"]/g)) {
      if (m[1].includes(':')) continue;
      const p = mount + (m[1] === '/' ? '' : m[1]);
      // Skip downloads and AI-generated pages (slow, cost money; covered elsewhere).
      // live = server-sent event streams that never end by design.
      if (/export|\.csv|daily-digest|\/file$|\/live$/.test(p)) continue;
      out.push(p);
    }
  }
  return out;
}

before(start);
after(stop);

test('no endpoint crashes for any role', async () => {
  const users = await roleUsers();
  const paths = allGetPaths();
  assert.ok(paths.length > 50, `expected many endpoints, found ${paths.length}`);
  const crashes = [];
  for (const [role, id] of Object.entries(users)) {
    for (const p of paths) {
      const r = await call(id, p);
      if (r.status >= 500) crashes.push(`${p} as ${role} -> ${r.status}`);
    }
  }
  assert.deepEqual(crashes, [], `server errors:\n${crashes.join('\n')}`);
});

test('anonymous requests are refused', async () => {
  for (const p of ['/api/projects', '/api/invoices', '/api/clients', '/api/users', '/api/messages/conversations']) {
    const r = await call(null, p);
    assert.equal(r.status, 401, `${p} should need a login`);
  }
});

test('a client only sees their own invoices and projects', async (t) => {
  const users = await roleUsers();
  if (!users.client) return t.skip('no client user in this database');
  const { query } = require('../src/config/database');
  const mine = (await query('SELECT id FROM clients WHERE user_id = $1', [users.client])).rows[0];
  if (!mine) return t.skip('client user has no client record');
  for (const p of ['/api/invoices', '/api/projects', '/api/client/projects', '/api/client/invoices']) {
    const r = await call(users.client, p);
    if (r.status !== 200) continue;
    const rows = Array.isArray(r.body.data) ? r.body.data : r.body.data?.projects || r.body.data?.invoices || [];
    for (const row of rows) {
      if (row.client_id) assert.equal(row.client_id, mine.id, `${p} leaked another client's record`);
    }
  }
  const other = (await query('SELECT id FROM projects WHERE client_id IS DISTINCT FROM $1 LIMIT 1', [mine.id])).rows[0];
  if (other) {
    const r = await call(users.client, `/api/projects/${other.id}`);
    assert.ok([403, 404].includes(r.status), 'client opened another client project');
  }
});

test('staff-only data is refused to the client role', async (t) => {
  const users = await roleUsers();
  if (!users.client) return t.skip('no client user');
  for (const p of ['/api/clients', '/api/leads', '/api/users', '/api/expenses', '/api/salaries/employees', '/api/payments']) {
    const r = await call(users.client, p);
    assert.ok([401, 403].includes(r.status), `${p} should be refused to a client (got ${r.status})`);
  }
});
