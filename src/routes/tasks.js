const express = require('express');
const multer = require('multer');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueNotification } = require('../queues/jobs');
const { transcribeAudio } = require('../services/voiceLeads');
const { groqChat } = require('../services/groq');
const { recordAction } = require('../services/actionAudit');

const router = express.Router();
router.use(authenticate);

/**
 * Who each role may assign personal/daily tasks to.
 * Director: admin, sales, developers, finance, PM (single or whole sales/dev teams).
 * PM: sales + developers (+ self).
 */
const ASSIGN_TARGETS = {
  director: ['admin', 'sales', 'developer', 'finance', 'pm'],
  admin: ['admin', 'sales', 'developer', 'finance', 'pm', 'director', 'hr'],
  pm: ['sales', 'developer', 'pm'],
  sales: ['sales', 'developer', 'director'],
  developer: ['sales', 'developer', 'director'],
  // Finance may assign to anyone on staff (depends on the request they explain)
  finance: ['admin', 'sales', 'developer', 'finance', 'pm', 'director', 'hr'],
};

const BULK_ROLES = new Set(['sales', 'developer']); // "all salespeople" / "all developers"

function canManageTask(user, task) {
  if (['admin', 'director', 'pm'].includes(user.role)) return true;
  if (task.assigned_to === user.id) return true;
  if (task.assigned_by === user.id) return true;
  return false;
}

function allowedTargetRoles(actorRole) {
  return ASSIGN_TARGETS[actorRole] || [];
}

async function notifyDirectors({ content, meta }) {
  const { rows } = await query(
    `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'director' AND u.status = 'active'`
  );
  for (const d of rows) {
    await queueNotification({
      userId: d.id,
      type: 'task_assigned',
      content,
      meta,
    });
  }
}

async function insertTask({ title, description, assignedTo, assignedBy, dueDate }) {
  const { rows } = await query(
    `INSERT INTO tasks (title, description, assigned_to, assigned_by, due_date)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [title, description, assignedTo, assignedBy, dueDate || null]
  );
  return rows[0];
}

/** People the current user may assign tasks to */
router.get(
  '/assignees',
  requirePermission('tasks', 'create'),
  asyncHandler(async (req, res) => {
    const roles = allowedTargetRoles(req.user.role);
    if (!roles.length) {
      return res.json({ ok: true, data: [], meta: { roles: [] } });
    }
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.status = 'active' AND r.name = ANY($1::text[])
       ORDER BY r.name, u.name`,
      [roles]
    );
    // Always allow self
    if (!rows.some((u) => u.id === req.user.id)) {
      rows.unshift({
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
      });
    }
    res.json({
      ok: true,
      data: rows,
      meta: {
        roles,
        bulkRoles: ['director', 'admin', 'pm', 'finance'].includes(req.user.role)
          ? [...BULK_ROLES].filter((r) => roles.includes(r))
          : [],
      },
    });
  })
);

router.get(
  '/',
  requirePermission('tasks', 'view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const clauses = [];

    // Hubs (director / admin / pm) see the full board so PM-assigned work
    // appears for the PM, the assignee, and the director together.
    if (['sales', 'developer', 'finance', 'hr', 'client'].includes(req.user.role)) {
      params.push(req.user.id);
      clauses.push(`(t.assigned_to = $${params.length} OR t.assigned_by = $${params.length})`);
    } else if (req.query.assigned_to) {
      params.push(req.query.assigned_to);
      clauses.push(`t.assigned_to = $${params.length}`);
    } else if (req.query.mine === '1') {
      params.push(req.user.id);
      clauses.push(`(t.assigned_to = $${params.length} OR t.assigned_by = $${params.length})`);
    }

    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`t.status = $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT t.*,
              a.name AS assignee_name, ar.name AS assignee_role,
              b.name AS assigned_by_name, br.name AS assigned_by_role
       FROM tasks t
       JOIN users a ON a.id = t.assigned_to
       JOIN roles ar ON ar.id = a.role_id
       JOIN users b ON b.id = t.assigned_by
       JOIN roles br ON br.id = b.role_id
       ${where}
       ORDER BY t.due_date NULLS LAST, t.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/',
  requirePermission('tasks', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const {
      title,
      description,
      assigned_to,
      assigned_to_ids,
      assign_to_all_role,
      due_date,
    } = req.body || {};

    if (!title?.trim()) {
      throw new AppError('title is required', 400, 'VALIDATION');
    }

    const allowed = allowedTargetRoles(req.user.role);
    if (!allowed.length) {
      throw new AppError('Your role cannot create tasks', 403, 'FORBIDDEN');
    }

    const titleTrim = title.trim();
    const descTrim = (description || '').trim() || titleTrim;
    const due = due_date || null;

    /** Resolve target user ids */
    let targetIds = [];

    if (assign_to_all_role) {
      if (!['director', 'admin', 'pm'].includes(req.user.role)) {
        throw new AppError('Only Director, Admin, or PM can assign to a whole role', 403, 'FORBIDDEN');
      }
      if (!BULK_ROLES.has(assign_to_all_role) || !allowed.includes(assign_to_all_role)) {
        throw new AppError(`Cannot bulk-assign to role ${assign_to_all_role}`, 400, 'VALIDATION');
      }
      const { rows } = await query(
        `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.name = $1 AND u.status = 'active'`,
        [assign_to_all_role]
      );
      targetIds = rows.map((r) => r.id);
      if (!targetIds.length) {
        throw new AppError(`No active ${assign_to_all_role} users to assign`, 400, 'VALIDATION');
      }
    } else if (Array.isArray(assigned_to_ids) && assigned_to_ids.length) {
      targetIds = [...new Set(assigned_to_ids.filter(Boolean))];
    } else {
      targetIds = [assigned_to || req.user.id];
    }

    // Validate each target
    const { rows: targets } = await query(
      `SELECT u.id, u.name, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
      [targetIds]
    );
    if (targets.length !== targetIds.length) {
      throw new AppError('One or more assignees not found or inactive', 404, 'NOT_FOUND');
    }
    for (const t of targets) {
      const ok = t.id === req.user.id || allowed.includes(t.role);
      if (!ok) {
        throw new AppError(
          `You cannot assign tasks to role "${t.role}". Allowed: ${allowed.join(', ')}`,
          403,
          'FORBIDDEN'
        );
      }
    }

    const created = [];
    for (const t of targets) {
      const row = await insertTask({
        title: titleTrim,
        description: descTrim,
        assignedTo: t.id,
        assignedBy: req.user.id,
        dueDate: due,
      });
      created.push(row);

      if (t.id !== req.user.id) {
        await queueNotification({
          userId: t.id,
          type: 'task_assigned',
          content: `New task from ${req.user.name} (${req.user.role}): ${titleTrim}`,
        meta: { taskId: row.id, assignedByRole: req.user.role, href: '#/tasks' },
        });
      }
    }

    // Mirror on Director board via notification when PM (or others) assign
    if (req.user.role === 'pm' && created.length) {
      const who =
        assign_to_all_role
          ? `all ${assign_to_all_role}`
          : targets.map((t) => `${t.name} (${t.role})`).join(', ');
      await notifyDirectors({
        content: `PM ${req.user.name} assigned task "${titleTrim}" to ${who}`,
        meta: {
          taskIds: created.map((c) => c.id),
          assignedBy: req.user.id,
          href: '#/tasks',
        },
      });
    }

    // Record in audit trail
    for (const t of created) {
      await recordAction({
        actorId: req.user.id,
        actorRole: req.user.role,
        action: 'created',
        resourceType: 'task',
        resourceId: t.id,
        summary: `${req.user.name} created task "${title}" for ${t.assigned_to || 'self'}`,
        after: { title, description, assigned_to: t.assigned_to, due_date: t.due_date },
      });
    }

    res.status(201).json({
      ok: true,
      data: created.length === 1 ? created[0] : created,
      meta: { count: created.length },
    });
  })
);

router.patch(
  '/:id',
  requirePermission('tasks', 'edit'),
  asyncHandler(async (req, res) => {
    const { status, description, due_date, title, assigned_to } = req.body || {};
    const { rows: existing } = await query(`SELECT * FROM tasks WHERE id = $1`, [req.params.id]);
    const task = existing[0];
    if (!task) throw new AppError('Task not found', 404, 'NOT_FOUND');
    if (!canManageTask(req.user, task)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const sets = [];
    const params = [];
    if (title !== undefined) {
      params.push(title);
      sets.push(`title = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (due_date !== undefined) {
      params.push(due_date || null);
      sets.push(`due_date = $${params.length}`);
    }
    if (assigned_to !== undefined && ['admin', 'director', 'pm'].includes(req.user.role)) {
      const allowed = allowedTargetRoles(req.user.role);
      const { rows: next } = await query(
        `SELECT u.id, r.name AS role FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.status = 'active'`,
        [assigned_to]
      );
      if (!next[0]) throw new AppError('Assignee not found', 404, 'NOT_FOUND');
      if (next[0].id !== req.user.id && !allowed.includes(next[0].role)) {
        throw new AppError('Cannot reassign to that role', 403, 'FORBIDDEN');
      }
      params.push(assigned_to);
      sets.push(`assigned_to = $${params.length}`);
    }
    if (status !== undefined) {
      if (!['open', 'in_progress', 'done', 'cancelled'].includes(status)) {
        throw new AppError('Invalid status', 400, 'VALIDATION');
      }
      params.push(status);
      sets.push(`status = $${params.length}`);
    }
    if (!sets.length) throw new AppError('Nothing to update', 400, 'VALIDATION');
    params.push(req.params.id);

    const { rows } = await query(
      `UPDATE tasks SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );
    res.json({ ok: true, data: rows[0] });
  })
);

router.delete(
  '/:id',
  requirePermission('tasks', 'edit'),
  asyncHandler(async (req, res) => {
    const { rows: existing } = await query(`SELECT * FROM tasks WHERE id = $1`, [req.params.id]);
    const task = existing[0];
    if (!task) throw new AppError('Task not found', 404, 'NOT_FOUND');
    if (!canManageTask(req.user, task)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    await query(`DELETE FROM tasks WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  })
);

/**
 * Voice task capture: transcribe audio + parse into task fields.
 */
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post(
  '/voice-capture',
  requirePermission('tasks', 'create'),
  memUpload.single('audio'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('No audio file', 400, 'VALIDATION');

    const { text: transcript } = await transcribeAudio({
      buffer: req.file.buffer,
      filename: req.file.originalname || 'recording.webm',
      mimetype: req.file.mimetype || 'audio/webm',
    });

    let projects = [];
    try {
      if (['developer'].includes(req.user.role)) {
        const { rows } = await query(
          `SELECT p.id, p.name FROM projects p
           JOIN assignments a ON a.project_id = p.id
           WHERE a.user_id = $1 AND p.status != 'deleted'`,
          [req.user.id]
        );
        projects = rows;
      } else {
        const { rows } = await query(`SELECT id, name FROM projects WHERE status != 'deleted' ORDER BY name`);
        projects = rows;
      }
    } catch { /* proceed without projects */ }

    const projectCtx = projects.length
      ? `\n\nAvailable projects:\n${projects.map((p) => `- "${p.name}" (id: ${p.id})`).join('\n')}`
      : '';

    const { text } = await groqChat({
      messages: [
        { role: 'system', content: `You extract a task from a spoken description.
Return:
- "title": short task title (max 8 words).
- "description": 1-2 sentence description of what needs to be done.
- "due_date": ISO date (YYYY-MM-DD) if mentioned, or null.
- "project_name": project name if mentioned, or null.
- "project_id": matching project id from the list, or null.${projectCtx}

Respond with ONLY valid JSON:
{"title":"","description":"","due_date":null,"project_name":null,"project_id":null}` },
        { role: 'user', content: `Transcript:\n"""${transcript.slice(0, 8000)}"""` },
      ],
      temperature: 0.1,
    });

    const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch {
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
      if (s >= 0 && e > s) parsed = JSON.parse(cleaned.slice(s, e + 1));
      else throw new Error('AI returned unparseable JSON');
    }

    res.json({
      ok: true,
      data: {
        transcript,
        title: parsed.title || '',
        description: parsed.description || '',
        due_date: parsed.due_date || null,
        project_name: parsed.project_name || null,
        project_id: parsed.project_id || null,
      },
    });
  })
);

module.exports = router;
