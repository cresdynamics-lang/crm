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
    const unreadOnly = req.query.unread === 'true' || req.query.filter === 'unread';
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const params = [req.user.id];
    let where = 'WHERE user_id = $1';
    if (unreadOnly) where += ' AND read_at IS NULL';

    const { rows } = await query(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );
    // The real unread total (the list is capped at 100, the count is not)
    const { rows: c } = await query(
      `SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: rows, meta: { unread: c[0].unread } });
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
