const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission, hasPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueNotification } = require('../queues/jobs');
const { removeStaffUser } = require('../services/staffRemoval');

const router = express.Router();
router.use(authenticate);

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthAdd(yyyyMm, delta) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthsFromTo(fromMonth, toMonth) {
  const out = [];
  let cur = fromMonth;
  while (cur <= toMonth) {
    out.push(cur);
    cur = monthAdd(cur, 1);
    if (out.length > 120) break; // safety
  }
  return out;
}

async function ensureMonthRow(tx, employeeId, salaryAmount, month) {
  const existing = await tx.query(
    `SELECT * FROM salary_payments WHERE employee_id = $1 AND month = $2`,
    [employeeId, month]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await tx.query(
    `INSERT INTO salary_payments (employee_id, month, amount_expected, status)
     VALUES ($1, $2, $3, 'owed')
     RETURNING *`,
    [employeeId, month, salaryAmount || 0]
  );
  return rows[0];
}

/** Backfill salary_payments from onboarding month through current month */
async function ensurePayrollHistory(txOrQuery, employeeId, salaryAmount, hireAt) {
  const to = currentMonth();
  const from = (hireAt ? new Date(hireAt) : new Date()).toISOString().slice(0, 7);
  const months = monthsFromTo(from, to);
  const run = txOrQuery.query ? txOrQuery : { query: txOrQuery };
  for (const month of months) {
    await ensureMonthRow(run, employeeId, salaryAmount, month);
  }
}

function canManagePayroll(user) {
  return (
    hasPermission(user, 'salaries', 'edit') ||
    hasPermission(user, 'employees', 'edit') ||
    ['hr', 'admin'].includes(user.role)
  );
}

async function employeeForUser(userId, tx) {
  const q = tx?.query ? tx.query.bind(tx) : query;
  const { rows } = await q(
    `SELECT e.*, u.name, u.email, u.phone, u.status AS user_status
     FROM employees e
     JOIN users u ON u.id = e.user_id
     WHERE e.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// --- Employees ---
router.get(
  '/employees',
  requirePermission('employees', 'view'),
  asyncHandler(async (_req, res) => {
    const month = currentMonth();

    await withTransaction(async (tx) => {
      const { rows: missing } = await tx.query(
        `SELECT e.id, e.salary_amount, e.created_at
         FROM employees e
         LEFT JOIN salary_payments sp ON sp.employee_id = e.id AND sp.month = $1
         WHERE sp.id IS NULL`,
        [month]
      );
      for (const m of missing) {
        await ensurePayrollHistory(tx, m.id, m.salary_amount, m.created_at);
      }
    });

    const { rows } = await query(
      `SELECT e.*, u.name, u.email, u.phone, u.status AS user_status,
              sp.status AS current_salary_status,
              sp.id AS current_salary_payment_id,
              sp.amount_expected AS current_amount_expected,
              sp.amount_paid AS current_amount_paid
       FROM employees e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN salary_payments sp
         ON sp.employee_id = e.id AND sp.month = $1
       ORDER BY u.name`,
      [month]
    );
    res.json({ ok: true, data: rows, meta: { month } });
  })
);

/**
 * Create employee + linked user in one transaction.
 * Fields: name, email, phone, home_address, next_of_kin, kra_pin, bank_account,
 * position, role, salary, first-time password.
 */
router.post(
  '/employees',
  requirePermission('employees', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const {
      name,
      email,
      phone,
      position,
      salary_amount,
      pay_cycle,
      password,
      role = 'developer',
      home_address,
      home,
      next_of_kin,
      kra_pin,
      bank_account,
    } = req.body || {};

    const homeAddress = home_address ?? home ?? null;

    if (!name?.trim() || !email?.trim()) {
      throw new AppError('name and email are required', 400, 'VALIDATION');
    }
    if (!password || String(password).length < 8) {
      throw new AppError('First-time password is required (min 8 characters)', 400, 'VALIDATION');
    }

    const result = await withTransaction(async (tx) => {
      let userId = req.body.user_id || null;

      if (!userId) {
        const { rows: roles } = await tx.query(`SELECT id FROM roles WHERE name = $1`, [role]);
        const roleId = roles[0]?.id;
        if (!roleId) throw new AppError('Invalid role for employee login', 400, 'VALIDATION');
        if (role === 'client') {
          throw new AppError('Use client portal linking for clients, not HR employees', 400, 'VALIDATION');
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const { rows: users } = await tx.query(
          `INSERT INTO users (name, email, phone, password_hash, role_id, status, must_set_password)
           VALUES ($1, $2, $3, $4, $5, 'active', TRUE)
           RETURNING id, name, email, phone, status`,
          [name.trim(), email.trim().toLowerCase(), phone || null, passwordHash, roleId]
        );
        userId = users[0].id;
      }

      const { rows: emp } = await tx.query(
        `INSERT INTO employees (
           user_id, position, salary_amount, pay_cycle,
           home_address, next_of_kin, kra_pin, bank_account
         )
         VALUES ($1, $2, $3, COALESCE($4, 'monthly'), $5, $6, $7, $8)
         RETURNING *`,
        [
          userId,
          position || null,
          salary_amount || 0,
          pay_cycle || null,
          homeAddress || null,
          next_of_kin || null,
          kra_pin || null,
          bank_account || null,
        ]
      );

      await ensurePayrollHistory(tx, emp[0].id, emp[0].salary_amount, emp[0].created_at);

      const { rows: joined } = await tx.query(
        `SELECT e.*, u.name, u.email, u.phone, u.status AS user_status
         FROM employees e JOIN users u ON u.id = e.user_id
         WHERE e.id = $1`,
        [emp[0].id]
      );

      return { employee: joined[0] };
    });

    res.status(201).json({ ok: true, data: result });
  })
);

router.patch(
  '/employees/:id',
  requirePermission('employees', 'edit'),
  asyncHandler(async (req, res) => {
    const {
      name,
      phone,
      position,
      salary_amount,
      pay_cycle,
      email,
      home_address,
      home,
      next_of_kin,
      kra_pin,
      bank_account,
    } = req.body || {};

    const homeAddress = home_address !== undefined ? home_address : home;

    const result = await withTransaction(async (tx) => {
      const { rows: existing } = await tx.query(
        `SELECT e.*, u.id AS uid FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
        [req.params.id]
      );
      if (!existing[0]) throw new AppError('Employee not found', 404, 'NOT_FOUND');

      if (name !== undefined || phone !== undefined || email !== undefined) {
        const sets = [];
        const params = [];
        if (name !== undefined) {
          params.push(name.trim());
          sets.push(`name = $${params.length}`);
        }
        if (phone !== undefined) {
          params.push(phone || null);
          sets.push(`phone = $${params.length}`);
        }
        if (email !== undefined) {
          params.push(email.trim().toLowerCase());
          sets.push(`email = $${params.length}`);
        }
        params.push(existing[0].uid);
        await tx.query(
          `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
          params
        );
      }

      const empSets = [];
      const empParams = [];
      if (position !== undefined) {
        empParams.push(position);
        empSets.push(`position = $${empParams.length}`);
      }
      if (salary_amount !== undefined) {
        empParams.push(salary_amount);
        empSets.push(`salary_amount = $${empParams.length}`);
      }
      if (pay_cycle !== undefined) {
        empParams.push(pay_cycle);
        empSets.push(`pay_cycle = $${empParams.length}`);
      }
      if (homeAddress !== undefined) {
        empParams.push(homeAddress || null);
        empSets.push(`home_address = $${empParams.length}`);
      }
      if (next_of_kin !== undefined) {
        empParams.push(next_of_kin || null);
        empSets.push(`next_of_kin = $${empParams.length}`);
      }
      if (kra_pin !== undefined) {
        empParams.push(kra_pin || null);
        empSets.push(`kra_pin = $${empParams.length}`);
      }
      if (bank_account !== undefined) {
        empParams.push(bank_account || null);
        empSets.push(`bank_account = $${empParams.length}`);
      }
      if (empSets.length) {
        empParams.push(req.params.id);
        await tx.query(
          `UPDATE employees SET ${empSets.join(', ')}, updated_at = NOW()
           WHERE id = $${empParams.length}`,
          empParams
        );
      }

      const { rows } = await tx.query(
        `SELECT e.*, u.name, u.email, u.phone, u.status AS user_status
         FROM employees e JOIN users u ON u.id = e.user_id
         WHERE e.id = $1`,
        [req.params.id]
      );
      return rows[0];
    });

    res.json({ ok: true, data: result });
  })
);

router.get(
  '/employees/:id',
  requireAnyPermission([
    ['salaries', 'view'],
    ['employees', 'view'],
  ]),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT e.*, u.name, u.email, u.phone, u.status AS user_status
       FROM employees e JOIN users u ON u.id = e.user_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Employee not found', 404, 'NOT_FOUND');

    // Non-managers may only view their own employee record
    if (!canManagePayroll(req.user) && rows[0].user_id !== req.user.id) {
      throw new AppError('Forbidden: you can only view your own payroll', 403, 'FORBIDDEN');
    }
    // HR directory needs employees:view for other people
    if (
      canManagePayroll(req.user) &&
      rows[0].user_id !== req.user.id &&
      !hasPermission(req.user, 'employees', 'view') &&
      !hasPermission(req.user, 'salaries', 'edit')
    ) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    await withTransaction(async (tx) => {
      await ensurePayrollHistory(tx, rows[0].id, rows[0].salary_amount, rows[0].created_at);
    });

    const { rows: history } = await query(
      `SELECT * FROM salary_payments
       WHERE employee_id = $1
       ORDER BY month DESC`,
      [req.params.id]
    );

    res.json({
      ok: true,
      data: {
        employee: rows[0],
        payroll: history,
        currentMonth: currentMonth(),
        canSettle: canManagePayroll(req.user),
      },
    });
  })
);

router.delete(
  '/employees/:id',
  requireAnyPermission([['employees', 'edit'], ['users', 'delete']]),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT e.id, e.user_id, u.name
       FROM employees e JOIN users u ON u.id = e.user_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Employee not found', 404, 'NOT_FOUND');
    const removed = await removeStaffUser(req.user, rows[0].user_id, {
      reason: 'hr_employee_remove',
    });
    res.json({ ok: true, data: { employee_id: rows[0].id, user: removed } });
  })
);

/**
 * Personal payroll — every staff user with salaries:view.
 * History from onboarding month at Cres Dynamics.
 */
router.get(
  '/me',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    const emp = await employeeForUser(req.user.id);
    if (!emp) {
      return res.json({
        ok: true,
        data: {
          employee: null,
          payroll: [],
          currentMonth: currentMonth(),
          canSettle: false,
        },
      });
    }

    await withTransaction(async (tx) => {
      await ensurePayrollHistory(tx, emp.id, emp.salary_amount, emp.created_at);
    });

    const { rows: history } = await query(
      `SELECT * FROM salary_payments
       WHERE employee_id = $1
       ORDER BY month DESC`,
      [emp.id]
    );

    res.json({
      ok: true,
      data: {
        employee: emp,
        payroll: history,
        currentMonth: currentMonth(),
        canSettle: canManagePayroll(req.user),
      },
    });
  })
);

// --- Salary payments ---
router.get(
  '/',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    const manage = canManagePayroll(req.user);
    const params = [];
    const clauses = [];

    if (!manage) {
      const emp = await employeeForUser(req.user.id);
      if (!emp) return res.json({ ok: true, data: [], meta: { scope: 'self' } });
      params.push(emp.id);
      clauses.push(`sp.employee_id = $${params.length}`);
    }

    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`sp.status = $${params.length}`);
    }
    if (req.query.month) {
      params.push(req.query.month);
      clauses.push(`sp.month = $${params.length}`);
    }
    if (req.query.employee_id && manage) {
      params.push(req.query.employee_id);
      clauses.push(`sp.employee_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT sp.*, e.position, u.name AS employee_name
       FROM salary_payments sp
       JOIN employees e ON e.id = sp.employee_id
       JOIN users u ON u.id = e.user_id
       ${where}
       ORDER BY sp.month DESC, u.name`,
      params
    );
    res.json({ ok: true, data: rows, meta: { scope: manage ? 'all' : 'self' } });
  })
);

router.post(
  '/',
  requirePermission('salaries', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { employee_id, month, amount_expected } = req.body || {};
    if (!employee_id || !month) {
      throw new AppError('employee_id and month (YYYY-MM) required', 400, 'VALIDATION');
    }
    const { rows } = await query(
      `INSERT INTO salary_payments (employee_id, month, amount_expected)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [employee_id, month, amount_expected]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/settle',
  requirePermission('salaries', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { amount_paid } = req.body || {};

    const settled = await withTransaction(async (tx) => {
      const { rows: payment } = await tx.query(
        `SELECT * FROM salary_payments WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!payment[0]) throw new AppError('Salary payment not found', 404, 'NOT_FOUND');
      if (payment[0].status !== 'owed') {
        throw new AppError('Salary payment not found or already settled', 409, 'INVALID_STATE');
      }

      // Admin must approve salary funding for this month (not an expense path)
      const { rows: funding } = await tx.query(
        `SELECT id FROM salary_funding_requests
         WHERE month = $1 AND status = 'admin_approved'
         LIMIT 1`,
        [payment[0].month]
      );
      if (!funding[0]) {
        throw new AppError(
          `Salary funding for ${payment[0].month} is not Admin-approved yet. HR must request funding → Finance approve → Admin approve before settling.`,
          409,
          'FUNDING_REQUIRED'
        );
      }

      // Auto-calculate attendance deduction
      let attendanceDeductions = null;
      const { calculateSalaryImpact } = require('../services/attendanceService');
      try {
        const impact = await calculateSalaryImpact(payment[0].employee_id, payment[0].month);
        if (impact && impact.missing_days > 0) {
          attendanceDeductions = {
            missing_days: impact.missing_days,
            total_expected: impact.total_expected,
            total_attended: impact.total_attended,
            daily_rate: impact.daily_rate,
            total_deduction: impact.total_deduction,
            attendance_score: impact.attendance_score,
          };
        }
      } catch { /* attendance table may not exist yet */ }

      // Apply deduction: reduce amount_paid by attendance deduction
      const finalAmount = amount_paid != null
        ? Math.max(0, Number(amount_paid) - (attendanceDeductions?.total_deduction || 0))
        : Math.max(0, payment[0].amount_expected - (attendanceDeductions?.total_deduction || 0));

      const { rows } = await tx.query(
        `UPDATE salary_payments
         SET amount_paid = $1,
             status = 'settled',
             settled_at = NOW(),
             attendance_deductions = $2::jsonb
         WHERE id = $3 AND status = 'owed'
         RETURNING *`,
        [finalAmount, attendanceDeductions ? JSON.stringify(attendanceDeductions) : null, req.params.id]
      );
      if (!rows[0]) throw new AppError('Salary payment not found or already settled', 409, 'INVALID_STATE');
      rows[0]._attendance_deductions = attendanceDeductions;
      return rows[0];
    });

    const { rows: financeUsers } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('finance', 'admin') AND u.status = 'active'`
    );
    for (const fu of financeUsers) {
      await queueNotification({
        userId: fu.id,
        type: 'salary_settled',
        content: `Salary settled for ${settled.month} (funding-approved path — not an expense)`,
        meta: { salaryPaymentId: settled.id, month: settled.month },
      });
    }

    const { rows: empUser } = await query(
      `SELECT e.user_id FROM employees e
       JOIN salary_payments sp ON sp.employee_id = e.id
       WHERE sp.id = $1`,
      [settled.id]
    );
    if (empUser[0]) {
      await queueNotification({
        userId: empUser[0].user_id,
        type: 'salary_settled',
        content: `Your salary for ${settled.month} was marked settled`,
        meta: { salaryPaymentId: settled.id, month: settled.month },
      });
    }

    res.json({ ok: true, data: settled });
  })
);

/**
 * HR updates individual salary payment amounts.
 * POST /api/salaries/:id/update-amount
 * Body: { amount_paid, status, hr_note }
 */
router.post(
  '/:id/update-amount',
  requirePermission('salaries', 'edit'),
  asyncHandler(async (req, res) => {
    if (!['hr', 'admin'].includes(req.user.role)) {
      throw new AppError('Only HR can update individual salary payments', 403, 'FORBIDDEN');
    }

    const { amount_paid, status, hr_note } = req.body || {};
    const sets = [];
    const params = [];

    if (amount_paid != null) {
      const amt = Number(amount_paid);
      if (isNaN(amt) || amt < 0) throw new AppError('amount_paid must be a non-negative number', 400, 'VALIDATION');
      params.push(amt);
      sets.push(`amount_paid = $${params.length}`);
    }

    if (status) {
      if (!['owed', 'partially_paid', 'settled'].includes(status)) {
        throw new AppError('Invalid status. Use: owed, partially_paid, settled', 400, 'VALIDATION');
      }
      params.push(status);
      sets.push(`status = $${params.length}`);
      if (status === 'settled') {
        sets.push(`settled_at = NOW()`);
      }
    }

    if (hr_note !== undefined) {
      params.push(hr_note || null);
      sets.push(`hr_note = $${params.length}`);
    }

    if (!sets.length) throw new AppError('Nothing to update', 400, 'VALIDATION');

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE salary_payments
       SET ${sets.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    if (!rows[0]) throw new AppError('Salary payment not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * HR bulk-update salary payments for a funding request.
 * POST /api/salaries/bulk-update
 * Body: { month, updates: [{ employee_id, amount_paid, status, hr_note }] }
 */
router.post(
  '/bulk-update',
  requirePermission('salaries', 'edit'),
  asyncHandler(async (req, res) => {
    if (!['hr', 'admin'].includes(req.user.role)) {
      throw new AppError('Only HR can bulk-update salary payments', 403, 'FORBIDDEN');
    }

    const month = req.body?.month;
    const updates = req.body?.updates;
    if (!month || !Array.isArray(updates)) {
      throw new AppError('month and updates array required', 400, 'VALIDATION');
    }

    const results = [];
    for (const u of updates) {
      if (!u.employee_id) continue;
      const sets = [];
      const params = [];

      if (u.amount_paid != null) {
        params.push(Number(u.amount_paid));
        sets.push(`amount_paid = $${params.length}`);
      }
      if (u.status) {
        params.push(u.status);
        sets.push(`status = $${params.length}`);
        if (u.status === 'settled') sets.push(`settled_at = NOW()`);
      }
      if (u.hr_note !== undefined) {
        params.push(u.hr_note || null);
        sets.push(`hr_note = $${params.length}`);
      }

      if (!sets.length) continue;

      params.push(u.employee_id, month);
      const { rows } = await query(
        `UPDATE salary_payments
         SET ${sets.join(', ')}
         WHERE employee_id = $${params.length - 1} AND month = $${params.length}
         RETURNING *`,
        params
      );
      if (rows[0]) results.push(rows[0]);
    }

    res.json({ ok: true, data: { updated: results.length, payments: results } });
  })
);

module.exports = router;
