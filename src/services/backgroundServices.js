/**
 * Background services, each run in exactly one process (leader lock) with
 * automatic failover between the web and worker processes. A crash inside one
 * service is caught and logged; the web app and the other services carry on.
 */
const { runAsLeader, releaseAll } = require('../lib/leader');

function guard(name, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(`[services] ${name}: ${e.message}`);
      return null;
    }
  };
}

function startBackgroundServices() {
  runAsLeader(
    'ops-scheduler',
    guard('ops-scheduler start', () => require('./opsJobs').startOpsScheduler()),
    (timer) => timer && clearInterval(timer)
  );
  runAsLeader(
    'health-sampler',
    guard('health-sampler start', () => require('./healthSampler').startSampler(60000)),
    guard('health-sampler stop', () => require('./healthSampler').stopSampler())
  );
  runAsLeader(
    'inbox-watcher',
    guard('inbox-watcher start', async () => {
      const w = require('./inboxWatcher').createWatcher();
      await w.start();
      return w;
    }),
    guard('inbox-watcher stop', (w) => w?.stop())
  );
}

module.exports = { startBackgroundServices, stopBackgroundServices: releaseAll };
