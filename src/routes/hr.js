const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

/**
 * HR dashboard - salary figures ONLY.
 * Chart: Settled / Owed / Expected (expected = all salaries, blue in UI).
 */
router.get(
  '/dashboard',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    if (!['hr', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM

    const { rows: expected } = await query(
      `SELECT COALESCE(SUM(amount_expected),0)::float AS total
       FROM salary_payments WHERE month = $1`,
      [month]
    );
    const { rows: owed } = await query(
      `SELECT COALESCE(SUM(amount_expected - amount_paid),0)::float AS total
       FROM salary_payments WHERE month = $1 AND status = 'owed'`,
      [month]
    );
    const { rows: settled } = await query(
      `SELECT COALESCE(SUM(amount_paid),0)::float AS total
       FROM salary_payments WHERE month = $1 AND status = 'settled'`,
      [month]
    );
    const { rows: empCount } = await query(`SELECT COUNT(*)::int AS count FROM employees`);

    const { rows: funding } = await query(
      `SELECT id, status, amount_requested, amount_funded
       FROM salary_funding_requests
       WHERE month = $1 AND status <> 'rejected'
       ORDER BY created_at DESC
       LIMIT 1`,
      [month]
    );

    // Settled / Owed / Expected over last 6 months
    const { rows: monthly } = await query(
      `SELECT m.month,
              COALESCE(s.settled_total, 0)::float AS settled,
              COALESCE(o.owed_total, 0)::float AS owed,
              COALESCE(e.expected_total, 0)::float AS expected
       FROM (
         SELECT to_char(d, 'YYYY-MM') AS month
         FROM generate_series(
           date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
           date_trunc('month', CURRENT_DATE),
           INTERVAL '1 month'
         ) d
       ) m
       LEFT JOIN (
         SELECT month, SUM(amount_paid) AS settled_total
         FROM salary_payments WHERE status = 'settled'
         GROUP BY month
       ) s ON s.month = m.month
       LEFT JOIN (
         SELECT month, SUM(amount_expected - amount_paid) AS owed_total
         FROM salary_payments WHERE status = 'owed'
         GROUP BY month
       ) o ON o.month = m.month
       LEFT JOIN (
         SELECT month, SUM(amount_expected) AS expected_total
         FROM salary_payments
         GROUP BY month
       ) e ON e.month = m.month
       ORDER BY m.month`
    );

    const labels = [];
    const settledSeries = [];
    const owedSeries = [];
    const expectedSeries = [];
    for (const row of monthly) {
      const [y, mo] = row.month.split('-');
      labels.push(new Date(Number(y), Number(mo) - 1, 1).toLocaleString(undefined, { month: 'short' }));
      settledSeries.push(row.settled);
      owedSeries.push(row.owed);
      expectedSeries.push(row.expected);
    }

    res.json({
      ok: true,
      data: {
        month,
        kpis: {
          expectedThisMonth: expected[0].total,
          owedThisMonth: owed[0].total,
          settledThisMonth: settled[0].total,
          employeeCount: empCount[0].count,
        },
        funding: funding[0] || null,
        chart: {
          labels,
          settled: settledSeries,
          owed: owedSeries,
          expected: expectedSeries,
        },
      },
    });
  })
);

const APPLICANT_STAGES = ['applied', 'interview', 'offer', 'hired', 'rejected'];

const DEFAULT_ONBOARDING_ITEMS = [
  { id: 'contract', label: 'Contract signed', done: false },
  { id: 'email', label: 'Work email created', done: false },
  { id: 'access', label: 'Systems access granted', done: false },
  { id: 'intro', label: 'Team introduction done', done: false },
  { id: 'equipment', label: 'Equipment issued', done: false },
];

function requireHrOrAdmin(req) {
  if (!['hr', 'admin'].includes(req.user.role)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

router.get(
  '/applicants',
  requirePermission('employees', 'view'),
  asyncHandler(async (req, res) => {
    requireHrOrAdmin(req);
    const params = [];
    const clauses = [];
    if (req.query.stage && APPLICANT_STAGES.includes(req.query.stage)) {
      params.push(req.query.stage);
      clauses.push(`a.stage = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT a.*, u.name AS created_by_name
       FROM applicants a
       LEFT JOIN users u ON u.id = a.created_by
       ${where}
       ORDER BY a.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/applicants',
  requirePermission('employees', 'create'),
  asyncHandler(async (req, res) => {
    requireHrOrAdmin(req);
    const { name, email, phone, role_applied, stage, interview_date, notes } = req.body || {};
    if (!name?.trim() || !role_applied?.trim()) {
      throw new AppError('name and role applied for are required', 400, 'VALIDATION');
    }
    const nextStage = APPLICANT_STAGES.includes(stage) ? stage : 'applied';
    const { rows } = await query(
      `INSERT INTO applicants
        (name, email, phone, role_applied, stage, interview_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name.trim(),
        email?.trim() || null,
        phone?.trim() || null,
        role_applied.trim(),
        nextStage,
        interview_date || null,
        notes?.trim() || null,
        req.user.id,
      ]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.patch(
  '/applicants/:id',
  requirePermission('employees', 'edit'),
  asyncHandler(async (req, res) => {
    requireHrOrAdmin(req);
    const { name, email, phone, role_applied, stage, interview_date, notes } = req.body || {};
    if (stage && !APPLICANT_STAGES.includes(stage)) {
      throw new AppError('Invalid stage', 400, 'VALIDATION');
    }
    const { rows } = await query(
      `UPDATE applicants SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         phone = COALESCE($3, phone),
         role_applied = COALESCE($4, role_applied),
         stage = COALESCE($5, stage),
         interview_date = COALESCE($6, interview_date),
         notes = COALESCE($7, notes),
         updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        name?.trim() || null,
        email === undefined ? null : email?.trim() || null,
        phone === undefined ? null : phone?.trim() || null,
        role_applied?.trim() || null,
        stage || null,
        interview_date === undefined ? null : interview_date || null,
        notes === undefined ? null : notes?.trim() || null,
        req.params.id,
      ]
    );
    if (!rows[0]) throw new AppError('Applicant not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/onboarding',
  requirePermission('employees', 'view'),
  asyncHandler(async (req, res) => {
    requireHrOrAdmin(req);
    const { rows } = await query(
      `SELECT e.id AS employee_id,
              u.name,
              e.position,
              u.email,
              u.phone,
              ob.items,
              ob.goal_30,
              ob.goal_60,
              ob.goal_90,
              ob.updated_at
       FROM employees e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN employee_onboarding ob ON ob.employee_id = e.id
       ORDER BY u.name`
    );
    res.json({
      ok: true,
      data: rows.map((r) => {
        const items = Array.isArray(r.items) ? r.items : DEFAULT_ONBOARDING_ITEMS;
        const done = items.filter((i) => i.done).length;
        return {
          ...r,
          items,
          done,
          total: items.length,
        };
      }),
      meta: { defaultItems: DEFAULT_ONBOARDING_ITEMS },
    });
  })
);

router.put(
  '/onboarding/:employeeId',
  requirePermission('employees', 'edit'),
  asyncHandler(async (req, res) => {
    requireHrOrAdmin(req);
    const emp = await query(`SELECT id FROM employees WHERE id = $1`, [req.params.employeeId]);
    if (!emp.rows[0]) throw new AppError('Employee not found', 404, 'NOT_FOUND');

    let items = req.body?.items;
    if (!Array.isArray(items) || !items.length) {
      items = DEFAULT_ONBOARDING_ITEMS;
    }
    items = items.map((i, idx) => ({
      id: String(i.id || `item-${idx}`),
      label: String(i.label || 'Item').slice(0, 200),
      done: Boolean(i.done),
    }));

    const { rows } = await query(
      `INSERT INTO employee_onboarding (employee_id, items, goal_30, goal_60, goal_90)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (employee_id) DO UPDATE SET
         items = EXCLUDED.items,
         goal_30 = EXCLUDED.goal_30,
         goal_60 = EXCLUDED.goal_60,
         goal_90 = EXCLUDED.goal_90,
         updated_at = NOW()
       RETURNING *`,
      [
        req.params.employeeId,
        JSON.stringify(items),
        req.body?.goal_30?.trim() || null,
        req.body?.goal_60?.trim() || null,
        req.body?.goal_90?.trim() || null,
      ]
    );
    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
