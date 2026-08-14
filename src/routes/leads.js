const express = require('express');
const { query, withTransaction } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    const { status, created_by, q } = req.query;
    const params = [];
    const clauses = [];

    if (req.user.role === 'sales') {
      params.push(req.user.id);
      clauses.push(`l.created_by = $${params.length}`);
    } else if (created_by) {
      params.push(created_by);
      clauses.push(`l.created_by = $${params.length}`);
    }

    if (status) {
      params.push(status);
      clauses.push(`l.status = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      clauses.push(
        `(l.name ILIKE $${params.length} OR l.business_name ILIKE $${params.length} OR COALESCE(l.email,'') ILIKE $${params.length} OR COALESCE(l.business_type,'') ILIKE $${params.length})`
      );
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT l.*,
              (SELECT MAX(e.created_at) FROM lead_engagements e WHERE e.lead_id = l.id) AS last_engagement_at,
              (SELECT MIN(e.follow_up_date) FROM lead_engagements e
               WHERE e.lead_id = l.id AND e.follow_up_date IS NOT NULL AND e.follow_up_date >= CURRENT_DATE) AS next_follow_up
       FROM leads l
       ${where}
       ORDER BY l.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/',
  requirePermission('leads', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { name, phone, email, business_name, business_type, force } = req.body || {};
    if (!name) throw new AppError('name is required', 400, 'VALIDATION');

    // Duplicate check on phone / business name (unless force=true after confirm)
    if (!force) {
      const params = [];
      const clauses = [];
      if (phone?.trim()) {
        params.push(phone.trim().replace(/\s+/g, ''));
        clauses.push(`regexp_replace(COALESCE(phone,''), '\\s', '', 'g') = $${params.length}`);
      }
      if (business_name?.trim()) {
        params.push(business_name.trim().toLowerCase());
        clauses.push(`LOWER(TRIM(COALESCE(business_name,''))) = $${params.length}`);
      }
      if (clauses.length) {
        const { rows: dupes } = await query(
          `SELECT id, name, phone, business_name, business_type, status, created_by,
                  (SELECT u.name FROM users u WHERE u.id = leads.created_by) AS owner_name
           FROM leads
           WHERE ${clauses.join(' OR ')}
           ORDER BY created_at DESC
           LIMIT 5`,
          params
        );
        if (dupes.length) {
          throw new AppError('Possible duplicate lead found', 409, 'DUPLICATE_LEAD', {
            duplicates: dupes,
          });
        }
      }
    }

    const { rows } = await query(
      `INSERT INTO leads (name, phone, email, business_name, business_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name,
        phone || null,
        email || null,
        business_name || null,
        (business_type || '').trim() || null,
        req.user.id,
      ]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/:id',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new AppError('Lead not found', 404, 'NOT_FOUND');
    if (req.user.role === 'sales' && rows[0].created_by !== req.user.id) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    res.json({ ok: true, data: rows[0] });
  })
);

router.patch(
  '/:id',
  requirePermission('leads', 'edit'),
  asyncHandler(async (req, res) => {
    const allowed = ['name', 'phone', 'email', 'business_name', 'business_type', 'status'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new AppError('No fields to update', 400, 'VALIDATION');
    params.push(req.params.id);

    const { rows } = await query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows[0]) throw new AppError('Lead not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/engagements',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { note, follow_up_date, status } = req.body || {};
    if (!note) throw new AppError('note is required', 400, 'VALIDATION');

    const allowedStatus = ['contacting', 'follow_up', 'not_interested', 'converted'];
    if (status && !allowedStatus.includes(status)) {
      throw new AppError('Invalid status', 400, 'VALIDATION');
    }

    const result = await withTransaction(async (tx) => {
      const leadRes = await tx.query(`SELECT * FROM leads WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const lead = leadRes.rows[0];
      if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND');
      if (req.user.role === 'sales' && lead.created_by !== req.user.id) {
        throw new AppError('Forbidden', 403, 'FORBIDDEN');
      }

      const eng = await tx.query(
        `INSERT INTO lead_engagements (lead_id, note, follow_up_date, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, note, follow_up_date || null, req.user.id]
      );

      let nextStatus = status;
      if (!nextStatus && follow_up_date) nextStatus = 'follow_up';

      let client = null;
      if (nextStatus === 'converted' && lead.status !== 'converted') {
        const clientRes = await tx.query(
          `INSERT INTO clients (lead_id, name, business_name, email, phone)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [lead.id, lead.name, lead.business_name, lead.email, lead.phone]
        );
        client = clientRes.rows[0];
        await tx.query(
          `UPDATE leads SET status = 'converted', updated_at = NOW() WHERE id = $1`,
          [lead.id]
        );
      } else if (nextStatus && nextStatus !== lead.status) {
        await tx.query(
          `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2`,
          [nextStatus, lead.id]
        );
      }

      const updated = await tx.query(`SELECT * FROM leads WHERE id = $1`, [lead.id]);
      return { engagement: eng.rows[0], lead: updated.rows[0], client };
    });

    res.status(201).json({ ok: true, data: result });
  })
);

router.get(
  '/:id/engagements',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT e.*, u.name AS created_by_name
       FROM lead_engagements e
       JOIN users u ON u.id = e.created_by
       WHERE e.lead_id = $1
       ORDER BY e.created_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

async function assertLeadAccess(req, leadId) {
  const { rows } = await query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
  if (!rows[0]) throw new AppError('Lead not found', 404, 'NOT_FOUND');
  if (req.user.role === 'sales' && rows[0].created_by !== req.user.id) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
  return rows[0];
}

/** List scheduled / sent messages for a lead */
router.get(
  '/:id/messages',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    await assertLeadAccess(req, req.params.id);
    const { rows } = await query(
      `SELECT m.*, u.name AS created_by_name
       FROM lead_messages m
       JOIN users u ON u.id = m.created_by
       WHERE m.lead_id = $1
       ORDER BY m.scheduled_for DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

/** Schedule a message to the lead's email */
router.post(
  '/:id/messages',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    const lead = await assertLeadAccess(req, req.params.id);
    const subject = (req.body?.subject || '').trim();
    const body = (req.body?.body || '').trim();
    const scheduled_for = req.body?.scheduled_for;
    const send_now = Boolean(req.body?.send_now);

    if (!subject || !body) throw new AppError('subject and body required', 400, 'VALIDATION');
    if (!lead.email) throw new AppError('Lead has no email on file', 400, 'VALIDATION');

    const when = send_now ? new Date() : new Date(scheduled_for);
    if (Number.isNaN(when.getTime())) {
      throw new AppError('scheduled_for must be a valid date/time', 400, 'VALIDATION');
    }

    const { rows } = await query(
      `INSERT INTO lead_messages (lead_id, subject, body, scheduled_for, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [lead.id, subject, body, when.toISOString(), req.user.id]
    );

    if (send_now || when.getTime() <= Date.now()) {
      const { queueLeadMessage } = require('../queues/jobs');
      await queueLeadMessage({ messageId: rows[0].id });
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/** Send a pending scheduled message now */
router.post(
  '/:id/messages/:messageId/send',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    await assertLeadAccess(req, req.params.id);
    const { rows } = await query(
      `SELECT * FROM lead_messages WHERE id = $1 AND lead_id = $2`,
      [req.params.messageId, req.params.id]
    );
    if (!rows[0]) throw new AppError('Message not found', 404, 'NOT_FOUND');
    if (rows[0].status === 'sent') {
      throw new AppError('Message already sent', 409, 'INVALID_STATE');
    }
    if (rows[0].status === 'cancelled') {
      throw new AppError('Message was cancelled', 409, 'INVALID_STATE');
    }

    await query(
      `UPDATE lead_messages
       SET status = 'pending', scheduled_for = NOW(), error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [rows[0].id]
    );

    const { queueLeadMessage } = require('../queues/jobs');
    await queueLeadMessage({ messageId: rows[0].id });
    res.json({ ok: true, data: { queued: true, messageId: rows[0].id } });
  })
);

module.exports = router;
