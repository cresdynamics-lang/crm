const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { listForDeveloper } = require('../services/assignments');

const router = express.Router();
router.use(authenticate);

function milestoneProgress(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  if (!list.length) return 0;
  const done = list.filter((m) => (m.status || '').toLowerCase() === 'completed').length;
  return Math.round((done / list.length) * 100);
}

/**
 * Developer dashboard - own performance only.
 * GET /api/developer/dashboard
 */
router.get(
  '/dashboard',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (!['developer', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const userId = req.user.id;

    const { rows: projects } = await query(
      `SELECT id, name, status, milestones
       FROM projects
       WHERE assigned_developer_id = $1
         AND COALESCE(assignment_status, 'accepted') IN ('accepted', 'auto_reassigned')
         AND status NOT IN ('pending_approval', 'rejected')
       ORDER BY updated_at DESC`,
      [userId]
    );

    const active = projects.filter((p) =>
      ['approved', 'in_progress', 'blocked'].includes(p.status)
    );

    const { rows: tasksDue } = await query(
      `SELECT COUNT(*)::int AS count FROM tasks
       WHERE assigned_to = $1
         AND status IN ('open', 'in_progress')
         AND due_date IS NOT NULL
         AND due_date <= CURRENT_DATE`,
      [userId]
    );

    const { rows: tasksDoneToday } = await query(
      `SELECT COUNT(*)::int AS count FROM tasks
       WHERE assigned_to = $1
         AND status = 'done'
         AND updated_at::date = CURRENT_DATE`,
      [userId]
    );

    const pending = await listForDeveloper(userId);

    const perProject = projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      progress_pct: milestoneProgress(p.milestones),
    }));

    res.json({
      ok: true,
      data: {
        kpis: {
          assignedProjects: projects.length,
          activeProjects: active.length,
          tasksDueToday: tasksDue[0].count,
          tasksCompletedToday: tasksDoneToday[0].count,
          pendingInvitations: pending.length,
        },
        perProject,
        chart: {
          labels: active.slice(0, 8).map((p) => p.name),
          values: active.slice(0, 8).map((p) => milestoneProgress(p.milestones)),
        },
        pendingInvitations: pending,
      },
    });
  })
);

/**
 * My accepted projects with milestone progress % (developer-scoped).
 */
router.get(
  '/projects',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (!['developer', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const params = [];
    let where = `WHERE p.status NOT IN ('pending_approval', 'rejected')
                   AND COALESCE(p.assignment_status, 'accepted') IN ('accepted', 'auto_reassigned')`;

    if (req.user.role === 'developer') {
      params.push(req.user.id);
      where += ` AND p.assigned_developer_id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.summary, p.description, p.updated_at, p.created_at,
              p.assignment_status
       FROM projects p
       ${where}
       ORDER BY p.updated_at DESC`,
      params
    );

    const data = rows.map((p) => ({
      ...p,
      progress_pct: milestoneProgress(p.milestones),
    }));

    res.json({ ok: true, data });
  })
);

module.exports = router;
