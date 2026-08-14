const Redis = require('ioredis');
const config = require('./index');

let redis = null;
let lastError = null;

function getRedis() {
  if (redis) return redis;

  redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
  });

  redis.on('error', (err) => {
    lastError = err.message;
    console.error('[redis]', err.message);
  });

  redis.on('connect', () => {
    lastError = null;
  });

  return redis;
}

async function healthCheck() {
  try {
    const client = getRedis();
    const pong = await client.ping();
    return { status: pong === 'PONG' ? 'up' : 'down', error: lastError };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

module.exports = {
  getRedis,
  healthCheck,
};
