/**
 * Action audit + analytics for Director/Admin reports panel.
 */
const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

router.get(
  '/actions',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const params = [];
    const clauses = [];
    if (req.query.resource_type) {
      params.push(req.query.resource_type);
      clauses.push(`resource_type = $${params.length}`);
    }
    if (req.query.actor_id) {
      params.push(req.query.actor_id);
      clauses.push(`actor_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT a.*, u.name AS actor_name
       FROM action_audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT 300`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

/**
 * Analytics for Director + Admin reports panel (ops only, no cash).
 */
router.get(
  '/analytics',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['director', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows: leadConv } = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
              COUNT(*)::int AS total
       FROM leads`
    );
    const { rows: projectsMonth } = await query(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
              COUNT(*)::int AS count
       FROM projects
       WHERE created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
       GROUP BY 1 ORDER BY 1`
    );
    const { rows: delivery } = await query(
      `SELECT u.name AS developer,
              COUNT(p.id)::int AS projects,
              COALESCE(AVG(
                CASE WHEN jsonb_array_length(COALESCE(p.milestones, '[]'::jsonb)) = 0 THEN 0
                ELSE (
                  SELECT COUNT(*)::float FROM jsonb_array_elements(p.milestones) m
                  WHERE LOWER(COALESCE(m->>'status','')) = 'completed'
                ) / NULLIF(jsonb_array_length(p.milestones), 0) * 100
                END
              ), 0)::float AS avg_completion
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN projects p ON p.assigned_developer_id = u.id
         AND p.assignment_status IN ('accepted', 'auto_reassigned')
         AND p.status NOT IN ('pending_approval', 'rejected')
       WHERE r.name = 'developer' AND u.status = 'active'
       GROUP BY u.id, u.name
       ORDER BY u.name`
    );
    const { rows: salesVol } = await query(
      `SELECT u.name AS sales_rep,
              COUNT(p.id)::int AS projects_created,
              COUNT(p.id) FILTER (WHERE p.status = 'completed')::int AS completed
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN projects p ON p.created_by = u.id
       WHERE r.name = 'sales' AND u.status = 'active'
       GROUP BY u.id, u.name
       ORDER BY projects_created DESC`
    );

    const total = leadConv[0].total || 0;
    const converted = leadConv[0].converted || 0;

    res.json({
      ok: true,
      data: {
        conversionRate: total ? Math.round((converted / total) * 100) : 0,
        leadsTotal: total,
        leadsConverted: converted,
        projectsByMonth: {
          labels: projectsMonth.map((r) => r.month),
          values: projectsMonth.map((r) => r.count),
        },
        developerDelivery: delivery,
        salesVolume: salesVol,
      },
    });
  })
);

module.exports = router;
