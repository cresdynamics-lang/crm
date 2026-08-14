const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission, hasPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueNotification } = require('../queues/jobs');

const router = express.Router();
router.use(authenticate);

async function employeeForUser(userId) {
  const { rows } = await query(
    `SELECT e.*, u.name, u.email
     FROM employees e
     JOIN users u ON u.id = e.user_id
     WHERE e.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function notifyHrOfLeave(leaveRow, employeeName) {
  const { rows: hrUsers } = await query(
    `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('hr', 'admin') AND u.status = 'active'`
  );
  for (const hr of hrUsers) {
    await queueNotification({
      userId: hr.id,
      type: 'leave_request',
      content: `Leave request from ${employeeName}: ${leaveRow.start_date} → ${leaveRow.end_date}`,
      meta: { leaveId: leaveRow.id, employeeId: leaveRow.employee_id, href: '#/leave' },
    });
  }
}

/** Own leave history (all staff with leave:view) */
router.get(
  '/mine',
  requirePermission('leave', 'view'),
  asyncHandler(async (req, res) => {
    const emp = await employeeForUser(req.user.id);
    if (!emp) {
      return res.json({ ok: true, data: [], meta: { employee: null } });
    }
    const { rows } = await query(
      `SELECT lr.*, u.name AS employee_name, e.position
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       JOIN users u ON u.id = e.user_id
       WHERE lr.employee_id = $1
       ORDER BY lr.created_at DESC
       LIMIT 200`,
      [emp.id]
    );
    res.json({ ok: true, data: rows, meta: { employee: { id: emp.id, name: emp.name } } });
  })
);

/** Self-service leave request → HR */
router.post(
  '/mine',
  requirePermission('leave', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { start_date, end_date, leave_type, reason } = req.body || {};
    if (!start_date || !end_date) {
      throw new AppError('start_date and end_date required', 400, 'VALIDATION');
    }
    const emp = await employeeForUser(req.user.id);
    if (!emp) {
      throw new AppError(
        'No employee record linked to your account. Ask HR to onboard you first.',
        400,
        'NO_EMPLOYEE'
      );
    }
    const { rows } = await query(
      `INSERT INTO leave_requests (employee_id, start_date, end_date, leave_type, reason)
       VALUES ($1, $2, $3, COALESCE($4, 'annual'), $5)
       RETURNING *`,
      [emp.id, start_date, end_date, leave_type || null, reason || null]
    );
    await notifyHrOfLeave(rows[0], emp.name);
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/** HR: all leave requests. Staff with only leave:view get redirected shape via /mine. */
router.get(
  '/',
  requireAnyPermission([
    ['leave', 'view'],
    ['employees', 'view'],
  ]),
  asyncHandler(async (req, res) => {
    const canManage =
      hasPermission(req.user, 'leave', 'decide') || hasPermission(req.user, 'employees', 'edit');

    if (!canManage) {
      const emp = await employeeForUser(req.user.id);
      if (!emp) return res.json({ ok: true, data: [], meta: { scope: 'self', employee: null } });
      const { rows } = await query(
        `SELECT lr.*, u.name AS employee_name, e.position
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN users u ON u.id = e.user_id
         WHERE lr.employee_id = $1
         ORDER BY lr.created_at DESC
         LIMIT 200`,
        [emp.id]
      );
      return res.json({
        ok: true,
        data: rows,
        meta: { scope: 'self', employee: { id: emp.id, name: emp.name } },
      });
    }

    const { rows } = await query(
      `SELECT lr.*, u.name AS employee_name, e.position
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       JOIN users u ON u.id = e.user_id
       ORDER BY lr.created_at DESC
       LIMIT 200`
    );
    res.json({ ok: true, data: rows, meta: { scope: 'all' } });
  })
);

/** HR can create on behalf of any employee; others use /mine */
router.post(
  '/',
  requireAnyPermission([
    ['leave', 'create'],
    ['employees', 'edit'],
  ]),
  idempotency,
  asyncHandler(async (req, res) => {
    const { employee_id, start_date, end_date, leave_type, reason } = req.body || {};
    if (!start_date || !end_date) {
      throw new AppError('start_date and end_date required', 400, 'VALIDATION');
    }

    const canManage =
      hasPermission(req.user, 'leave', 'decide') || hasPermission(req.user, 'employees', 'edit');

    let targetEmployeeId = employee_id;
    let employeeName = null;

    if (!canManage || !targetEmployeeId) {
      const emp = await employeeForUser(req.user.id);
      if (!emp) {
        throw new AppError(
          'No employee record linked to your account. Ask HR to onboard you first.',
          400,
          'NO_EMPLOYEE'
        );
      }
      targetEmployeeId = emp.id;
      employeeName = emp.name;
    } else {
      const { rows: empRows } = await query(
        `SELECT e.id, u.name FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
        [targetEmployeeId]
      );
      if (!empRows[0]) throw new AppError('Employee not found', 404, 'NOT_FOUND');
      employeeName = empRows[0].name;
    }

    const { rows } = await query(
      `INSERT INTO leave_requests (employee_id, start_date, end_date, leave_type, reason)
       VALUES ($1, $2, $3, COALESCE($4, 'annual'), $5)
       RETURNING *`,
      [targetEmployeeId, start_date, end_date, leave_type || null, reason || null]
    );

    await notifyHrOfLeave(rows[0], employeeName);
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/:id/decide',
  requireAnyPermission([
    ['leave', 'decide'],
    ['employees', 'edit'],
  ]),
  asyncHandler(async (req, res) => {
    const decision = req.body?.status;
    if (!['approved', 'rejected'].includes(decision)) {
      throw new AppError('status must be approved or rejected', 400, 'VALIDATION');
    }
    const { rows } = await query(
      `UPDATE leave_requests
       SET status = $1, decided_by = $2, decided_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [decision, req.user.id, req.params.id]
    );
    if (!rows[0]) throw new AppError('Leave request not found or already decided', 409, 'INVALID_STATE');

    const { rows: emp } = await query(
      `SELECT e.user_id, u.name FROM employees e
       JOIN users u ON u.id = e.user_id
       WHERE e.id = $1`,
      [rows[0].employee_id]
    );
    if (emp[0]) {
      await queueNotification({
        userId: emp[0].user_id,
        type: 'leave_decision',
        content: `Your leave request was ${decision}`,
        meta: { leaveId: rows[0].id, status: decision, href: '#/leave' },
      });
    }

    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
