/**
 * Read-only pool for the public website database (cresdynamics).
 * Director analytics + Finance website-payments read LIVE website data
 * through this pool. Never writes; the website owns its data.
 */
const { Pool } = require('pg');
const config = require('./index');

let pool = null;

function getWebsiteDb() {
  if (!config.websiteDatabaseUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: config.websiteDatabaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => console.error('[websiteDb] idle client error', err.message));
  }
  return pool;
}

async function wQuery(text, params) {
  const p = getWebsiteDb();
  if (!p) throw new Error('WEBSITE_DATABASE_URL not configured');
  return p.query(text, params);
}

async function wQueryRows(text, params) {
  const result = await wQuery(text, params);
  return result.rows;
}

async function websiteDbAvailable() {
  try {
    if (!config.websiteDatabaseUrl) {
      return { status: 'down', connected: false, error: 'WEBSITE_DATABASE_URL not configured' };
    }
    const p = getWebsiteDb();
    if (!p) return { status: 'down', connected: false, error: 'WEBSITE_DATABASE_URL not configured' };
    await p.query('SELECT 1');
    return { status: 'up', connected: true };
  } catch (err) {
    return { status: 'down', connected: false, error: err.message };
  }
}

function notConnectedPayload(extra = {}) {
  return {
    ok: true,
    connected: false,
    message: 'Not connected yet',
    data: {
      connected: false,
      message: 'Not connected yet',
      ...extra,
    },
  };
}

/** Send HTTP 200 with a friendly disconnected payload. Returns true if disconnected (caller should return). */
async function respondIfDisconnected(res, extra = {}) {
  const status = await websiteDbAvailable();
  if (status.status === 'up') return false;
  res.status(200).json(notConnectedPayload({ error: status.error, ...extra }));
  return true;
}

module.exports = {
  getWebsiteDb,
  wQuery,
  wQueryRows,
  websiteDbAvailable,
  notConnectedPayload,
  respondIfDisconnected,
};