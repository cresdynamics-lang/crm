const express = require('express');
const { query, withTransaction } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const {
  queueInvoiceOnProjectApproval,
  queueNotification,
  queueOutboundClientEmail,
} = require('../queues/jobs');
const {
  normalizeMilestones,
  normalizeStatus,
  milestoneLabel,
  pendingHours,
  progressPercent,
  newlyCompletedMilestones,
  MS_STATUSES,
} = require('../services/milestones');

const router = express.Router();
router.use(authenticate);

const PROGRESS_ROLES = ['sales', 'director', 'pm', 'developer', 'admin'];

function scopeClause(user, params, alias = '') {
  const p = alias ? `${alias}.` : '';
  // Role-based row scoping
  if (user.role === 'developer') {
    params.push(user.id);
    return `${p}assigned_developer_id = $${params.length}
            AND COALESCE(${p}assignment_status, 'accepted') IN ('accepted', 'auto_reassigned')
            AND ${p}status NOT IN ('pending_approval', 'rejected')`;
  }
  if (user.role === 'sales') {
    params.push(user.id);
    return `${p}created_by = $${params.length}`;
  }
  if (user.role === 'client') {
    params.push(user.id);
    params.push(user.email);
    return `${p}client_id IN (SELECT id FROM clients WHERE user_id = $${params.length - 1} OR email = $${params.length})
            AND ${p}status NOT IN ('pending_approval', 'rejected')`;
  }
  if (user.role === 'finance') {
    // Finance uses /api/finance/projects — block ops list
    return `FALSE`;
  }
  return null;
}

function canSeeProjectMoney(role) {
  // Sales sets project value on create/resubmit. Director sees projection. Admin/Finance: full.
  return ['sales', 'director', 'admin', 'finance'].includes(role);
}

function canSeePreviewUrl(role) {
  // Ops + client. Finance/HR should not surface live preview links.
  return ['sales', 'developer', 'pm', 'director', 'admin', 'client'].includes(role);
}

function canSeeClientDetails(role) {
  // PM: operational only — client name may appear via dedicated PM queries, not contact
  return ['sales', 'director', 'admin', 'finance'].includes(role);
}

function canSeeClientContact(role) {
  return ['sales', 'director', 'admin', 'finance'].includes(role);
}

async function loadClient(clientId) {
  if (!clientId) return null;
  const { rows } = await query(
    `SELECT id, name, business_name, email, phone FROM clients WHERE id = $1`,
    [clientId]
  );
  return rows[0] || null;
}

function shapeProject(project, role, client = null) {
  const data = { ...project };

  if (!canSeeProjectMoney(role)) {
    delete data.value_amount;
  }

  if (!canSeePreviewUrl(role)) {
    delete data.preview_url;
  }

  if (!canSeeClientDetails(role)) {
    delete data.client_id;
  } else if (client) {
    data.client_name = client.name;
    data.client_business = client.business_name;
    if (canSeeClientContact(role)) {
      data.client_email = client.email;
      data.client_phone = client.phone;
    }
  }

  return data;
}

function buildChangeAudit(before, after, { note, milestone_status } = {}) {
  const changes = {};
  const parts = [];

  if (before.name !== undefined && after.name !== undefined && before.name !== after.name) {
    changes.name = { from: before.name, to: after.name };
    parts.push(`Name updated`);
  }
  if (
    before.description !== undefined &&
    after.description !== undefined &&
    (before.description || '') !== (after.description || '')
  ) {
    changes.description = true;
    parts.push(`Description updated`);
  }

  if (before.status !== after.status) {
    changes.status = { from: before.status, to: after.status };
    parts.push(`Status ${before.status} → ${after.status}`);
  }

  const beforeMs = Array.isArray(before.milestones) ? before.milestones : [];
  const afterMs = Array.isArray(after.milestones) ? after.milestones : [];
  const msChanges = [];
  const len = Math.max(beforeMs.length, afterMs.length);
  for (let i = 0; i < len; i++) {
    const b = beforeMs[i];
    const a = afterMs[i];
    if (!a) continue;
    const bStatus = normalizeStatus(b?.status);
    const aStatus = normalizeStatus(a.status);
    if (!b || bStatus !== aStatus) {
      msChanges.push({
        title: milestoneLabel(a),
        from: b ? bStatus : null,
        to: aStatus,
      });
      parts.push(`Milestone '${milestoneLabel(a)}' → ${aStatus.replace(/_/g, ' ')}`);
    }
  }
  if (msChanges.length) changes.milestones = msChanges;

  if (note) {
    changes.note = note;
    parts.push(`Note added`);
  }
  if (milestone_status && !msChanges.length) {
    changes.milestone_status = milestone_status;
    parts.push(milestone_status);
  }

  return {
    changes,
    change_summary: parts.length ? parts.join('; ') : 'Progress update logged',
  };
}

async function assertCanAccessProject(user, project) {
  if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

  if (user.role === 'developer') {
    if (project.assigned_developer_id !== user.id
      || ['pending_approval', 'rejected'].includes(project.status)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
  }
  if (user.role === 'sales' && project.created_by !== user.id) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
  if (user.role === 'client') {
    const { rows: owned } = await query(
      `SELECT 1 FROM clients c
       WHERE c.id = $1 AND (c.user_id = $2 OR c.email = $3)`,
      [project.client_id, user.id, user.email]
    );
    if (!owned[0] || ['pending_approval', 'rejected'].includes(project.status)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
  }
  if (user.role === 'finance') {
    // Finance may view for money context but not required here
  }
}

router.get(
  '/',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'finance') {
      throw new AppError(
        'Finance uses /api/finance/projects for money views only',
        403,
        'FORBIDDEN'
      );
    }
    const params = [];
    const clauses = [];
    const scoped = scopeClause(req.user, params, 'p');
    if (scoped) clauses.push(scoped);

    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`p.status = $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT p.*,
              d.name AS developer_name,
              c.name AS client_name,
              c.business_name AS client_business
       FROM projects p
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       LEFT JOIN clients c ON c.id = p.client_id
       ${where}
       ORDER BY p.created_at DESC`,
      params
    );

    const data = [];
    for (const row of rows) {
      const client = canSeeClientDetails(req.user.role)
        ? await loadClient(row.client_id)
        : null;
      const shaped = shapeProject(row, req.user.role, client);
      shaped.developer_name = row.developer_name || null;
      shaped.progress_percent = progressPercent(row.milestones);
      data.push(shaped);
    }

    res.json({ ok: true, data });
  })
);

router.post(
  '/',
  requirePermission('projects', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'finance') {
      throw new AppError('Finance cannot create projects', 403, 'FORBIDDEN');
    }
    const {
      name, client_id, description, milestones, summary,
      assigned_developer_id, value_amount,
    } = req.body || {};
    if (!name) throw new AppError('name is required', 400, 'VALIDATION');

    const overview = (description || summary || '').trim() || null;
    const normalizedMs = normalizeMilestones(milestones || []);

    const { rows } = await query(
      `INSERT INTO projects
        (name, client_id, description, milestones, summary, assigned_developer_id, created_by, value_amount, status)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'pending_approval')
       RETURNING *`,
      [
        name,
        client_id || null,
        overview,
        JSON.stringify(normalizedMs),
        overview,
        assigned_developer_id || null,
        req.user.id,
        value_amount || null,
      ]
    );

    // Async: notify directors
    const { rows: directors } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('director', 'admin') AND u.status = 'active'`
    );
    for (const d of directors) {
      await queueNotification({
        userId: d.id,
        type: 'project_pending_approval',
        content: `Project "${name}" awaiting approval`,
        meta: { projectId: rows[0].id },
      });
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/**
 * Developer workload - active project counts (PM/Director assignment guard).
 * Must be registered before /:id
 */
router.get(
  '/meta/developer-workload',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (!['pm', 'director', 'admin', 'sales'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { rows } = await query(
      `SELECT u.id, u.name, u.email,
              COUNT(p.id) FILTER (
                WHERE p.status IN ('approved', 'in_progress', 'blocked')
              )::int AS active_count,
              COUNT(p.id) FILTER (WHERE p.status = 'completed')::int AS completed_count
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN projects p ON p.assigned_developer_id = u.id
       WHERE r.name = 'developer' AND u.status = 'active'
       GROUP BY u.id, u.name, u.email
       ORDER BY active_count DESC, u.name`
    );
    res.json({ ok: true, data: rows });
  })
);

/**
 * PM timeline / Gantt feed across projects.
 */
router.get(
  '/meta/timeline',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (!['pm', 'director', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.assigned_developer_id,
              d.name AS developer_name, c.name AS client_name
       FROM projects p
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.status NOT IN ('pending_approval', 'rejected')
       ORDER BY p.updated_at DESC
       LIMIT 100`
    );

    const items = [];
    for (const p of rows) {
      const ms = Array.isArray(p.milestones) ? p.milestones : [];
      for (const m of ms) {
        if (!m.due_date) continue;
        items.push({
          projectId: p.id,
          projectName: p.name,
          projectStatus: p.status,
          milestone: m.title || m.name || 'Milestone',
          status: m.status || 'not_started',
          due_date: m.due_date,
          developer_name: p.developer_name,
          client_name: p.client_name,
        });
      }
    }
    items.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    res.json({ ok: true, data: items });
  })
);

router.get(
  '/:id',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    const project = rows[0];
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

    if (req.user.role === 'client') {
      await assertCanAccessProject(req.user, project);
      throw new AppError('Use client portal project endpoint', 403, 'FORBIDDEN');
    }

    await assertCanAccessProject(req.user, project);

    const client = canSeeClientDetails(req.user.role)
      ? await loadClient(project.client_id)
      : null;

    let developerName = null;
    if (project.assigned_developer_id) {
      const { rows: devRows } = await query(
        `SELECT name FROM users WHERE id = $1`,
        [project.assigned_developer_id]
      );
      developerName = devRows[0]?.name || null;
    }

    res.json({
      ok: true,
      data: {
        ...shapeProject(project, req.user.role, client),
        developer_name: developerName,
        ...pendingHours(
          normalizeMilestones(Array.isArray(project.milestones) ? project.milestones : [])
        ),
        progress_percent: progressPercent(project.milestones),
      },
      meta: {
        canUpdateProgress: PROGRESS_ROLES.includes(req.user.role)
          && !['pending_approval', 'rejected'].includes(project.status),
        canEditProject: ['director', 'pm', 'admin'].includes(req.user.role)
          && !['pending_approval', 'rejected'].includes(project.status),
        canSeeClient: canSeeClientDetails(req.user.role),
        canSeeMoney: canSeeProjectMoney(req.user.role),
      },
    });
  })
);

router.post(
  '/:id/approve',
  requirePermission('projects', 'approve'),
  idempotency,
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE projects
         SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND status = 'pending_approval'
         RETURNING *`,
        [req.user.id, req.params.id]
      );
      const project = rows[0];
      if (!project) throw new AppError('Project not pending approval', 409, 'INVALID_STATE');

      // Sync: create invoice row immediately (user-facing result)
      let invoice = null;
      if (project.value_amount != null) {
        const inv = await tx.query(
          `INSERT INTO invoices (project_id, client_id, amount, status, due_date, amount_paid)
           VALUES ($1, $2, $3, 'issued', CURRENT_DATE + INTERVAL '14 days', 0)
           RETURNING *`,
          [project.id, project.client_id, project.value_amount]
        );
        invoice = inv.rows[0];
      }
      return { project, invoice };
    });

    // Async side-effects: email client, notify finance (queued + retried)
    if (result.invoice) {
      await queueInvoiceOnProjectApproval(result.project.id, result.invoice.id);
    }

    // Create pending developer invitation after approval
    if (result.project.assigned_developer_id) {
      try {
        const { assignDeveloper } = require('../services/assignments');
        await assignDeveloper({
          projectId: result.project.id,
          developerId: result.project.assigned_developer_id,
          assignedBy: result.project.created_by || req.user.id,
          actorRole: 'system',
          note: 'Invitation after Director approval',
        });
      } catch (e) {
        console.error('[approve] assignment invite failed', e.message);
      }
    }

    const { recordAction } = require('../services/actionAudit');
    await recordAction({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'project.approve',
      resourceType: 'project',
      resourceId: result.project.id,
      summary: `Approved project "${result.project.name}"`,
      after: { status: 'approved' },
    });

    res.json({ ok: true, data: result });
  })
);

router.post(
  '/:id/reject',
  requirePermission('projects', 'approve'),
  asyncHandler(async (req, res) => {
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new AppError('Rejection reason is required', 400, 'VALIDATION');

    const { rows } = await query(
      `UPDATE projects
       SET status = 'rejected',
           rejection_reason = $1,
           approved_by = $2,
           approved_at = NOW(),
           updated_at = NOW()
       WHERE id = $3 AND status = 'pending_approval'
       RETURNING *`,
      [reason, req.user.id, req.params.id]
    );
    if (!rows[0]) throw new AppError('Project not pending approval', 409, 'INVALID_STATE');

    await queueNotification({
      userId: rows[0].created_by,
      type: 'project_rejected',
      content: `Project "${rows[0].name}" was rejected: ${reason}`,
      meta: { projectId: rows[0].id, reason },
    });

    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * Sales edits a rejected project and resubmits for Director approval.
 */
router.patch(
  '/:id/resubmit',
  requirePermission('projects', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { rows: existing } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    const project = existing[0];
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    if (project.status !== 'rejected') {
      throw new AppError('Only rejected projects can be resubmitted', 409, 'INVALID_STATE');
    }
    if (req.user.role === 'sales' && project.created_by !== req.user.id) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    if (!['sales', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Sales can resubmit rejected projects', 403, 'FORBIDDEN');
    }

    const {
      name, description, summary, milestones, client_id,
      assigned_developer_id, value_amount,
    } = req.body || {};

    const sets = [
      `status = 'pending_approval'`,
      `rejection_reason = NULL`,
      `approved_by = NULL`,
      `approved_at = NULL`,
      `updated_at = NOW()`,
    ];
    const params = [];
    if (name !== undefined) {
      params.push(name.trim());
      sets.push(`name = $${params.length}`);
    }
    if (description !== undefined || summary !== undefined) {
      const overview = String(
        description !== undefined ? description : summary ?? project.description ?? ''
      ).trim() || null;
      params.push(overview);
      sets.push(`description = $${params.length}`);
      params.push(overview);
      sets.push(`summary = $${params.length}`);
    }
    if (milestones !== undefined) {
      params.push(JSON.stringify(normalizeMilestones(milestones)));
      sets.push(`milestones = $${params.length}::jsonb`);
    }
    if (client_id !== undefined) {
      params.push(client_id || null);
      sets.push(`client_id = $${params.length}`);
    }
    if (assigned_developer_id !== undefined) {
      params.push(assigned_developer_id || null);
      sets.push(`assigned_developer_id = $${params.length}`);
    }
    if (value_amount !== undefined && ['sales', 'admin'].includes(req.user.role)) {
      params.push(value_amount);
      sets.push(`value_amount = $${params.length}`);
    }
    params.push(req.params.id);

    const { rows } = await query(
      `UPDATE projects SET ${sets.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    const { rows: directors } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('director', 'admin') AND u.status = 'active'`
    );
    for (const d of directors) {
      await queueNotification({
        userId: d.id,
        type: 'project_pending_approval',
        content: `Project "${rows[0].name}" resubmitted for approval`,
        meta: { projectId: rows[0].id, resubmitted: true },
      });
    }

    res.json({ ok: true, data: rows[0] });
  })
);

router.patch(
  '/:id/progress',
  requirePermission('projects', 'edit'),
  asyncHandler(async (req, res) => {
    if (!PROGRESS_ROLES.includes(req.user.role)) {
      throw new AppError('Your role cannot update project progress', 403, 'FORBIDDEN');
    }

    const { status, milestones, note, milestone_status, preview_url, name, description } =
      req.body || {};
    const allowedStatuses = ['in_progress', 'blocked', 'completed', 'approved'];
    if (status && !allowedStatuses.includes(status)) {
      throw new AppError('Invalid status transition', 400, 'VALIDATION');
    }

    const { rows: existing } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    const current = existing[0];
    if (!current) throw new AppError('Project not found', 404, 'NOT_FOUND');

    if (['pending_approval', 'rejected'].includes(current.status)) {
      throw new AppError('Project not available for progress updates', 403, 'FORBIDDEN');
    }

    await assertCanAccessProject(req.user, current);

    const canEditFields = ['director', 'pm', 'admin'].includes(req.user.role);

    // Normalize milestone statuses + tasks (omit field = leave unchanged; never wipe with [])
    let nextMilestones;
    if (milestones !== undefined) {
      if (!Array.isArray(milestones)) {
        throw new AppError('milestones must be an array', 400, 'VALIDATION');
      }
      for (const m of milestones) {
        if (m.status && !MS_STATUSES.has(normalizeStatus(m.status)) && m.status !== 'pending') {
          throw new AppError(`Invalid milestone status: ${m.status}`, 400, 'VALIDATION');
        }
      }
      nextMilestones = normalizeMilestones(milestones);
    }

    const sets = [];
    const params = [];
    if (status) {
      params.push(status);
      sets.push(`status = $${params.length}`);
    }
    if (nextMilestones !== undefined) {
      params.push(JSON.stringify(nextMilestones));
      sets.push(`milestones = $${params.length}::jsonb`);
    }
    if (canEditFields && name !== undefined) {
      const n = String(name || '').trim();
      if (!n) throw new AppError('name cannot be empty', 400, 'VALIDATION');
      params.push(n);
      sets.push(`name = $${params.length}`);
    }
    if (canEditFields && description !== undefined) {
      const overview = String(description || '').trim() || null;
      params.push(overview);
      sets.push(`description = $${params.length}`);
      params.push(overview);
      sets.push(`summary = $${params.length}`);
    }
    if (preview_url !== undefined && canSeePreviewUrl(req.user.role)) {
      const url = String(preview_url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        throw new AppError('Preview link must start with http:// or https://', 400, 'VALIDATION');
      }
      params.push(url || null);
      sets.push(`preview_url = $${params.length}`);
    }
    if (!sets.length && !note && !milestone_status) {
      throw new AppError('Nothing to update', 400, 'VALIDATION');
    }

    const before = {
      name: current.name,
      description: current.description || current.summary || null,
      status: current.status,
      milestones: normalizeMilestones(
        Array.isArray(current.milestones) ? current.milestones : []
      ),
    };

    let project = current;
    if (sets.length) {
      const progressTouch =
        status ||
        nextMilestones !== undefined ||
        (preview_url !== undefined && canSeePreviewUrl(req.user.role));
      if (progressTouch && !status && current.status === 'approved') {
        params.push('in_progress');
        sets.push(`status = $${params.length}`);
      }
      params.push(req.params.id);
      const { rows } = await query(
        `UPDATE projects SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING *`,
        params
      );
      project = rows[0];
    }

    const after = {
      name: project.name,
      description: project.description || project.summary || null,
      status: project.status,
      milestones: nextMilestones !== undefined
        ? nextMilestones
        : normalizeMilestones(Array.isArray(project.milestones) ? project.milestones : []),
    };
    const audit = buildChangeAudit(before, after, { note, milestone_status });

    // Always append an immutable audit row when any progress action is taken
    const { rows: updates } = await query(
      `INSERT INTO project_updates
        (project_id, updated_by, milestone_status, note, actor_role, change_summary, changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        project.id,
        req.user.id,
        milestone_status || null,
        note || null,
        req.user.role,
        audit.change_summary,
        JSON.stringify(audit.changes),
      ]
    );
    const updateRow = updates[0];

    const { rows: hubs } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('pm', 'director', 'admin') AND u.status = 'active'
         AND u.id <> $1`,
      [req.user.id]
    );
    for (const h of hubs) {
      const workload = pendingHours(after.milestones);
      await queueNotification({
        userId: h.id,
        type: 'project_update',
        content: `${req.user.name} (${req.user.role}) updated project "${project.name}"` +
          (workload.pending_tasks
            ? ` · ${workload.pending_tasks} pending task(s), ${workload.pending_hours}h`
            : ''),
        meta: {
          projectId: project.id,
          updateId: updateRow.id,
          pending_hours: workload.pending_hours,
          pending_tasks: workload.pending_tasks,
        },
      });
    }

    // Newly completed milestones → notify Sales + email client
    const completed = newlyCompletedMilestones(before.milestones, after.milestones);
    if (completed.length) {
      const titles = completed.map((m) => milestoneLabel(m));
      const msg = titles.length === 1
        ? `Milestone "${titles[0]}" is done on project "${project.name}".`
        : `These milestones are done on project "${project.name}": ${titles.map((t) => `"${t}"`).join(', ')}.`;

      if (project.created_by && project.created_by !== req.user.id) {
        await queueNotification({
          userId: project.created_by,
          type: 'milestone_completed',
          content: msg,
          meta: { projectId: project.id, milestones: titles },
        });
      }

      const client = await loadClient(project.client_id);
      if (client?.email) {
        const subject = `Milestone update: ${project.name}`;
        const body = [
          `Hello${client.name ? ` ${client.name}` : ''},`,
          '',
          msg,
          '',
          'Please review the progress in your client portal when convenient.',
          '',
          '— Cres Dynamics',
        ].join('\n');
        const { rows: emailRows } = await query(
          `INSERT INTO outbound_emails (sent_by, client_id, to_email, subject, body, status)
           VALUES ($1, $2, $3, $4, $5, 'queued')
           RETURNING id`,
          [req.user.id, project.client_id, client.email, subject, body]
        );
        await queueOutboundClientEmail({
          emailId: emailRows[0].id,
          to: client.email,
          subject,
          body,
        });
        await queueNotification({
          userId: project.created_by,
          type: 'milestone_client_emailed',
          content: `Client emailed about completed milestone(s) on "${project.name}"`,
          meta: { projectId: project.id, emailId: emailRows[0].id },
        }).catch(() => {});
      }
    }

    const client = canSeeClientDetails(req.user.role)
      ? await loadClient(project.client_id)
      : null;

    res.json({
      ok: true,
      data: {
        project: {
          ...shapeProject(project, req.user.role, client),
          ...pendingHours(after.milestones),
        },
        update: {
          ...updateRow,
          author_name: req.user.name,
          author_role: req.user.role,
        },
        completed_milestones: completed.map(milestoneLabel),
      },
    });
  })
);

router.get(
  '/:id/updates',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    const { rows: projects } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    const project = projects[0];
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    await assertCanAccessProject(req.user, project);

    if (req.user.role === 'client') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT u.*, us.name AS author_name, COALESCE(u.actor_role, r.name) AS author_role,
              us.avatar_url AS author_avatar_url
       FROM project_updates u
       JOIN users us ON us.id = u.updated_by
       JOIN roles r ON r.id = us.role_id
       WHERE u.project_id = $1
       ORDER BY u.created_at DESC
       LIMIT 200`,
      [req.params.id]
    );
    // Append-only: never expose edit/delete affordances
    res.json({
      ok: true,
      data: rows,
      meta: { immutable: true },
    });
  })
);

/**
 * Staff: list project documents / deliverables (screenshots & videos).
 */
router.get(
  '/:id/documents',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    const { rows: projects } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    const project = projects[0];
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    await assertCanAccessProject(req.user, project);
    if (req.user.role === 'client') {
      throw new AppError('Use client portal documents endpoint', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT d.id, d.title, d.file_path, d.original_name, d.mime_type, d.file_size,
              d.kind, d.milestone_title, d.shared_with_client, d.created_at,
              u.name AS uploaded_by_name
       FROM project_documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.project_id = $1
       ORDER BY d.created_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

module.exports = router;
