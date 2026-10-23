/**
 * Admin AI inbox: sync IMAP, draft with Groq, approve/regenerate/ignore/send via Resend.
 */
const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { syncAdminInbox } = require('../services/adminInbox');
const { draftInboxReply } = require('../services/groq');
const { sendWithFailover } = require('../services/emailService');
const config = require('../config');

const router = express.Router();
router.use(authenticate);

function assertAdmin(req) {
  if (req.user.role !== 'admin') {
    throw new AppError('Admin only', 403, 'FORBIDDEN');
  }
}

router.get(
  '/',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const status = req.query.status || 'active';
    const params = [];
    const clauses = [];
    if (status === 'active') {
      clauses.push(`status IN ('pending', 'drafted')`);
    } else if (status === 'all') {
      // no status filter
    } else {
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT * FROM admin_inbox_messages
       ${where}
       ORDER BY COALESCE(received_at, created_at) DESC
       LIMIT 100`,
      params
    );
    res.json({
      ok: true,
      data: rows,
      meta: {
        imapConfigured: !!(config.imap.host && config.imap.user && config.imap.password),
        groqConfigured: !!config.groq.apiKey,
        resendConfigured: !!(config.email.resendApiKey && config.email.resendFrom),
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
    const result = await syncAdminInbox({ limit: Number(req.body?.limit) || 20 });
    res.json({ ok: true, data: result });
  })
);

router.get(
  '/:id',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [
      req.params.id,
    ]);
    if (!rows[0]) throw new AppError('Message not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/regenerate',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [
      req.params.id,
    ]);
    const msg = rows[0];
    if (!msg) throw new AppError('Message not found', 404, 'NOT_FOUND');
    if (['sent', 'ignored'].includes(msg.status)) {
      throw new AppError('Message is closed', 409, 'INVALID_STATE');
    }

    const instructions = String(req.body?.instructions || '').trim();
    const drafted = await draftInboxReply({
      fromName: msg.from_name,
      fromEmail: msg.from_email,
      subject: msg.subject,
      bodyText: msg.body_text,
      attachmentSummaries: msg.attachment_summaries,
      instructions,
    });

    const { rows: updated } = await query(
      `UPDATE admin_inbox_messages
       SET ai_draft = $1,
           ai_summary = COALESCE($2, ai_summary),
           ai_instructions = $3,
           status = 'drafted',
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [drafted.draft, drafted.summary, instructions || null, msg.id]
    );
    res.json({ ok: true, data: updated[0] });
  })
);

router.post(
  '/:id/approve',
  requirePermission('users', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [
      req.params.id,
    ]);
    const msg = rows[0];
    if (!msg) throw new AppError('Message not found', 404, 'NOT_FOUND');
    if (['sent', 'ignored'].includes(msg.status)) {
      throw new AppError('Message is closed', 409, 'INVALID_STATE');
    }

    const body = String(req.body?.body || msg.ai_draft || '').trim();
    if (!body) throw new AppError('No draft body to send', 400, 'VALIDATION');

    const subject = req.body?.subject || `Re: ${msg.subject || ''}`.trim();

    // Original recipients (CC + To) are CC'd back, minus the sender.
    const originalCc = [...new Set([...(msg.cc_emails || []), ...(msg.to_emails || [])])].filter(
      (e) => e && e.toLowerCase() !== msg.from_email.toLowerCase()
    );
    // Optional extra CC supplied by the admin at send time.
    const extraCc = String(req.body?.cc || '')
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    const cc = [...new Set([...originalCc, ...extraCc])].filter(Boolean);

    const sent = await sendWithFailover({
      to: msg.from_email,
      cc: cc.length ? cc : undefined,
      subject,
      body,
      meta: { fromRole: 'default', type: 'admin_inbox_reply', inboxId: msg.id },
    });

    const { rows: updated } = await query(
      `UPDATE admin_inbox_messages
       SET status = 'sent',
           final_body = $1,
           ai_draft = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [body, msg.id]
    );

    res.json({ ok: true, data: updated[0], meta: { sent } });
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
       SET status = 'ignored', updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('sent')
       RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Message not found or already sent', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
