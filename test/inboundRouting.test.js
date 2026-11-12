/**
 * Company-inbox intent routing: jobs → HR, inquiries/quotes → Director,
 * Ref/header replies still win first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const tm = require('../src/services/teamMail');
const { start, stop, roleUsers } = require('./helpers');

test('classifyInboundIntent: job applications → hr', () => {
  assert.equal(
    tm.classifyInboundIntent({
      subject: 'Application for Developer role',
      body_text: 'Please find my CV attached. I am applying for the developer position.',
    }),
    'hr'
  );
  assert.equal(
    tm.classifyInboundIntent({
      subject: 'Sales Executive application',
      body_text: 'I would like to apply for the sales executive vacancy. Resume attached.',
    }),
    'hr'
  );
  assert.equal(
    tm.classifyInboundIntent({
      subject: 'Job inquiry',
      body_text: 'I am looking for a job at Cres Dynamics. Here is my cover letter.',
    }),
    'hr'
  );
});

test('classifyInboundIntent: inquiries / quotes / changes → director', () => {
  assert.equal(
    tm.classifyInboundIntent({
      subject: 'Request for quotation',
      body_text: 'We need a quote for a new CRM website for our shop.',
    }),
    'director'
  );
  assert.equal(
    tm.classifyInboundIntent({
      subject: 'Change request on our system',
      body_text: 'Please modify the checkout flow and send a proposal.',
    }),
    'director'
  );
  assert.equal(
    tm.classifyInboundIntent({
      subject: 'Inquiry',
      body_text: 'Interested in a partnership and a demo of your platform.',
    }),
    'director'
  );
});

test('classifyInboundIntent: unrelated mail stays unrouted by topic', () => {
  assert.equal(
    tm.classifyInboundIntent({ subject: 'Hello', body_text: 'Just saying hi to the team.' }),
    null
  );
});

test('routeReplies: job mail goes to HR; Ref reply still goes to the sender', async () => {
  await start();
  const users = await roleUsers();
  const { query } = require('../src/config/database');
  const hrId = users.hr;
  const directorId = users.director;
  const sender = users.developer || users.sales || users.admin;
  assert.ok(hrId, 'seed needs an HR user');
  assert.ok(directorId, 'seed needs a Director user');
  assert.ok(sender, 'seed needs a staff sender');

  const cleanup = { inbox: [], mail: [], sent: [] };
  try {
    const ref = tm.newRefCode();
    const mid = `<${ref.toLowerCase()}.route-test@cresdynamics.com>`;
    const { rows: sent } = await query(
      `INSERT INTO team_mail_sent (user_id, team_label, to_email, subject, body, ref_code, message_id)
       VALUES ($1,'Developer Team','tracked-route@example.invalid','Proposal','Body',$2,$3) RETURNING id`,
      [sender, ref, mid]
    );
    cleanup.sent.push(sent[0].id);

    const mk = async (extra) => {
      const { rows } = await query(
        `INSERT INTO admin_inbox_messages (message_id, from_email, from_name, subject, body_text, status)
         VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id, from_email, is_scam, subject, body_text`,
        [`<ir-${Math.random()}@example.invalid>`, extra.from, extra.name || 'Someone', extra.subject, extra.body]
      );
      cleanup.inbox.push(rows[0].id);
      return rows[0];
    };

    const job = await mk({
      from: 'applicant@example.invalid',
      name: 'Applicant',
      subject: 'Application for Developer',
      body: 'I am applying for the developer role. CV attached.',
    });
    const quote = await mk({
      from: 'buyer@example.invalid',
      name: 'Buyer',
      subject: 'Request for quotation',
      body: 'Please send a quote for a new website.',
    });
    const reply = await mk({
      from: 'client@other.invalid',
      name: 'Client',
      subject: 'Re: Proposal',
      body: `Looks good.\n\nRef ${ref} - please keep this line when you reply`,
    });

    const routed = await tm.routeReplies([job, quote, reply]);
    assert.deepEqual(new Set(routed), new Set([job.id, quote.id, reply.id]));

    const { rows: flags } = await query(
      `SELECT id, routed_to, routed_by FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`,
      [[job.id, quote.id, reply.id]]
    );
    const by = Object.fromEntries(flags.map((r) => [r.id, r]));
    assert.equal(by[job.id].routed_by, 'hr');
    assert.equal(by[job.id].routed_to, hrId);
    assert.equal(by[quote.id].routed_by, 'director');
    assert.equal(by[quote.id].routed_to, directorId);
    assert.equal(by[reply.id].routed_by, 'reference');
    assert.equal(by[reply.id].routed_to, sender);

    const { rows: hrMail } = await query(
      `SELECT to_user_id FROM team_mail WHERE inbox_message_id = $1`,
      [job.id]
    );
    assert.ok(hrMail.some((r) => r.to_user_id === hrId));
    cleanup.mail.push(job.id, quote.id, reply.id);
  } finally {
    if (cleanup.mail.length) await query(`DELETE FROM team_mail WHERE inbox_message_id = ANY($1::uuid[])`, [cleanup.mail]).catch(() => {});
    if (cleanup.inbox.length) await query(`DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[])`, [cleanup.inbox]).catch(() => {});
    if (cleanup.sent.length) await query(`DELETE FROM team_mail_sent WHERE id = ANY($1::uuid[])`, [cleanup.sent]).catch(() => {});
    await stop();
  }
});
