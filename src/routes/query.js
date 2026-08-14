const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler } = require('../lib/errors');
const { runQuery, listResources, RESOURCES } = require('../services/queryService');

const router = express.Router();
router.use(authenticate);
router.use(requirePermission('query', 'view'));

/**
 * GET /api/query
 * Lists resources the current role may fetch (AI agent discovery).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const available = listResources(req.user);
    const catalog = available.map((name) => ({
      resource: name,
      filters: RESOURCES[name]
        ? Object.keys(RESOURCES[name].filters || {})
        : [],
      endpoint: `/api/query/${name}`,
    }));
    res.json({
      ok: true,
      data: {
        role: req.user.role,
        resources: catalog,
        note: 'All queries enforce the same RBAC as domain APIs. Structured JSON only.',
      },
    });
  })
);

/**
 * GET /api/query/:resource?status=&date_from=&date_to=&...
 * AI-parseable filtered fetch. Example:
 *   /api/query/projects?status=in_progress&assigned_developer=&date_from=&date_to=
 */
router.get(
  '/:resource',
  asyncHandler(async (req, res) => {
    const result = await runQuery(req.params.resource, req.user, req.query);
    res.json({ ok: true, data: result });
  })
);

/**
 * POST /api/query/:resource
 * Same filters via JSON body (better for complex AI agent calls).
 */
router.post(
  '/:resource',
  asyncHandler(async (req, res) => {
    const filters = { ...(req.body || {}), ...(req.query || {}) };
    const result = await runQuery(req.params.resource, req.user, filters);
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
