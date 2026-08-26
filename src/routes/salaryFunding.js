/**
 * Salary funding: HR selects people → Finance Approvals → Admin Approvals.
 * Salaries are NOT expenses; settlement unlocked after admin_approved.
 */
const express = require('express');
const { query, withTransaction } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueNotification } = require('../queues/jobs');

const router = express.Router();
router.use(authenticate);

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
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

async function ensureMonthRows(month) {
  await withTransaction(async (tx) => {
    const { rows: missing } = await tx.query(
      `SELECT e.id, e.salary_amount
       FROM employees e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN salary_payments sp ON sp.employee_id = e.id AND sp.month = $1
       WHERE sp.id IS NULL AND u.status = 'active'`,
      [month]
    );
    for (const m of missing) {
      await tx.query(
        `INSERT INTO salary_payments (employee_id, month, amount_expected, amount_paid, status)
         VALUES ($1, $2, $3, 0, 'owed')
         ON CONFLICT (employee_id, month) DO NOTHING`,
        [m.id, month, Number(m.salary_amount || 0)]
      );
    }
  });
}

/** People HR can include in a funding request for a month (all staff with payroll rows). */
router.get(
  '/eligible',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    if (!['hr', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const month = req.query.month || currentMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new AppError('month must be YYYY-MM', 400, 'VALIDATION');
    }
    await ensureMonthRows(month);
    const { rows } = await query(
      `SELECT e.id AS employee_id, u.name, u.email, r.name AS role,
              e.position, e.salary_amount,
              sp.amount_expected, sp.status AS salary_status
       FROM employees e
       JOIN users u ON u.id = e.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN salary_payments sp ON sp.employee_id = e.id AND sp.month = $1
       WHERE u.status = 'active' AND r.name <> 'client'
       ORDER BY u.name`,
      [month]
    );
    res.json({
      ok: true,
      data: rows.map((r) => ({
        ...r,
        amount_expected: Number(r.amount_expected ?? r.salary_amount ?? 0),
      })),
      meta: { month },
    });
  })
);

router.get(
  '/',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    const role = req.user.role;
    if (!['hr', 'finance', 'admin'].includes(role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const params = [];
    const clauses = [];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`sfr.status = $${params.length}`);
    }
    if (req.query.month) {
      params.push(req.query.month);
      clauses.push(`sfr.month = $${params.length}`);
    }
    if (role === 'finance' && req.query.inbox === '1') {
      clauses.push(`sfr.status = 'pending_finance'`);
    }
    if (role === 'admin' && req.query.inbox === '1') {
      clauses.push(`sfr.status = 'finance_approved'`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT sfr.*,
              req.name AS requested_by_name,
              fin.name AS finance_approved_by_name,
              adm.name AS admin_approved_by_name,
              rej.name AS rejected_by_name
       FROM salary_funding_requests sfr
       LEFT JOIN users req ON req.id = sfr.requested_by
       LEFT JOIN users fin ON fin.id = sfr.finance_approved_by
       LEFT JOIN users adm ON adm.id = sfr.admin_approved_by
       LEFT JOIN users rej ON rej.id = sfr.rejected_by
       ${where}
       ORDER BY sfr.created_at DESC
       LIMIT 100`,
      params
    );

    // Attach employee names for selected people
    const data = [];
    for (const row of rows) {
      const ids = row.employee_ids || [];
      let people = [];
      if (ids.length) {
        const { rows: peeps } = await query(
          `SELECT e.id, u.name, r.name AS role, sp.amount_expected
           FROM employees e
           JOIN users u ON u.id = e.user_id
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN salary_payments sp ON sp.employee_id = e.id AND sp.month = $2
           WHERE e.id = ANY($1::uuid[])
           ORDER BY u.name`,
          [ids, row.month]
        );
        people = peeps;
      }
      data.push({ ...row, people });
    }

    res.json({ ok: true, data });
  })
);

router.get(
  '/summary',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    const month = req.query.month || currentMonth();
    await ensureMonthRows(month);
    const { rows: expected } = await query(
      `SELECT COALESCE(SUM(amount_expected), 0)::float AS total, COUNT(*)::int AS rows
       FROM salary_payments WHERE month = $1`,
      [month]
    );
    const { rows: funding } = await query(
      `SELECT * FROM salary_funding_requests
       WHERE month = $1 AND status <> 'rejected'
       ORDER BY created_at DESC LIMIT 1`,
      [month]
    );
    res.json({
      ok: true,
      data: {
        month,
        expectedTotal: expected[0].total,
        paymentRows: expected[0].rows,
        funding: funding[0] || null,
        canSettle: funding[0]?.status === 'admin_approved',
      },
    });
  })
);

router.post(
  '/',
  requirePermission('salaries', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'hr') {
      throw new AppError('Only HR can request salary funding', 403, 'FORBIDDEN');
    }
    const month = req.body?.month || currentMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new AppError('month must be YYYY-MM', 400, 'VALIDATION');
    }
    await ensureMonthRows(month);

    const employeeIds = Array.isArray(req.body?.employee_ids)
      ? [...new Set(req.body.employee_ids.filter(Boolean))]
      : [];
    if (!employeeIds.length) {
      throw new AppError('Select at least one person for salary funding', 400, 'VALIDATION');
    }

    const { rows: selected } = await query(
      `SELECT sp.employee_id, sp.amount_expected, u.name
       FROM salary_payments sp
       JOIN employees e ON e.id = sp.employee_id
       JOIN users u ON u.id = e.user_id
       WHERE sp.month = $1 AND sp.employee_id = ANY($2::uuid[])`,
      [month, employeeIds]
    );
    if (selected.length !== employeeIds.length) {
      throw new AppError('One or more selected people have no payroll row for that month', 400, 'VALIDATION');
    }

    const amount = Number(
      req.body?.amount_requested ??
        selected.reduce((s, r) => s + Number(r.amount_expected || 0), 0)
    );
    if (!(amount > 0)) {
      throw new AppError('amount_requested must be positive', 400, 'VALIDATION');
    }

    let row;
    try {
      const { rows } = await query(
        `INSERT INTO salary_funding_requests
           (month, amount_requested, status, note, requested_by, employee_ids)
         VALUES ($1, $2, 'pending_finance', $3, $4, $5::uuid[])
         RETURNING *`,
        [month, amount, req.body?.note || null, req.user.id, employeeIds]
      );
      row = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new AppError(
          'An active funding request already exists for this month',
          409,
          'DUPLICATE'
        );
      }
      throw err;
    }

    await notifyRoles(['finance'], {
      type: 'salary_funding_request',
      content: `HR requested salary funding for ${month}: ${amount} (${employeeIds.length} people) — review in Approvals`,
      meta: { fundingId: row.id, month, amount, href: '#/approvals' },
    });

    res.status(201).json({ ok: true, data: row });
  })
);

router.post(
  '/:id/finance-approve',
  requirePermission('salaries', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'finance') {
      throw new AppError('Only Finance can approve and escalate salary funding', 403, 'FORBIDDEN');
    }

    const result = await withTransaction(async (tx) => {
      const { rows: existing } = await tx.query(
        `SELECT * FROM salary_funding_requests WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!existing[0]) throw new AppError('Funding request not found', 404, 'NOT_FOUND');
      if (existing[0].status !== 'pending_finance') {
        throw new AppError('Request is not awaiting Finance', 409, 'INVALID_STATE');
      }

      const amountFunded = Number(
        req.body?.amount_funded ?? existing[0].amount_requested
      );
      if (!(amountFunded > 0)) {
        throw new AppError('amount_funded must be positive', 400, 'VALIDATION');
      }

      const { rows } = await tx.query(
        `UPDATE salary_funding_requests
         SET status = 'finance_approved',
             amount_funded = $1,
             finance_note = $2,
             finance_approved_by = $3,
             finance_approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [amountFunded, req.body?.finance_note || null, req.user.id, req.params.id]
      );
      return rows[0];
    });

    await notifyRoles(['admin'], {
      type: 'salary_funding_escalated',
      content: `Finance escalated salary funding for ${result.month}: ${result.amount_funded} — needs Admin approval`,
      meta: { fundingId: result.id, month: result.month, href: '#/approvals' },
    });
    await notifyRoles(['hr'], {
      type: 'salary_funding_escalated',
      content: `Finance approved salary funding for ${result.month} and sent it to Admin`,
      meta: { fundingId: result.id, month: result.month, href: '#/salary-funding' },
    });

    res.json({ ok: true, data: result });
  })
);

router.post(
  '/:id/admin-approve',
  requirePermission('salaries', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new AppError('Only Admin can give final salary funding approval', 403, 'FORBIDDEN');
    }

    const result = await withTransaction(async (tx) => {
      const { rows: existing } = await tx.query(
        `SELECT * FROM salary_funding_requests WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!existing[0]) throw new AppError('Funding request not found', 404, 'NOT_FOUND');
      if (existing[0].status !== 'finance_approved') {
        throw new AppError('Request must be escalated by Finance first', 409, 'INVALID_STATE');
      }

      const { rows } = await tx.query(
        `UPDATE salary_funding_requests
         SET status = 'admin_approved',
             admin_note = $1,
             admin_approved_by = $2,
             admin_approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [req.body?.admin_note || null, req.user.id, req.params.id]
      );
      return rows[0];
    });

    await notifyRoles(['hr', 'finance'], {
      type: 'salary_funding_approved',
      content: `Admin approved and disbursed salary funding for ${result.month}. HR may now update individual payment statuses.`,
      meta: {
        fundingId: result.id,
        month: result.month,
        amount_funded: result.amount_funded,
        href: '#/salary-funding',
      },
    });

    res.json({ ok: true, data: result });
  })
);

router.post(
  '/:id/reject',
  requirePermission('salaries', 'view'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Finance or Admin can reject funding requests', 403, 'FORBIDDEN');
    }

    const result = await withTransaction(async (tx) => {
      const { rows: existing } = await tx.query(
        `SELECT * FROM salary_funding_requests WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!existing[0]) throw new AppError('Funding request not found', 404, 'NOT_FOUND');
      if (!['pending_finance', 'finance_approved'].includes(existing[0].status)) {
        throw new AppError('Request cannot be rejected in its current state', 409, 'INVALID_STATE');
      }

      const noteField = req.user.role === 'admin' ? 'admin_note' : 'finance_note';
      const { rows } = await tx.query(
        `UPDATE salary_funding_requests
         SET status = 'rejected',
             ${noteField} = COALESCE($1, ${noteField}),
             rejected_by = $2,
             rejected_at = NOW(),
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [req.body?.note || null, req.user.id, req.params.id]
      );
      return rows[0];
    });

    await notifyRoles(['hr'], {
      type: 'salary_funding_rejected',
      content: `Salary funding for ${result.month} was rejected`,
      meta: { fundingId: result.id, month: result.month, href: '#/salary-funding' },
    });

    res.json({ ok: true, data: result });
  })
);

module.exports = router;
