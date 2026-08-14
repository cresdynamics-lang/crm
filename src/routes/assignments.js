const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const {
  assignDeveloper,
  acceptAssignment,
  rejectAssignment,
  swapAssignment,
  listForDeveloper,
  historyForProject,
} = require('../services/assignments');
const { query } = require('../config/database');

const router = express.Router();
router.use(authenticate);

/** Developer: pending invitations */
router.get(
  '/pending',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'developer' && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const developerId = req.user.role === 'admin' && req.query.developer_id
      ? req.query.developer_id
      : req.user.id;
    const rows = await listForDeveloper(developerId);
    res.json({ ok: true, data: rows });
  })
);

/** Assignment history for a project (Sales/PM/Admin/Director) */
router.get(
  '/project/:projectId',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (['developer', 'finance', 'client', 'hr'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    if (req.user.role === 'sales') {
      const { rows } = await query(
        `SELECT created_by FROM projects WHERE id = $1`,
        [req.params.projectId]
      );
      if (!rows[0] || rows[0].created_by !== req.user.id) {
        throw new AppError('Forbidden', 403, 'FORBIDDEN');
      }
    }
    const rows = await historyForProject(req.params.projectId);
    res.json({ ok: true, data: rows });
  })
);

/** Sales/Admin (re)assign after approval or after rejection */
router.post(
  '/',
  requireAnyPermission([['projects', 'create'], ['projects', 'edit']]),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['sales', 'admin', 'pm'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { project_id, developer_id, note } = req.body || {};
    if (!project_id || !developer_id) {
      throw new AppError('project_id and developer_id required', 400, 'VALIDATION');
    }
    const { rows: projects } = await query(`SELECT * FROM projects WHERE id = $1`, [project_id]);
    const p = projects[0];
    if (!p) throw new AppError('Project not found', 404, 'NOT_FOUND');
    if (['pending_approval', 'rejected'].includes(p.status)) {
      throw new AppError('Assign after Director approval', 409, 'INVALID_STATE');
    }
    if (req.user.role === 'sales' && p.created_by !== req.user.id) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const row = await assignDeveloper({
      projectId: project_id,
      developerId: developer_id,
      assignedBy: req.user.id,
      actorRole: req.user.role,
      note: note || null,
    });
    res.status(201).json({ ok: true, data: row });
  })
);

router.post(
  '/:id/accept',
  requirePermission('projects', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'developer') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const row = await acceptAssignment({
      assignmentId: req.params.id,
      developerId: req.user.id,
      actorRole: req.user.role,
    });
    res.json({ ok: true, data: row });
  })
);

router.post(
  '/:id/reject',
  requirePermission('projects', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'developer') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const row = await rejectAssignment({
      assignmentId: req.params.id,
      developerId: req.user.id,
      actorRole: req.user.role,
      note: req.body?.note || null,
    });
    res.json({ ok: true, data: row });
  })
);

router.post(
  '/:id/swap',
  requirePermission('projects', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'developer') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const nominate = req.body?.developer_id;
    if (!nominate) throw new AppError('developer_id required for swap', 400, 'VALIDATION');
    const row = await swapAssignment({
      assignmentId: req.params.id,
      developerId: req.user.id,
      nominateDeveloperId: nominate,
      actorRole: req.user.role,
      note: req.body?.note || null,
    });
    res.status(201).json({ ok: true, data: row });
  })
);

module.exports = router;
