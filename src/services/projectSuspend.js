/**
 * Finance (and 3-penalty automation) can suspend a project so delivery stops
 * until the unpaid invoice is settled. Resume restores the prior status.
 */
const { query } = require('../config/database');
const { queueNotification } = require('../queues/jobs');

const MAX_INVOICE_PENALTIES = 3;
const SUSPENDABLE = ['approved', 'in_progress', 'blocked'];

async function actorForSystem() {
  const { rows } = await query(
    `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('finance', 'admin') AND u.status = 'active'
     ORDER BY CASE r.name WHEN 'finance' THEN 0 ELSE 1 END, u.created_at
     LIMIT 1`
  );
  return rows[0]?.id || null;
}

async function notifyProjectPeople(project, content, type, extraMeta = {}) {
  const ids = new Set();
  const { rows: staff } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('finance', 'admin', 'director', 'pm') AND u.status = 'active'`
  );
  staff.forEach((u) => ids.add(u.id));
  if (project.assigned_developer_id) ids.add(project.assigned_developer_id);
  if (project.created_by) ids.add(project.created_by);
  const meta = { projectId: project.id, href: '#/projects', ...extraMeta };
  for (const userId of ids) {
    await queueNotification({ userId, type, content, meta });
  }
}

async function writeAudit(projectId, actorUserId, actorRole, note, summary) {
  if (!actorUserId) return;
  await query(
    `INSERT INTO project_updates
       (project_id, updated_by, note, actor_role, change_summary, changes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      projectId,
      actorUserId,
      note || null,
      actorRole || 'finance',
      summary,
      JSON.stringify({ status: 'suspended', note: note || null }),
    ]
  );
}

async function suspendProject({
  projectId,
  actorUserId = null,
  actorRole = 'finance',
  reason,
  source = 'finance',
  invoiceId = null,
} = {}) {
  if (!projectId) return null;
  const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  const project = rows[0];
  if (!project) return null;
  if (project.status === 'suspended') return project;
  if (!SUSPENDABLE.includes(project.status)) return null;

  const why = String(reason || 'Suspended by Finance').trim().slice(0, 500);
  const { rows: updated } = await query(
    `UPDATE projects
     SET status = 'suspended',
         status_before_suspend = $2,
         suspended_at = NOW(),
         suspended_by = $3,
         suspend_reason = $4,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'suspended'
     RETURNING *`,
    [projectId, project.status, actorUserId || null, why]
  );
  const next = updated[0];
  if (!next) return project;

  await writeAudit(
    projectId,
    actorUserId,
    actorRole,
    why,
    source === 'penalty_cap' ? 'Suspended after 3 invoice penalties' : 'Suspended by Finance'
  );
  await notifyProjectPeople(
    next,
    source === 'penalty_cap'
      ? `${next.name} was suspended after 3 unpaid-invoice penalties. Delivery is paused.`
      : `${next.name} was suspended by Finance. Delivery is paused.`,
    'project_suspended',
    { invoiceId, href: invoiceId ? '#/invoices' : '#/projects' }
  );
  return next;
}

async function unsuspendProject({
  projectId,
  actorUserId,
  actorRole = 'finance',
  note,
} = {}) {
  if (!projectId) return null;
  const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  const project = rows[0];
  if (!project) return null;
  if (project.status !== 'suspended') return project;

  const restore = SUSPENDABLE.includes(project.status_before_suspend)
    ? project.status_before_suspend
    : 'in_progress';
  const why = String(note || 'Resumed by Finance').trim().slice(0, 500);
  const { rows: updated } = await query(
    `UPDATE projects
     SET status = $2,
         suspended_at = NULL,
         suspended_by = NULL,
         suspend_reason = NULL,
         status_before_suspend = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = 'suspended'
     RETURNING *`,
    [projectId, restore]
  );
  const next = updated[0];
  if (!next) return project;

  await writeAudit(projectId, actorUserId, actorRole, why, `Resumed (${restore})`);
  await notifyProjectPeople(
    next,
    `${next.name} was resumed by Finance. Delivery can continue.`,
    'project_resumed',
    { href: '#/projects' }
  );
  return next;
}

async function suspendProjectForInvoice(inv, { reason } = {}) {
  if (!inv?.project_id) return null;
  const actorUserId = await actorForSystem();
  return suspendProject({
    projectId: inv.project_id,
    actorUserId,
    actorRole: 'finance',
    reason:
      reason ||
      `Unpaid invoice ${inv.invoice_number || String(inv.id).slice(0, 8)} reached ${MAX_INVOICE_PENALTIES} overdue penalties`,
    source: 'penalty_cap',
    invoiceId: inv.id,
  });
}

module.exports = {
  MAX_INVOICE_PENALTIES,
  suspendProject,
  unsuspendProject,
  suspendProjectForInvoice,
};
