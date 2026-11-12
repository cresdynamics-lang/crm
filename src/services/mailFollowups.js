/**
 * Mail follow-ups.
 *
 *  waiting    - an email YOU sent that nobody has answered for 2+ days
 *  unanswered - an email sent TO you (a client's reply, or one forwarded to you) that you have not answered for 2+ days
 *
 * People are reminded once per email (a notification), the list stays in Team mail > Follow-ups, and Jarvis
 * drafts the follow-up. Nothing is sent without the person reading and sending it.
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');

const AFTER_DAYS = 2;
const LOOK_BACK_DAYS = 30;

/** Sent emails (team mail and client emails) with no reply, no later email to the same person, not dismissed. */
async function waitingFor(userId) {
  const { rows } = await query(
    `WITH sent AS (
       SELECT 'team'::text AS src, s.id, s.to_email, s.subject, s.body, s.created_at, s.replied_at,
              s.followup_dismissed_at, s.project_id, s.followup_reminded_at
         FROM team_mail_sent s
        WHERE s.user_id = $1 AND s.status = 'sent' AND s.team_mail_id IS NULL
       UNION ALL
       SELECT 'client', o.id, o.to_email, o.subject, o.body, o.created_at, NULL::timestamptz,
              o.followup_dismissed_at, NULL::uuid, o.followup_reminded_at
         FROM outbound_emails o
        WHERE o.sent_by = $1 AND o.status IN ('sent', 'queued')
     )
     SELECT s.*, pr.name AS project_name
       FROM sent s LEFT JOIN projects pr ON pr.id = s.project_id
      WHERE s.created_at < NOW() - ($2 || ' days')::interval
        AND s.created_at > NOW() - ($3 || ' days')::interval
        AND s.replied_at IS NULL AND s.followup_dismissed_at IS NULL
        AND s.to_email !~* '@([^@]+\\.)?(local|localhost|invalid|test|example)$'
        AND NOT EXISTS (SELECT 1 FROM admin_inbox_messages m
                         WHERE LOWER(m.from_email) = LOWER(s.to_email) AND COALESCE(m.received_at, m.created_at) > s.created_at)
        AND NOT EXISTS (SELECT 1 FROM sent s2 WHERE LOWER(s2.to_email) = LOWER(s.to_email) AND s2.created_at > s.created_at)
      ORDER BY s.created_at ASC
      LIMIT 100`,
    [userId, String(AFTER_DAYS), String(LOOK_BACK_DAYS)]
  );
  return rows;
}

/** Mail sent to this person from outside that they have not answered or marked done. */
async function unansweredFor(userId) {
  const { rows } = await query(
    `SELECT t.id, t.subject, LEFT(t.body, 300) AS body, t.created_at, t.original_from_email, t.original_from_name,
            t.project_id, pr.name AS project_name, t.followup_reminded_at
       FROM team_mail t LEFT JOIN projects pr ON pr.id = t.project_id
      WHERE t.to_user_id = $1 AND t.status IN ('unread', 'read') AND t.original_from_email IS NOT NULL
        AND t.is_cc = FALSE AND t.followup_dismissed_at IS NULL
        AND t.created_at < NOW() - ($2 || ' days')::interval AND t.created_at > NOW() - ($3 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM team_mail_sent s WHERE s.user_id = $1 AND LOWER(s.to_email) = LOWER(t.original_from_email)
                          AND s.status = 'sent' AND s.created_at > t.created_at)
      ORDER BY t.created_at ASC
      LIMIT 100`,
    [userId, String(AFTER_DAYS), String(LOOK_BACK_DAYS)]
  );
  return rows;
}

const daysAgo = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));

/** The two lists, shaped for the screen. A developer never sees a project owner's address. */
async function listFollowups(user) {
  const tm = require('./teamMail');
  const [waiting, unanswered] = await Promise.all([waitingFor(user.id), unansweredFor(user.id)]);
  return {
    waiting: waiting.map((w) => {
      const hide = user.role === 'developer' && w.project_id;
      return {
        kind: 'waiting', src: w.src, id: w.id, subject: w.subject, sent_at: w.created_at, days: daysAgo(w.created_at),
        to: hide ? `Owner of ${w.project_name || 'the project'}` : w.to_email,
        compose_to: hide ? `#${tm.projectHandle(w.project_name)}` : w.to_email,
        snippet: String(hide ? tm.hideAddresses(w.body) : w.body || '').slice(0, 200),
      };
    }),
    unanswered: unanswered.map((u) => {
      const row = tm.maskForDeveloper(user, u);
      return {
        kind: 'unanswered', id: u.id, subject: u.subject, received_at: u.created_at, days: daysAgo(u.created_at),
        from: row.original_from_email || row.original_from_name || 'Someone', snippet: String(row.body || '').slice(0, 200),
      };
    }),
  };
}

/** Jarvis writes the follow-up (waiting) or the late reply (unanswered). The person edits and sends it. */
async function draftFollowup(user, { kind, id }) {
  const tm = require('./teamMail');
  const { jarvisDraftReply } = require('./jarvisMailDraft');
  const team = tm.teamLabel(user.role);
  const signoff = `Kind regards,\n${user.name}\n${team === 'Director' ? 'Director' : team}, Cres Dynamics Ltd`;
  if (kind === 'waiting') {
    const { rows } = await query(
      `SELECT * FROM (
         SELECT 'team'::text AS src, id, to_email, subject, body, created_at, user_id, project_id FROM team_mail_sent
         UNION ALL SELECT 'client', id, to_email, subject, body, created_at, sent_by, NULL::uuid FROM outbound_emails
       ) x WHERE x.id = $1 AND x.user_id = $2`,
      [id, user.id]
    );
    const s = rows[0];
    if (!s) throw new AppError('Email not found', 404, 'NOT_FOUND');
    const d = await jarvisDraftReply({
      id: null, fromName: '', fromEmail: s.to_email,
      subject: s.subject, bodyText: s.body, attachmentSummaries: [],
      instructions: `This is a FOLLOW-UP, not a reply. I emailed this person ${daysAgo(s.created_at)} days ago (my email is quoted as the message) and they have not answered. Write a short, warm, polite nudge: refer to my earlier email, restate in one line what I need from them, make it easy to answer, and offer help. Do not repeat the whole email or sound pushy. Sign as me.`,
      mode: 'reply', signoff,
    });
    const hide = user.role === 'developer' && s.project_id;
    return { draft: hide ? tm.hideAddresses(d.draft) : d.draft, subject: /^re:/i.test(s.subject) ? s.subject : `Re: ${s.subject}` };
  }
  const { rows } = await query(`SELECT * FROM team_mail WHERE id = $1 AND to_user_id = $2`, [id, user.id]);
  const m = rows[0];
  if (!m) throw new AppError('Email not found', 404, 'NOT_FOUND');
  const d = await jarvisDraftReply({
    id: m.inbox_message_id, fromName: m.original_from_name, fromEmail: m.original_from_email,
    subject: m.original_subject || m.subject, bodyText: m.body, attachmentSummaries: [],
    instructions: `This person wrote ${daysAgo(m.created_at)} days ago and has not had an answer yet. Reply properly to what they asked, and briefly apologise for the delay (one short line, no excuses). Sign as me.`,
    mode: 'reply', signoff,
  });
  const hide = user.role === 'developer' && m.project_id;
  return { draft: hide ? tm.hideAddresses(d.draft) : d.draft, subject: /^re:/i.test(m.original_subject || '') ? m.original_subject : `Re: ${m.original_subject || m.subject}` };
}

async function dismiss(user, { kind, id }) {
  if (kind === 'unanswered') {
    await query(`UPDATE team_mail SET followup_dismissed_at = NOW() WHERE id = $1 AND to_user_id = $2`, [id, user.id]);
  } else {
    await query(`UPDATE team_mail_sent SET followup_dismissed_at = NOW() WHERE id = $1 AND user_id = $2`, [id, user.id]);
    await query(`UPDATE outbound_emails SET followup_dismissed_at = NOW() WHERE id = $1 AND sent_by = $2`, [id, user.id]);
  }
}

/** Working hours in Nairobi (UTC+3): reminders never ping people at night. */
function nairobiHour(now = new Date()) {
  return (now.getUTCHours() + 3) % 24;
}

/**
 * Remind each person once about each email that needs a follow-up. One notification per person per run,
 * listing how many. Called every few minutes by the ops scheduler; the per-email timestamp keeps it to once.
 */
async function remindMailFollowups(now = new Date()) {
  const hour = nairobiHour(now);
  if (hour < 8 || hour >= 18) return { reminded: 0, skipped: 'outside working hours' };
  const { rows: people } = await query(
    `SELECT DISTINCT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active' AND r.name = ANY($1::text[])`,
    [require('./teamMail').STAFF_ROLES]
  );
  const { queueNotification } = require('../queues/jobs');
  let reminded = 0;
  for (const p of people) {
    const [w, u] = await Promise.all([waitingFor(p.id), unansweredFor(p.id)]);
    const newW = w.filter((x) => !x.followup_reminded_at);
    const newU = u.filter((x) => !x.followup_reminded_at);
    if (!newW.length && !newU.length) continue;
    const parts = [];
    if (newW.length) parts.push(`${newW.length} email${newW.length === 1 ? '' : 's'} you sent ${newW.length === 1 ? 'has' : 'have'} had no reply for ${AFTER_DAYS}+ days`);
    if (newU.length) parts.push(`${newU.length} message${newU.length === 1 ? '' : 's'} to you ${newU.length === 1 ? 'is' : 'are'} still unanswered`);
    await queueNotification({
      userId: p.id,
      type: 'mail_followup',
      content: `Follow-up needed: ${parts.join(' and ')}. Jarvis can draft them in Team mail > Follow-ups.`,
      meta: { href: '/mail?box=followups' },
    });
    for (const x of newW) {
      await query(`UPDATE team_mail_sent SET followup_reminded_at = NOW() WHERE id = $1`, [x.id]);
      await query(`UPDATE outbound_emails SET followup_reminded_at = NOW() WHERE id = $1`, [x.id]);
    }
    for (const x of newU) await query(`UPDATE team_mail SET followup_reminded_at = NOW() WHERE id = $1`, [x.id]);
    reminded += 1;
  }
  return { reminded };
}

module.exports = { listFollowups, draftFollowup, dismiss, remindMailFollowups, waitingFor, unansweredFor, AFTER_DAYS };
