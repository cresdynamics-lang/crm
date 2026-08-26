/**
 * Append-only action audit for meaningful writes across the system.
 * Extended with queryAudit for the Data Pool / RAG system.
 */
const { query } = require('../config/database');

async function recordAction({
  actorId = null,
  actorRole = null,
  action,
  resourceType,
  resourceId = null,
  summary,
  before = null,
  after = null,
  meta = {},
}) {
  try {
    await query(
      `INSERT INTO action_audit_log
        (actor_id, actor_role, action, resource_type, resource_id, summary, before_state, after_state, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)`,
      [
        actorId,
        actorRole,
        action,
        resourceType,
        resourceId,
        summary,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        JSON.stringify(meta || {}),
      ]
    );
  } catch (err) {
    console.error('[actionAudit] failed', err.message);
  }
}

/**
 * Query audit log entries with filters.
 */
async function queryAudit({ resourceType, resourceId, actorId, action, limit = 100, offset = 0 }) {
  const params = [];
  const clauses = [];

  if (resourceType) { params.push(resourceType); clauses.push(`resource_type = $${params.length}`); }
  if (resourceId) { params.push(resourceId); clauses.push(`resource_id = $${params.length}`); }
  if (actorId) { params.push(actorId); clauses.push(`actor_id = $${params.length}`); }
  if (action) { params.push(action); clauses.push(`action = $${params.length}`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name, u.avatar_url AS actor_avatar_url
     FROM action_audit_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

module.exports = { recordAction, queryAudit };
