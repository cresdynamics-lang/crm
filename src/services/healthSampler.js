/**
 * Health sampler for the Admin health dashboard.
 * Computes droplet/system metrics, PM2 process stats, website probes and
 * CRM group status, then persists a snapshot (health_snapshots) and pushes
 * a live payload to all online admin clients over socket.io.
 */
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const { healthCheck: dbHealth } = require('../config/database');
const { healthCheck: redisHealth } = require('../config/redis');
const { healthCheck: queueHealth } = require('../queues');
const { websiteDbAvailable } = require('../config/websiteDb');
const { withTransaction } = require('../config/database');

const WEBSITE_BASE = process.env.WEBSITE_BASE_URL || '';
const PROBE_PATHS = [
  { name: 'home', path: '/' },
  { name: 'blog', path: '/blog' },
  { name: 'events', path: '/events' },
  { name: 'careers', path: '/careers' },
];

function probe(path) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(WEBSITE_BASE + path, (res) => {
      res.resume();
      resolve({ status: res.statusCode < 500 ? 'up' : 'down', code: res.statusCode, latencyMs: Date.now() - started });
    });
    req.setTimeout(4000, () => {
      req.destroy();
      resolve({ status: 'down', code: 'timeout', latencyMs: Date.now() - started });
    });
    req.on('error', () => resolve({ status: 'down', code: 'error', latencyMs: Date.now() - started }));
  });
}

function cpuPercent() {
  try {
    const load = os.loadavg()[0];
    const cores = Math.max(os.cpus().length, 1);
    return Math.max(0, Math.min(100, Math.round((load / cores) * 100)));
  } catch {
    return 0;
  }
}

function diskPercent() {
  try {
    const out = execFileSync('df', ['-k', '/'], { encoding: 'utf8', timeout: 3000 });
    const [, totalK, usedK] = out.trim().split('\n')[1].split(/\s+/);
    const total = Number(totalK);
    const used = Number(usedK);
    return total > 0 ? Math.round((used / total) * 100) : 0;
  } catch {
    return null;
  }
}

function pm2Processes() {
  try {
    const env = { ...process.env, PM2_HOME: process.env.PM2_HOME || '/root/.pm2' };
    const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 4000, env }));
    const wanted = new Set(['cresdynamics', 'crm-api', 'crm-worker']);
    return list
      .filter((p) => wanted.has(p.name))
      .map((p) => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env?.status || 'unknown',
        restarts: p.pm2_env?.restart_time || 0,
        cpu: Math.round(p.monit?.cpu || 0),
        memMb: Math.round((p.monit?.memory || 0) / 1024 / 1024),
        uptimeSec: p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000) : null,
      }));
  } catch {
    return [];
  }
}

async function computeAll() {
  const mem = os.totalmem();
  const memFree = os.freemem();
  const memUsed = mem - memFree;

  const [websiteDb, db, redis, queues, ...probes] = await Promise.all([
    websiteDbAvailable(),
    dbHealth(),
    redisHealth(),
    queueHealth(),
    ...(WEBSITE_BASE
      ? PROBE_PATHS.map((p) => probe(p.path))
      : PROBE_PATHS.map(() => Promise.resolve({ status: 'down', code: 'unconfigured', latencyMs: 0 }))),
  ]);

  const websiteAll = probes.every((p) => p.status === 'up') && websiteDb.status === 'up';
  const websiteAnyDown = probes.some((p) => p.status === 'down');

  const groups = {
    auth: { status: 'up' },
    users: { status: db.status },
    leads: { status: db.status },
    clients: { status: db.status },
    projects: { status: db.status },
    invoices: { status: db.status },
    payments: { status: db.status },
    expenses: { status: db.status },
    salaries: { status: db.status },
    notifications: { status: db.status === 'up' && queues.status === 'up' ? 'up' : 'degraded' },
    messages: { status: db.status === 'up' ? 'up' : 'down' },
    reports: { status: db.status },
    queues,
    redis,
    database: db,
  };

  return {
    asOf: new Date().toISOString(),
    timezone: 'Africa/Nairobi',
    system: {
      hostname: os.hostname(),
      cpuPercent: cpuPercent(),
      load1: Number(os.loadavg()[0].toFixed(2)),
      memUsedPct: Math.round((memUsed / mem) * 100),
      memUsedMb: Math.round(memUsed / 1024 / 1024),
      memTotalMb: Math.round(mem / 1024 / 1024),
      diskUsedPct: diskPercent(),
      uptimeSec: os.uptime(),
    },
    processes: pm2Processes(),
    website: {
      status: websiteAnyDown || websiteDb.status !== 'up' ? 'down' : websiteAll ? 'up' : 'degraded',
      websiteDb,
      probes: probes.map((p, i) => ({
        name: PROBE_PATHS[i].name,
        path: PROBE_PATHS[i].path,
        status: p.status,
        code: p.code,
        latencyMs: p.latencyMs,
      })),
    },
    crm: {
      status: db.status !== 'up' ? 'down' : redis.status !== 'up' ? 'degraded' : 'up',
      groups,
    },
  };
}

function flatten(payload) {
  const rows = [{ category: 'system.cpu', name: 'cpu', status: 'up', detail: { pct: payload.system.cpuPercent } }];
  rows.push({ category: 'system.memory', name: 'memory', status: payload.system.memUsedPct > 95 ? 'degraded' : 'up', detail: { usedPct: payload.system.memUsedPct, usedMb: payload.system.memUsedMb, totalMb: payload.system.memTotalMb } });
  rows.push({ category: 'system.disk', name: 'disk', status: payload.system.diskUsedPct == null ? 'down' : payload.system.diskUsedPct > 92 ? 'degraded' : 'up', detail: { usedPct: payload.system.diskUsedPct } });
  for (const p of payload.website.probes) {
    rows.push({ category: 'website', name: p.name, status: p.status, latency_ms: p.latencyMs, detail: { code: p.code, path: p.path } });
  }
  rows.push({ category: 'website', name: 'website-db', status: payload.website.websiteDb.status, detail: payload.website.websiteDb });
  for (const [name, g] of Object.entries(payload.crm.groups)) {
    rows.push({ category: 'crm', name, status: g.status === 'up' ? 'up' : g.status === 'down' ? 'down' : 'degraded' });
  }
  for (const proc of payload.processes) {
    rows.push({ category: 'process', name: proc.name, status: proc.status === 'online' ? 'up' : 'down', detail: proc });
  }
  return rows;
}

async function save(payload) {
  const rows = flatten(payload);
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO health_snapshots (category, name, status, latency_ms, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [r.category, r.name, r.status, r.latency_ms ?? null, r.detail ? JSON.stringify(r.detail) : null]
      );
    }
    await client.query(`DELETE FROM health_snapshots WHERE checked_at < now() - interval '8 days'`);
  });

  try {
    const { emitToRole } = require('../realtime/socket');
    emitToRole('admin', 'health:live', payload);
  } catch {
    /* socket may not be ready */
  }
  return rows.length;
}

let timer = null;

function startSampler(intervalMs = 60000) {
  if (timer) return timer;
  const tick = async () => {
    try {
      const payload = await computeAll();
      await save(payload);
    } catch (err) {
      console.error('[health] sampler tick failed:', err.message);
    }
  };
  setTimeout(tick, 3000); // first run soon after boot
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { computeAll, save, startSampler, flatten };