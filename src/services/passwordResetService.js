const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');
const { queuePasswordResetEmail } = require('../queues/jobs');
const { findUserByEmail } = require('./authService');

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_LENGTH = 6;

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generateNumericOtp() {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

async function sendResetEmail({ email, code, name, expiresAt }) {
  const { sendWithFailover } = require('./emailService');
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const body = `Hi ${first},\n\nYour Cres Dynamics password reset code is: ${code}\n\nIt expires in 10 minutes and works once. If you did not ask for this, ignore this email: your password has not changed.`;
  const html = `<p>Hi ${first.replace(/[<>&]/g, '')},</p>
  <p>Your <strong>CRES OS</strong> password reset code is:</p>
  <p style="font-family:monospace;font-size:32px;letter-spacing:8px;font-weight:bold;margin:14px 0;color:#1b2a4a;">${code}</p>
  <p style="font-size:14px;">It expires in 10 minutes and works once. Type it on the sign-in page, then choose a new password.</p>
  <p style="color:#5b6b80;font-size:13px;">If you did not ask for this, ignore this email: your password has not changed.</p>`;
  return sendWithFailover({ to: email, subject: `${code} is your Cres OS password reset code`, body, html, meta: { type: 'password_reset', expiresAt, fromRole: 'default' } });
}

/**
 * Always returns ok shape - never reveal whether email exists.
 */
async function requestPasswordReset(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new AppError('email is required', 400, 'VALIDATION');

  const user = await findUserByEmail(normalized);
  if (user && user.status === 'active') {
    // Invalidate prior unused codes
    await query(
      `UPDATE password_reset_otps SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    const code = generateNumericOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await query(
      `INSERT INTO password_reset_otps (user_id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, normalized, hashCode(code), expiresAt]
    );

    // Send at once (so the code arrives in seconds); the queue is only the backup if sending fails.
    try {
      await sendResetEmail({ email: normalized, code, name: user.name, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      console.warn('[password-reset] direct send failed, queued instead:', err.message);
      await queuePasswordResetEmail({ email: normalized, code, name: user.name, expiresAt: expiresAt.toISOString() });
    }
  }

  return {
    message: 'If that email is registered, a reset code has been sent.',
    expiresInMinutes: 10,
  };
}

async function verifyResetCode(email, code) {
  const normalized = String(email || '').trim().toLowerCase();
  const otp = String(code || '').trim();
  if (!normalized || !otp) {
    throw new AppError('email and code are required', 400, 'VALIDATION');
  }

  const { rows } = await query(
    `SELECT * FROM password_reset_otps
     WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalized]
  );
  const row = rows[0];
  if (!row || row.code_hash !== hashCode(otp)) {
    throw new AppError('Invalid or expired code', 400, 'OTP_INVALID');
  }

  // Issue short-lived reset token (single-use binding)
  const resetToken = crypto.randomBytes(32).toString('hex');
  await query(
    `UPDATE password_reset_otps
     SET code_hash = $1
     WHERE id = $2`,
    [hashCode(`reset:${resetToken}`), row.id]
  );

  return {
    resetToken,
    email: normalized,
    expiresAt: row.expires_at,
  };
}

async function resetPassword({ email, resetToken, newPassword }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !resetToken || !newPassword) {
    throw new AppError('email, resetToken, and newPassword are required', 400, 'VALIDATION');
  }
  if (String(newPassword).length < 8) {
    throw new AppError('Password must be at least 8 characters', 400, 'VALIDATION');
  }

  const { rows } = await query(
    `SELECT * FROM password_reset_otps
     WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalized]
  );
  const row = rows[0];
  if (!row || row.code_hash !== hashCode(`reset:${resetToken}`)) {
    throw new AppError('Invalid or expired reset session', 400, 'OTP_INVALID');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, row.user_id]
  );
  await query(
    `UPDATE password_reset_otps SET used_at = NOW() WHERE id = $1`,
    [row.id]
  );
  // Revoke refresh tokens
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [row.user_id]
  );

  // The message said "reset your password" when locked out: make that true straight away
  await require('../middleware/authLimiter').clearForEmail(normalized, 'login').catch(() => {});
  return { reset: true };
}

module.exports = {
  requestPasswordReset,
  verifyResetCode,
  resetPassword,
  OTP_TTL_MS,
};
