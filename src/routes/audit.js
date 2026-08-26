/**
 * Audit log routes — Data Pool / RAG system endpoint.
 * Directors and Admins can query the full audit trail.
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler } = require('../lib/errors');
const { queryAudit } = require('../services/actionAudit');

const router = express.Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['director', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Director or Admin only' } });
    }

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await queryAudit({
      resourceType: req.query.resource_type || null,
      resourceId: req.query.resource_id || null,
      actorId: req.query.actor_id || null,
      action: req.query.action || null,
      limit,
      offset,
    });

    res.json({ ok: true, data: rows, meta: { limit, offset } });
  })
);

module.exports = router;
