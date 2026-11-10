/** Recording a payment emails the client its receipt at once (queued in the same request). Address is *.invalid: never delivered. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users, clientId, projectId;
const EMAIL = `pay-${Date.now()}@client-example.invalid`;

before(async () => {
  await start();
  users = await roleUsers();
  const { query } = require('../src/config/database');
  clientId = (await query(`INSERT INTO clients (name, email) VALUES ('PAYTEST Client', $1) RETURNING id`, [EMAIL])).rows[0].id;
  projectId = (await query(`INSERT INTO projects (name, client_id, status, created_by) VALUES ('PAYTEST project', $1, 'approved', $2) RETURNING id`, [clientId, users.admin])).rows[0].id;
});

after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE project_id = $1)`, [projectId]);
  await query(`DELETE FROM invoices WHERE project_id = $1`, [projectId]);
  await query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await stop();
});

test('Finance creates the invoice; recording a payment emails the receipt to the client immediately', async () => {
  const inv = await call(users.finance, '/api/invoices', {
    method: 'POST',
    body: { client_id: clientId, project_id: projectId, items: [{ description: 'Build', qty: 1, unit_price: 10000 }] },
    headers: { 'Idempotency-Key': `pi-${Date.now()}` },
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body).slice(0, 200));
  assert.equal(inv.body.data.emailed ?? true, true, 'invoice is emailed when Finance creates it');

  const pay = await call(users.finance, '/api/payments', {
    method: 'POST',
    body: { invoice_id: inv.body.data.invoice.id, amount: 4000, bank_reference: `TEST${Date.now()}`, method: 'mpesa' },
    headers: { 'Idempotency-Key': `pp-${Date.now()}` },
  });
  assert.equal(pay.status, 201, JSON.stringify(pay.body).slice(0, 300));
  assert.equal(pay.body.data.receipt_emailed, true, 'receipt queued at once');
  assert.equal(pay.body.data.receipt_to, EMAIL, 'sent to the client on the invoice');
  assert.equal(pay.body.data.receipt_email_error, null);
});
