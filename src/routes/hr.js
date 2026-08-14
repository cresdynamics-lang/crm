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

module.exports = router;
