const express = require('express');
const { query: db } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { healthCheck: dbHealth } = require('../config/database');
const { healthCheck: redisHealth } = require('../config/redis');
const { healthCheck: queueHealth } = require('../queues');

const router = express.Router();

/**
 * Aggregate + per-group health.
 * Dashboard shell uses these to show graceful degradation (e.g. chat unavailable).
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [database, redis, queues] = await Promise.all([
      dbHealth(),
      redisHealth(),
      queueHealth(),
    ]);

    const groups = {
      auth: { status: 'up' },
      users: { status: database.status },
      leads: { status: database.status },
      clients: { status: database.status },
      projects: { status: database.status },
      invoices: { status: database.status },
      payments: { status: database.status },
      expenses: { status: database.status },
      salaries: { status: database.status },
      notifications: { status: database.status === 'up' && queues.status === 'up' ? 'up' : 'degraded' },
      messages: { status: database.status === 'up' ? 'up' : 'down' },
      reports: { status: database.status },
      query: { status: database.status },
      queues: queues,
      redis,
      database,
    };

    const criticalDown = database.status !== 'up';
    res.status(criticalDown ? 503 : 200).json({
      ok: !criticalDown,
      data: {
        status: criticalDown ? 'down' : redis.status !== 'up' ? 'degraded' : 'up',
        groups,
        checkedAt: new Date().toISOString(),
      },
    });
  })
);

router.get(
  '/groups/:group',
  asyncHandler(async (req, res) => {
    const group = req.params.group;
    const database = await dbHealth();
    const redis = await redisHealth();
    const queues = await queueHealth();

    const map = {
      database,
      redis,
      queues,
      messages: { status: database.status },
      notifications: {
        status: database.status === 'up' && queues.status === 'up' ? 'up' : 'degraded',
      },
      invoices: { status: database.status },
      auth: { status: 'up' },
    };

    const result = map[group] || { status: 'unknown' };
    res.status(result.status === 'down' ? 503 : 200).json({ ok: result.status !== 'down', data: result });
  })
);

router.get(
  '/failed-jobs',
  authenticate,
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    if (!['admin', 'finance'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { rows } = await db(
      `SELECT * FROM failed_jobs ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ ok: true, data: rows });
  })
);

module.exports = router;
