/** The bell keeps unread only; the Notifications section keeps everything; every type has an action. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
const ids = [];
before(async () => { await start(); users = await roleUsers(); });
after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM notifications WHERE id = ANY($1::uuid[])`, [ids]);
  await stop();
});

test('unread filter, read leaves the unread list but stays in All', async () => {
  const { query } = require('../src/config/database');
  const a = await query(`INSERT INTO notifications (user_id, type, content, meta) VALUES ($1,'invoice_paid','NBTEST one','{}') RETURNING id`, [users.finance]);
  const b = await query(`INSERT INTO notifications (user_id, type, content, meta) VALUES ($1,'invoice_paid','NBTEST two','{}') RETURNING id`, [users.finance]);
  ids.push(a.rows[0].id, b.rows[0].id);
  let unread = await call(users.finance, '/api/notifications?filter=unread');
  assert.ok(unread.body.data.some((n) => n.content === 'NBTEST one'));
  await call(users.finance, `/api/notifications/${a.rows[0].id}/read`, { method: 'POST' });
  unread = await call(users.finance, '/api/notifications?filter=unread');
  assert.ok(!unread.body.data.some((n) => n.content === 'NBTEST one'), 'read ones leave the bell');
  assert.ok(unread.body.data.some((n) => n.content === 'NBTEST two'));
  const all = await call(users.finance, '/api/notifications?filter=all&limit=200');
  assert.ok(all.body.data.some((n) => n.content === 'NBTEST one'), 'but stay in the Notifications section');
});

test('every notification type the system creates has an action button that goes somewhere', () => {
  // Load the browser module and ask it about every type (it has no DOM dependencies for action())
  const src = require('fs').readFileSync(require('path').join(__dirname, '../public/js/notifActions.js'), 'utf8');
  const CresNotifActions = new Function(`${src}; return CresNotifActions;`)();
  const types = ['lead_stale', 'invoice_penalty', 'salary_settled', 'invoice_overdue', 'invoice_paid', 'inbox_new', 'project_update', 'payment_recorded',
    'project_pending_approval', 'project_assignment', 'team_mail', 'report_reminder', 'invoice_issued', 'salary_funding_approved', 'milestone_client_emailed',
    'milestone_completed', 'project_assignment_accepted', 'salary_funding_escalated', 'new_message', 'daily_report', 'report_remarks', 'salary_funding_request',
    'invoice_followup', 'meeting_invite', 'project_needs_invoice', 'mail_followup', 'staff_credentials_failed', 'client_change_request', 'task_assigned',
    'leave_request', 'expense_pending_finance', 'password_reset', 'something_new_in_future'];
  for (const role of ['admin', 'director', 'sales', 'developer', 'finance', 'hr', 'pm']) {
    for (const type of types) {
      const a = CresNotifActions.action({ type, meta: type === 'project_update' ? { projectId: 'p1' } : {} }, { role });
      assert.ok(a.href && a.label, `${role}/${type} has an action`);
    }
  }
  assert.equal(CresNotifActions.action({ type: 'project_update', meta: { projectId: 'p1' } }, { role: 'director' }).href, '#/projects/p1');
  assert.equal(CresNotifActions.action({ type: 'project_needs_invoice', meta: {} }, { role: 'finance' }).label, 'Create invoice');
});
