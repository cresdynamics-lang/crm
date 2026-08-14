const { Queue, Worker, QueueEvents } = require('bullmq');
const config = require('../config');
const { getRedis } = require('../config/redis');
const { query } = require('../config/database');

const QUEUE_NAMES = {
  sideEffects: 'cres-side-effects',
  email: 'cres-email',
  notifications: 'cres-notifications',
  deadLetter: 'cres-dead-letter',
};

const defaultJobOpts = {
  attempts: config.queue.attempts,
  backoff: {
    type: 'exponential',
    delay: config.queue.backoffMs,
  },
  removeOnComplete: 100,
  removeOnFail: false,
};

let queues = null;

function connection() {
  // BullMQ wants a duplicated connection without shared blocking issues
  const base = getRedis();
  return base.duplicate();
}

function getQueues() {
  if (queues) return queues;

  const conn = connection();
  queues = {
    sideEffects: new Queue(QUEUE_NAMES.sideEffects, { connection: conn, defaultJobOptions: defaultJobOpts }),
    email: new Queue(QUEUE_NAMES.email, { connection: conn, defaultJobOptions: defaultJobOpts }),
    notifications: new Queue(QUEUE_NAMES.notifications, { connection: conn, defaultJobOptions: defaultJobOpts }),
    deadLetter: new Queue(QUEUE_NAMES.deadLetter, {
      connection: conn,
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    }),
  };

  return queues;
}

/**
 * Enqueue an async side-effect. Failures retry; exhausted jobs go to DLQ.
 */
async function enqueue(queueKey, jobName, payload, opts = {}) {
  const q = getQueues()[queueKey];
  if (!q) throw new Error(`Unknown queue: ${queueKey}`);
  return q.add(jobName, payload, {
    ...defaultJobOpts,
    ...opts,
    jobId: opts.jobId,
  });
}

async function moveToDeadLetter(queueName, job, err) {
  const payload = {
    queue: queueName,
    jobName: job.name,
    data: job.data,
    failedReason: err?.message || String(err),
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  };

  await getQueues().deadLetter.add('dead-letter', payload);

  await query(
    `INSERT INTO failed_jobs (queue, job_name, payload, error, attempts)
     VALUES ($1, $2, $3, $4, $5)`,
    [queueName, job.name, job.data, err?.message || String(err), job.attemptsMade]
  ).catch((e) => console.error('[dlq] db insert failed', e.message));
}

async function healthCheck() {
  try {
    const redisHealth = await require('../config/redis').healthCheck();
    if (redisHealth.status !== 'up') {
      return { status: 'down', error: redisHealth.error || 'redis down' };
    }

    const q = getQueues();
    const counts = await q.sideEffects.getJobCounts('waiting', 'active', 'failed', 'delayed');
    return { status: 'up', queues: { sideEffects: counts } };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

module.exports = {
  QUEUE_NAMES,
  getQueues,
  enqueue,
  moveToDeadLetter,
  healthCheck,
  defaultJobOpts,
  connection,
  Worker,
  QueueEvents,
};
