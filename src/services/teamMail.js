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

/** Unique, readable reference for one outgoing email, e.g. CR-7K3F9Q (no 0/O/1/I). */
function newRefCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = require('crypto').randomBytes(6);
  return `CR-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}
const REF_RE = /\bCR-[A-HJ-NP-Z2-9]{6}\b/g;

function signature(user, ref = null) {
  const team = teamLabel(user.role);
  return [
    '', '--', user.name,
    team === 'Director' ? `Director, ${COMPANY}` : `${team}, ${COMPANY}`,
    `${replyToAddress()} | www.cresdynamics.com`,
    ref ? `Ref ${ref} - please keep this line when you reply` : null,
  ].filter((l) => l !== null).join('\n');
}

function withSignature(body, user, ref = null) {
  const b = String(body || '').trimEnd();
  const signed = b.includes(`${teamLabel(user.role)}, ${COMPANY}`) || b.includes(`Director, ${COMPANY}`);
  // Jarvis (or the writer) already signed: only add the reference line
  if (signed) return ref ? `${b}\nRef ${ref} - please keep this line when you reply` : b;
  return b + '\n' + signature(user, ref);
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
  // Tracking: a unique reference in the signature + our own Message-ID, so the reply
  // can be routed back to this person automatically (see routeReplies).
  const ref = newRefCode();
  const domain = (sendingAddress().split('@')[1] || 'cresdynamics.com').toLowerCase();
  const messageId = `<${ref.toLowerCase()}.${require('crypto').randomUUID()}@${domain}>`;
  const headers = { 'Message-ID': messageId, 'X-Cres-Ref': ref };
  if (teamMailId) {
    // Replying inside a thread: keep it threaded in the client's mail app
    const { rows: t } = await query(`SELECT reply_message_id FROM team_mail WHERE id = $1`, [teamMailId]);
    const parentId = t[0]?.reply_message_id;
    if (parentId) {
      headers['In-Reply-To'] = parentId;
      headers.References = parentId;
    }
  }
  const finalBody = withSignature(text, by, ref);
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
      headers,
      meta: { type: 'team_mail', fromRole: by.role, userId: by.id, ref },
    });
  } catch (err) {
    await query(
      `INSERT INTO team_mail_sent (team_mail_id, user_id, team_label, to_email, cc, subject, body, status, error, ref_code, message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8,$9,$10)`,
      [teamMailId, by.id, label, addr, ccList, subj, finalBody, err.message, ref, messageId]
    ).catch(() => {});
    throw new AppError(`The email did not send: ${err.message}`, 502, 'EMAIL_FAILED');
  }
  const { rows } = await query(
    `INSERT INTO team_mail_sent (team_mail_id, user_id, team_label, to_email, cc, subject, body, provider, message_ref, ref_code, message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [teamMailId, by.id, label, addr, ccList, subj, finalBody, result?.provider || null, result?.messageId || null, ref, messageId]
  );
  if (teamMailId) await query(`UPDATE team_mail SET status = 'done' WHERE id = $1 AND to_user_id = $2`, [teamMailId, by.id]);
  return { ...rows[0], from: displayName(by), replyTo: replyToAddress(), skipped: Boolean(result?.skipped) };
}

/**
 * Which staff email is this incoming message a reply to? Most reliable first:
 *  1. header   - In-Reply-To / References carry the Message-ID we sent
 *  2. reference - the "Ref CR-XXXXXX" line from our signature is in the reply
 *  3. sender   - the person we emailed most recently from that address (60 days)
 */
async function findSentFor(msg) {
  const ids = [msg.in_reply_to, ...(msg.reference_ids || [])].filter(Boolean);
  if (ids.length) {
    const { rows } = await query(
      `SELECT s.* FROM team_mail_sent s JOIN users u ON u.id = s.user_id
        WHERE s.message_id = ANY($1::text[]) AND s.status = 'sent' AND u.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1`,
      [ids]
    );
    if (rows[0]) return { sent: rows[0], by: 'header' };
  }
  const refs = [...new Set(`${msg.subject || ''}\n${msg.body_text || ''}`.match(REF_RE) || [])];
  if (refs.length) {
    const { rows } = await query(
      `SELECT s.* FROM team_mail_sent s JOIN users u ON u.id = s.user_id
        WHERE s.ref_code = ANY($1::text[]) AND s.status = 'sent' AND u.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1`,
      [refs]
    );
    if (rows[0]) return { sent: rows[0], by: 'reference' };
  }
  const { rows } = await query(
    `SELECT s.* FROM team_mail_sent s JOIN users u ON u.id = s.user_id
      WHERE LOWER(s.to_email) = LOWER($1) AND s.status = 'sent' AND s.created_at > NOW() - INTERVAL '60 days' AND u.status = 'active'
      ORDER BY s.created_at DESC LIMIT 1`,
    [msg.from_email]
  );
  return rows[0] ? { sent: rows[0], by: 'sender' } : null;
}

/**
 * New mail in the company inbox that answers an email a staff member sent:
 * forward it to that person's Team mail automatically (no admin needed).
 * The admin still sees it, marked "auto-forwarded". Returns the routed ids.
 */
async function routeReplies(inboxRows) {
  const own = new Set([replyToAddress(), sendingAddress(), process.env.IMAP_USER].filter(Boolean).map((a) => a.toLowerCase()));
  const routed = [];
  for (const m of inboxRows) {
    if (m.is_scam || own.has(String(m.from_email || '').toLowerCase())) continue; // never our own mailbox
    const { rows: full } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [m.id]);
    const msg = full[0];
    if (!msg || msg.routed_to) continue;
    const hit = await findSentFor(msg);
    if (!hit) continue;
    const { sent, by } = hit;
    const { rows: ins } = await query(
      `INSERT INTO team_mail (inbox_message_id, parent_id, to_user_id, subject, body, original_from_email, original_from_name,
                              original_subject, original_received_at, attachments, auto_routed, note, sent_ref_id, reply_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,TRUE,$11,$12,$13) RETURNING *`,
      [
        msg.id, sent.team_mail_id, sent.user_id, msg.subject || '(no subject)', msg.body_text || '',
        msg.reply_to_email || msg.from_email, msg.from_name, msg.subject, msg.received_at || msg.created_at,
        JSON.stringify((msg.attachment_summaries || []).map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, index: i }))),
        `Reply to your email "${sent.subject}"${sent.ref_code ? ` (Ref ${sent.ref_code})` : ''}. Forwarded to you automatically.`,
        sent.id,
        msg.message_id && !String(msg.message_id).startsWith('uid-') ? msg.message_id : null,
      ]
    );
    await query(
      `UPDATE admin_inbox_messages SET routed_to = $1, routed_by = $2, is_read = TRUE, updated_at = NOW() WHERE id = $3`,
      [sent.user_id, by, msg.id]
    );
    await notifyRecipient(ins[0], 'CRES OS');
    routed.push(msg.id);
  }
  return routed;
}

module.exports = { newRefCode, findSentFor, TEAMS, STAFF_ROLES, teamLabel, displayName, signature, withSignature, forward, sendOutside, routeReplies, replyToAddress, sendingAddress };
