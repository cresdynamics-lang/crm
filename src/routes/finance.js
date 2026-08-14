const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

/**
 * Full money-health dashboard - Finance + Admin ONLY.
 * Director cannot hit this (no cash_flow / account_balance).
 */
router.get(
  '/dashboard',
  requireAnyPermission([['cash_flow', 'view'], ['account_balance', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows: balances } = await query(
      `SELECT id, label, balance, updated_at FROM account_balances ORDER BY label`
    );
    const totalBalance = balances.reduce((s, b) => s + Number(b.balance), 0);

    const { rows: paid } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM payments`
    );
    const { rows: exp } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses WHERE approval_status = 'approved'`
    );
    const { rows: outstanding } = await query(
      `SELECT COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS total
       FROM invoices WHERE status IN ('issued','overdue','partially_paid')`
    );
    const { rows: issuedCount } = await query(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE status = 'issued'`
    );
    const { rows: overdueCount } = await query(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE status = 'overdue'`
    );
    const { rows: pendingFinanceExp } = await query(
      `SELECT COUNT(*)::int AS count FROM expenses
       WHERE approval_status IN ('pending_finance', 'pending')`
    );
    const { rows: pendingFinanceFund } = await query(
      `SELECT COUNT(*)::int AS count FROM salary_funding_requests
       WHERE status = 'pending_finance'`
    );

    // Cash flow by month (last 6): payments in vs expenses out
    const { rows: monthly } = await query(
      `SELECT m.month,
              COALESCE(p.in_amount, 0)::float AS money_in,
              COALESCE(e.out_amount, 0)::float AS money_out
       FROM (
         SELECT to_char(d, 'YYYY-MM') AS month
         FROM generate_series(
           date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
           date_trunc('month', CURRENT_DATE),
           INTERVAL '1 month'
         ) d
       ) m
       LEFT JOIN (
         SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
                SUM(amount) AS in_amount
         FROM payments
         GROUP BY 1
       ) p ON p.month = m.month
       LEFT JOIN (
         SELECT to_char(date_trunc('month', COALESCE(approved_at, created_at)), 'YYYY-MM') AS month,
                SUM(amount) AS out_amount
         FROM expenses
         WHERE approval_status = 'approved'
         GROUP BY 1
       ) e ON e.month = m.month
       ORDER BY m.month`
    );

    const cashLabels = [];
    const cashIn = [];
    const cashOut = [];
    for (const row of monthly) {
      const [y, mo] = row.month.split('-');
      const d = new Date(Number(y), Number(mo) - 1, 1);
      cashLabels.push(d.toLocaleString(undefined, { month: 'short' }));
      cashIn.push(row.money_in);
      cashOut.push(row.money_out);
    }

    // Revenue by project (paid + issued amounts on invoices)
    const { rows: byProject } = await query(
      `SELECT COALESCE(p.name, 'Unlinked') AS label,
              COALESCE(SUM(i.amount),0)::float AS total
       FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       GROUP BY COALESCE(p.name, 'Unlinked')
       ORDER BY total DESC
       LIMIT 8`
    );

    // Expense breakdown by category
    const { rows: byCategory } = await query(
      `SELECT category AS label, COALESCE(SUM(amount),0)::float AS total
       FROM expenses
       WHERE approval_status = 'approved'
       GROUP BY category
       ORDER BY total DESC`
    );

    const { rows: notifications } = await query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.id]
    );

    res.json({
      ok: true,
      data: {
        kpis: {
          accountBalance: totalBalance,
          revenue: paid[0].total,
          expenses: exp[0].total,
          netCash: paid[0].total - exp[0].total,
          outstanding: outstanding[0].total,
          issuedCount: issuedCount[0].count,
          overdueCount: overdueCount[0].count,
          pendingApprovals:
            (pendingFinanceExp[0]?.count || 0) + (pendingFinanceFund[0]?.count || 0),
          pendingExpenses: pendingFinanceExp[0]?.count || 0,
          pendingSalaryFunding: pendingFinanceFund[0]?.count || 0,
        },
        balances,
        cashFlowChart: { labels: cashLabels, moneyIn: cashIn, moneyOut: cashOut },
        revenueByProject: {
          labels: byProject.map((r) => r.label),
          values: byProject.map((r) => r.total),
        },
        expenseBreakdown: {
          labels: byCategory.map((r) => r.label),
          values: byCategory.map((r) => r.total),
        },
        notifications,
      },
    });
  })
);

/**
 * Finance-wise project list: value, invoice, paid, balance — no create/edit workflow.
 */
router.get(
  '/projects',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.value_amount, p.created_at, p.updated_at,
              c.name AS client_name, c.business_name AS client_business,
              i.id AS invoice_id, i.amount AS invoice_amount, i.amount_paid,
              i.status AS invoice_status, i.due_date,
              (COALESCE(i.amount, 0) - COALESCE(i.amount_paid, 0))::float AS balance_due
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN LATERAL (
         SELECT inv.*
         FROM invoices inv
         WHERE inv.project_id = p.id
         ORDER BY inv.created_at DESC
         LIMIT 1
       ) i ON TRUE
       WHERE p.status NOT IN ('pending_approval', 'rejected')
       ORDER BY
         CASE WHEN i.status = 'overdue' THEN 0
              WHEN i.status IN ('issued', 'partially_paid') THEN 1
              WHEN i.status = 'paid' THEN 2
              ELSE 3 END,
         p.updated_at DESC`
    );

    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        value_amount: r.value_amount != null ? Number(r.value_amount) : null,
        client_name: r.client_name,
        client_business: r.client_business,
        invoice_id: r.invoice_id,
        invoice_amount: r.invoice_amount != null ? Number(r.invoice_amount) : null,
        amount_paid: r.amount_paid != null ? Number(r.amount_paid) : 0,
        invoice_status: r.invoice_status,
        due_date: r.due_date,
        balance_due: Number(r.balance_due || 0),
        updated_at: r.updated_at,
      })),
    });
  })
);

/**
 * Full financial cash-flow report: money in/out across projects, clients, accounts.
 */
router.get(
  '/cash-flow-report',
  requireAnyPermission([['cash_flow', 'view'], ['account_balance', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { buildCashFlowReport } = require('../services/cashFlowReport');
    const data = await buildCashFlowReport({
      date_from: req.query.date_from,
      date_to: req.query.date_to,
    });
    res.json({ ok: true, data });
  })
);

module.exports = router;
