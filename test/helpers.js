/**
 * Test harness: starts the CRM's web app (no background workers or schedulers)
 * on a free port against the configured database, and signs short-lived tokens
 * for one seeded user per role.
 *
 * Safety: outgoing email and AI calls are switched off before the app loads,
 * so tests never send mail or spend money.
 */
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MAIL_MAILER = 'stub';
process.env.RESEND_API_KEY = '';
process.env.MAIL_HOST = '';
process.env.MAIL_PASSWORD = '';
process.env.OPENROUTER_API_KEY = '';
process.env.GROQ_API_KEY = '';
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const http = require('http');
const jwt = require('jsonwebtoken');

let server;
let base;
let users;

async function start() {
  if (base) return base;
  const { createApp } = require('../src/app');
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function stop() {
  if (server) await new Promise((r) => server.close(r));
  const { pool } = require('../src/config/database');
  await pool.end().catch(() => {});
  try {
    require('../src/config/redis').getRedis().disconnect();
  } catch {
    /* no redis */
  }
}

/** One active user per role, from the seeded database. */
async function roleUsers() {
  if (users) return users;
  const { query } = require('../src/config/database');
  const { rows } = await query(
    `SELECT DISTINCT ON (r.name) r.name AS role, u.id
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active'
     ORDER BY r.name, u.created_at`
  );
  users = Object.fromEntries(rows.map((r) => [r.role, r.id]));
  return users;
}

function tokenFor(userId) {
  const config = require('../src/config');
  return jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: '10m' });
}

/** fetch as a user (or anonymously with userId = null). Returns { status, body, headers }. */
async function call(userId, pathname, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (userId) h.Authorization = `Bearer ${tokenFor(userId)}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000), // no test request may hang
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

module.exports = { start, stop, roleUsers, tokenFor, call };
