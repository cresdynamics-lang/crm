const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

const PREF_COLUMNS = [
  'notify_project_update',
  'notify_invoice_paid',
  'notify_new_message',
  'notify_daily_report',
  'notify_system',
  'email_digest',
];

const avatarsDir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
fs.mkdirSync(avatarsDir, { recursive: true });

const AVATAR_MAX = 5 * 1024 * 1024;
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10) || '.jpg';
      cb(null, `${reqUserIdSafe(_req)}-${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
    },
  }),
  limits: { fileSize: AVATAR_MAX, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error('File type not allowed — use JPG, PNG, GIF, or WebP'), ok);
  },
});

function reqUserIdSafe(req) {
  return (req.user && req.user.id) || 'anon';
}

async function ensureSettings(userId) {
  await query(
    `INSERT INTO user_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const { rows } = await query(`SELECT * FROM user_settings WHERE user_id = $1`, [userId]);
  return rows[0];
}

function publicProfile(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    role: row.role,
    avatar_url: row.avatar_url || null,
  };
}

router.get(
  '/profile',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.avatar_url, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json({ ok: true, data: publicProfile(rows[0]) });
  })
);

router.patch(
  '/profile',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    const { name, phone } = req.body || {};
    if (!name?.trim()) throw new AppError('name is required', 400, 'VALIDATION');

    const { rows } = await query(
      `UPDATE users SET name = $1, phone = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, email, phone, status, avatar_url`,
      [name.trim(), phone?.trim() || null, req.user.id]
    );
    res.json({ ok: true, data: { ...rows[0], role: req.user.role } });
  })
);

router.post(
  '/avatar',
  requirePermission('settings', 'view'),
  (req, res, next) => {
    avatarUpload.single('avatar')(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('Choose a profile picture', 400, 'VALIDATION');
    const avatar_url = `/uploads/avatars/${req.file.filename}`;

    const { rows: prev } = await query(`SELECT avatar_url FROM users WHERE id = $1`, [req.user.id]);
    const old = prev[0]?.avatar_url;
    if (old && old.startsWith('/uploads/avatars/')) {
      const oldPath = path.join(__dirname, '..', '..', old.replace(/^\//, ''));
      fs.unlink(oldPath, () => {});
    }

    const { rows } = await query(
      `UPDATE users SET avatar_url = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, phone, status, avatar_url`,
      [avatar_url, req.user.id]
    );
    res.json({ ok: true, data: { ...rows[0], role: req.user.role } });
  })
);

router.delete(
  '/avatar',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    const { rows: prev } = await query(`SELECT avatar_url FROM users WHERE id = $1`, [req.user.id]);
    const old = prev[0]?.avatar_url;
    if (old && old.startsWith('/uploads/avatars/')) {
      const oldPath = path.join(__dirname, '..', '..', old.replace(/^\//, ''));
      fs.unlink(oldPath, () => {});
    }
    const { rows } = await query(
      `UPDATE users SET avatar_url = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, email, phone, status, avatar_url`,
      [req.user.id]
    );
    res.json({ ok: true, data: { ...rows[0], role: req.user.role } });
  })
);

router.post(
  '/password',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      throw new AppError('currentPassword and newPassword required', 400, 'VALIDATION');
    }
    if (String(newPassword).length < 8) {
      throw new AppError('New password must be at least 8 characters', 400, 'VALIDATION');
    }

    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) throw new AppError('Current password is incorrect', 400, 'AUTH_INVALID');

    const hash = await bcrypt.hash(newPassword, 10);
    await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, req.user.id]
    );
    res.json({ ok: true, data: { changed: true } });
  })
);

router.get(
  '/notifications',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    const settings = await ensureSettings(req.user.id);
    res.json({ ok: true, data: settings });
  })
);

router.patch(
  '/notifications',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    await ensureSettings(req.user.id);
    const sets = [];
    const params = [];
    for (const col of PREF_COLUMNS) {
      if (typeof req.body?.[col] === 'boolean') {
        params.push(req.body[col]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw new AppError('No preference fields to update', 400, 'VALIDATION');
    params.push(req.user.id);
    const { rows } = await query(
      `UPDATE user_settings SET ${sets.join(', ')}, updated_at = NOW()
       WHERE user_id = $${params.length}
       RETURNING *`,
      params
    );
    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
