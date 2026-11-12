/** Public: the private "see your login password" page behind the welcome email link. */
const express = require('express');
const { asyncHandler, AppError } = require('../lib/errors');
const { clientIp } = require('../middleware/authLimiter');
const cr = require('../services/credentialReveal');

const router = express.Router();
const hits = new Map(); // ip -> { n, until }

/** 40 looks per 15 minutes per address: a link cannot be guessed (256-bit), this just stops hammering. */
function limit(req, _res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.until < now) hits.set(ip, { n: 1, until: now + 15 * 60 * 1000 });
  else if (++h.n > 40) return next(new AppError('Too many attempts. Wait a few minutes.', 429, 'TOO_MANY_ATTEMPTS'));
  if (hits.size > 5000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  return next();
}

router.use(limit);

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: await cr.status(req.params.token) });
  })
);

router.post(
  '/:token/reveal',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: await cr.reveal(req.params.token) });
  })
);

module.exports = router;
