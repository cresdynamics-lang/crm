const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

/**
 * Director (and Admin) company-wide dashboard.
 * Invoices projection only - never account balances / cash health.
 */
router.get(
  '/dashboard',
  requireAnyPermission([['projects', 'approve'], ['invoices', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['director', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows: active } = await query(
      `SELECT COUNT(*)::int AS count FROM projects
       WHERE status IN ('approved', 'in_progress', 'blocked')`
    );
    const { rows: pending } = await query(
      `SELECT COUNT(*)::int AS count FROM projects WHERE status = 'pending_approval'`
    );
    const { rows: completedWeek } = await query(
      `SELECT COUNT(*)::int AS count FROM projects
       WHERE status = 'completed'
         AND updated_at >= date_trunc('week', CURRENT_DATE)`
    );
    const { rows: reportsWeek } = await query(
      `SELECT COUNT(*)::int AS count FROM daily_reports
       WHERE created_at >= date_trunc('week', CURRENT_DATE)`
    );
    const { rows: openTasks } = await query(
      `SELECT COUNT(*)::int AS count FROM tasks WHERE status IN ('open', 'in_progress')`
    );

    // Team performance snapshot (lightweight)
    const { rows: byRole } = await query(
      `SELECT r.name AS role, COUNT(dr.id)::int AS reports
       FROM roles r
       LEFT JOIN users u ON u.role_id = r.id AND u.status = 'active'
       LEFT JOIN daily_reports dr
         ON dr.user_id = u.id
        AND dr.created_at >= date_trunc('week', CURRENT_DATE)
       WHERE r.name IN ('sales', 'developer', 'pm')
       GROUP BY r.name
       ORDER BY r.name`
    );

    // Invoice projection: expected in (issued/overdue) vs collected (paid) this month
    const { rows: invIn } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total
       FROM invoices WHERE status IN ('issued', 'overdue')`
    );
    const { rows: invOut } = await query(
      // "out" for director = money already marked paid (projected collected), not expenses
      `SELECT COALESCE(SUM(amount),0)::float AS total
       FROM invoices WHERE status = 'paid'`
    );

    // Chart: last 6 months issued vs paid totals
    const { rows: monthly } = await query(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
              COALESCE(SUM(CASE WHEN status IN ('issued','overdue') THEN amount ELSE 0 END),0)::float AS expected,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END),0)::float AS collected
       FROM invoices
       WHERE created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
       GROUP BY 1
       ORDER BY 1`
    );

    const labels = [];
    const expected = [];
    const collected = [];
    const byMonth = Object.fromEntries(monthly.map((m) => [m.month, m]));
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      labels.push(d.toLocaleDateString(undefined, { month: 'short' }));
      labels[labels.length - 1] = d.toLocaleString(undefined, { month: 'short' });
      expected.push(byMonth[key]?.expected || 0);
      collected.push(byMonth[key]?.collected || 0);
    }

    res.json({
      ok: true,
      data: {
        kpis: {
          activeProjects: active[0].count,
          pendingApprovals: pending[0].count,
          completedThisWeek: completedWeek[0].count,
          reportsThisWeek: reportsWeek[0].count,
          openTasks: openTasks[0].count,
        },
        teamPerformance: byRole,
        invoiceProjection: {
          expectedIn: invIn[0].total,
          collected: invOut[0].total,
          // Explicitly no balances / expenses / cash flow
        },
        chart: { labels, expected, collected },
      },
    });
  })
);

/**
 * Pending approvals queue with submitter + client + developer names.
 */
router.get(
  '/approvals',
  requirePermission('projects', 'approve'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.created_at, p.value_amount, p.summary,
              c.name AS client_name, c.business_name AS client_business,
              s.name AS submitted_by_name, s.id AS submitted_by,
              d.name AS developer_name, d.id AS assigned_developer_id
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       JOIN users s ON s.id = p.created_by
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       WHERE p.status = 'pending_approval'
       ORDER BY p.created_at ASC`
    );
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/approvals/:id',
  requirePermission('projects', 'approve'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT p.*,
              c.name AS client_name, c.business_name AS client_business,
              c.email AS client_email, c.phone AS client_phone,
              s.name AS submitted_by_name, s.email AS submitted_by_email,
              d.name AS developer_name, d.email AS developer_email
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       JOIN users s ON s.id = p.created_by
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
