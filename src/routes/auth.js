const express = require('express');
const { login, refresh, logout, findActiveUserById, loadUserPermissions } = require('../services/authService');
const {
  requestPasswordReset,
  verifyResetCode,
  resetPassword,
} = require('../services/passwordResetService');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../lib/errors');

const { setFileCookie, clearFileCookie } = require('../middleware/fileAccess');
const { guardAuth, recordFailure, recordSuccess } = require('../middleware/authLimiter');

const router = express.Router();

router.post(
  '/login',
  guardAuth('login', { limit: 5, ipLimit: 30 }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      throw new AppError('email and password are required', 400, 'VALIDATION');
    }
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'] || null;
    try {
      const result = await login(email, password);
      const { query } = require('../config/database');
      await query(
        `INSERT INTO login_audit (user_id, email, success, ip, user_agent)
         VALUES ($1, $2, TRUE, $3, $4)`,
        [result.user.id, email, ip, userAgent]
      ).catch(() => {});
      await recordSuccess(req);
      res.json({ ok: true, data: result });
    } catch (err) {
      if (err.status === 401 || err.statusCode === 401 || /invalid/i.test(err.message || '')) await recordFailure(req);
      const { query } = require('../config/database');
      await query(
        `INSERT INTO login_audit (user_id, email, success, ip, user_agent)
         VALUES (NULL, $1, FALSE, $2, $3)`,
        [email, ip, userAgent]
      ).catch(() => {});
      throw err;
    }
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    const result = await refresh(refreshToken);
    if (result?.user?.id) setFileCookie(res, result.user.id);
    res.json({ ok: true, data: result });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    await logout(refreshToken);
    clearFileCookie(res);
    res.json({ ok: true, data: { loggedOut: true } });
  })
);

router.post(
  '/forgot-password',
  guardAuth('forgot', { limit: 5, ipLimit: 20 }),
  asyncHandler(async (req, res) => {
    // Every request counts: this sends email, so it must not be spammable.
    await recordFailure(req);
    const result = await requestPasswordReset(req.body?.email);
    res.json({ ok: true, data: result });
  })
);

router.post(
  '/verify-reset-code',
  guardAuth('resetcode', { limit: 5, ipLimit: 20 }),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body || {};
    let result;
    try {
      result = await verifyResetCode(email, code);
    } catch (err) {
      await recordFailure(req);
      throw err;
    }
    await recordSuccess(req);
    res.json({ ok: true, data: result });
  })
);

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { email, resetToken, newPassword } = req.body || {};
    const result = await resetPassword({ email, resetToken, newPassword });
    res.json({ ok: true, data: result });
  })
);

router.get(
  '/verify',
  authenticate,
  asyncHandler(async (req, res) => {
    // Every page checks the session on load; renew the /uploads file cookie here.
    setFileCookie(res, req.user.id);
    res.json({
      ok: true,
      data: {
        user: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
          phone: req.user.phone,
          role: req.user.role,
          status: req.user.status,
          avatar_url: req.user.avatar_url || null,
        },
        permissions: req.user.permissions,
      },
    });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await findActiveUserById(req.user.id);
    const permissions = await loadUserPermissions(user.role_id);
    res.json({
      ok: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role_name,
        status: user.status,
        avatar_url: user.avatar_url || null,
        permissions,
      },
    });
  })
);

module.exports = router;
