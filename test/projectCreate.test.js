/**
 * Who needs approval when creating a project: only Sales.
 * Director / Admin projects are active immediately (invoice raised, approved_by set);
 * Sales projects wait as pending_approval until a Director approves.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
const made = [];

before(async () => {
  await start();
  users = await roleUsers();
});

after(async () => {
  const { query } = require('../src/config/database');
  if (made.length) {
    await query(`DELETE FROM invoices WHERE project_id = ANY($1::uuid[])`, [made]);
    await query(`DELETE FROM project_updates WHERE project_id = ANY($1::uuid[])`, [made]).catch(() => {});
    await query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [made]);
  }
  await stop();
});

async function create(role, extra = {}) {
  const r = await call(users[role], '/api/projects', {
    method: 'POST',
    body: { name: `TEST ${role} project ${Date.now()}`, value_amount: 50000, milestones: [{ title: 'A' }, { title: 'B' }], ...extra },
    headers: { 'Idempotency-Key': `pc-${role}-${Date.now()}-${Math.random()}` },
  });
  if (r.body?.data?.id) made.push(r.body.data.id);
  return r;
}

test('Director and Admin projects are active at once, with their invoice (PMs have no create permission)', async () => {
  for (const role of ['director', 'admin']) {
    if (!users[role]) continue;
    const r = await create(role);
    assert.equal(r.status, 201, `${role} create: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.data.status, 'approved', `${role} project should be active`);
    assert.equal(r.body.data.approved_by, users[role]);
    assert.ok(r.body.data.approved_at);
    assert.ok(r.body.data.invoice, `${role} project should raise its invoice`);
    assert.equal(Number(r.body.data.invoice.amount), 50000);
  }
});

test('Sales projects wait for approval, then approval makes them active with the invoice', async () => {
  const r = await create('sales');
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, 'pending_approval');
  assert.equal(r.body.data.approved_by, null);
  const { query } = require('../src/config/database');
  const none = await query(`SELECT count(*)::int n FROM invoices WHERE project_id = $1`, [r.body.data.id]);
  assert.equal(none.rows[0].n, 0, 'no invoice before approval');

  const ok = await call(users.director, `/api/projects/${r.body.data.id}/approve`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `ap-${Date.now()}` },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.project.status, 'approved');
  assert.ok(ok.body.data.invoice);
});

test('Finance still cannot create projects', async () => {
  if (!users.finance) return;
  const r = await create('finance');
  assert.equal(r.status, 403);
});

test('progress follows the milestones automatically: 1 of 2 done = 50%', async () => {
  const { progressPercent } = require('../src/services/milestones');
  // The rule itself
  assert.equal(progressPercent([{ status: 'completed' }, { status: 'in_progress' }]), 50);
  assert.equal(progressPercent([{ status: 'completed' }, { status: 'completed' }, { status: 'not_started' }]), 67);
  assert.equal(progressPercent([{ status: 'completed' }, { status: 'completed' }]), 100);
  assert.equal(progressPercent([]), 0);
  assert.equal(progressPercent([{ status: 'not_started' }], 'completed'), 100, 'completed project is 100%');

  // End to end through the API
  const r = await create('director');
  assert.equal(r.status, 201);
  const id = r.body.data.id;
  const [a, b] = r.body.data.milestones;

  const readDetail = async () => (await call(users.director, `/api/projects/${id}`)).body.data.progress_percent;
  const readList = async () => (await call(users.director, '/api/projects')).body.data.find((p) => p.id === id)?.progress_percent;
  const readPm = async () => (await call(users.pm, '/api/pm/projects')).body.data?.find?.((p) => p.id === id)?.progress_pct;
  const setStatuses = async (sa, sb) =>
    call(users.director, `/api/projects/${id}/progress`, {
      method: 'PATCH',
      body: { milestones: [{ ...a, status: sa }, { ...b, status: sb }] },
    });

  assert.equal(await readDetail(), 0, 'nothing done = 0%');
  assert.equal((await setStatuses('completed', 'not_started')).status, 200);
  assert.equal(await readDetail(), 50, 'detail shows 50% with 1 of 2 done');
  assert.equal(await readList(), 50, 'project list shows 50%');
  if (users.pm) assert.equal(await readPm(), 50, 'PM view shows 50%');
  assert.equal((await setStatuses('completed', 'completed')).status, 200);
  assert.equal(await readDetail(), 100, 'both done = 100%');
  assert.equal((await setStatuses('in_progress', 'completed')).status, 200);
  assert.equal(await readDetail(), 50, 'it goes back down if one is re-opened');
});
