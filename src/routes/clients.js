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
  requirePermission('clients', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'client') {
      const { rows } = await query(
        `SELECT * FROM clients WHERE user_id = $1 OR email = $2`,
        [req.user.id, req.user.email]
      );
      return res.json({ ok: true, data: rows });
    }

    const { rows } = await query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM projects p WHERE p.client_id = c.id) AS project_count
       FROM clients c
       ${req.query.q ? `WHERE c.name ILIKE $1 OR c.business_name ILIKE $1 OR c.email ILIKE $1` : ''}
       ORDER BY c.converted_at DESC NULLS LAST, c.name ASC
       LIMIT 200`,
      req.query.q ? [`%${String(req.query.q).trim()}%`] : []
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/',
  requirePermission('clients', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { name, business_name, email, phone, lead_id } = req.body || {};
    if (!name) throw new AppError('name is required', 400, 'VALIDATION');

    const client = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO clients (lead_id, name, business_name, email, phone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [lead_id || null, name, business_name || null, email || null, phone || null]
      );

      if (lead_id) {
        await tx.query(
          `UPDATE leads SET status = 'converted', updated_at = NOW() WHERE id = $1`,
          [lead_id]
        );
      }
      return rows[0];
    });

    res.status(201).json({ ok: true, data: client });
  })
);

router.post(
  '/convert/:leadId',
  requirePermission('clients', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { rows: leads } = await query(`SELECT * FROM leads WHERE id = $1`, [req.params.leadId]);
    const lead = leads[0];
    if (!lead) throw new AppError('Lead not found', 404, 'NOT_FOUND');

    const client = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO clients (lead_id, name, business_name, email, phone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [lead.id, lead.name, lead.business_name, lead.email, lead.phone]
      );
      await tx.query(
        `UPDATE leads SET status = 'converted', updated_at = NOW() WHERE id = $1`,
        [lead.id]
      );
      return rows[0];
    });

    res.status(201).json({ ok: true, data: client });
  })
);

router.get(
  '/:id',
  requirePermission('clients', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new AppError('Client not found', 404, 'NOT_FOUND');
    const client = rows[0];
    const { rows: projects } = await query(
      `SELECT id, name, status, value_amount, created_at, updated_at FROM projects WHERE client_id = $1 ORDER BY created_at DESC`,
      [client.id]
    );
    const { rows: money } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS invoiced,
              COALESCE(SUM(amount_paid),0)::float AS paid
       FROM invoices WHERE client_id = $1`,
      [client.id]
    );
    const showMoney = ['admin', 'finance', 'director', 'sales'].includes(req.user.role);
    const data = {
      ...client,
      projects: projects.map((p) => {
        const row = { ...p };
        if (!showMoney) delete row.value_amount;
        return row;
      }),
    };
    if (showMoney) {
      data.invoiced = money[0].invoiced;
      data.paid = money[0].paid;
      data.balance = Math.max(0, money[0].invoiced - money[0].paid);
    }
    res.json({ ok: true, data });
  })
);

router.get(
  '/:id/projects',
  requirePermission('clients', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, status, assigned_developer_id, created_at, approved_at, summary
       FROM projects
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

module.exports = router;
