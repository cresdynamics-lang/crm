/**
 * Team mail.
 *
 *  - Forward: an email from the company inbox (or a team mail) is copied to a
 *    person or a whole team INSIDE CRES OS. Nothing goes to anyone's personal
 *    mailbox.
 *  - Send outside: staff email a client/partner as
 *        "Allan Abere - Developer Team, Cres Dynamics Ltd" <info@cresdynamics.com>
 *    and every reply lands in the company inbox (info@), where it is routed
 *    back to that staff member automatically.
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');

const TEAMS = {
  sales: 'Sales Team',
  developer: 'Developer Team',
  finance: 'Finance Team',
  hr: 'HR Team',
  pm: 'Project Management Team',
  director: 'Director',
  admin: 'Admin Team',
};
const STAFF_ROLES = Object.keys(TEAMS);
const COMPANY = 'Cres Dynamics Ltd';

function replyToAddress() {
  return process.env.TEAM_MAIL_REPLY_TO || process.env.IMAP_USER || 'info@cresdynamics.com';
}

/** The verified sending address (from RESEND_FROM_EMAIL / EMAIL_FROM), without a display name. */
function sendingAddress() {
  const raw = process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || replyToAddress();
  const m = String(raw).match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

function teamLabel(role) {
  return TEAMS[role] || 'Team';
}

/** "Allan Abere - Developer Team, Cres Dynamics Ltd" (quotes/brackets stripped for a safe header). */
function displayName(user) {
  const name = String(user.name || '').replace(/["<>\r\n]/g, '').trim();
  const team = teamLabel(user.role);
  return team === 'Director' ? `${name} - Director, ${COMPANY}` : `${name} - ${team}, ${COMPANY}`;
}

function signature(user) {
  const team = teamLabel(user.role);
  return ['', '--', user.name, team === 'Director' ? `Director, ${COMPANY}` : `${team}, ${COMPANY}`, `${replyToAddress()} | www.cresdynamics.com`].join('\n');
}

function withSignature(body, user) {
  const b = String(body || '').trimEnd();
  // Don't add it twice if the writer (or Jarvis) already signed with the team line
  if (b.includes(`${teamLabel(user.role)}, ${COMPANY}`) || b.includes(`Director, ${COMPANY}`)) return b;
  return b + '\n' + signature(user);
}

async function notifyRecipient(row, fromName) {
  try {
    const { queueNotification } = require('../queues/jobs');
    await queueNotification({
      userId: row.to_user_id,
      type: 'team_mail',
      content: row.auto_routed
        ? `Reply from ${row.original_from_name || row.original_from_email}: ${row.subject}`
        : `${fromName} forwarded you an email: ${row.subject}`,
      meta: { mailId: row.id, href: '/mail' },
    });
    require('../realtime/socket').emitToUser(row.to_user_id, 'mail:new', { id: row.id, subject: row.subject });
  } catch {
    /* in-app notice is best effort */
  }
}

/** Resolve recipients: explicit people + every active member of the chosen teams (never the sender). */
async function resolveRecipients({ userIds = [], teams = [], excludeId }) {
  const ids = [...new Set(userIds.map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const roles = [...new Set(teams.map(String))].filter((r) => STAFF_ROLES.includes(r));
  if (!ids.length && !roles.length) throw new AppError('Choose at least one person or team', 400, 'VALIDATION');
  const { rows } = await query(
    `SELECT u.id, u.name, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active' AND r.name = ANY($3::text[])
        AND (u.id = ANY($1::uuid[]) OR r.name = ANY($2::text[]))
        AND u.id <> $4`,
    [ids, roles, STAFF_ROLES, excludeId]
  );
  return rows.map((u) => ({ ...u, viaTeam: roles.includes(u.role) && !ids.includes(u.id) ? u.role : null }));
}

/**
 * Forward inside CRES OS. source: { inboxMessageId } or { mailId }.
 * subject/body may be edited by the forwarder; note is a private message to the recipients.
 */
async function forward({ by, source, userIds, teams, subject, body, note }) {
  let original;
  if (source.inboxMessageId) {
    if (by.role !== 'admin') throw new AppError('Only Admin can forward from the company inbox', 403, 'FORBIDDEN');
    const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [source.inboxMessageId]);
    if (!rows[0]) throw new AppError('Email not found', 404, 'NOT_FOUND');
    const m = rows[0];
    original = {
      inbox_message_id: m.id,
      parent_id: null,
      original_from_email: m.reply_to_email && !m.is_scam ? m.reply_to_email : m.from_email,
      original_from_name: m.from_name,
      original_subject: m.subject,
      original_received_at: m.received_at || m.created_at,
      body: m.body_text || '',
      subject: m.subject || '(no subject)',
      attachments: (m.attachment_summaries || []).map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, index: i, summary: String(a.summary || '').slice(0, 300) })),
    };
  } else if (source.mailId) {
    const { rows } = await query(`SELECT * FROM team_mail WHERE id = $1 AND to_user_id = $2`, [source.mailId, by.id]);
    if (!rows[0]) throw new AppError('Email not found', 404, 'NOT_FOUND');
    const t = rows[0];
    original = {
      inbox_message_id: t.inbox_message_id,
      parent_id: t.id,
      original_from_email: t.original_from_email,
      original_from_name: t.original_from_name,
      original_subject: t.original_subject,
      original_received_at: t.original_received_at,
      body: t.body,
      subject: t.subject,
      attachments: t.attachments || [],
    };
  } else {
    throw new AppError('Nothing to forward', 400, 'VALIDATION');
  }

  const recipients = await resolveRecipients({ userIds, teams, excludeId: by.id });
  if (!recipients.length) throw new AppError('No active staff match that choice', 400, 'VALIDATION');
  const finalSubject = String(subject || `Fwd: ${original.subject}`).slice(0, 500);
  const finalBody = String(body ?? original.body).slice(0, 50000);
  const created = [];
  for (const r of recipients) {
    const { rows } = await query(
      `INSERT INTO team_mail (inbox_message_id, parent_id, from_user_id, to_user_id, to_team, subject, body, note,
                              original_from_email, original_from_name, original_subject, original_received_at, attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       RETURNING *`,
      [
        original.inbox_message_id, original.parent_id, by.id, r.id, r.viaTeam, finalSubject, finalBody,
        note ? String(note).slice(0, 2000) : null,
        original.original_from_email, original.original_from_name, original.original_subject,
        original.original_received_at, JSON.stringify(original.attachments || []),
      ]
    );
    created.push({ id: rows[0].id, to: r.name, role: r.role });
    await notifyRecipient(rows[0], by.name);
  }
  if (source.inboxMessageId) {
    await query(`UPDATE admin_inbox_messages SET is_read = TRUE, updated_at = NOW() WHERE id = $1`, [source.inboxMessageId]);
  }
  return created;
}

/** Send an email to someone outside, as "<Name> - <Team>, Cres Dynamics Ltd"; replies go to info@. */
async function sendOutside({ by, to, cc, subject, body, teamMailId = null }) {
  const addr = String(to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new AppError('Enter a valid email address', 400, 'VALIDATION');
  const ccList = String(cc || '').split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 10);
  const subj = String(subject || '').trim();
  const text = String(body || '').trim();
  if (!subj) throw new AppError('Add a subject', 400, 'VALIDATION');
  if (text.length < 2) throw new AppError('Write the message', 400, 'VALIDATION');

  const { sendWithFailover } = require('./emailService');
  const finalBody = withSignature(text, by);
  const label = teamLabel(by.role);
  let result;
  try {
    result = await sendWithFailover({
      to: addr,
      cc: ccList.length ? ccList : undefined,
      subject: subj,
      body: finalBody,
      from: `${displayName(by)} <${sendingAddress()}>`,
      replyTo: replyToAddress(),
      meta: { type: 'team_mail', fromRole: by.role, userId: by.id },
    });
  } catch (err) {
    await query(
      `INSERT INTO team_mail_sent (team_mail_id, user_id, team_label, to_email, cc, subject, body, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8)`,
      [teamMailId, by.id, label, addr, ccList, subj, finalBody, err.message]
    ).catch(() => {});
    throw new AppError(`The email did not send: ${err.message}`, 502, 'EMAIL_FAILED');
  }
  const { rows } = await query(
    `INSERT INTO team_mail_sent (team_mail_id, user_id, team_label, to_email, cc, subject, body, provider, message_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [teamMailId, by.id, label, addr, ccList, subj, finalBody, result?.provider || null, result?.messageId || null]
  );
  if (teamMailId) await query(`UPDATE team_mail SET status = 'done' WHERE id = $1 AND to_user_id = $2`, [teamMailId, by.id]);
  return { ...rows[0], from: displayName(by), replyTo: replyToAddress(), skipped: Boolean(result?.skipped) };
}

/**
 * New mail in the company inbox from someone a staff member emailed recently:
 * route a copy to that staff member's Team Mail automatically (admin still sees it).
 */
async function routeReplies(inboxRows) {
  const own = new Set([replyToAddress(), sendingAddress(), process.env.IMAP_USER].filter(Boolean).map((a) => a.toLowerCase()));
  for (const m of inboxRows) {
    if (m.is_scam || own.has(String(m.from_email || '').toLowerCase())) continue; // our own mailbox is never "a client reply"
    const { rows } = await query(
      `SELECT s.user_id, u.name FROM team_mail_sent s JOIN users u ON u.id = s.user_id
        WHERE LOWER(s.to_email) = LOWER($1) AND s.status = 'sent' AND s.created_at > NOW() - INTERVAL '60 days' AND u.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1`,
      [m.from_email]
    );
    if (!rows[0]) continue;
    const { rows: full } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [m.id]);
    const msg = full[0];
    if (!msg) continue;
    const { rows: ins } = await query(
      `INSERT INTO team_mail (inbox_message_id, to_user_id, subject, body, original_from_email, original_from_name,
                              original_subject, original_received_at, attachments, auto_routed, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,TRUE,$10) RETURNING *`,
      [
        msg.id, rows[0].user_id, msg.subject || '(no subject)', msg.body_text || '', msg.from_email, msg.from_name,
        msg.subject, msg.received_at || msg.created_at,
        JSON.stringify((msg.attachment_summaries || []).map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, index: i }))),
        'Reply to an email you sent. It also stays in the company inbox.',
      ]
    );
    await query(`UPDATE admin_inbox_messages SET routed_to = $1 WHERE id = $2`, [rows[0].user_id, msg.id]);
    await notifyRecipient(ins[0], 'CRES OS');
  }
}

module.exports = { TEAMS, STAFF_ROLES, teamLabel, displayName, signature, withSignature, forward, sendOutside, routeReplies, replyToAddress, sendingAddress };
