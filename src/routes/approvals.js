const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { hasPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

/**
 * Unified inbox of items waiting on the signed-in person.
 * Project (Director/Admin) · Expense (Finance/Admin) · Salary funding (Finance/Admin) · Leave (HR/Admin).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = [];
    const role = req.user.role;

    if (hasPermission(req.user, 'projects', 'approve') && ['director', 'admin'].includes(role)) {
      const { rows } = await query(
        `SELECT p.id, p.name, p.value_amount, p.created_at,
                c.name AS client_name, s.name AS submitted_by_name
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
         JOIN users s ON s.id = p.created_by
         WHERE p.status = 'pending_approval'
         ORDER BY p.created_at ASC`
      );
      for (const r of rows) {
        items.push({
          kind: 'project',
          id: r.id,
          title: r.name,
          subtitle: r.client_name || 'No client',
          from: r.submitted_by_name,
          amount: r.value_amount != null ? Number(r.value_amount) : null,
          submitted_at: r.created_at,
          approve_label: 'Approve',
          reject_label: 'Reject',
        });
      }
    }

    if (hasPermission(req.user, 'expenses', 'edit') && ['finance', 'admin'].includes(role)) {
      const status = role === 'admin' ? 'pending_admin' : 'pending_finance';
      const { rows } = await query(
        `SELECT e.id, e.category, e.amount, e.description, e.created_at, e.approval_status,
                u.name AS submitted_by_name
         FROM expenses e
         LEFT JOIN users u ON u.id = e.created_by
         WHERE e.approval_status = $1
            OR ($1 = 'pending_finance' AND e.approval_status = 'pending')
         ORDER BY e.created_at ASC`,
        [status]
      );
      const { rows: setting } = await query(
        `SELECT value FROM system_settings WHERE key = 'expense_approval'`
      );
      const v = setting[0]?.value || { threshold: 500, requireAboveThreshold: true };
      const threshold = Number(v.threshold ?? 500);
      const requireAboveThreshold = v.requireAboveThreshold !== false;
      for (const r of rows) {
        const needsAdmin = requireAboveThreshold && Number(r.amount) > threshold;
        items.push({
          kind: 'expense',
          id: r.id,
          title: `Expense · ${(r.category || 'other').replace(/_/g, ' ')}`,
          subtitle: r.description || '',
          from: r.submitted_by_name,
          amount: Number(r.amount),
          submitted_at: r.created_at,
          approve_label: role === 'admin' ? 'Approve' : needsAdmin ? 'Approve → Admin' : 'Approve',
          reject_label: 'Reject',
          extra: { approval_status: r.approval_status, needs_admin: needsAdmin },
        });
      }
    }

    if (hasPermission(req.user, 'salaries', 'view') && ['finance', 'admin'].includes(role)) {
      const fundStatus = role === 'admin' ? 'finance_approved' : 'pending_finance';
      const { rows } = await query(
        `SELECT sfr.id, sfr.month, sfr.amount_requested, sfr.created_at, u.name AS submitted_by_name
         FROM salary_funding_requests sfr
         LEFT JOIN users u ON u.id = sfr.requested_by
         WHERE sfr.status = $1
         ORDER BY sfr.created_at ASC`,
        [fundStatus]
      );
      for (const r of rows) {
        items.push({
          kind: 'funding',
          id: r.id,
          title: `Salary funding · ${r.month}`,
          subtitle: role === 'finance' ? 'Enter funded amount on approve' : 'Unlock HR settlement',
          from: r.submitted_by_name,
          amount: Number(r.amount_requested),
          submitted_at: r.created_at,
          approve_label: role === 'admin' ? 'Approve' : 'Add & escalate',
          reject_label: 'Reject',
          extra: { month: r.month, amount_requested: r.amount_requested },
        });
      }
    }

    if (
      (hasPermission(req.user, 'leave', 'decide') || hasPermission(req.user, 'employees', 'edit')) &&
      ['hr', 'admin'].includes(role)
    ) {
      const { rows } = await query(
        `SELECT lr.id, lr.leave_type, lr.start_date, lr.end_date, lr.reason, lr.created_at,
                u.name AS submitted_by_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN users u ON u.id = e.user_id
         WHERE lr.status = 'pending'
         ORDER BY lr.created_at ASC`
      );
      for (const r of rows) {
        items.push({
          kind: 'leave',
          id: r.id,
          title: `Leave · ${(r.leave_type || 'annual').replace(/_/g, ' ')}`,
          subtitle: `${r.start_date} → ${r.end_date}${r.reason ? ` · ${r.reason}` : ''}`,
          from: r.submitted_by_name,
          amount: null,
          submitted_at: r.created_at,
          approve_label: 'Approve',
          reject_label: 'Reject',
        });
      }
    }

    items.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    res.json({ ok: true, data: items });
  })
);

router.post(
  '/:kind/:id/decide',
  asyncHandler(async (req, res) => {
    throw new AppError(
      'Use the existing approve/reject endpoints for this item type',
      400,
      'USE_TYPED_ENDPOINT'
    );
  })
);

module.exports = router;
