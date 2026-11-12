/**
 * Run a background service in exactly ONE process, with automatic failover.
 *
 * Each service (ops scheduler, inbox watcher, health sampler…) takes a Redis
 * lock that expires after 45s and is renewed every 15s. If the process holding
 * it crashes or stalls, the lock lapses and another process (web or worker)
 * picks the service up within a minute. A failure inside one service never
 * stops the others: each start/stop is isolated.
 *
 * Without Redis, only the process that sets CRES_PROCESS=web runs services,
 * so nothing runs twice.
 */
const os = require('os');

const TTL_MS = 45000;
const RENEW_MS = 15000;
const me = `${os.hostname()}:${process.pid}`;
const services = new Map(); // name -> { start, stop, running, handle }
let timer = null;

function redis() {
  try {
    const r = require('../config/redis').getRedis();
    return r.status === 'ready' ? r : null;
  } catch {
    return null;
  }
}

async function tryHold(name) {
  const r = redis();
  if (!r) return process.env.CRES_PROCESS === 'web';
  const key = `cres:leader:${name}`;
  const ok = await r.set(key, me, 'PX', TTL_MS, 'NX').catch(() => null);
  if (ok) return true;
  const owner = await r.get(key).catch(() => null);
  if (owner === me) {
    await r.pexpire(key, TTL_MS).catch(() => {});
    return true;
  }
  return false;
}

let ticking = false;
async function tick() {
  if (ticking) return; // never run two checks at once (that would start a service twice)
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
  }
}

async function tickOnce() {
  for (const [name, svc] of services) {
    let lead = false;
    try {
      lead = await tryHold(name);
    } catch {
      lead = false;
    }
    if (lead && !svc.running) {
      try {
        svc.handle = await svc.start();
        svc.running = true;
        console.log(`[leader] ${name} started in ${process.env.CRES_PROCESS || 'process'} ${process.pid}`);
      } catch (e) {
        console.error(`[leader] ${name} failed to start: ${e.message}`);
      }
    } else if (!lead && svc.running) {
      try {
        await svc.stop?.(svc.handle);
      } catch {
        /* ignore */
      }
      svc.running = false;
      console.log(`[leader] ${name} handed over (another process holds it)`);
    }
  }
}

/** Register a singleton service. start() may return a handle passed to stop(). */
function runAsLeader(name, start, stop) {
  services.set(name, { start, stop, running: false, handle: null });
  if (!timer) {
    timer = setInterval(() => tick().catch(() => {}), RENEW_MS);
    if (timer.unref) timer.unref();
  }
  // First attempt shortly after boot (Redis needs a moment to connect); one timer for all
  if (!firstTick) {
    firstTick = setTimeout(() => tick().catch(() => {}), 1500);
    firstTick.unref?.();
  }
}
let firstTick = null;

async function releaseAll() {
  const r = redis();
  for (const [name, svc] of services) {
    if (svc.running) {
      try {
        await svc.stop?.(svc.handle);
      } catch {
        /* ignore */
      }
      svc.running = false;
    }
    if (r) {
      const key = `cres:leader:${name}`;
      const owner = await r.get(key).catch(() => null);
      if (owner === me) await r.del(key).catch(() => {});
    }
  }
}

function status() {
  return [...services.entries()].map(([name, s]) => ({ name, running: s.running, process: me }));
}

module.exports = { runAsLeader, releaseAll, status };
