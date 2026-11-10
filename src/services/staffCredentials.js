/**
 * Email a new staff member their CRES OS sign-in details.
 *
 * Sent directly (not through the BullMQ queue). The email carries a private reveal link, never the
 * password; the password is stored encrypted and erased after it is seen. Retries a few times in the
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

/**
 * The email never contains the password. It carries a private "Click to see your login password" link:
 * the page shows the password after a click, then a Login button that opens the sign-in page with a hint
 * about which email to type.
 */
function buildCredentialsEmail({ name, role, createdByName, revealUrl }) {
  const roleLabel = ROLE_LABELS[role] || role || 'Staff';
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const subject = 'Your CRES OS account is ready - tap to see your login';
  const body = [
    `Hi ${first},`,
    '',
    `${createdByName ? `${createdByName} has` : 'An account has been'} created your CRES OS account at Cres Dynamics (${roleLabel}).`,
    '',
    'Your login password is hidden for your safety.',
    `Click here to see it: ${revealUrl}`,
    '',
    'The page shows your password once, then a Login button. Sign in with the email address this message was sent to.',
    'The link works for 7 days. After you sign in, change the password under Settings > Password.',
    'If you did not expect this email, tell your manager.',
    '',
    '- Cres Dynamics',
  ].join('\n');
  const html = `
  <p>Hi ${escapeHtml(first)},</p>
  <p>${createdByName ? `${escapeHtml(createdByName)} has` : 'An account has been'} created your <strong>CRES OS</strong> account at Cres Dynamics as <strong>${escapeHtml(roleLabel)}</strong>.</p>
  <div style="margin:18px 0;padding:18px;border:1px dashed #00a8c5;border-radius:10px;background:#f3fbfd;text-align:center;">
    <div style="font-size:13px;color:#5b6b80;margin-bottom:6px;">Your login password is hidden for your safety</div>
    <div style="font-family:monospace;font-size:20px;letter-spacing:4px;color:#1b2a4a;margin-bottom:12px;">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
    <a href="${escapeHtml(revealUrl)}" style="display:inline-block;background:#00a8c5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Click to see your login password</a>
  </div>
  <p style="font-size:14px;">The page shows your password once, then a <strong>Login</strong> button. Sign in with the email address this message was sent to. The link works for 7 days.</p>
  <p style="font-size:14px;">After you sign in, change the password under <strong>Settings &rsaquo; Password</strong>.</p>
  <p style="color:#5b6b80;font-size:13px;">If you did not expect this email, tell your manager.</p>`;
  return { subject, body, html };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliver(details, { attempts = 3, backoffMs = 5000 } = {}) {
  const { createReveal } = require('./credentialReveal');
  const { url } = await createReveal({ userId: details.userId, password: details.password });
  const msg = buildCredentialsEmail({ ...details, revealUrl: url });
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
