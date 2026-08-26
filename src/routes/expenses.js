const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueNotification } = require('../queues/jobs');

const router = express.Router();
router.use(authenticate);

async function expenseThreshold() {
  const { rows } = await query(
    `SELECT value FROM system_settings WHERE key = 'expense_approval'`
  );
  const v = rows[0]?.value || { threshold: 500, requireAboveThreshold: true };
  return {
    threshold: Number(v.threshold ?? 500),
    requireAboveThreshold: v.requireAboveThreshold !== false,
  };
}

async function notifyRoles(roles, payload) {
  const { rows } = await query(
    `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name = ANY($1::text[]) AND u.status = 'active'`,
    [roles]
  );
  for (const u of rows) {
    await queueNotification({ ...payload, userId: u.id });
  }
}

router.get(
  '/',
  requirePermission('expenses', 'view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const clauses = [];
    if (req.query.category) {
      params.push(req.query.category);
      clauses.push(`e.category = $${params.length}`);
    }
    if (req.query.approval_status) {
      // Support legacy "pending" as either finance or admin queue
      if (req.query.approval_status === 'pending') {
        clauses.push(`e.approval_status IN ('pending', 'pending_finance', 'pending_admin')`);
      } else if (req.query.approval_status === 'pending_finance') {
        clauses.push(`e.approval_status IN ('pending_finance', 'pending')`);
      } else {
        params.push(req.query.approval_status);
        clauses.push(`e.approval_status = $${params.length}`);
      }
    }
    // Director sees expenses they created + anything still in flight they care about
    if (req.user.role === 'director' && req.query.mine === '1') {
      params.push(req.user.id);
      clauses.push(`e.created_by = $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT e.*,
              c.name AS created_by_name,
              cr.name AS created_by_role,
              f.name AS finance_approved_by_name,
              a.name AS approved_by_name
       FROM expenses e
       LEFT JOIN users c ON c.id = e.created_by
       LEFT JOIN roles cr ON cr.id = c.role_id
       LEFT JOIN users f ON f.id = e.finance_approved_by
       LEFT JOIN users a ON a.id = e.approved_by
       ${where}
       ORDER BY e.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

/**
 * Create expense.
 * Director submissions always: pending_finance → Finance → Admin → approved.
 * Other roles: threshold may send to pending_admin; else auto-approved.
 */
router.post(
  '/',
  requirePermission('expenses', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { category, amount, description, linked_salary_id } = req.body || {};
    if (!category || amount == null) {
      throw new AppError('category and amount required', 400, 'VALIDATION');
    }
    if (!['operational', 'other', 'salary'].includes(category)) {
      throw new AppError('Invalid category', 400, 'VALIDATION');
    }

    const amt = Number(amount);
    if (!(amt > 0)) throw new AppError('amount must be positive', 400, 'VALIDATION');

    let approval_status = 'approved';
    let pipeline = 'auto';

    if (req.user.role === 'director') {
      // Director expenses always need Finance then Admin
      approval_status = 'pending_finance';
      pipeline = 'director_finance_admin';
    } else if (category !== 'salary' && !linked_salary_id) {
      const { threshold, requireAboveThreshold } = await expenseThreshold();
      if (requireAboveThreshold && amt > threshold) {
        approval_status = 'pending_admin';
        pipeline = 'threshold_admin';
      }
    }

    const { rows } = await query(
      `INSERT INTO expenses
        (category, amount, description, linked_salary_id, created_by, approval_status,
         approved_at)
       VALUES ($1, $2, $3, $4, $5, $6::varchar,
         CASE WHEN $6::varchar = 'approved' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [category, amt, description || null, linked_salary_id || null, req.user.id, approval_status]
    );

    const expense = rows[0];
    if (approval_status === 'pending_finance') {
      await notifyRoles(['finance', 'admin'], {
        type: 'expense_pending_finance',
        content: `Director expense ${amt} needs Finance approval: ${description || category}`,
        meta: {
          expenseId: expense.id,
          href: '#/expenses',
          action: 'Finance must approve, then Admin.',
        },
      });
    } else if (approval_status === 'pending_admin') {
      await notifyRoles(['admin'], {
        type: 'expense_pending_admin',
        content: `Expense ${amt} needs Admin approval before the transaction can proceed`,
        meta: {
          expenseId: expense.id,
          href: '#/expenses',
          action: 'Admin final approval required.',
        },
      });
    }

    res.status(201).json({
      ok: true,
      data: expense,
      meta: { approval_status, pipeline },
    });
  })
);

/** Finance approves Director expenses → escalate to Admin */
router.post(
  '/:id/finance-approve',
  requirePermission('expenses', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Finance can approve at this stage', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `UPDATE expenses
       SET approval_status = 'pending_admin',
           finance_approved_by = $1,
           finance_approved_at = NOW(),
           approval_note = COALESCE($2, approval_note)
       WHERE id = $3 AND approval_status IN ('pending_finance', 'pending')
       RETURNING *`,
      [req.user.id, req.body?.note || null, req.params.id]
    );
    if (!rows[0]) {
      throw new AppError('Expense not found or not awaiting Finance', 409, 'INVALID_STATE');
    }

    await notifyRoles(['admin'], {
      type: 'expense_pending_admin',
      content: `Finance approved expense ${rows[0].amount} — Admin final approval needed`,
      meta: {
        expenseId: rows[0].id,
        href: '#/expenses',
        action: 'Admin must approve before the transaction can happen.',
      },
    });
    if (rows[0].created_by) {
      await queueNotification({
        userId: rows[0].created_by,
        type: 'expense_finance_approved',
        content: `Finance approved your expense of ${rows[0].amount}; waiting on Admin`,
        meta: { expenseId: rows[0].id, href: '#/expenses' },
      });
    }

    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * Admin final approval — transaction may proceed.
 * Also accepts legacy pending / pending_admin.
 */
router.post(
  '/:id/approve',
  requirePermission('expenses', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'finance') {
      // Finance can only use finance-approve; Admin does final approve
      throw new AppError('Only Admin can give final expense approval', 403, 'FORBIDDEN');
    }
    if (req.user.role === 'finance') {
      throw new AppError('Use Finance approve to escalate to Admin', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `UPDATE expenses
       SET approval_status = 'approved',
           approved_by = $1,
           approved_at = NOW(),
           approval_note = COALESCE($2, approval_note)
       WHERE id = $3 AND approval_status IN ('pending_admin', 'pending')
       RETURNING *`,
      [req.user.id, req.body?.note || null, req.params.id]
    );
    if (!rows[0]) {
      throw new AppError(
        'Expense not found or not awaiting Admin (Finance must approve first for Director expenses)',
        409,
        'INVALID_STATE'
      );
    }

    if (rows[0].created_by) {
      await queueNotification({
        userId: rows[0].created_by,
        type: 'expense_approved',
        content: `Admin approved your expense of ${rows[0].amount} — transaction may proceed`,
        meta: { expenseId: rows[0].id, href: '#/expenses' },
      });
    }
    await notifyRoles(['finance'], {
      type: 'expense_approved',
      content: `Admin approved expense ${rows[0].amount} — transaction unlocked`,
      meta: { expenseId: rows[0].id, href: '#/expenses' },
    });

    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/reject',
  requirePermission('expenses', 'edit'),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Finance or Admin can reject expenses', 403, 'FORBIDDEN');
    }
    const note = (req.body?.note || '').trim();
    if (!note) throw new AppError('Rejection note required', 400, 'VALIDATION');

    const allowedStatuses =
      req.user.role === 'finance'
        ? ['pending_finance', 'pending']
        : ['pending_admin', 'pending_finance', 'pending'];

    const { rows } = await query(
      `UPDATE expenses
       SET approval_status = 'rejected',
           approved_by = $1,
           approved_at = NOW(),
           approval_note = $2
       WHERE id = $3 AND approval_status = ANY($4::text[])
       RETURNING *`,
      [req.user.id, note, req.params.id, allowedStatuses]
    );
    if (!rows[0]) throw new AppError('Expense not found or not rejectable', 409, 'INVALID_STATE');

    if (rows[0].created_by) {
      await queueNotification({
        userId: rows[0].created_by,
        type: 'expense_rejected',
        content: `Your expense of ${rows[0].amount} was rejected: ${note}`,
        meta: { expenseId: rows[0].id, href: '#/expenses' },
      });
    }

    res.json({ ok: true, data: rows[0] });
  })
);

/** Flag invoice for sales follow-up */
router.post(
  '/flag-invoice',
  requirePermission('invoice_followups', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { invoice_id, assigned_sales_user_id, note } = req.body || {};
    if (!invoice_id || !assigned_sales_user_id) {
      throw new AppError('invoice_id and assigned_sales_user_id required', 400, 'VALIDATION');
    }

    const inv = await query(`SELECT id, status FROM invoices WHERE id = $1`, [invoice_id]);
    if (!inv.rows[0]) throw new AppError('Invoice not found', 404, 'NOT_FOUND');

    const { rows } = await query(
      `INSERT INTO invoice_followups (invoice_id, assigned_sales_user_id, flagged_by, note)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [invoice_id, assigned_sales_user_id, req.user.id, note || null]
    );

    await queueNotification({
      userId: assigned_sales_user_id,
      type: 'invoice_followup',
      content: `Invoice flagged for your follow-up${note ? `: ${note}` : ''}`,
      meta: { invoiceId: invoice_id, followupId: rows[0].id, href: '#/followups' },
    });

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/:id/receipt',
  requirePermission('expenses', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT approval_status FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    if (!rows[0]) throw new AppError('Expense not found', 404, 'NOT_FOUND');
    if (rows[0].approval_status !== 'approved') {
      throw new AppError(
        'Receipt available only after Admin approval (transaction unlocked)',
        409,
        'NOT_APPROVED'
      );
    }
    const { expenseReceipt } = require('../services/receipts');
    const receipt = await expenseReceipt(req.params.id);
    res.json({ ok: true, data: receipt });
  })
);

router.get(
  '/:id/receipt/file',
  requirePermission('expenses', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT approval_status FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    if (!rows[0]) throw new AppError('Expense not found', 404, 'NOT_FOUND');
    if (rows[0].approval_status !== 'approved') {
      throw new AppError(
        'Receipt available only after Admin approval (transaction unlocked)',
        409,
        'NOT_APPROVED'
      );
    }
    const { expenseReceipt } = require('../services/receipts');
    const { expenseReceiptPdf } = require('../services/pdfService');
    const receipt = await expenseReceipt(req.params.id);
    const pdf = await expenseReceiptPdf(receipt);
    const filename = `${String(receipt.documentNumber || 'expense-receipt').replace(/[^\w.\-]+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  })
);

router.post(
  '/:id/receipt/send',
  requirePermission('expenses', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { rows } = await query(`SELECT approval_status FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    if (!rows[0]) throw new AppError('Expense not found', 404, 'NOT_FOUND');
    if (rows[0].approval_status !== 'approved') {
      throw new AppError('Cannot send receipt until Admin approval', 409, 'NOT_APPROVED');
    }
    const { expenseReceipt } = require('../services/receipts');
    const { queueReceiptEmail } = require('../queues/jobs');
    const receipt = await expenseReceipt(req.params.id);
    const to = (req.body?.to || req.user.email || '').trim();
    if (!to) throw new AppError('Recipient email required (to)', 400, 'VALIDATION');
    await queueReceiptEmail({
      to,
      subject: receipt.subject,
      body: receipt.text,
      receiptType: 'expense',
      receiptId: receipt.id,
    });
    res.json({ ok: true, data: { queued: true, to } });
  })
);

module.exports = router;
