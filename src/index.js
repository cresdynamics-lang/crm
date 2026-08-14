require('dotenv').config();
const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { startWorkers } = require('./queues/workers');
const { initSocket } = require('./realtime/socket');
const { healthCheck: dbHealth } = require('./config/database');
const { healthCheck: redisHealth, getRedis } = require('./config/redis');

async function boot() {
  getRedis();
  const db = await dbHealth();
  const redis = await redisHealth();

  if (db.status !== 'up') {
    console.error('[boot] database unavailable:', db.error);
    process.exit(1);
  }

  if (redis.status !== 'up') {
    console.warn('[boot] redis unavailable - async queues degraded:', redis.error);
  }

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  let workers = [];
  if (redis.status === 'up') {
    workers = startWorkers();
  }

  server.listen(config.port, () => {
    console.log(`[boot] Cres Dynamics CRM on :${config.port}`);
    console.log(`[boot] db=${db.status} redis=${redis.status} workers=${workers.length} socket=up`);
    try {
      const { startOpsScheduler } = require('./services/opsJobs');
      startOpsScheduler();
      console.log('[boot] ops scheduler started (overdue + follow-up alerts)');
    } catch (e) {
      console.warn('[boot] ops scheduler skipped:', e.message);
    }
  });

  const shutdown = async (signal) => {
    console.log(`[boot] ${signal} received - shutting down`);
    server.close();
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
