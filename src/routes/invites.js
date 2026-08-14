const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { enqueue } = require('../queues');

const router = express.Router();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Admin/HR invite user - no password set by admin; email invite link.
 */
router.post(
  '/invite',
  authenticate,
  requirePermission('users', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['admin', 'hr'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { name, email, phone, role } = req.body || {};
    if (!name?.trim() || !email?.trim() || !role) {
      throw new AppError('name, email, and role required', 400, 'VALIDATION');
    }

    const { rows: roles } = await query(`SELECT id FROM roles WHERE name = $1`, [role]);
    if (!roles[0]) throw new AppError('Unknown role', 400, 'VALIDATION');

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // Placeholder hash - user cannot login until they accept invite
    const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);

    const { rows } = await query(
      `INSERT INTO users
        (name, email, phone, password_hash, role_id, status, invite_token_hash, invite_expires_at, must_set_password)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, TRUE)
       RETURNING id, name, email, phone, status`,
      [name.trim(), email.trim().toLowerCase(), phone || null, placeholder, roles[0].id, tokenHash, expiresAt]
    );

    const acceptUrl = `${req.protocol}://${req.get('host')}/login?invite=${rawToken}`;
    await enqueue('email', 'user.invite', {
      email: rows[0].email,
      name: rows[0].name,
      acceptUrl,
      expiresAt: expiresAt.toISOString(),
    });

    res.status(201).json({
      ok: true,
      data: { ...rows[0], role },
      meta: { inviteQueued: true, note: 'Invite email queued - Admin never sees the final password' },
    });
  })
);

/** Public: accept invite and set password */
router.post(
  '/accept-invite',
  asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 8) {
      throw new AppError('token and password (min 8) required', 400, 'VALIDATION');
    }
    const tokenHash = hashToken(token);
    const { rows } = await query(
      `SELECT * FROM users
       WHERE invite_token_hash = $1
         AND invite_expires_at > NOW()
         AND must_set_password = TRUE`,
      [tokenHash]
    );
    if (!rows[0]) throw new AppError('Invalid or expired invite', 400, 'INVITE_INVALID');

    const hash = await bcrypt.hash(password, 10);
    await query(
      `UPDATE users
       SET password_hash = $1, invite_token_hash = NULL, invite_expires_at = NULL,
           must_set_password = FALSE, updated_at = NOW()
       WHERE id = $2`,
      [hash, rows[0].id]
    );
    res.json({ ok: true, data: { accepted: true, email: rows[0].email } });
  })
);

router.get(
  '/login-audit',
  authenticate,
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const { rows } = await query(
      `SELECT la.*, u.name AS user_name
       FROM login_audit la
       LEFT JOIN users u ON u.id = la.user_id
       ORDER BY la.created_at DESC
       LIMIT 200`
    );
    res.json({ ok: true, data: rows });
  })
);

module.exports = router;
