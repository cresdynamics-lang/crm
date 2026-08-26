const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const {
  getCompliance,
  calculateSalaryImpact,
  getTeamCompliance,
  ensureAttendanceRows,
} = require('../services/attendanceService');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/attendance/report-compliance
 * Returns attendance compliance for a user or the requesting user.
 * Query params: user_id (optional), from, to
 */
router.get(
  '/report-compliance',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    const userId = req.query.user_id || req.user.id;
    const fromDate = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const toDate = req.query.to || new Date().toISOString().slice(0, 10);

    // Non-managers can only see their own
    if (!['director', 'admin', 'pm', 'hr'].includes(req.user.role) && userId !== req.user.id) {
      throw new AppError('Cannot view other users attendance', 403, 'FORBIDDEN');
    }

    const compliance = await getCompliance(userId, fromDate, toDate);
    res.json({ ok: true, data: compliance });
  })
);

/**
 * GET /api/attendance/salary-impact
 * Calculate salary deduction for an employee based on missing reports.
 * Query params: employee_id (required), month (optional, defaults to current YYYY-MM)
 */
router.get(
  '/salary-impact',
  requirePermission('salaries', 'view'),
  asyncHandler(async (req, res) => {
    const employeeId = req.query.employee_id;
    if (!employeeId) throw new AppError('employee_id required', 400, 'VALIDATION');

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    // Non-managers can only see their own
    if (!['director', 'admin', 'hr', 'finance'].includes(req.user.role)) {
      const { rows } = await query(
        `SELECT id FROM employees WHERE user_id = $1`, [req.user.id]
      );
      if (!rows[0] || rows[0].id !== employeeId) {
        throw new AppError('Cannot view other employees salary impact', 403, 'FORBIDDEN');
      }
    }

    const impact = await calculateSalaryImpact(employeeId, month);
    if (!impact) throw new AppError('Employee not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: impact });
  })
);

/**
 * GET /api/attendance/team
 * Team attendance summary for director/admin.
 */
router.get(
  '/team',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['director', 'admin', 'pm'].includes(req.user.role)) {
      throw new AppError('Only directors/admins can view team attendance', 403, 'FORBIDDEN');
    }

    const fromDate = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const toDate = req.query.to || new Date().toISOString().slice(0, 10);

    const team = await getTeamCompliance(fromDate, toDate);
    res.json({ ok: true, data: team });
  })
);

/**
 * POST /api/attendance/ensure
 * Ensure attendance rows exist for a given month (backfill).
 * Query params: year, month (optional, defaults to current)
 */
router.post(
  '/ensure',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    const year = Number(req.body?.year) || new Date().getFullYear();
    const month = Number(req.body?.month) || new Date().getMonth() + 1;

    const created = await ensureAttendanceRows(year, month);
    res.json({ ok: true, data: { year, month, rows_created: created } });
  })
);

module.exports = router;
