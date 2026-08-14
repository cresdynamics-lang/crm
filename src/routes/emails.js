const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueOutboundClientEmail } = require('../queues/jobs');

const router = express.Router();
router.use(authenticate);

/**
 * Client email surface for Sales, Finance, and Admin.
 * Finance / invoice / payment mail sends as Cres Dynamics Finance (see emailService).
 */
router.get(
  '/',
  requirePermission('clients', 'view'),
  asyncHandler(async (req, res) => {
    if (!['sales', 'admin', 'finance'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const params = [req.user.id];
    let where = 'WHERE sent_by = $1';
    if (req.query.client_id) {
      params.push(req.query.client_id);
      where += ` AND client_id = $${params.length}`;
    }
    if (req.query.all === '1' && ['admin', 'finance'].includes(req.user.role)) {
      where = 'WHERE 1=1';
      params.length = 0;
      if (req.query.client_id) {
        params.push(req.query.client_id);
        where = `WHERE client_id = $1`;
      }
    }
    const { rows } = await query(
      `SELECT oe.*, u.name AS sender_name, u.email AS sender_email
       FROM outbound_emails oe
       LEFT JOIN users u ON u.id = oe.sent_by
       ${where}
       ORDER BY oe.created_at DESC LIMIT 100`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/',
  requirePermission('clients', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['sales', 'admin', 'finance'].includes(req.user.role)) {
      throw new AppError('Only Sales, Finance, or Admin can email clients', 403, 'FORBIDDEN');
    }

    const { client_id, to_email, subject, body } = req.body || {};
    if (!subject?.trim() || !body?.trim()) {
      throw new AppError('subject and body are required', 400, 'VALIDATION');
    }

    let to = to_email?.trim();
    let clientId = client_id || null;

    if (clientId) {
      const { rows } = await query(`SELECT id, email, name FROM clients WHERE id = $1`, [clientId]);
      if (!rows[0]) throw new AppError('Client not found', 404, 'NOT_FOUND');
      if (!to) to = rows[0].email;
    }

    if (!to) throw new AppError('to_email or client with email required', 400, 'VALIDATION');

    const { rows } = await query(
      `INSERT INTO outbound_emails (sent_by, client_id, to_email, subject, body, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')
       RETURNING *`,
      [req.user.id, clientId, to, subject.trim(), body.trim()]
    );

    await queueOutboundClientEmail({
      emailId: rows[0].id,
      to,
      subject: subject.trim(),
      body: body.trim(),
    });

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
