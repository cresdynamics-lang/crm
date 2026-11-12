/**
 * Admin AI inbox (info@).
 *
 * Mail arrives live (IMAP IDLE watcher) or via "Sync now". Each email gets a
 * scam check; Jarvis pre-drafts replies following how Cres Dynamics operates.
 * The admin decides: send (as drafted or edited), decline (polite no), ignore,
 * delete (recoverable), mark scam / not scam, mark read / unread - one at a
 * time or in bulk. Nothing is ever sent without the admin pressing a button.
 */
const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { syncAdminInbox, draftForMessage } = require('../services/adminInbox');
const { sendWithFailover } = require('../services/emailService');
const config = require('../config');

const router = express.Router();
router.use(authenticate);

function assertAdmin(req) {
  if (req.user.role !== 'admin') {
    throw new AppError('Admin only', 403, 'FORBIDDEN');
  }
}

const UUID = /^[0-9a-f-]{36}$/i;
const CLOSED = ['sent', 'ignored', 'declined'];

function live(event, payload) {
  try {
    require('../realtime/socket').emitToRole('admin', event, payload);
  } catch {
    /* optional */
  }
}

async function loadMsg(id) {
  if (!UUID.test(String(id))) throw new AppError('Message not found', 404, 'NOT_FOUND');
  const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [id]);
  if (!rows[0]) throw new AppError('Message not found', 404, 'NOT_FOUND');
  return rows[0];
}

/** Filters for the tabs. Deleted mail only shows in the Deleted tab. */
function filterSql(status) {
  switch (status) {
    case 'active':
      return `deleted_at IS NULL AND is_scam = FALSE AND status IN ('pending', 'drafted', 'error')`;
    case 'unread':
      return `deleted_at IS NULL AND is_read = FALSE AND is_scam = FALSE`;
    case 'read':
      return `deleted_at IS NULL AND is_read = TRUE AND is_scam = FALSE`;
    case 'scam':
      return `deleted_at IS NULL AND is_scam = TRUE`;
    case 'deleted':
      return `deleted_at IS NOT NULL`;
    case 'all':
      return `deleted_at IS NULL`;
    case 'sent':
    case 'ignored':
    case 'declined':
      return `deleted_at IS NULL AND status = '${status}'`;
    default:
      return `deleted_at IS NULL AND is_scam = FALSE AND status IN ('pending', 'drafted', 'error')`;
  }
}

router.get(
  '/',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const status = String(req.query.status || 'active');
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = filterSql(status);
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (subject ILIKE $1 OR from_email ILIKE $1 OR from_name ILIKE $1 OR body_text ILIKE $1)`;
    }
    const { rows } = await query(
      `SELECT id, from_email, from_name, subject, LEFT(body_text, 400) AS body_text, received_at, created_at,
              has_attachments, status, ai_summary, (ai_draft IS NOT NULL) AS has_draft,
              is_read, is_scam, scam_score, scam_reasons, deleted_at
         FROM admin_inbox_messages
        WHERE ${where}
        ORDER BY COALESCE(received_at, created_at) DESC
        LIMIT 200`,
      params
    );
    const { rows: c } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE ${filterSql('active')})::int AS active,
         COUNT(*) FILTER (WHERE ${filterSql('unread')})::int AS unread,
         COUNT(*) FILTER (WHERE ${filterSql('read')})::int AS read,
         COUNT(*) FILTER (WHERE ${filterSql('scam')})::int AS scam,
         COUNT(*) FILTER (WHERE ${filterSql('deleted')})::int AS deleted
       FROM admin_inbox_messages`
    );
    let watcher = null;
    try {
      watcher = require('../lib/leader').status().find((s) => s.name === 'inbox-watcher') || null;
    } catch {
      watcher = null;
    }
    res.json({
      ok: true,
      data: rows,
      meta: {
        counts: c[0],
        imapConfigured: !!(config.imap.host && config.imap.user && config.imap.password),
        mailbox: config.imap.user || null,
        groqConfigured: !!config.groq.apiKey,
        resendConfigured: !!(config.email.resendApiKey && config.email.resendFrom),
        liveWatcherHere: watcher?.running || false,
      },
    });
  })
);

router.post(
  '/sync',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const result = await syncAdminInbox({ limit: Number(req.body?.limit) || 30 });
    res.json({ ok: true, data: result });
  })
);

/**
 * POST /bulk { ids: [...], action }
 * action: read | unread | scam | not_scam | ignore | delete | restore | purge
 */
router.post(
  '/bulk',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const ids = [...new Set((req.body?.ids || []).map(String))].filter((x) => UUID.test(x)).slice(0, 500);
    const action = String(req.body?.action || '');
    if (!ids.length) throw new AppError('Select at least one email', 400, 'VALIDATION');
    const uid = req.user.id;
    const SQL = {
      read: [`UPDATE admin_inbox_messages SET is_read = TRUE, read_at = COALESCE(read_at, NOW()), updated_at = NOW() WHERE id = ANY($1::uuid[])`, [ids]],
      unread: [`UPDATE admin_inbox_messages SET is_read = FALSE, read_at = NULL, updated_at = NOW() WHERE id = ANY($1::uuid[])`, [ids]],
      scam: [`UPDATE admin_inbox_messages SET is_scam = TRUE, is_read = TRUE, scam_marked_by = $2, updated_at = NOW() WHERE id = ANY($1::uuid[])`, [ids, uid]],
      not_scam: [`UPDATE admin_inbox_messages SET is_scam = FALSE, scam_marked_by = $2, updated_at = NOW() WHERE id = ANY($1::uuid[])`, [ids, uid]],
      ignore: [`UPDATE admin_inbox_messages SET status = 'ignored', is_read = TRUE, handled_by = $2, updated_at = NOW() WHERE id = ANY($1::uuid[]) AND status NOT IN ('sent', 'declined')`, [ids, uid]],
      delete: [`UPDATE admin_inbox_messages SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids, uid]],
      restore: [`UPDATE admin_inbox_messages SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW() WHERE id = ANY($1::uuid[])`, [ids]],
      // Permanent: only for mail already in the Deleted tab
      purge: [`DELETE FROM admin_inbox_messages WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`, [ids]],
    };
    if (!SQL[action]) throw new AppError('Unknown action', 400, 'VALIDATION');
    const r = await query(SQL[action][0], SQL[action][1]);
    live('inbox:updated', { ids, action });
    res.json({ ok: true, data: { action, changed: r.rowCount } });
  })
);

router.get(
  '/:id',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    let msg = await loadMsg(req.params.id);
    if (!msg.is_read) {
      const { rows } = await query(
        `UPDATE admin_inbox_messages SET is_read = TRUE, read_at = NOW() WHERE id = $1 RETURNING *`,
        [msg.id]
      );
      msg = rows[0];
      live('inbox:updated', { ids: [msg.id], action: 'read' });
    }
    if (msg.routed_to) {
      const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [msg.routed_to]);
      msg.routed_to_name = rows[0]?.name || null;
    }
    res.json({ ok: true, data: msg });
  })
);

/** Download one attachment (admin only; files are never served publicly). */
router.get(
  '/:id/attachments/:index',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    let list = Array.isArray(msg.attachment_summaries) ? msg.attachment_summaries : [];
    const i = Number(req.params.index);
    if (!list[i]?.file && msg.has_attachments) {
      const { refetchAttachments } = require('../services/adminInbox');
      list = (await refetchAttachments(msg).catch(() => null)) || list;
    }
    const a = list[i];
    const { attachmentPath } = require('../services/adminInbox');
    const full = a?.file ? attachmentPath(a.file) : null;
    if (!full || !require('fs').existsSync(full)) throw new AppError('Attachment not available', 404, 'NOT_FOUND');
    const safeName = String(a.name || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(full);
  })
);

/** Save an edited draft without sending. */
router.patch(
  '/:id/draft',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    if (CLOSED.includes(msg.status)) throw new AppError('This email is already handled', 409, 'INVALID_STATE');
    const body = String(req.body?.body ?? '').slice(0, 20000);
    const { rows } = await query(
      `UPDATE admin_inbox_messages SET ai_draft = $1, status = CASE WHEN $1 = '' THEN status ELSE 'drafted' END, updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [body, msg.id]
    );
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/regenerate',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    if (CLOSED.includes(msg.status)) throw new AppError('This email is already handled', 409, 'INVALID_STATE');
    const mode = req.body?.mode === 'decline' ? 'decline' : 'reply';
    const updated = await draftForMessage(msg.id, { instructions: String(req.body?.instructions || '').trim(), mode });
    res.json({ ok: true, data: updated, meta: { draftedBy: updated.draftedBy } });
  })
);

/** Build the reply envelope: to the sender (or their Reply-To), CC the others. */
function envelope(msg, extraCcRaw) {
  const to = msg.reply_to_email && !msg.is_scam ? msg.reply_to_email : msg.from_email;
  const originalCc = [...new Set([...(msg.cc_emails || []), ...(msg.to_emails || [])])].filter(
    (e) => e && e.toLowerCase() !== msg.from_email.toLowerCase() && e.toLowerCase() !== String(config.imap.user || '').toLowerCase()
  );
  const extraCc = String(extraCcRaw || '').split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /.+@.+\..+/.test(e));
  const cc = [...new Set([...originalCc, ...extraCc])];
  const headers = msg.message_id && !String(msg.message_id).startsWith('uid-')
    ? { 'In-Reply-To': msg.message_id, References: msg.message_id }
    : undefined;
  return { to, cc: cc.length ? cc : undefined, headers };
}

async function sendAndClose(req, msg, { body, status }) {
  const subject = String(req.body?.subject || `Re: ${msg.subject || ''}`).trim();
  const env = envelope(msg, req.body?.cc);
  const sent = await sendWithFailover({
    ...env,
    subject,
    body,
    meta: { fromRole: 'default', type: status === 'declined' ? 'admin_inbox_decline' : 'admin_inbox_reply', inboxId: msg.id },
  });
  const { rows } = await query(
    `UPDATE admin_inbox_messages
        SET status = $1, final_body = $2, ai_draft = $2, is_read = TRUE, handled_by = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
    [status, body, req.user.id, msg.id]
  );
  live('inbox:updated', { ids: [msg.id], action: status });
  return { row: rows[0], sent, to: env.to };
}

/** Send the reply (as drafted, or as edited in the box). */
router.post(
  '/:id/approve',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    if (CLOSED.includes(msg.status)) throw new AppError('This email is already handled', 409, 'INVALID_STATE');
    if (msg.deleted_at) throw new AppError('Restore this email before replying', 409, 'INVALID_STATE');
    const body = String(req.body?.body || msg.ai_draft || '').trim();
    if (!body) throw new AppError('No reply to send - write one or draft with Jarvis', 400, 'VALIDATION');
    const out = await sendAndClose(req, msg, { body, status: 'sent' });
    res.json({ ok: true, data: { ...out.row, to: out.to }, meta: { sent: out.sent } });
  })
);

/**
 * Decline: send a polite "no". Uses the text in the box if given; otherwise
 * Jarvis writes a short decline first. send=false just marks it declined.
 */
router.post(
  '/:id/decline',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    if (CLOSED.includes(msg.status)) throw new AppError('This email is already handled', 409, 'INVALID_STATE');
    if (req.body?.send === false) {
      const { rows } = await query(
        `UPDATE admin_inbox_messages SET status = 'declined', is_read = TRUE, handled_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [msg.id, req.user.id]
      );
      live('inbox:updated', { ids: [msg.id], action: 'declined' });
      return res.json({ ok: true, data: { ...rows[0], to: null } });
    }
    let body = String(req.body?.body || '').trim();
    if (!body) {
      const d = await draftForMessage(msg.id, { mode: 'decline', instructions: String(req.body?.instructions || '') });
      body = String(d.ai_draft || '').trim();
    }
    if (!body) throw new AppError('Could not write the decline - type one in the box', 400, 'VALIDATION');
    const out = await sendAndClose(req, msg, { body, status: 'declined' });
    res.json({ ok: true, data: { ...out.row, to: out.to }, meta: { sent: out.sent } });
  })
);

router.post(
  '/:id/ignore',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(
      `UPDATE admin_inbox_messages
          SET status = 'ignored', is_read = TRUE, handled_by = $2, updated_at = NOW()
        WHERE id = $1 AND status NOT IN ('sent', 'declined')
        RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) throw new AppError('Message not found or already answered', 404, 'NOT_FOUND');
    live('inbox:updated', { ids: [rows[0].id], action: 'ignored' });
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/scam',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    const isScam = req.body?.scam !== false;
    const { rows } = await query(
      `UPDATE admin_inbox_messages SET is_scam = $2, is_read = TRUE, scam_marked_by = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [msg.id, isScam, req.user.id]
    );
    live('inbox:updated', { ids: [msg.id], action: isScam ? 'scam' : 'not_scam' });
    res.json({ ok: true, data: rows[0] });
  })
);

/** Soft delete (Deleted tab; restore any time). */
router.delete(
  '/:id',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const msg = await loadMsg(req.params.id);
    const { rows } = await query(
      `UPDATE admin_inbox_messages SET deleted_at = COALESCE(deleted_at, NOW()), deleted_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [msg.id, req.user.id]
    );
    live('inbox:updated', { ids: [msg.id], action: 'delete' });
    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
