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

/**
 * The real client address. nginx sets X-Real-IP from the connection itself ($remote_addr),
 * so it cannot be forged. X-Forwarded-For is NOT used: clients can send their own, and
 * rotating it would reset every per-IP limit.
 */
function clientIp(req) {
  return req.headers['x-real-ip']?.toString().trim() || req.socket?.remoteAddress || req.ip || 'unknown';
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
function guardAuth(scope, { limit = 5, ipLimit = 30, emailLimit = 25 } = {}) {
  return async (req, _res, next) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const ip = clientIp(req);
    req.authLimitKeys = {
      pair: `authlimit:${scope}:${email}:${ip}`,
      ip: `authlimit:${scope}:ip:${ip}`,
      email: `authlimit:${scope}:email:${email}`, // one account guessed from many addresses
    };
    const [pair, perIp, perEmail] = await Promise.all([count(req.authLimitKeys.pair), count(req.authLimitKeys.ip), count(req.authLimitKeys.email)]);
    if (pair >= limit || perIp >= ipLimit || perEmail >= emailLimit) {
      return next(new AppError('Too many attempts. Wait 15 minutes and try again, or reset your password.', 429, 'TOO_MANY_ATTEMPTS'));
    }
    return next();
  };
}

async function recordFailure(req) {
  if (!req.authLimitKeys) return;
  await Promise.all([bump(req.authLimitKeys.pair), bump(req.authLimitKeys.ip), bump(req.authLimitKeys.email)]);
}

async function recordSuccess(req) {
  if (req.authLimitKeys) await clear(req.authLimitKeys.pair);
}

/**
 * After a successful password reset the person must be able to sign in at once: lift every sign-in
 * lock held against that email (any address), not just the one they reset from.
 */
async function clearForEmail(email, scope = 'login') {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return;
  const prefix = `authlimit:${scope}:${e}:`;
  const own = `authlimit:${scope}:email:${e}`;
  for (const k of [...memory.keys()]) if (k.startsWith(prefix) || k === own) memory.delete(k);
  try {
    const r = getRedis();
    if (r.status !== 'ready') return;
    await r.del(own);
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) await r.del(...keys);
    } while (cursor !== '0');
  } catch {
    /* memory already cleared */
  }
}

module.exports = { guardAuth, recordFailure, recordSuccess, clientIp, clearForEmail };
