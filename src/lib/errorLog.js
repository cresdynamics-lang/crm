/**
 * Error logging and alerts.
 *
 * Every server error (5xx) and crash is appended as one JSON line to
 * logs/errors.log (rotated at 5 MB, git-ignored), so problems can be found
 * without waiting for a user to report them.
 *
 * Optional: set ALERT_WEBHOOK_URL (Slack / Teams / Discord incoming webhook)
 * to get a message for each new error, at most one per error type per 10
 * minutes so a broken page cannot flood the channel.
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.log');
const MAX_BYTES = 5 * 1024 * 1024;
const ALERT_EVERY_MS = 10 * 60 * 1000;
const lastAlert = new Map();

function rotateIfLarge() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* no file yet */
  }
}

function alert(entry) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const key = `${entry.kind}:${entry.route || ''}:${entry.message}`.slice(0, 200);
  const last = lastAlert.get(key) || 0;
  if (Date.now() - last < ALERT_EVERY_MS) return;
  lastAlert.set(key, Date.now());
  const text = `CRES OS ${entry.kind}: ${entry.message}${entry.route ? ` (${entry.route})` : ''}${entry.user ? ` user ${entry.user}` : ''}`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text }), // Slack/Teams use text, Discord uses content
  }).catch(() => {});
}

/**
 * @param {Error} err
 * @param {{ kind?: string, req?: import('express').Request }} [ctx]
 */
function logError(err, { kind = 'error', req } = {}) {
  const entry = {
    at: new Date().toISOString(),
    kind,
    message: String(err?.message || err).slice(0, 500),
    code: err?.code,
    route: req ? `${req.method} ${req.originalUrl?.split('?')[0]}` : undefined,
    user: req?.user?.id,
    role: req?.user?.role,
    stack: String(err?.stack || '').split('\n').slice(0, 8).join('\n'),
  };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfLarge();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    /* logging must never take the server down */
  }
  alert(entry);
}

/** Crashes outside a request: log them; let uncaught exceptions restart the process. */
function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    logError(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    logError(err, { kind: 'uncaughtException' });
    // State is unknown after this; exit so the process manager restarts cleanly.
    setTimeout(() => process.exit(1), 200);
  });
}

module.exports = { logError, installProcessHandlers };
