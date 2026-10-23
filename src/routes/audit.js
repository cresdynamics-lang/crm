/**
 * Audit log routes — Data Pool / RAG system endpoint.
 * Directors and Admins can query the full audit trail.
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler } = require('../lib/errors');
const { query } = require('../config/database');
const { queryAudit } = require('../services/actionAudit');

const router = express.Router();
router.use(authenticate);

function assertDirectorOrAdmin(req, res) {
  if (!['director', 'admin'].includes(req.user.role)) {
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Director or Admin only' } });
    return false;
  }
  return true;
}

router.get(
  '/analytics',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!assertDirectorOrAdmin(req, res)) return;

    const { rows: leadStats } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('converted', 'won'))::int AS converted
       FROM leads`
    );
    const leadsTotal = leadStats[0].total;
    const leadsConverted = leadStats[0].converted;
    const conversionRate = leadsTotal > 0 ? Math.round((leadsConverted / leadsTotal) * 100) : 0;

    const { rows: monthly } = await query(
      `SELECT to_char(m.month, 'Mon') AS label, COALESCE(p.count, 0)::int AS value
       FROM (
         SELECT date_trunc('month', CURRENT_DATE) - INTERVAL '5 months' + INTERVAL '1 month' * n AS month
         FROM generate_series(0, 5) n
       ) m
       LEFT JOIN (
         SELECT date_trunc('month', created_at) AS month, COUNT(*)::int AS count
         FROM projects
         GROUP BY 1
       ) p ON p.month = m.month
       ORDER BY m.month`
    );

    const { rows: developerDelivery } = await query(
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
         AND p.status NOT IN ('pending_approval', 'rejected')
       WHERE r.name = 'developer' AND u.status = 'active'
       GROUP BY u.id, u.name
       ORDER BY u.name`
    );

    const { rows: salesVolume } = await query(
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

    res.json({
      ok: true,
      data: {
        conversionRate,
        leadsConverted,
        leadsTotal,
        projectsByMonth: {
          labels: monthly.map((r) => r.label),
          values: monthly.map((r) => r.value),
        },
        developerDelivery,
        salesVolume,
      },
    });
  })
);

router.get(
  '/actions',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!assertDirectorOrAdmin(req, res)) return;
    const rows = await queryAudit({
      limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
      offset: parseInt(req.query.offset, 10) || 0,
    });
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['director', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Director or Admin only' } });
    }

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await queryAudit({
      resourceType: req.query.resource_type || null,
      resourceId: req.query.resource_id || null,
      actorId: req.query.actor_id || null,
      action: req.query.action || null,
      limit,
      offset,
    });

    res.json({ ok: true, data: rows, meta: { limit, offset } });
  })
);

module.exports = router;
