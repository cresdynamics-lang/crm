const jwt = require('jsonwebtoken');
const config = require('../config');
const { findActiveUserById, loadUserPermissions } = require('../services/authService');
const { AppError } = require('../lib/errors');

/**
 * Authenticate via Bearer JWT, then RE-VERIFY role + status from DB.
 * Never trust the token's role claim alone.
 */
async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwt.secret);
    } catch {
      throw new AppError('Invalid or expired token', 401, 'AUTH_TOKEN_INVALID');
    }

    const user = await findActiveUserById(payload.sub);
    if (!user || user.status !== 'active') {
      throw new AppError('User inactive or not found', 401, 'AUTH_USER_INACTIVE');
    }

    // Re-verify: ignore stale/forged role claim from token
    const permissions = await loadUserPermissions(user.role_id);

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role_name,
      roleId: user.role_id,
      status: user.status,
      avatar_url: user.avatar_url || null,
      permissions,
    };

    next();
  } catch (err) {
    next(err);
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  return authenticate(req, res, next);
}

module.exports = { authenticate, optionalAuth };
