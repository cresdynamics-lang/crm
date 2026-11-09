/**
 * Email a new staff member their CRES OS sign-in details.
 *
 * Sent directly (not through the BullMQ queue) so the first-time password is
 * never written to Redis job data or to failed_jobs. Retries a few times in the
 * background; if every attempt fails, the person who created the account gets an
 * in-app notice so they can hand the details over another way.
 */
const { query } = require('../config/database');
const { sendWithFailover } = require('./emailService');

const ROLE_LABELS = {
  admin: 'Admin',
  director: 'Director',
  finance: 'Finance',
  hr: 'HR',
  pm: 'Project Manager',
  sales: 'Sales',
  developer: 'Developer',
};

function loginUrl() {
  const root = (process.env.PUBLIC_WEB_URL || process.env.APP_URL || 'https://cresos.cresdynamics.com').replace(/\/$/, '');
  return `${root}/login`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCredentialsEmail({ name, email, password, role, createdByName }) {
  const roleLabel = ROLE_LABELS[role] || role || 'Staff';
  const url = loginUrl();
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const subject = 'Your CRES OS account is ready';
  const body = [
    `Hi ${first},`,
    '',
    `${createdByName ? `${createdByName} has` : 'An account has been'} created your CRES OS account at Cres Dynamics.`,
    '',
    `Sign in: ${url}`,
    `Email: ${email}`,
    `Temporary password: ${password}`,
    `Role: ${roleLabel}`,
    '',
    'After you sign in, change this password under Settings > Password.',
    'Do not share it with anyone. If you did not expect this email, tell your manager.',
    '',
    '— Cres Dynamics',
  ].join('\n');
  const html = `
  <p>Hi ${escapeHtml(first)},</p>
  <p>${createdByName ? `${escapeHtml(createdByName)} has` : 'An account has been'} created your <strong>CRES OS</strong> account at Cres Dynamics.</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
    <tr><td style="padding:6px 12px 6px 0;color:#5b6b80;">Sign in</td><td style="padding:6px 0;"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#5b6b80;">Email</td><td style="padding:6px 0;">${escapeHtml(email)}</td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#5b6b80;">Temporary password</td><td style="padding:6px 0;font-family:monospace;font-size:15px;"><strong>${escapeHtml(password)}</strong></td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#5b6b80;">Role</td><td style="padding:6px 0;">${escapeHtml(roleLabel)}</td></tr>
  </table>
  <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#00a8c5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">Sign in to CRES OS</a></p>
  <p>After you sign in, change this password under <strong>Settings &rsaquo; Password</strong>. Do not share it with anyone.</p>
  <p style="color:#5b6b80;font-size:13px;">If you did not expect this email, tell your manager.</p>`;
  return { subject, body, html };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliver(details, { attempts = 3, backoffMs = 5000 } = {}) {
  const msg = buildCredentialsEmail(details);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await sendWithFailover({
        to: details.email,
        subject: msg.subject,
        body: msg.body,
        html: msg.html,
        meta: { type: 'staff_credentials', userId: details.userId, fromRole: 'admin' },
      });
      return { sent: true };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(backoffMs * (i + 1));
    }
  }
  throw lastErr;
}

async function reportFailure(details, err) {
  const reason = err?.message || String(err);
  console.error(`[staff-credentials] login email to ${details.email} failed: ${reason}`);
  // Keep a dead-letter record WITHOUT the password, so Admin can see it in Email activity.
  await query(
    `INSERT INTO failed_jobs (queue, job_name, payload, error, attempts)
     VALUES ('cres-email', 'user.credentials', $1::jsonb, $2, 3)`,
    [JSON.stringify({ userId: details.userId, email: details.email, role: details.role }), reason]
  ).catch(() => {});
  if (details.createdBy) {
    const { queueNotification } = require('../queues/jobs');
    await queueNotification({
      userId: details.createdBy,
      type: 'staff_credentials_failed',
      content: `Login email to ${details.name || details.email} did not send. Share their sign-in details another way, or reset their password once email is working.`,
      meta: { userId: details.userId, href: details.role && details.createdByRole === 'hr' ? '#/employees' : '#/users' },
    }).catch(() => {});
  }
}

/**
 * Fire-and-forget: never blocks or fails the account-creation request.
 * details: { userId, name, email, password, role, createdBy, createdByName }
 */
function sendStaffCredentials(details) {
  if (!details?.email || !details?.password) return;
  if (process.env.NODE_ENV === 'test' && !process.env.STAFF_CREDENTIALS_EMAIL_IN_TEST) return;
  setImmediate(() => {
    deliver(details).catch((err) => reportFailure(details, err));
  });
}

module.exports = { sendStaffCredentials, buildCredentialsEmail, deliver };
