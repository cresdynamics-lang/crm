/**
 * Team mail API (/api/mail): emails forwarded inside CRES OS, and emails staff
 * send to outside people as "<Name> - <Team>, Cres Dynamics Ltd" with replies
 * to the company inbox. Every staff member sees only their own mail.
 */
const express = require('express');
const fs = require('fs');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../lib/errors');
const tm = require('../services/teamMail');

const router = express.Router();
router.use(authenticate);

const UUID = /^[0-9a-f-]{36}$/i;

function staffOnly(req) {
  if (!tm.STAFF_ROLES.includes(req.user.role)) throw new AppError('Team mail is for staff', 403, 'FORBIDDEN');
}

async function myMail(req, id) {
  if (!UUID.test(String(id))) throw new AppError('Email not found', 404, 'NOT_FOUND');
  const { rows } = await query(
    `SELECT t.*, f.name AS from_user_name, fr.name AS from_user_role
       FROM team_mail t
       LEFT JOIN users f ON f.id = t.from_user_id
       LEFT JOIN roles fr ON fr.id = f.role_id
      WHERE t.id = $1 AND t.to_user_id = $2`,
    [id, req.user.id]
  );
  if (!rows[0]) throw new AppError('Email not found', 404, 'NOT_FOUND');
  return rows[0];
}

/** Who you can forward to: people and teams. */
router.get(
  '/people',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const { rows } = await query(
      `SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' AND r.name = ANY($1::text[]) AND u.id <> $2
        ORDER BY r.name, u.name`,
      [tm.STAFF_ROLES, req.user.id]
    );
    const teams = Object.entries(tm.TEAMS)
      .map(([role, label]) => ({ role, label, members: rows.filter((p) => p.role === role).length }))
      .filter((t) => t.members > 0);
    res.json({ ok: true, data: { people: rows, teams, me: { from: tm.displayName(req.user), replyTo: tm.replyToAddress() } } });
  })
);

/** GET /api/mail?box=inbox|done|sent */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const box = String(req.query.box || 'inbox');
    if (box === 'sent') {
      const { rows } = await query(
        `SELECT id, to_email, cc, subject, LEFT(body, 300) AS body, status, error, team_label, created_at
           FROM team_mail_sent WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.user.id]
      );
      return res.json({ ok: true, data: rows });
    }
    const statusSql = box === 'done' ? `t.status = 'done'` : `t.status <> 'done'`;
    const { rows } = await query(
      `SELECT t.id, t.subject, LEFT(t.body, 240) AS body, t.note, t.status, t.auto_routed, t.to_team, t.created_at,
              t.original_from_email, t.original_from_name, jsonb_array_length(t.attachments) AS attachment_count,
              f.name AS from_user_name
         FROM team_mail t LEFT JOIN users f ON f.id = t.from_user_id
        WHERE t.to_user_id = $1 AND ${statusSql}
        ORDER BY t.created_at DESC LIMIT 150`,
      [req.user.id]
    );
    const { rows: c } = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'unread')::int AS unread, COUNT(*) FILTER (WHERE status <> 'done')::int AS inbox
         FROM team_mail WHERE to_user_id = $1`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows, meta: { counts: c[0], me: { from: tm.displayName(req.user), replyTo: tm.replyToAddress() } } });
  })
);

/** POST /api/mail/forward { inbox_message_id | mail_id, user_ids[], teams[], subject, body, note } */
router.post(
  '/forward',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const b = req.body || {};
    const created = await tm.forward({
      by: req.user,
      source: { inboxMessageId: b.inbox_message_id || null, mailId: b.mail_id || null },
      userIds: Array.isArray(b.user_ids) ? b.user_ids : [],
      teams: Array.isArray(b.teams) ? b.teams : [],
      subject: b.subject,
      body: b.body,
      note: b.note,
    });
    res.status(201).json({ ok: true, data: { forwarded: created.length, to: created.map((c) => c.to) } });
  })
);

/** Compose a new email to someone outside. */
router.post(
  '/send',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const out = await tm.sendOutside({ by: req.user, to: req.body?.to, cc: req.body?.cc, subject: req.body?.subject, body: req.body?.body });
    res.status(201).json({ ok: true, data: out });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    let mail = await myMail(req, req.params.id);
    if (mail.status === 'unread') {
      await query(`UPDATE team_mail SET status = 'read', read_at = NOW() WHERE id = $1`, [mail.id]);
      mail = { ...mail, status: 'read' };
    }
    const { rows: sent } = await query(
      `SELECT to_email, subject, body, created_at, status FROM team_mail_sent WHERE team_mail_id = $1 AND user_id = $2 ORDER BY created_at`,
      [mail.id, req.user.id]
    );
    res.json({ ok: true, data: { ...mail, replies: sent, me: { from: tm.displayName(req.user), replyTo: tm.replyToAddress() } } });
  })
);

/** Reply to the original sender (outside), from "<Name> - <Team>, Cres Dynamics Ltd". */
router.post(
  '/:id/reply',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const mail = await myMail(req, req.params.id);
    if (!mail.original_from_email) throw new AppError('This email has no outside sender to reply to', 400, 'VALIDATION');
    const subject = req.body?.subject || (/^re:/i.test(mail.original_subject || '') ? mail.original_subject : `Re: ${mail.original_subject || mail.subject}`);
    const out = await tm.sendOutside({ by: req.user, to: req.body?.to || mail.original_from_email, cc: req.body?.cc, subject, body: req.body?.body, teamMailId: mail.id });
    res.status(201).json({ ok: true, data: out });
  })
);

/** Jarvis drafts the reply, signed as this person and their team. */
router.post(
  '/:id/draft',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const mail = await myMail(req, req.params.id);
    const { jarvisDraftReply } = require('../services/jarvisMailDraft');
    let attachments = [];
    if (mail.inbox_message_id) {
      const { rows } = await query(`SELECT attachment_summaries FROM admin_inbox_messages WHERE id = $1`, [mail.inbox_message_id]);
      attachments = rows[0]?.attachment_summaries || [];
    }
    const team = tm.teamLabel(req.user.role);
    const d = await jarvisDraftReply({
      id: mail.inbox_message_id,
      fromName: mail.original_from_name,
      fromEmail: mail.original_from_email,
      subject: mail.original_subject || mail.subject,
      bodyText: mail.body,
      attachmentSummaries: attachments,
      instructions: [String(req.body?.instructions || '').trim(), mail.note ? `Note from ${mail.from_user_name || 'a colleague'}: ${mail.note}` : ''].filter(Boolean).join('\n'),
      mode: req.body?.mode === 'decline' ? 'decline' : 'reply',
      signoff: `Kind regards,\n${req.user.name}\n${team === 'Director' ? 'Director' : team}, Cres Dynamics Ltd`,
    });
    res.json({ ok: true, data: { draft: d.draft, summary: d.summary } });
  })
);

router.post(
  '/:id/done',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const mail = await myMail(req, req.params.id);
    const status = req.body?.done === false ? 'read' : 'done';
    await query(`UPDATE team_mail SET status = $1 WHERE id = $2`, [status, mail.id]);
    res.json({ ok: true, data: { id: mail.id, status } });
  })
);

/** Attachments of a forwarded email (only for its recipient). */
router.get(
  '/:id/attachments/:index',
  asyncHandler(async (req, res) => {
    staffOnly(req);
    const mail = await myMail(req, req.params.id);
    if (!mail.inbox_message_id) throw new AppError('Attachment not available', 404, 'NOT_FOUND');
    const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [mail.inbox_message_id]);
    const msg = rows[0];
    const i = Number(req.params.index);
    let list = msg?.attachment_summaries || [];
    const { attachmentPath, refetchAttachments } = require('../services/adminInbox');
    if (msg && !list[i]?.file && msg.has_attachments) list = (await refetchAttachments(msg).catch(() => null)) || list;
    const a = list[i];
    const full = a?.file ? attachmentPath(a.file) : null;
    if (!full || !fs.existsSync(full)) throw new AppError('Attachment not available', 404, 'NOT_FOUND');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(a.name || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 120)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(full);
  })
);

module.exports = router;
