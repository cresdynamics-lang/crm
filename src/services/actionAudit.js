/**
 * Append-only action audit for meaningful writes across the system.
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

module.exports = { recordAction };
