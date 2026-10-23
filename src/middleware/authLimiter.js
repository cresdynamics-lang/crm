/**
 * Brute-force protection for sign-in and password reset.
 *
 * Counts failures per (email + IP) and per IP in Redis, so limits survive
 * restarts and hold across several server processes. If Redis is down it
 * falls back to memory rather than letting everything through.
 *
 *   per email + IP : 5 failures  -> locked 15 minutes
 *   per IP         : 30 failures -> locked 15 minutes (spraying many emails)
 */
const { AppError } = require('../lib/errors');
const { getRedis } = require('../config/redis');

const WINDOW_SEC = 15 * 60;
const memory = new Map(); // key -> { count, until }

function clientIp(req) {
  return req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || 'unknown';
}

function memoryCount(key) {
  const m = memory.get(key);
  return m && m.until >= Date.now() ? m.count : 0;
}

/** Failures so far: the higher of Redis and memory (memory holds any counted while Redis was down). */
async function count(key) {
  let fromRedis = 0;
  try {
    const r = getRedis();
    if (r.status === 'ready') fromRedis = Number((await r.get(key)) || 0);
  } catch {
    /* memory only */
  }
  return Math.max(fromRedis, memoryCount(key));
}

/** Count one failure in memory always, and in Redis when it is up. */
async function bump(key) {
  const m = memory.get(key);
  const fresh = !m || m.until < Date.now();
  memory.set(key, { count: fresh ? 1 : m.count + 1, until: fresh ? Date.now() + WINDOW_SEC * 1000 : m.until });
  try {
    const r = getRedis();
    if (r.status === 'ready') {
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, WINDOW_SEC);
    }
  } catch {
    /* memory has it */
  }
}

async function clear(key) {
  memory.delete(key);
  try {
    await getRedis().del(key);
  } catch {
    /* memory already cleared */
  }
}

/**
 * Wrap an auth action. `limit` is the failures allowed per email+IP.
 * Only failed attempts count; success clears the email+IP counter.
 */
function guardAuth(scope, { limit = 5, ipLimit = 30 } = {}) {
  return async (req, _res, next) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const ip = clientIp(req);
    req.authLimitKeys = {
      pair: `authlimit:${scope}:${email}:${ip}`,
      ip: `authlimit:${scope}:ip:${ip}`,
    };
    const [pair, perIp] = await Promise.all([count(req.authLimitKeys.pair), count(req.authLimitKeys.ip)]);
    if (pair >= limit || perIp >= ipLimit) {
      return next(new AppError('Too many attempts. Wait 15 minutes and try again, or reset your password.', 429, 'TOO_MANY_ATTEMPTS'));
    }
    return next();
  };
}

async function recordFailure(req) {
  if (!req.authLimitKeys) return;
  await Promise.all([bump(req.authLimitKeys.pair), bump(req.authLimitKeys.ip)]);
}

async function recordSuccess(req) {
  if (req.authLimitKeys) await clear(req.authLimitKeys.pair);
}

module.exports = { guardAuth, recordFailure, recordSuccess, clientIp };
