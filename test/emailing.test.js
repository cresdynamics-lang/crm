/**
 * Emailing + reminders: notification push writes rows (regression for the
 * "inconsistent types deduced for parameter $2" failure), client-facing
 * milestone change text, staff credential email content, the 12-hour report
 * reminder, and filing a report delay reason.
 *
 * No email is sent: MAIL_MAILER=stub and provider keys are blanked by helpers.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
const cleanup = { notifications: [], delayNotes: [], reminders: [] };

before(async () => {
  await start();
  users = await roleUsers();
});

after(async () => {
  const { query } = require('../src/config/database');
  if (cleanup.notifications.length) {
    await query('DELETE FROM notifications WHERE id = ANY($1::uuid[])', [cleanup.notifications]);
  }
  if (cleanup.delayNotes.length) {
    await query('DELETE FROM report_delay_notes WHERE id = ANY($1::uuid[])', [cleanup.delayNotes]);
  }
  if (cleanup.reminders.length) {
    await query('DELETE FROM report_reminder_log WHERE id = ANY($1::uuid[])', [cleanup.reminders]);
  }
  await stop();
});

test('notification push inserts a row (no parameter type error)', async () => {
  const { handleNotification } = require('../src/queues/workers');
  const userId = users.developer || users.admin;
  const row = await handleNotification({
    data: { userId, type: 'project_update', content: `test push ${Date.now()}`, meta: { t: 1 } },
  });
  assert.ok(row && row.id, `expected an inserted notification, got ${JSON.stringify(row)}`);
  cleanup.notifications.push(row.id);

  // invoice_* types are de-duplicated per day
  const content = `test invoice dup ${Date.now()}`;
  const first = await handleNotification({ data: { userId, type: 'invoice_paid', content, meta: {} } });
  if (first?.id) cleanup.notifications.push(first.id);
  const second = await handleNotification({ data: { userId, type: 'invoice_paid', content, meta: {} } });
  assert.equal(second.skipped, true);
});

test('milestone changes read clearly for clients', () => {
  const { describeMilestoneChanges } = require('../src/services/milestones');
  const before = [
    { id: 'a', title: 'Design', status: 'in_progress' },
    { id: 'b', title: 'Build', status: 'not_started', due_date: '2026-12-01' },
    { id: 'c', title: 'Old step', status: 'not_started' },
  ];
  const after = [
    { id: 'a', title: 'Design', status: 'completed' },
    { id: 'b', title: 'Build & test', status: 'in_progress', due_date: '2026-12-10' },
    { id: 'd', title: 'Launch', status: 'not_started' },
  ];
  const kinds = describeMilestoneChanges(before, after).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['added', 'completed', 'due_date', 'removed', 'renamed', 'status'].sort());
  assert.equal(describeMilestoneChanges(before, before).length, 0, 'no change -> no email');
});

test('credentials email carries sign-in link, email and password', () => {
  const { buildCredentialsEmail } = require('../src/services/staffCredentials');
  const m = buildCredentialsEmail({
    name: 'Test Person',
    email: 'test.person@example.invalid',
    password: 'Temp-Pass-123',
    role: 'developer',
    createdByName: 'Nelson',
  });
  assert.match(m.body, /\/login/);
  assert.match(m.body, /test\.person@example\.invalid/);
  assert.match(m.body, /Temp-Pass-123/);
  assert.match(m.body, /Developer/);
  assert.match(m.html, /Temp-Pass-123/);
});

test('report reminders only go out in working hours', () => {
  const { reportReminderWindowOpen } = require('../src/services/opsJobs');
  // 2026-11-09 is a Monday. 06:00 UTC = 09:00 Nairobi.
  assert.equal(reportReminderWindowOpen(new Date('2026-11-09T06:00:00Z')), true);
  assert.equal(reportReminderWindowOpen(new Date('2026-11-09T18:00:00Z')), false); // 21:00
  assert.equal(reportReminderWindowOpen(new Date('2026-11-08T08:00:00Z')), false); // Sunday
});

test('staff without a report for 12h get one reminder, not two', async () => {
  const { query } = require('../src/config/database');
  const { remindMissingReports } = require('../src/services/opsJobs');
  const dev = users.developer;
  if (!dev) return;
  // Make this dev look overdue: no reminder in the window, no recent report
  await query(`DELETE FROM report_reminder_log WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '12 hours'`, [dev]);
  const { rows: recent } = await query(
    `SELECT 1 FROM daily_reports WHERE user_id = $1 AND created_at > NOW() - INTERVAL '12 hours'`,
    [dev]
  );
  const { rows: fresh } = await query(`SELECT 1 FROM users WHERE id = $1 AND created_at > NOW() - INTERVAL '12 hours'`, [dev]);
  if (recent.length || fresh.length) return; // not overdue in this database

  await remindMissingReports({ force: true });
  const again = await remindMissingReports({ force: true });
  const { rows } = await query(
    `SELECT id FROM report_reminder_log WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '5 minutes'`,
    [dev]
  );
  cleanup.reminders.push(...rows.map((r) => r.id));
  assert.equal(rows.length, 1, 'exactly one reminder in the window');
  assert.ok(again.reminded === 0 || again.candidates >= 0);
});

test('staff can file a delay reason; PM sees it; others cannot read it', async () => {
  const dev = users.developer || users.sales;
  const bad = await call(dev, '/api/reports/delay-notes', { method: 'POST', body: { reason: 'x' } });
  assert.equal(bad.status, 400);

  const needsWho = await call(dev, '/api/reports/delay-notes', {
    method: 'POST',
    body: { reason: 'Was with a client all day', already_communicated: true },
  });
  assert.equal(needsWho.status, 400);

  const ok = await call(dev, '/api/reports/delay-notes', {
    method: 'POST',
    body: { reason: 'Was with a client all day', already_communicated: true, communicated_to: 'PM on WhatsApp' },
  });
  assert.equal(ok.status, 201);
  cleanup.delayNotes.push(ok.body.data.id);

  const mine = await call(dev, '/api/reports/delay-notes?mine=1');
  assert.equal(mine.status, 200);
  assert.ok(mine.body.data.some((n) => n.id === ok.body.data.id));

  if (users.pm) {
    const pm = await call(users.pm, '/api/reports/delay-notes');
    assert.equal(pm.status, 200);
    assert.ok(pm.body.data.some((n) => n.id === ok.body.data.id));
  }
  const other = users.sales && users.sales !== dev ? users.sales : null;
  if (other) {
    const r = await call(other, '/api/reports/delay-notes');
    if (r.status === 200) assert.ok(!r.body.data.some((n) => n.id === ok.body.data.id), 'peers must not see it');
  }
});

test('meeting invite email: https link, inviter name/role/email, others, calendar file', () => {
  const { inviteEmail, meetingIcs, publicBase, meetingLink } = require('../src/services/meetingService');
  const prev = { env: process.env.NODE_ENV, url: process.env.PUBLIC_WEB_URL };
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_WEB_URL = 'http://cresos.cresdynamics.com/';
  const link = meetingLink(publicBase('http://127.0.0.1:3002'), '11111111-1111-1111-1111-111111111111');
  process.env.NODE_ENV = prev.env;
  if (prev.url === undefined) delete process.env.PUBLIC_WEB_URL; else process.env.PUBLIC_WEB_URL = prev.url;
  assert.equal(link, 'https://cresos.cresdynamics.com/meeting/11111111-1111-1111-1111-111111111111');

  const meeting = {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Weekly sync',
    status: 'scheduled',
    scheduled_at: '2026-11-10T07:00:00Z',
    host_name: 'Roy',
  };
  const inviter = { id: 'x', name: 'Nelson Were', email: 'nelson@example.invalid', role: 'admin' };
  const m = inviteEmail({ meeting, inviter, invitee: { name: 'Allan Abere' }, link, others: ['Roy', 'Mary'] });
  assert.match(m.subject, /Weekly sync/);
  assert.match(m.body, /Nelson Were \(Admin\)/);
  assert.match(m.body, /nelson@example\.invalid/);
  assert.match(m.body, /Also invited: Roy, Mary/);
  assert.match(m.body, new RegExp(link));
  assert.match(m.html, /Join|Open meeting/);
  const ics = meetingIcs({ meeting, inviter, link });
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:20261110T070000Z/);
  assert.equal(meetingIcs({ meeting: { ...meeting, status: 'live' }, inviter, link }), null);
});

test('meeting relay: per-person TURN logins that expire, valid for coturn', () => {
  const crypto = require('crypto');
  const prev = { urls: process.env.MEETING_TURN_URLS, secret: process.env.MEETING_TURN_SECRET };
  process.env.MEETING_TURN_URLS = 'turn:turn.example.invalid:3478?transport=udp,turns:turn.example.invalid:5349?transport=tcp';
  process.env.MEETING_TURN_SECRET = 'test-secret';
  const { iceServers } = require('../src/services/meetingService');
  const list = iceServers('11111111-2222-3333-4444-555555555555');
  if (prev.urls === undefined) delete process.env.MEETING_TURN_URLS; else process.env.MEETING_TURN_URLS = prev.urls;
  if (prev.secret === undefined) delete process.env.MEETING_TURN_SECRET; else process.env.MEETING_TURN_SECRET = prev.secret;
  const turn = list.find((s) => s.username);
  assert.ok(turn, 'a TURN entry is included');
  const [expiry, uid] = turn.username.split(':');
  assert.equal(uid, '11111111-2222-3333-4444-555555555555');
  const hours = (Number(expiry) - Date.now() / 1000) / 3600;
  assert.ok(hours > 11 && hours <= 12, 'expires in about 12 hours');
  assert.equal(turn.credential, crypto.createHmac('sha1', 'test-secret').update(turn.username).digest('base64'));
  assert.equal(turn.urls.length, 2);
});
