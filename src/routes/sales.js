const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

/**
 * Sales dashboard - pipeline + ownership. Zero finance figures.
 * GET /api/sales/dashboard
 */
router.get(
  '/dashboard',
  requireAnyPermission([['leads', 'view'], ['projects', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['sales', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const userId = req.user.id;
    const isSales = req.user.role === 'sales';
    const leadScope = isSales ? 'AND created_by = $1' : '';
    const projectScope = isSales ? 'AND created_by = $1' : '';
    const params = isSales ? [userId] : [];

    const { rows: leadsInContact } = await query(
      `SELECT COUNT(*)::int AS count FROM leads
       WHERE status = 'contacting'
       ${leadScope}`,
      params
    );

    const { rows: prospects } = await query(
      `SELECT COUNT(*)::int AS count FROM leads
       WHERE status = 'follow_up'
       ${leadScope}`,
      params
    );

    // Deals = converted leads / clients created by this sales user
    const { rows: deals } = await query(
      `SELECT COUNT(*)::int AS count FROM leads
       WHERE status = 'converted' ${leadScope}`,
      params
    );

    const { rows: followUpsDue } = await query(
      `SELECT COUNT(DISTINCT l.id)::int AS count
       FROM leads l
       JOIN lead_engagements e ON e.lead_id = l.id
       WHERE l.status = 'follow_up'
         AND e.follow_up_date IS NOT NULL
         AND e.follow_up_date <= CURRENT_DATE
         ${isSales ? 'AND l.created_by = $1' : ''}`,
      params
    );

    const { rows: projectsCreated } = await query(
      `SELECT COUNT(*)::int AS count FROM projects WHERE TRUE ${projectScope}`,
      params
    );

    const { rows: leadsConverted } = await query(
      `SELECT COUNT(*)::int AS count FROM leads
       WHERE status = 'converted' ${leadScope}`,
      params
    );

    // Assignment status breakdown for own projects
    const { rows: assignmentBreakdown } = await query(
      `SELECT COALESCE(assignment_status, 'unassigned') AS status, COUNT(*)::int AS count
       FROM projects
       WHERE status NOT IN ('pending_approval', 'rejected')
       ${projectScope}
       GROUP BY 1`,
      params
    );

    const { rows: pendingInvoiceFollowups } = await query(
      `SELECT COUNT(*)::int AS count FROM invoice_followups
       WHERE status = 'pending'
       ${isSales ? 'AND assigned_sales_user_id = $1' : ''}`,
      isSales ? [userId] : []
    );

    // Engagements this week (velocity signal)
    const chartParams = isSales ? [userId] : [];
    const { rows: weekRows } = await query(
      `SELECT DATE(e.created_at) AS day, COUNT(*)::int AS count
       FROM lead_engagements e
       JOIN leads l ON l.id = e.lead_id
       WHERE e.created_at >= date_trunc('week', CURRENT_DATE)
         AND e.created_at < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
         ${isSales ? 'AND l.created_by = $1' : ''}
       GROUP BY DATE(e.created_at)
       ORDER BY day`,
      chartParams
    );

    const weekStart = new Date();
    const day = weekStart.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() + diff);

    const labels = [];
    const values = [];
    const byDay = Object.fromEntries(
      weekRows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.count])
    );
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
      values.push(byDay[key] || 0);
    }

    res.json({
      ok: true,
      data: {
        kpis: {
          leadsInContact: leadsInContact[0].count,
          prospects: prospects[0].count,
          deals: deals[0].count,
          followUpsDue: followUpsDue[0].count,
          projectsCreated: projectsCreated[0].count,
          leadsConverted: leadsConverted[0].count,
          pendingInvoiceFollowups: pendingInvoiceFollowups[0].count,
          assignmentBreakdown: Object.fromEntries(
            assignmentBreakdown.map((r) => [r.status, r.count])
          ),
        },
        chart: { labels, values },
      },
    });
  })
);

module.exports = router;
