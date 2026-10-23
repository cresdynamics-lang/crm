/**
 * Admin health endpoints.
 * live     - immediate system/website/CRM snapshot (no DB write)
 * overview - latest persisted snapshot + rolling history from health_snapshots
 */
const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../lib/errors');
const { computeAll } = require('../services/healthSampler');

const router = express.Router();
router.use(authenticate);

function assertAdmin(req) {
  if (req.user.role !== 'admin') {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

router.get(
  '/live',
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    res.json({ ok: true, data: await computeAll() });
  })
);

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows: history } = await query(
      `SELECT category, name, status, latency_ms, detail, checked_at
       FROM health_snapshots
       WHERE checked_at >= now() - interval '2 hours'
       ORDER BY checked_at DESC
       LIMIT 800`
    );
    const { rows: latest } = await query(
      `SELECT DISTINCT ON (name) name, category, status, latency_ms, detail, checked_at
       FROM health_snapshots
       ORDER BY name, checked_at DESC`
    );
    res.json({
      ok: true,
      data: {
        latest: latest.map((r) => ({
          name: r.name,
          category: r.category,
          status: r.status,
          latencyMs: r.latency_ms,
          checkedAt: r.checked_at,
          detail: r.detail,
        })),
        history: history.map((r) => ({
          category: r.category,
          name: r.name,
          status: r.status,
          latencyMs: r.latency_ms,
          checkedAt: r.checked_at,
        })),
      },
    });
  })
);

module.exports = router;