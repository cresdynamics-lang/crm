/**
 * Developer -> project owner mail by #tag: the system supplies the owner's address (never shown to the
 * developer), copies the Director, and routes the owner's reply back. Addresses are *.invalid: nothing is delivered.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, roleUsers, call } = require('./helpers');

let users, projectId, clientId, handle;
const NAME = `Tagtest Shop ${Date.now()}`;
const inbox = [];
const OWNER = `owner-${Date.now()}@client-example.invalid`;

before(async () => {
  await start();
  users = await roleUsers();
  const { query } = require('../src/config/database');
  const c = await query(`INSERT INTO clients (name, business_name, email, phone) VALUES ('Secret Owner', 'Secret Biz Ltd', $1, '+254700111222') RETURNING id`, [OWNER]);
  clientId = c.rows[0].id;
  const p = await query(
    `INSERT INTO projects (name, client_id, status, assigned_developer_id, assignment_status, created_by, milestones)
     VALUES ($1,$2,'approved',$3,'accepted',$4,'[{"title":"A","status":"not_started"}]'::jsonb) RETURNING id`,
    [NAME, clientId, users.developer, users.director]
  );
  projectId = p.rows[0].id;
  handle = require('../src/services/teamMail').projectHandle(NAME);
});

after(async () => {
  const { query } = require('../src/config/database');
  await query(`DELETE FROM team_mail WHERE project_id = $1 OR inbox_message_id = ANY($2::uuid[])`, [projectId, inbox]);
  await query(`DELETE FROM team_mail_sent WHERE project_id = $1`, [projectId]);
  await query(`DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`, [inbox]);
  await query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await stop();
});

test('developer sees the project scope but not the owner (name, business, email, phone)', async () => {
  for (const path of ['/api/projects', `/api/projects/${projectId}`]) {
    const r = await call(users.developer, path);
    assert.equal(r.status, 200);
    const txt = JSON.stringify(r.body);
    for (const secret of ['Secret Owner', 'Secret Biz Ltd', OWNER, '+254700111222']) assert.ok(!txt.includes(secret), `${path} leaked ${secret}`);
    assert.ok(txt.includes(NAME), 'project and its milestones are visible');
  }
});

test('#tag sends to the owner, hides the address, copies the Director, and the reply comes back masked', async () => {
  const { query } = require('../src/config/database');
  const tm = require('../src/services/teamMail');
  const r = await call(users.developer, '/api/mail/send', { method: 'POST', body: { to: `#${handle}`, subject: 'Question about scope', body: 'Which payment gateway do you want?' } });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  assert.ok(!JSON.stringify(r.body).includes(OWNER), 'developer response has no owner address');
  assert.equal(r.body.data.skipped, true, '.invalid address is never actually emailed');

  const { rows: sent } = await query(`SELECT * FROM team_mail_sent WHERE project_id = $1`, [projectId]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to_email, OWNER, 'the real address is stored server-side');
  assert.ok(sent[0].cc_user_ids.includes(users.director), 'Director is copied automatically');
  assert.match(sent[0].subject, new RegExp(NAME));

  const dirMail = await call(users.director, '/api/mail');
  assert.ok(dirMail.body.data.find((m) => m.subject.includes('Question about scope')), 'Director has a copy');

  const sentBox = await call(users.developer, '/api/mail?box=sent');
  assert.ok(!JSON.stringify(sentBox.body).includes(OWNER));

  // Owner replies (quoting their own address in the signature)
  const { rows } = await query(
    `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status)
     VALUES ($1,$2,'Secret Owner',$3,$4,'pending') RETURNING id, from_email, is_scam`,
    [`<dp-${Date.now()}@client-example.invalid>`, OWNER, `Re: ${sent[0].subject}`, `Use Stripe. Reach me on ${OWNER}\n\nRef ${sent[0].ref_code} - please keep this line when you reply`]
  );
  inbox.push(rows[0].id);
  await tm.routeReplies(rows);

  const list = await call(users.developer, '/api/mail');
  const item = list.body.data.find((m) => m.auto_routed && m.subject.startsWith('Re:'));
  assert.ok(item, 'reply reaches the developer');
  assert.equal(item.original_from_email, null);
  const open = await call(users.developer, `/api/mail/${item.id}`);
  assert.ok(!JSON.stringify(open.body).includes(OWNER), 'no owner address anywhere in what the developer reads');
  assert.ok(!JSON.stringify(open.body).includes('Secret Owner'));
  assert.match(open.body.data.body, /Use Stripe/);

  const dirList = await call(users.director, '/api/mail');
  assert.ok(dirList.body.data.find((m) => m.auto_routed && m.subject.startsWith('Re:')), 'Director also gets the reply');

  // Developer can still answer without ever seeing the address
  const rep = await call(users.developer, `/api/mail/${item.id}/reply`, { method: 'POST', body: { body: 'Thanks, will do.' } });
  assert.equal(rep.status, 201, JSON.stringify(rep.body).slice(0, 200));
  assert.ok(!JSON.stringify(rep.body).includes(OWNER));
});

test('a project that is not yours cannot be tagged', async () => {
  const other = users.sales || users.admin;
  const r = await call(users.developer === other ? users.hr : other, '/api/mail/send', { method: 'POST', body: { to: `#${handle}`, subject: 'x', body: 'hello there' } });
  assert.ok([400, 403].includes(r.status));
});
