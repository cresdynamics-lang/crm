/**
 * Live admin inbox: keeps one IMAP connection open in IDLE mode, so new mail
 * at info@ appears in CRES OS within seconds (no "Sync now" needed).
 *
 * On new mail: sync -> scam check -> notify admins (socket + bell) ->
 * Jarvis drafts a reply in the background (not for likely scams).
 *
 * Fallbacks: if IDLE drops, reconnect with backoff (5s -> 5 min); a safety
 * poll every 2 minutes catches anything missed. It runs as a leader-locked
 * service, so exactly one process watches the mailbox.
 */
const { ImapFlow } = require('imapflow');
const config = require('../config');

const POLL_MS = 2 * 60 * 1000;

function configured() {
  const { host, user, password } = config.imap;
  return Boolean(host && user && password);
}

function createWatcher() {
  let client = null;
  let stopped = false;
  let backoff = 5000;
  let pollTimer = null;
  let reconnectTimer = null;
  let syncing = null;
  let pendingAgain = false;

  async function runSync(reason) {
    if (syncing) {
      pendingAgain = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        const { syncAdminInbox } = require('./adminInbox');
        const res = await syncAdminInbox({ limit: 30 });
        if (res.synced) console.log(`[inbox-watch] ${res.synced} new email(s) (${reason})`);
      } catch (e) {
        console.warn(`[inbox-watch] sync failed (${reason}): ${e.message}`);
      } finally {
        syncing = null;
        if (pendingAgain && !stopped) {
          pendingAgain = false;
          runSync('queued');
        }
      }
    })();
    return syncing;
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5 * 60 * 1000);
  }

  async function connect() {
    if (stopped) return;
    const { host, port, user, password, secure } = config.imap;
    client = new ImapFlow({ host, port, secure, auth: { user, pass: password }, logger: false, emitLogs: false });
    client.on('error', (e) => console.warn('[inbox-watch] connection error:', e.message));
    client.on('close', () => {
      if (!stopped) {
        console.warn('[inbox-watch] connection closed; reconnecting');
        scheduleReconnect();
      }
    });
    // New message arrived in the selected mailbox (server push during IDLE)
    client.on('exists', (data) => {
      if (data.count > (data.prevCount || 0)) runSync('push');
    });
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      backoff = 5000;
      console.log('[inbox-watch] watching INBOX (IDLE)');
      runSync('connect');
      // imapflow enters IDLE automatically while the connection is otherwise unused.
    } catch (e) {
      console.warn('[inbox-watch] connect failed:', e.message);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      scheduleReconnect();
    }
  }

  return {
    async start() {
      if (!configured()) {
        console.warn('[inbox-watch] IMAP not configured; live inbox off');
        return;
      }
      stopped = false;
      await connect();
      pollTimer = setInterval(() => runSync('poll'), POLL_MS);
      pollTimer.unref?.();
    },
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearTimeout(reconnectTimer);
      try {
        await client?.logout();
      } catch {
        try {
          client?.close();
        } catch {
          /* ignore */
        }
      }
      client = null;
    },
    syncNow: runSync,
  };
}

module.exports = { createWatcher, configured };
