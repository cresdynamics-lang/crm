const { AppError } = require('../lib/errors');

/**
 * Require one or more permissions (resource:action).
 * Checks role_permissions loaded on req.user - never frontend-only.
 *
 * Usage: requirePermission('invoices', 'view')
 *        requirePermission('account_balance', 'view')
 *        requireAnyPermission([['invoices','view'], ['invoice_followups','view']])
 */
function requirePermission(resource, action) {
  const needed = `${resource}:${action}`;
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'AUTH_REQUIRED'));
    }
    if (!req.user.permissions.includes(needed)) {
      return next(
        new AppError(
          `Forbidden: missing permission ${needed}`,
          403,
          'FORBIDDEN'
        )
      );
    }
    return next();
  };
}

function requireAnyPermission(pairs) {
  const needed = pairs.map(([r, a]) => `${r}:${a}`);
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'AUTH_REQUIRED'));
    }
    const ok = needed.some((p) => req.user.permissions.includes(p));
    if (!ok) {
      return next(
        new AppError(
          `Forbidden: requires one of ${needed.join(', ')}`,
          403,
          'FORBIDDEN'
        )
      );
    }
    return next();
  };
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'AUTH_REQUIRED'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError('Forbidden: insufficient role', 403, 'FORBIDDEN'));
    }
    return next();
  };
}

function hasPermission(user, resource, action) {
  return Boolean(user?.permissions?.includes(`${resource}:${action}`));
}

module.exports = {
  requirePermission,
  requireAnyPermission,
  requireRole,
  hasPermission,
};
