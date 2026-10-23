const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { removeStaffUser } = require('../services/staffRemoval');

const router = express.Router();
router.use(authenticate);

/** Assignable developers for project create - sales with projects:create may list */
router.get(
  '/developers',
  requireAnyPermission([['projects', 'create'], ['users', 'view'], ['tasks', 'create'], ['reports', 'view']]),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'developer' AND u.status = 'active'
       ORDER BY u.name`
    );
    res.json({ ok: true, data: rows });
  })
);

/** Sales reps for Finance invoice follow-up assignment */
router.get(
  '/sales',
  requireAnyPermission([['invoice_followups', 'create'], ['users', 'view'], ['tasks', 'create'], ['reports', 'view']]),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'sales' AND u.status = 'active'
       ORDER BY u.name`
    );
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    const { role, status } = req.query;
    const params = [];
    const clauses = [];

    if (status && status !== 'all') {
      params.push(status);
      clauses.push(`u.status = $${params.length}`);
    }
    if (role) {
      params.push(role);
      clauses.push(`r.name = $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, u.updated_at, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       ${where}
       ORDER BY u.name ASC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/roles',
  requirePermission('users', 'view'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(`SELECT id, name, description FROM roles ORDER BY name`);
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/',
  requirePermission('users', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { name, email, phone, password, role } = req.body || {};
    if (!name || !email || !password || !role) {
      throw new AppError('name, email, password, role required', 400, 'VALIDATION');
    }
    const { rows: roles } = await query(`SELECT id FROM roles WHERE name = $1`, [role]);
    if (!roles[0]) throw new AppError('Unknown role', 400, 'VALIDATION');

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (name, email, phone, password_hash, role_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, status, created_at`,
      [name, email, phone || null, passwordHash, roles[0].id]
    );
    res.status(201).json({ ok: true, data: { ...rows[0], role } });
  })
);

router.patch(
  '/:id/role',
  requirePermission('users', 'edit'),
  asyncHandler(async (req, res) => {
    const { role } = req.body || {};
    const { rows: roles } = await query(`SELECT id FROM roles WHERE name = $1`, [role]);
    if (!roles[0]) throw new AppError('Unknown role', 400, 'VALIDATION');

    if (req.params.id === req.user.id && role !== 'admin') {
      throw new AppError('Cannot demote your own admin role', 400, 'VALIDATION');
    }

    const { rows } = await query(
      `UPDATE users SET role_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, phone, status`,
      [roles[0].id, req.params.id]
    );
    if (!rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');
    res.json({
      ok: true,
      data: { ...rows[0], role },
      meta: { note: 'Role takes effect on the user next authenticated request (DB re-verify)' },
    });
  })
);

/**
 * Edit user profile fields + status. Role may be included (same immediate effect).
 */
router.patch(
  '/:id',
  requirePermission('users', 'edit'),
  asyncHandler(async (req, res) => {
    const { name, phone, email, status, role, password } = req.body || {};
    const { rows: existing } = await query(
      `SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [req.params.id]
    );
    if (!existing[0]) throw new AppError('User not found', 404, 'NOT_FOUND');

    if (status && !['active', 'inactive'].includes(status)) {
      throw new AppError('status must be active or inactive', 400, 'VALIDATION');
    }
    if (req.params.id === req.user.id && status === 'inactive') {
      throw new AppError('Cannot deactivate your own account', 400, 'VALIDATION');
    }
    if (req.params.id === req.user.id && role && role !== 'admin') {
      throw new AppError('Cannot demote your own admin role', 400, 'VALIDATION');
    }

    let roleId = null;
    if (role) {
      const { rows: roles } = await query(`SELECT id FROM roles WHERE name = $1`, [role]);
      if (!roles[0]) throw new AppError('Unknown role', 400, 'VALIDATION');
      roleId = roles[0].id;
    }

    const sets = [];
    const params = [];
    if (name !== undefined) {
      params.push(name.trim());
      sets.push(`name = $${params.length}`);
    }
    if (phone !== undefined) {
      params.push(phone || null);
      sets.push(`phone = $${params.length}`);
    }
    if (email !== undefined) {
      params.push(email.trim().toLowerCase());
      sets.push(`email = $${params.length}`);
    }
    if (status !== undefined) {
      params.push(status);
      sets.push(`status = $${params.length}`);
    }
    if (roleId) {
      params.push(roleId);
      sets.push(`role_id = $${params.length}`);
    }
    if (password) {
      if (String(password).length < 8) {
        throw new AppError('Password must be at least 8 characters', 400, 'VALIDATION');
      }
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      sets.push(`password_hash = $${params.length}`);
    }
    if (!sets.length) throw new AppError('No fields to update', 400, 'VALIDATION');

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING id, name, email, phone, status, created_at, updated_at`,
      params
    );

    const { rows: joined } = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, u.updated_at, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [rows[0].id]
    );

    res.json({
      ok: true,
      data: joined[0],
      meta: role
        ? { note: 'Role takes effect on the user next authenticated request (DB re-verify)' }
        : undefined,
    });
  })
);

router.delete(
  '/:id',
  requireAnyPermission([['users', 'delete'], ['users', 'edit'], ['employees', 'edit']]),
  asyncHandler(async (req, res) => {
    const data = await removeStaffUser(req.user, req.params.id, {
      reason: req.body?.reason || req.query?.reason,
    });
    res.json({ ok: true, data });
  })
);

module.exports = router;
