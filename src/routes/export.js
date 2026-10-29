const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { progressPercent } = require('../services/milestones');

const router = express.Router();
router.use(authenticate);

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return [header, ...lines].join('\n');
}

router.get(
  '/invoices.csv',
  requirePermission('invoices', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'sales') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const { rows } = await query(
      `SELECT i.*, c.name AS client_name, p.name AS project_name
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN projects p ON p.id = i.project_id
       ORDER BY i.created_at DESC
       LIMIT 2000`
    );
    const csv = toCsv(rows, [
      { label: 'id', key: 'id' },
      { label: 'client', key: 'client_name' },
      { label: 'project', key: 'project_name' },
      { label: 'amount', key: 'amount' },
      { label: 'amount_paid', key: 'amount_paid' },
      { label: 'status', key: 'status' },
      { label: 'due_date', key: 'due_date' },
      { label: 'created_at', key: 'created_at' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.send(csv);
  })
);

router.get(
  '/projects.csv',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'admin') {
      const { rows } = await query(
        `SELECT p.id, p.name, p.status, p.value_amount, p.milestones, p.due_date, p.created_at,
                c.name AS client_name, d.name AS developer_name,
                COALESCE(SUM(i.amount), 0)::float AS invoiced,
                COALESCE(SUM(COALESCE(i.amount_paid, 0)), 0)::float AS paid,
                COALESCE(SUM(GREATEST(i.amount - COALESCE(i.amount_paid, 0), 0)), 0)::float AS balance
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
         LEFT JOIN users d ON d.id = p.assigned_developer_id
         LEFT JOIN invoices i ON i.project_id = p.id
         WHERE p.deleted_at IS NULL
         GROUP BY p.id, p.name, p.status, p.value_amount, p.milestones, p.due_date, p.created_at,
                  c.name, d.name
         ORDER BY p.name ASC
         LIMIT 2000`
      );
      const csv = toCsv(rows, [
        { label: 'project', key: 'name' },
        { label: 'client', key: 'client_name' },
        { label: 'status', key: 'status' },
        { label: 'progress_pct', value: (r) => progressPercent(r.milestones) },
        { label: 'value_kes', key: 'value_amount' },
        { label: 'invoiced_kes', key: 'invoiced' },
        { label: 'paid_kes', key: 'paid' },
        { label: 'balance_kes', key: 'balance' },
        { label: 'developer', key: 'developer_name' },
        { label: 'due_date', key: 'due_date' },
      ]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="projects.csv"');
      res.send(csv);
      return;
    }

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.created_at, c.name AS client_name, d.name AS developer_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       WHERE p.status NOT IN ('pending_approval','rejected')
         AND p.deleted_at IS NULL
       ORDER BY p.updated_at DESC
       LIMIT 2000`
    );
    // Strip client for developers
    const data = req.user.role === 'developer'
      ? rows.map(({ client_name, ...r }) => ({ ...r, client_name: '' }))
      : rows;
    const csv = toCsv(data, [
      { label: 'id', key: 'id' },
      { label: 'name', key: 'name' },
      { label: 'status', key: 'status' },
      { label: 'client', key: 'client_name' },
      { label: 'developer', key: 'developer_name' },
      { label: 'created_at', key: 'created_at' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="projects.csv"');
    res.send(csv);
  })
);

router.get(
  '/salary-payments.csv',
  requireAnyPermission([['salaries', 'view'], ['employees', 'view']]),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT sp.*, u.name AS employee_name
       FROM salary_payments sp
       JOIN employees e ON e.id = sp.employee_id
       JOIN users u ON u.id = e.user_id
       ORDER BY sp.month DESC, u.name
       LIMIT 2000`
    );
    const csv = toCsv(rows, [
      { label: 'employee', key: 'employee_name' },
      { label: 'month', key: 'month' },
      { label: 'expected', key: 'amount_expected' },
      { label: 'paid', key: 'amount_paid' },
      { label: 'status', key: 'status' },
      { label: 'settled_at', key: 'settled_at' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="salary-payments.csv"');
    res.send(csv);
  })
);

router.get(
  '/login-audit.csv',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const { rows } = await query(
      `SELECT * FROM login_audit ORDER BY created_at DESC LIMIT 5000`
    );
    const csv = toCsv(rows, [
      { label: 'created_at', key: 'created_at' },
      { label: 'email', key: 'email' },
      { label: 'user_id', key: 'user_id' },
      { label: 'success', key: 'success' },
      { label: 'ip', key: 'ip' },
      { label: 'user_agent', key: 'user_agent' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="login-audit.csv"');
    res.send(csv);
  })
);

router.get(
  '/cash-flow.csv',
  requireAnyPermission([['cash_flow', 'view'], ['account_balance', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { buildCashFlowReport, cashFlowToCsv } = require('../services/cashFlowReport');
    const report = await buildCashFlowReport({
      date_from: req.query.date_from,
      date_to: req.query.date_to,
    });
    const csv = cashFlowToCsv(report);
    const name = `cres-cash-flow-${report.period.from}_to_${report.period.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  })
);

module.exports = router;
