const { Pool } = require('pg');
const config = require('./index');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (config.env === 'development' && duration > 200) {
    console.warn(`[db] slow query ${duration}ms`, text.slice(0, 80));
  }
  return result;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
  healthCheck,
};
