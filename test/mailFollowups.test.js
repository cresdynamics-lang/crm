/** Follow-ups: emails sent with no reply after 2 days, and received mail nobody answered. Addresses are *.invalid or example-domain mimics. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users;
const sentIds = [];
const mailIds = [];
const inboxIds = [];
const WAIT = `waitfor-${Date.now()}@follow-test.org`; // not a blocked test domain, but never emailed: rows are inserted directly

before(async () => { await start(); users = await roleUsers(); });
after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM team_mail WHERE id = ANY($1::uuid[])`, [mailIds]);
  await query(`DELETE FROM team_mail_sent WHERE id = ANY($1::uuid[]) OR subject LIKE 'FUTEST%'`, [sentIds]);
  await query(`DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`, [inboxIds]);
  await stop();
});

async function sentRow(userId, to, subject, ageDays) {
  const { query } = require('../src/config/database');
  const { rows } = await query(
    `INSERT INTO team_mail_sent (user_id, team_label, to_email, subject, body, status, ref_code, created_at)
     VALUES ($1,'Sales Team',$2,$3,'Hi, could you confirm the quote?','sent',$4, NOW() - ($5 || ' days')::interval) RETURNING id`,
    [userId, to, subject, `CR-FU${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[01OI]/g, 'X')}`, String(ageDays)]
  );
  sentIds.push(rows[0].id);
  return rows[0].id;
}

test('an email with no reply for 2+ days is listed; a recent one, a replied one and a dismissed one are not', async () => {
  const u = users.sales;
  const old = await sentRow(u, WAIT, 'FUTEST old no reply', 3);
  await sentRow(u, `fresh-${Date.now()}@follow-test.org`, 'FUTEST fresh', 1);
  const { query } = require('../src/config/database');
  const replied = await sentRow(u, `rep-${Date.now()}@follow-test.org`, 'FUTEST replied', 4);
  await query(`UPDATE team_mail_sent SET replied_at = NOW() WHERE id = $1`, [replied]);
  const dismissed = await sentRow(u, `dis-${Date.now()}@follow-test.org`, 'FUTEST dismissed', 5);

  let r = await call(u, '/api/mail?box=followups');
  assert.equal(r.status, 200);
  const subjects = r.body.data.waiting.map((w) => w.subject);
  assert.ok(subjects.includes('FUTEST old no reply'));
  assert.ok(!subjects.includes('FUTEST fresh'));
  assert.ok(!subjects.includes('FUTEST replied'));
  assert.equal(r.body.data.waiting.find((w) => w.id === old).days, 3);

  const d = await call(u, '/api/mail/followups/dismiss', { method: 'POST', body: { kind: 'waiting', id: dismissed } });
  assert.equal(d.status, 200);
  r = await call(u, '/api/mail?box=followups');
  assert.ok(!r.body.data.waiting.some((w) => w.id === dismissed));
});

test('an answer arriving in the company inbox removes it from the list', async () => {
  const { query } = require('../src/config/database');
  const addr = `ans-${Date.now()}@follow-test.org`;
  await sentRow(users.sales, addr, 'FUTEST gets answer', 3);
  let r = await call(users.sales, '/api/mail?box=followups');
  assert.ok(r.body.data.waiting.some((w) => w.subject === 'FUTEST gets answer'));
  const m = await query(`INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status) VALUES ($1,$2,'X','Re: FUTEST','ok','pending') RETURNING id`, [`<fu-${Date.now()}@follow-test.org>`, addr]);
  inboxIds.push(m.rows[0].id);
  r = await call(users.sales, '/api/mail?box=followups');
  assert.ok(!r.body.data.waiting.some((w) => w.subject === 'FUTEST gets answer'));
});

test('mail sent to you and unanswered for 2+ days is listed until you reply or mark it done', async () => {
  const { query } = require('../src/config/database');
  const t = await query(
    `INSERT INTO team_mail (to_user_id, subject, body, original_from_email, original_from_name, original_subject, status, created_at)
     VALUES ($1,'FUTEST asks a question','Can you call me?','asker@follow-test.org','Asker','FUTEST asks a question','read', NOW() - INTERVAL '3 days') RETURNING id`,
    [users.developer]
  );
  mailIds.push(t.rows[0].id);
  let r = await call(users.developer, '/api/mail?box=followups');
  assert.ok(r.body.data.unanswered.some((x) => x.id === t.rows[0].id));
  await call(users.developer, `/api/mail/${t.rows[0].id}/done`, { method: 'POST', body: { done: true } });
  r = await call(users.developer, '/api/mail?box=followups');
  assert.ok(!r.body.data.unanswered.some((x) => x.id === t.rows[0].id));
});

test('reminders: one notification per person, only once per email, never at night', async () => {
  const { query } = require('../src/config/database');
  const fu = require('../src/services/mailFollowups');
  await sentRow(users.admin, `rem-${Date.now()}@follow-test.org`, 'FUTEST remind me', 3);
  const night = await fu.remindMailFollowups(new Date('2026-11-10T22:00:00Z')); // 01:00 Nairobi
  assert.equal(night.reminded, 0);
  const day = await fu.remindMailFollowups(new Date('2026-11-10T09:00:00Z')); // 12:00 Nairobi
  assert.ok(day.reminded >= 1);
  const again = await fu.remindMailFollowups(new Date('2026-11-10T09:05:00Z'));
  const { rows } = await query(`SELECT followup_reminded_at FROM team_mail_sent WHERE subject = 'FUTEST remind me'`);
  assert.ok(rows[0].followup_reminded_at, 'marked as reminded');
  assert.equal(again.reminded, 0, 'not reminded twice about the same emails');
});

test('Sent box keeps the full email and can be searched', async () => {
  await sentRow(users.sales, `search-${Date.now()}@follow-test.org`, 'FUTEST zebra proposal', 0);
  const all = await call(users.sales, '/api/mail?box=sent');
  assert.ok(all.body.data.some((m) => m.subject === 'FUTEST zebra proposal'));
  const hit = await call(users.sales, '/api/mail?box=sent&q=zebra');
  assert.ok(hit.body.data.every((m) => /zebra/i.test(`${m.subject} ${m.body} ${m.to_email}`)));
  assert.ok(hit.body.data.length >= 1);
});
