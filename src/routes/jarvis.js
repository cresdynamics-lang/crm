/**
 * Jarvis side panel — capabilities + ask.
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../lib/errors');
const config = require('../config');
const { askJarvis, allowedEndpoints } = require('../services/jarvisAssistant');
const { gatherCompanyBrief } = require('../services/jarvisBriefing');

const router = express.Router();
router.use(authenticate);

const hits = new Map();

function assertRateLimit(userId) {
  const limit = Number(process.env.JARVIS_CRM_RATE_PER_HOUR) || 40;
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (hits.get(userId) || []).filter((ts) => now - ts < windowMs);
  if (recent.length >= limit) {
    throw new AppError('Too many Jarvis questions this hour. Try again later.', 429, 'RATE_LIMIT');
  }
  recent.push(now);
  hits.set(userId, recent);
}

router.get(
  '/capabilities',
  asyncHandler(async (req, res) => {
    const topics = allowedEndpoints(req.user).map((e) => ({ id: e.id, desc: e.desc }));
    if (['admin', 'director'].includes(req.user.role)) {
      topics.unshift({
        id: 'company_brief',
        desc:
          req.user.role === 'admin'
            ? 'Full company snapshot including finance'
            : 'Company snapshot: operations, pending invoices, cleared receipts (no books)',
      });
    }
    res.json({
      ok: true,
      data: {
        enabled: Boolean(config.openRouter.apiKey),
        topics,
        financeScope: req.user.role === 'admin' ? 'full' : req.user.role === 'director' ? 'receipts_and_pending_invoices' : 'role_scoped',
      },
    });
  })
);

router.get(
  '/briefing',
  asyncHandler(async (req, res) => {
    if (!['admin', 'director'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const data = await gatherCompanyBrief(req.user);
    res.json({ ok: true, data });
  })
);

router.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) throw new AppError('message is required', 400, 'VALIDATION');
    if (!config.openRouter.apiKey) {
      throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
    }

    assertRateLimit(req.user.id);

    const result = await askJarvis({
      user: req.user,
      authHeader: req.headers.authorization,
      message,
      history: req.body?.history,
    });

    res.json({ ok: true, data: { answer: result.answer, used: result.used } });
  })
);

module.exports = router;
