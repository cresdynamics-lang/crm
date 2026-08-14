const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { pendingHours, normalizeMilestones } = require('../services/milestones');

const router = express.Router();
router.use(authenticate);

const ACTIVE_STATUSES = ['approved', 'in_progress', 'blocked'];
const DUE_SOON_DAYS = 7;

function milestoneProgress(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  if (!list.length) return 0;
  const done = list.filter((m) => (m.status || '').toLowerCase() === 'completed').length;
  return Math.round((done / list.length) * 100);
}

function projectDueDate(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  const open = list.filter((m) => (m.status || '').toLowerCase() !== 'completed' && m.due_date);
  if (!open.length) {
    const any = list.filter((m) => m.due_date).map((m) => m.due_date).sort();
    return any.length ? any[any.length - 1] : null;
  }
  return open.map((m) => m.due_date).sort()[0];
}

function healthFlag(dueDate, status) {
  if (status === 'completed') return 'on_track';
  if (!dueDate) return 'on_track';
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  if (due < today) return 'overdue';
  const soon = new Date(today);
  soon.setDate(soon.getDate() + DUE_SOON_DAYS);
  if (due <= soon) return 'due_soon';
  return 'on_track';
}

function enrichProject(row) {
  const milestones = normalizeMilestones(row.milestones);
  const progress_pct = milestoneProgress(milestones);
  const due_date = projectDueDate(milestones);
  const health = healthFlag(due_date, row.status);
  const workload = pendingHours(milestones);
  const { value_amount, ...rest } = row;
  return {
    ...rest,
    milestones,
    progress_pct,
    due_date,
    health,
    pending_hours: workload.pending_hours,
    pending_tasks: workload.pending_tasks,
  };
}

function assertPm(req) {
  if (!['pm', 'admin'].includes(req.user.role)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

/**
 * PM dashboard - project/people health only. No invoices or money.
 */
router.get(
  '/dashboard',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertPm(req);

    const { rows: projects } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.assigned_developer_id,
              p.client_id, p.updated_at,
              c.name AS client_name,
              d.name AS developer_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       WHERE p.status NOT IN ('pending_approval', 'rejected')
       ORDER BY p.updated_at DESC`
    );

    const enriched = projects.map(enrichProject);
    const active = enriched.filter((p) => ACTIVE_STATUSES.includes(p.status));
    const dueSoon = active.filter((p) => p.health === 'due_soon');
    const overdue = active.filter((p) => p.health === 'overdue');
    const onTrack = active.filter((p) => p.health === 'on_track');
    const pendingWork = enriched.reduce(
      (acc, p) => {
        acc.hours += p.pending_hours || 0;
        acc.tasks += p.pending_tasks || 0;
        return acc;
      },
      { hours: 0, tasks: 0 }
    );

    const loadMap = new Map();
    for (const p of active) {
      if (!p.assigned_developer_id) continue;
      const key = p.assigned_developer_id;
      if (!loadMap.has(key)) {
        loadMap.set(key, {
          developerId: key,
          developerName: p.developer_name || 'Unassigned',
          activeCount: 0,
          overdueCount: 0,
          pending_hours: 0,
          pending_tasks: 0,
        });
      }
      const entry = loadMap.get(key);
      entry.activeCount += 1;
      entry.pending_hours += p.pending_hours || 0;
      entry.pending_tasks += p.pending_tasks || 0;
      if (p.health === 'overdue') entry.overdueCount += 1;
    }
    const teamLoad = Array.from(loadMap.values()).sort((a, b) => b.activeCount - a.activeCount);

    const { rows: pendingReports } = await query(
      `SELECT COUNT(*)::int AS count FROM daily_reports
       WHERE routing_status = 'pending_pm'`
    );

    const { rows: devPerf } = await query(
      `SELECT u.name AS label,
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
         AND COALESCE(p.assignment_status, 'accepted') IN ('accepted', 'auto_reassigned')
         AND p.status NOT IN ('pending_approval', 'rejected')
       WHERE r.name = 'developer' AND u.status = 'active'
       GROUP BY u.id, u.name
       ORDER BY u.name`
    );

    const { rows: salesPerf } = await query(
      `SELECT u.name AS label,
              COUNT(p.id)::int AS projects
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN projects p ON p.created_by = u.id
         AND p.created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
       WHERE r.name = 'sales' AND u.status = 'active'
       GROUP BY u.id, u.name
       ORDER BY projects DESC`
    );

    res.json({
      ok: true,
      data: {
        kpis: {
          activeProjects: active.length,
          dueSoon: dueSoon.length,
          overdue: overdue.length,
          teamLoad: teamLoad.length ? Math.round(teamLoad.reduce((s, t) => s + t.activeCount, 0) / teamLoad.length * 10) / 10 : 0,
          developersLoaded: teamLoad.length,
          pendingReports: pendingReports[0].count,
          pendingHours: pendingWork.hours,
          pendingTasks: pendingWork.tasks,
        },
        healthChart: {
          labels: ['On track', 'Due soon', 'Overdue'],
          values: [onTrack.length, dueSoon.length, overdue.length],
        },
        developerPerformance: {
          labels: devPerf.map((r) => r.label),
          values: devPerf.map((r) => Math.round(r.avg_completion)),
          projects: devPerf.map((r) => r.projects),
        },
        salesPerformance: {
          labels: salesPerf.map((r) => r.label),
          values: salesPerf.map((r) => r.projects),
        },
        teamLoad,
        flagged: [...overdue, ...dueSoon].slice(0, 12),
      },
    });
  })
);

/**
 * Full company project list for PM oversight (approved+ workstreams).
 */
router.get(
  '/projects',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertPm(req);

    const params = [];
    const clauses = [`p.status NOT IN ('pending_approval', 'rejected')`];

    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`p.status = $${params.length}`);
    }
    if (req.query.developer_id) {
      params.push(req.query.developer_id);
      clauses.push(`p.assigned_developer_id = $${params.length}`);
    }
    if (req.query.client_id) {
      params.push(req.query.client_id);
      clauses.push(`p.client_id = $${params.length}`);
    }
    if (req.query.date_from) {
      params.push(req.query.date_from);
      clauses.push(`p.created_at >= $${params.length}::date`);
    }
    if (req.query.date_to) {
      params.push(req.query.date_to);
      clauses.push(`p.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.summary, p.description,
              p.assigned_developer_id, p.client_id, p.created_by, p.preview_url,
              p.created_at, p.updated_at, p.approved_at,
              c.name AS client_name,
              d.name AS developer_name,
              s.name AS sales_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       LEFT JOIN users s ON s.id = p.created_by
       ${where}
       ORDER BY p.updated_at DESC`,
      params
    );

    let data = rows.map(enrichProject);
    if (req.query.health) {
      data = data.filter((p) => p.health === req.query.health);
    }

    res.json({ ok: true, data });
  })
);

/**
 * Project detail for PM - milestones, updates, sales summary. No money.
 */
router.get(
  '/projects/:id',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertPm(req);

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.summary, p.description,
              p.assigned_developer_id, p.client_id, p.created_by, p.preview_url,
              p.created_at, p.updated_at, p.approved_at, p.approved_by,
              c.name AS client_name,
              d.name AS developer_name, d.email AS developer_email,
              s.name AS sales_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       LEFT JOIN users s ON s.id = p.created_by
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');
    if (['pending_approval', 'rejected'].includes(rows[0].status)) {
      throw new AppError('Project not in PM oversight scope', 404, 'NOT_FOUND');
    }

    const project = enrichProject(rows[0]);
    // Explicitly strip any money / client contact fields
    delete project.value_amount;
    delete project.client_email;
    delete project.client_phone;

    const { rows: updates } = await query(
      `SELECT pu.*, u.name AS author_name
       FROM project_updates pu
       JOIN users u ON u.id = pu.updated_by
       WHERE pu.project_id = $1
       ORDER BY pu.created_at DESC
       LIMIT 100`,
      [req.params.id]
    );

    res.json({
      ok: true,
      data: {
        project,
        updates,
      },
    });
  })
);

module.exports = router;
