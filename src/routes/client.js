const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

const docsDir = path.join(__dirname, '..', '..', 'uploads', 'documents');
fs.mkdirSync(docsDir, { recursive: true });

const DELIVERABLE_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_MIME = /^(image\/(jpeg|jpg|png|gif|webp|heic|heif)|video\/(mp4|webm|quicktime|x-m4v))$/i;
const SHARED_MIME =
  /^(image\/|video\/(mp4|webm|quicktime|x-m4v)|application\/pdf|text\/plain|application\/msword|application\/vnd)/i;

const docUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, docsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 20) || '';
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: DELIVERABLE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = SHARED_MIME.test(file.mimetype);
    cb(
      ok
        ? null
        : new Error(
            'File type not allowed — use a screenshot (JPG/PNG/WebP) or short video (MP4/WebM) under 20 MB'
          ),
      ok
    );
  },
});

function assertClient(req) {
  if (req.user.role !== 'client') {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

function milestoneProgress(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  if (!list.length) return 0;
  const done = list.filter((m) => {
    const s = (m.status || '').toLowerCase();
    return s === 'completed';
  }).length;
  return Math.round((done / list.length) * 100);
}

function publicMilestones(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  return list.map((m) => ({
    title: m.title || m.name || 'Milestone',
    status: (m.status === 'pending' ? 'not_started' : m.status) || 'not_started',
    due_date: m.due_date || null,
  }));
}

async function clientRecordIds(user) {
  const { rows } = await query(
    `SELECT id FROM clients WHERE user_id = $1 OR email = $2`,
    [user.id, user.email]
  );
  return rows.map((r) => r.id);
}

async function assertOwnsProject(user, projectId) {
  const ids = await clientRecordIds(user);
  if (!ids.length) throw new AppError('No client profile linked', 404, 'NOT_FOUND');
  const { rows } = await query(
    `SELECT p.id, p.name, p.status, p.milestones, p.summary, p.updated_at, p.approved_at, p.client_id, p.preview_url
     FROM projects p
     WHERE p.id = $1
       AND p.client_id = ANY($2::uuid[])
       AND p.status NOT IN ('pending_approval', 'rejected')`,
    [projectId, ids]
  );
  if (!rows[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');
  return rows[0];
}

/**
 * Client portal dashboard - own projects only, no money/accounts.
 */
router.get(
  '/dashboard',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const ids = await clientRecordIds(req.user);
    if (!ids.length) {
      return res.json({
        ok: true,
        data: { kpis: { projectCount: 0, activeCount: 0, avgProgress: 0 }, projects: [] },
      });
    }

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.updated_at
       FROM projects p
       WHERE p.client_id = ANY($1::uuid[])
         AND p.status NOT IN ('pending_approval', 'rejected')
       ORDER BY p.updated_at DESC`,
      [ids]
    );

    const projects = rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      progress_pct: milestoneProgress(p.milestones),
      updated_at: p.updated_at,
    }));

    const active = projects.filter((p) =>
      ['approved', 'in_progress', 'blocked'].includes(p.status)
    );
    const avgProgress = projects.length
      ? Math.round(projects.reduce((s, p) => s + p.progress_pct, 0) / projects.length)
      : 0;

    res.json({
      ok: true,
      data: {
        kpis: {
          projectCount: projects.length,
          activeCount: active.length,
          avgProgress,
          completedCount: projects.filter((p) => p.status === 'completed').length,
        },
        projects,
      },
    });
  })
);

router.get(
  '/projects',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const ids = await clientRecordIds(req.user);
    if (!ids.length) return res.json({ ok: true, data: [] });

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.milestones, p.updated_at, p.approved_at, p.preview_url
       FROM projects p
       WHERE p.client_id = ANY($1::uuid[])
         AND p.status NOT IN ('pending_approval', 'rejected')
       ORDER BY p.updated_at DESC`,
      [ids]
    );

    res.json({
      ok: true,
      data: rows.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        progress_pct: milestoneProgress(p.milestones),
        milestones: publicMilestones(p.milestones),
        preview_url: p.preview_url || null,
        updated_at: p.updated_at,
        approved_at: p.approved_at,
      })),
    });
  })
);

/**
 * Project detail / timeline - milestones only.
 * No internal notes, no assigned developer identity, no value_amount.
 */
router.get(
  '/projects/:id',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const p = await assertOwnsProject(req.user, req.params.id);
    const milestones = publicMilestones(p.milestones);

    const { rows: docs } = await query(
      `SELECT id, title, file_path, original_name, mime_type, file_size, created_at, kind, milestone_title
       FROM project_documents
       WHERE project_id = $1 AND shared_with_client = TRUE
       ORDER BY created_at DESC`,
      [p.id]
    );

    const { rows: signoffs } = await query(
      `SELECT milestone_title, status, client_note, decided_at
       FROM milestone_signoffs WHERE project_id = $1`,
      [p.id]
    );
    const signoffByTitle = Object.fromEntries(signoffs.map((s) => [s.milestone_title, s]));
    const milestonesWithSignoff = milestones.map((m) => ({
      ...m,
      signoff: signoffByTitle[m.title] || null,
    }));

    res.json({
      ok: true,
      data: {
        project: {
          id: p.id,
          name: p.name,
          status: p.status,
          summary: p.summary || null,
          progress_pct: milestoneProgress(p.milestones),
          milestones: milestonesWithSignoff,
          preview_url: p.preview_url || null,
          updated_at: p.updated_at,
          approved_at: p.approved_at,
        },
        documents: docs,
      },
    });
  })
);

router.get(
  '/invoices',
  requirePermission('invoices', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const { rows } = await query(
      `SELECT i.id, i.amount, i.status, i.created_at, i.updated_at, i.auto_sent_at,
              p.id AS project_id, p.name AS project_name
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       LEFT JOIN projects p ON p.id = i.project_id
       WHERE c.user_id = $1 OR c.email = $2
       ORDER BY i.created_at DESC`,
      [req.user.id, req.user.email]
    );
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/documents',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const ids = await clientRecordIds(req.user);
    if (!ids.length) return res.json({ ok: true, data: [] });

    const params = [ids];
    let projectFilter = '';
    if (req.query.project_id) {
      params.push(req.query.project_id);
      projectFilter = `AND d.project_id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT d.id, d.title, d.file_path, d.original_name, d.mime_type, d.file_size, d.created_at,
              p.id AS project_id, p.name AS project_name
       FROM project_documents d
       JOIN projects p ON p.id = d.project_id
       WHERE p.client_id = ANY($1::uuid[])
         AND d.shared_with_client = TRUE
         AND p.status NOT IN ('pending_approval', 'rejected')
         ${projectFilter}
       ORDER BY d.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

/**
 * Staff upload of a document shared to the client portal.
 * Sales / PM / Admin (not the client).
 */
router.post(
  '/documents',
  requireAnyPermission([['projects', 'create'], ['projects', 'edit']]),
  docUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'client') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const project_id = req.body?.project_id;
    const title = (req.body?.title || req.file?.originalname || 'Document').trim();
    if (!project_id || !req.file) {
      throw new AppError('project_id and file required', 400, 'VALIDATION');
    }
    const file_path = `/uploads/documents/${req.file.filename}`;
    const kind = req.body?.kind === 'deliverable' ? 'deliverable' : 'shared';
    const milestone_title = (req.body?.milestone_title || '').trim() || null;
    const shared = req.body?.shared_with_client === 'false' ? false : true;

    if (kind === 'deliverable' && !milestone_title) {
      throw new AppError('Select a milestone for this deliverable', 400, 'VALIDATION');
    }
    if (kind === 'deliverable' && !title) {
      throw new AppError('Title is required', 400, 'VALIDATION');
    }
    if (kind === 'deliverable' && !MEDIA_MIME.test(req.file.mimetype)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      throw new AppError(
        'Deliverables must be a screenshot (JPG/PNG/WebP) or short video (MP4/WebM), max 20 MB',
        400,
        'VALIDATION'
      );
    }

    // Developers may upload deliverables on assigned projects
    if (req.user.role === 'developer') {
      const { rows: owned } = await query(
        `SELECT id FROM projects WHERE id = $1 AND assigned_developer_id = $2
           AND status NOT IN ('pending_approval', 'rejected')`,
        [project_id, req.user.id]
      );
      if (!owned[0]) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    } else if (!['sales', 'pm', 'admin', 'director'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows: projects } = await query(
      `SELECT id FROM projects WHERE id = $1 AND status NOT IN ('pending_approval', 'rejected')`,
      [project_id]
    );
    if (!projects[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');

    const { rows } = await query(
      `INSERT INTO project_documents
        (project_id, title, file_path, original_name, mime_type, file_size, shared_with_client, uploaded_by, kind, milestone_title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        project_id,
        title,
        file_path,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        kind === 'deliverable' ? shared : true,
        req.user.id,
        kind,
        milestone_title,
      ]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/** Client: approve or request changes on a milestone */
router.post(
  '/projects/:id/signoffs',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const p = await assertOwnsProject(req.user, req.params.id);
    const milestone_title = (req.body?.milestone_title || '').trim();
    const status = req.body?.status;
    const client_note = (req.body?.client_note || '').trim() || null;
    if (!milestone_title || !['approved', 'changes_requested'].includes(status)) {
      throw new AppError('milestone_title and status (approved|changes_requested) required', 400, 'VALIDATION');
    }

    const { rows } = await query(
      `INSERT INTO milestone_signoffs (project_id, milestone_title, status, client_note, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (project_id, milestone_title) DO UPDATE
         SET status = EXCLUDED.status,
             client_note = EXCLUDED.client_note,
             decided_by = EXCLUDED.decided_by,
             decided_at = NOW()
       RETURNING *`,
      [p.id, milestone_title, status, client_note, req.user.id]
    );

    const { queueNotification } = require('../queues/jobs');
    const { rows: staff } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('sales', 'pm', 'director', 'admin') AND u.status = 'active'`
    );
    for (const s of staff) {
      await queueNotification({
        userId: s.id,
        type: 'milestone_signoff',
        content: `Client ${status.replace(/_/g, ' ')} milestone "${milestone_title}" on ${p.name}`,
        meta: { projectId: p.id, signoffId: rows[0].id },
      });
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/** Client change request - no Community; notifies Sales */
router.post(
  '/change-requests',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    assertClient(req);
    const { project_id, subject, details } = req.body || {};
    if (!project_id || !subject?.trim() || !details?.trim()) {
      throw new AppError('project_id, subject, details required', 400, 'VALIDATION');
    }
    await assertOwnsProject(req.user, project_id);

    const { rows } = await query(
      `INSERT INTO client_change_requests (project_id, client_user_id, subject, details)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [project_id, req.user.id, subject.trim(), details.trim()]
    );

    const { queueNotification } = require('../queues/jobs');
    const { rows: sales } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('sales', 'pm', 'admin') AND u.status = 'active'`
    );
    for (const s of sales) {
      await queueNotification({
        userId: s.id,
        type: 'client_change_request',
        content: `Client change request: ${subject.trim()}`,
        meta: { changeRequestId: rows[0].id, projectId: project_id },
      });
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/change-requests',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'client') {
      const { rows } = await query(
        `SELECT cr.*, p.name AS project_name
         FROM client_change_requests cr
         JOIN projects p ON p.id = cr.project_id
         WHERE cr.client_user_id = $1
         ORDER BY cr.created_at DESC`,
        [req.user.id]
      );
      return res.json({ ok: true, data: rows });
    }
    if (!['sales', 'pm', 'admin', 'director'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { rows } = await query(
      `SELECT cr.*, p.name AS project_name, u.name AS client_name
       FROM client_change_requests cr
       JOIN projects p ON p.id = cr.project_id
       JOIN users u ON u.id = cr.client_user_id
       ORDER BY cr.created_at DESC
       LIMIT 100`
    );
    res.json({ ok: true, data: rows });
  })
);

module.exports = router;
