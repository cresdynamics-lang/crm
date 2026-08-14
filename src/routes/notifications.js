const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);
router.use(requirePermission('notifications', 'view'));

/**
 * Finance uses this feed instead of Community chat.
 * All roles with notifications:view can read their own.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    const params = [req.user.id];
    let where = 'WHERE user_id = $1';
    if (unreadOnly) where += ' AND read_at IS NULL';

    const { rows } = await query(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE notifications SET read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) throw new AppError('Notification not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ ok: true, data: { readAll: true } });
  })
);

module.exports = router;
