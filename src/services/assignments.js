/**
 * Developer project assignment: Accept / Swap / Reject (+ 24h swap timeout).
 */
const { query, withTransaction } = require('../config/database');
const { AppError } = require('../lib/errors');
const { queueNotification } = require('../queues/jobs');
const { recordAction } = require('./actionAudit');

const SWAP_HOURS = 24;

async function notifyUsers(userIds, type, content, meta) {
  const uniq = [...new Set(userIds.filter(Boolean))];
  for (const userId of uniq) {
    await queueNotification({ userId, type, content, meta });
  }
}

async function staffIds(roles) {
  const { rows } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = ANY($1::text[]) AND u.status = 'active'`,
    [roles]
  );
  return rows.map((r) => r.id);
}

/**
 * Sales/Admin assigns (or reassigns) a developer. Creates pending invitation.
 */
async function assignDeveloper({
  projectId,
  developerId,
  assignedBy,
  actorRole,
  note = null,
}) {
  const { rows: projects } = await query(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  const project = projects[0];
  if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

  const { rows: devs } = await query(
    `SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1 AND r.name = 'developer' AND u.status = 'active'`,
    [developerId]
  );
  if (!devs[0]) throw new AppError('Developer not found', 404, 'NOT_FOUND');

  // Cancel prior pending invites for this project
  await query(
    `UPDATE project_assignments
     SET status = 'cancelled', updated_at = NOW()
     WHERE project_id = $1 AND status = 'pending'`,
    [projectId]
  );

  const { rows } = await query(
    `INSERT INTO project_assignments
      (project_id, developer_id, assigned_by, status, original_developer_id, note, expires_at)
     VALUES ($1, $2, $3, 'pending', NULL, $4, NOW() + ($5 || ' hours')::interval)
     RETURNING *`,
    [projectId, developerId, assignedBy, note, String(SWAP_HOURS)]
  );

  // Mirror pending assignee so Sales can see who was invited; project not active for them until accept
  // Keep assigned_developer_id as invitation target for scoping pending queue
  await query(
    `UPDATE projects
     SET assigned_developer_id = $1, assignment_status = 'pending', updated_at = NOW()
     WHERE id = $2`,
    [developerId, projectId]
  );

  await recordAction({
    actorId: assignedBy,
    actorRole,
    action: 'assignment.create',
    resourceType: 'project_assignment',
    resourceId: rows[0].id,
    summary: `Assigned project "${project.name}" to ${devs[0].name} (pending)`,
    after: rows[0],
    meta: { projectId },
  });

  await notifyUsers(
    [developerId],
    'project_assignment',
    `Project invitation: "${project.name}" - Accept, Swap, or Reject`,
    { projectId, assignmentId: rows[0].id }
  );

  return rows[0];
}

async function acceptAssignment({ assignmentId, developerId, actorRole }) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT a.*, p.name AS project_name, p.created_by
       FROM project_assignments a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1 FOR UPDATE OF a`,
      [assignmentId]
    );
    const a = rows[0];
    if (!a) throw new AppError('Assignment not found', 404, 'NOT_FOUND');
    if (a.developer_id !== developerId) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    if (a.status !== 'pending') throw new AppError('Invitation is no longer pending', 409, 'INVALID_STATE');

    const { rows: updated } = await tx.query(
      `UPDATE project_assignments
       SET status = 'accepted', decided_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [assignmentId]
    );

    await tx.query(
      `UPDATE projects
       SET assigned_developer_id = $1, assignment_status = 'accepted', updated_at = NOW()
       WHERE id = $2`,
      [developerId, a.project_id]
    );

    // Cancel other pending for same project
    await tx.query(
      `UPDATE project_assignments
       SET status = 'cancelled', updated_at = NOW()
       WHERE project_id = $1 AND status = 'pending' AND id <> $2`,
      [a.project_id, assignmentId]
    );

    await recordAction({
      actorId: developerId,
      actorRole,
      action: 'assignment.accept',
      resourceType: 'project_assignment',
      resourceId: assignmentId,
      summary: `Accepted project "${a.project_name}"`,
      before: { status: 'pending' },
      after: updated[0],
      meta: { projectId: a.project_id },
    });

    const staff = await staffIds(['sales', 'pm', 'admin']);
    await notifyUsers(
      [...staff, a.created_by, a.assigned_by],
      'project_assignment_accepted',
      `${a.project_name}: developer accepted the assignment`,
      { projectId: a.project_id, assignmentId }
    );

    return updated[0];
  });
}

async function rejectAssignment({ assignmentId, developerId, actorRole, note = null }) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT a.*, p.name AS project_name, p.created_by
       FROM project_assignments a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1 FOR UPDATE OF a`,
      [assignmentId]
    );
    const a = rows[0];
    if (!a) throw new AppError('Assignment not found', 404, 'NOT_FOUND');
    if (a.developer_id !== developerId) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    if (a.status !== 'pending') throw new AppError('Invitation is no longer pending', 409, 'INVALID_STATE');

    const isSwapInvite = Boolean(a.original_developer_id && a.swap_of_assignment_id);

    const { rows: updated } = await tx.query(
      `UPDATE project_assignments
       SET status = 'rejected', note = COALESCE($2, note), decided_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [assignmentId, note]
    );

    if (isSwapInvite) {
      // Swap failed → auto-reassign back to original developer A
      const { rows: re } = await tx.query(
        `INSERT INTO project_assignments
          (project_id, developer_id, assigned_by, status, original_developer_id, note, decided_at)
         VALUES ($1, $2, $3, 'auto_reassigned', $2, 'Swap rejected or timed out - restored to original', NOW())
         RETURNING *`,
        [a.project_id, a.original_developer_id, a.assigned_by]
      );
      await tx.query(
        `UPDATE projects
         SET assigned_developer_id = $1, assignment_status = 'auto_reassigned', updated_at = NOW()
         WHERE id = $2`,
        [a.original_developer_id, a.project_id]
      );
      await recordAction({
        actorId: developerId,
        actorRole,
        action: 'assignment.swap_failed',
        resourceType: 'project_assignment',
        resourceId: assignmentId,
        summary: `Swap rejected for "${a.project_name}" - restored to original developer`,
        after: re[0],
        meta: { projectId: a.project_id, restoredTo: a.original_developer_id },
      });
      const staff = await staffIds(['sales', 'pm', 'admin']);
      await notifyUsers(
        [...staff, a.created_by, a.assigned_by, a.original_developer_id],
        'project_assignment_swap_failed',
        `${a.project_name}: swap rejected - restored to original developer`,
        { projectId: a.project_id }
      );
    } else {
      await tx.query(
        `UPDATE projects
         SET assigned_developer_id = NULL, assignment_status = 'rejected', updated_at = NOW()
         WHERE id = $1`,
        [a.project_id]
      );
      await recordAction({
        actorId: developerId,
        actorRole,
        action: 'assignment.reject',
        resourceType: 'project_assignment',
        resourceId: assignmentId,
        summary: `Rejected project "${a.project_name}"`,
        after: updated[0],
        meta: { projectId: a.project_id },
      });
      const staff = await staffIds(['sales', 'pm', 'admin']);
      await notifyUsers(
        [...staff, a.created_by, a.assigned_by],
        'project_assignment_rejected',
        `${a.project_name}: developer rejected the assignment - Sales can reassign`,
        { projectId: a.project_id }
      );
    }

    return updated[0];
  });
}

/**
 * Developer A nominates Developer B. Creates pending invite for B.
 */
async function swapAssignment({ assignmentId, developerId, nominateDeveloperId, actorRole, note = null }) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT a.*, p.name AS project_name, p.created_by
       FROM project_assignments a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1 FOR UPDATE OF a`,
      [assignmentId]
    );
    const a = rows[0];
    if (!a) throw new AppError('Assignment not found', 404, 'NOT_FOUND');
    if (a.developer_id !== developerId) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    if (a.status !== 'pending' && a.status !== 'accepted') {
      throw new AppError('Only pending or accepted assignments can be swapped', 409, 'INVALID_STATE');
    }
    if (nominateDeveloperId === developerId) {
      throw new AppError('Cannot swap to yourself', 400, 'VALIDATION');
    }

    const { rows: nominees } = await tx.query(
      `SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1 AND r.name = 'developer' AND u.status = 'active'`,
      [nominateDeveloperId]
    );
    if (!nominees[0]) throw new AppError('Nominated developer not found', 404, 'NOT_FOUND');

    await tx.query(
      `UPDATE project_assignments
       SET status = 'swapped', decided_at = NOW(), updated_at = NOW(), note = COALESCE($2, note)
       WHERE id = $1`,
      [assignmentId, note]
    );

    const { rows: invite } = await tx.query(
      `INSERT INTO project_assignments
        (project_id, developer_id, assigned_by, status, original_developer_id, swap_of_assignment_id, note, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, NOW() + ($7 || ' hours')::interval)
       RETURNING *`,
      [
        a.project_id,
        nominateDeveloperId,
        a.assigned_by || developerId,
        developerId,
        assignmentId,
        note || `Swap nominated by original invitee`,
        String(SWAP_HOURS),
      ]
    );

    await tx.query(
      `UPDATE projects
       SET assigned_developer_id = $1, assignment_status = 'pending', updated_at = NOW()
       WHERE id = $2`,
      [nominateDeveloperId, a.project_id]
    );

    await recordAction({
      actorId: developerId,
      actorRole,
      action: 'assignment.swap',
      resourceType: 'project_assignment',
      resourceId: invite[0].id,
      summary: `Swapped "${a.project_name}" to ${nominees[0].name}`,
      after: invite[0],
      meta: { projectId: a.project_id, from: developerId, to: nominateDeveloperId },
    });

    await notifyUsers(
      [nominateDeveloperId],
      'project_assignment',
      `Project swap invitation: "${a.project_name}" - Accept or Reject within ${SWAP_HOURS}h`,
      { projectId: a.project_id, assignmentId: invite[0].id }
    );
    const staff = await staffIds(['sales', 'pm', 'admin']);
    await notifyUsers(
      [...staff, a.created_by, a.assigned_by],
      'project_assignment_swap',
      `${a.project_name}: swap proposed to ${nominees[0].name}`,
      { projectId: a.project_id }
    );

    return invite[0];
  });
}

/** Expire pending swap invites older than expires_at → restore original */
async function expireStaleAssignments() {
  const { rows } = await query(
    `SELECT a.*
     FROM project_assignments a
     WHERE a.status = 'pending'
       AND a.expires_at IS NOT NULL
       AND a.expires_at < NOW()`
  );
  let n = 0;
  for (const a of rows) {
    try {
      await rejectAssignment({
        assignmentId: a.id,
        developerId: a.developer_id,
        actorRole: 'system',
        note: 'Timed out - auto rejected',
      });
      n += 1;
    } catch (e) {
      console.error('[assignments] expire failed', a.id, e.message);
    }
  }
  return { expired: n };
}

async function listForDeveloper(developerId) {
  const { rows } = await query(
    `SELECT a.*, p.name AS project_name, p.status AS project_status, p.summary,
            u.name AS assigned_by_name,
            o.name AS original_developer_name
     FROM project_assignments a
     JOIN projects p ON p.id = a.project_id
     LEFT JOIN users u ON u.id = a.assigned_by
     LEFT JOIN users o ON o.id = a.original_developer_id
     WHERE a.developer_id = $1
       AND a.status = 'pending'
       AND p.status NOT IN ('pending_approval', 'rejected')
     ORDER BY a.created_at DESC`,
    [developerId]
  );
  return rows;
}

async function historyForProject(projectId) {
  const { rows } = await query(
    `SELECT a.*,
            d.name AS developer_name,
            ab.name AS assigned_by_name,
            o.name AS original_developer_name
     FROM project_assignments a
     JOIN users d ON d.id = a.developer_id
     LEFT JOIN users ab ON ab.id = a.assigned_by
     LEFT JOIN users o ON o.id = a.original_developer_id
     WHERE a.project_id = $1
     ORDER BY a.created_at ASC`,
    [projectId]
  );
  return rows;
}

module.exports = {
  SWAP_HOURS,
  assignDeveloper,
  acceptAssignment,
  rejectAssignment,
  swapAssignment,
  expireStaleAssignments,
  listForDeveloper,
  historyForProject,
};
