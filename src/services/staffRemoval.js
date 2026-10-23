/**
 * Shared staff removal for Admin, Director, and HR.
 * Deactivates login. Keeps payroll, reports, and invoices.
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');
const { recordAction } = require('./actionAudit');

const CAN_REMOVE_ROLES = ['admin', 'director', 'hr'];

async function loadUser(id) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.status, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function removeStaffUser(actor, userId, { reason } = {}) {
  if (!CAN_REMOVE_ROLES.includes(actor.role)) {
    throw new AppError('Only Admin, Director, or HR can remove a user', 403, 'FORBIDDEN');
  }
  if (!userId) throw new AppError('User id required', 400, 'VALIDATION');
  if (String(userId) === String(actor.id)) {
    throw new AppError('You cannot remove your own account', 400, 'VALIDATION');
  }

  const target = await loadUser(userId);
  if (!target) throw new AppError('User not found', 404, 'NOT_FOUND');
  if (target.status === 'inactive') {
    return { ...target, already_removed: true };
  }

  if (target.role === 'admin') {
    const { rows: admins } = await query(
      `SELECT COUNT(*)::int AS n
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'admin' AND u.status = 'active'`
    );
    if ((admins[0]?.n || 0) <= 1) {
      throw new AppError('Cannot remove the last active admin', 400, 'VALIDATION');
    }
  }

  const { rows } = await query(
    `UPDATE users
     SET status = 'inactive', updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, email, phone, status, updated_at`,
    [userId]
  );

  await query(
    `UPDATE projects
     SET assigned_developer_id = NULL, updated_at = NOW()
     WHERE assigned_developer_id = $1
       AND status NOT IN ('completed', 'rejected')`,
    [userId]
  ).catch(() => {});

  await recordAction({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'removed',
    resourceType: 'user',
    resourceId: userId,
    summary: `${actor.name} removed ${target.name} (${target.role})`,
    before: { status: 'active', role: target.role },
    after: { status: 'inactive' },
    meta: { reason: reason || null },
  });

  return { ...rows[0], role: target.role };
}

module.exports = { removeStaffUser, loadUser, CAN_REMOVE_ROLES };
