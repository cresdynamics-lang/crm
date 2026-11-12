/** Director, Sales and Admin can edit a client's contact at any time; others cannot. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users, clientId;
const projects = [];

before(async () => {
  await start();
  users = await roleUsers();
  const { query } = require('../src/config/database');
  const c = await query(`INSERT INTO clients (name, email, phone) VALUES ('CCTEST Contact Co', 'old@contact-test.invalid', '+254700000001') RETURNING id`);
  clientId = c.rows[0].id;
  for (const status of ['pending_approval', 'approved', 'rejected', 'completed']) {
    const p = await query(`INSERT INTO projects (name, client_id, status, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [`CCTEST ${status}`, clientId, status, users.sales]);
    projects.push(p.rows[0].id);
  }
});

after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projects]);
  await query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await stop();
});

test('Director, Sales and Admin can edit email and phone, whatever state the projects are in', async () => {
  let n = 0;
  for (const role of ['director', 'sales', 'admin']) {
    if (!users[role]) continue;
    n++;
    const r = await call(users[role], `/api/clients/${clientId}`, { method: 'PATCH', body: { email: `${role}@contact-test.invalid`, phone: `+25470000010${n}` } });
    assert.equal(r.status, 200, `${role}: ${JSON.stringify(r.body).slice(0, 150)}`);
    assert.equal(r.body.data.email, `${role}@contact-test.invalid`);
    // and it shows on every project of that client (any status)
    for (const id of projects) {
      const pr = await call(users[role], `/api/projects/${id}`);
      if (pr.status === 200) assert.equal(pr.body.data.client_email, `${role}@contact-test.invalid`);
    }
  }
});

test('bad email is refused; Finance and Developer cannot edit', async () => {
  const bad = await call(users.director, `/api/clients/${clientId}`, { method: 'PATCH', body: { email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  for (const role of ['finance', 'developer']) {
    if (!users[role]) continue;
    const r = await call(users[role], `/api/clients/${clientId}`, { method: 'PATCH', body: { phone: '+254799999999' } });
    assert.equal(r.status, 403, role);
  }
});
