const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role_name, // claim only - re-verified from DB every request
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseDurationToMs(duration) {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * mult[unit];
}

async function issueRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + parseDurationToMs(config.jwt.refreshExpiresIn));

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return { token: raw, expiresAt };
}

async function findUserByEmail(email) {
  const { rows } = await query(
    `SELECT u.*, r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.email) = LOWER($1)`,
    [email]
  );
  return rows[0] || null;
}

async function findActiveUserById(id) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.status, u.role_id, u.avatar_url,
            r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function login(email, password) {
  const user = await findUserByEmail(email);
  if (!user || user.status !== 'active') {
    throw new AppError('Invalid email or password', 401, 'AUTH_INVALID');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    throw new AppError('Invalid email or password', 401, 'AUTH_INVALID');
  }

  const accessToken = signAccessToken(user);
  const refresh = await issueRefreshToken(user.id);

  return {
    accessToken,
    refreshToken: refresh.token,
    expiresAt: refresh.expiresAt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role_name,
      status: user.status,
      avatar_url: user.avatar_url || null,
    },
  };
}

async function refresh(refreshToken) {
  if (!refreshToken) {
    throw new AppError('Refresh token required', 400, 'AUTH_REFRESH_REQUIRED');
  }

  const tokenHash = hashToken(refreshToken);
  const { rows } = await query(
    `SELECT * FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  const stored = rows[0];
  if (!stored) {
    throw new AppError('Invalid or expired refresh token', 401, 'AUTH_REFRESH_INVALID');
  }

  const user = await findActiveUserById(stored.user_id);
  if (!user || user.status !== 'active') {
    throw new AppError('User inactive or not found', 401, 'AUTH_USER_INACTIVE');
  }

  // Rotate: revoke old, issue new
  await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [stored.id]);
  const accessToken = signAccessToken(user);
  const next = await issueRefreshToken(user.id);

  return {
    accessToken,
    refreshToken: next.token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role_name,
      status: user.status,
      avatar_url: user.avatar_url || null,
    },
  };
}

async function logout(refreshToken) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

async function loadUserPermissions(roleId) {
  const { rows } = await query(
    `SELECT p.resource, p.action
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1`,
    [roleId]
  );
  return rows.map((r) => `${r.resource}:${r.action}`);
}

module.exports = {
  login,
  refresh,
  logout,
  findUserByEmail,
  findActiveUserById,
  loadUserPermissions,
  signAccessToken,
};
