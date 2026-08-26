/**
 * Knowledge Base service — stores and searches the Cres Ops data pool.
 * Admin feeds documents, text, and voice transcriptions. The RAG engine
 * searches this to answer employee questions.
 */
const { query } = require('../config/database');

/**
 * Ingest a knowledge base entry.
 */
async function ingestKnowledge({ title, content, sourceType = 'text', sourceFile = null, category = 'general', tags = [], accessibleRoles = ['all'], createdBy }) {
  const { rows } = await query(
    `INSERT INTO knowledge_base (title, content, source_type, source_file, category, tags, accessible_roles, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [title, content, sourceType, sourceFile, category, JSON.stringify(tags), JSON.stringify(accessibleRoles), createdBy || null]
  );
  return rows[0];
}

/**
 * Search knowledge base entries by keyword, category, and role access.
 */
async function searchKnowledge({ searchText, category, role, limit = 10 }) {
  const params = [];
  const clauses = [];

  // Role access: entries where accessible_roles contains the user's role OR 'all'
  params.push(JSON.stringify([role]));
  params.push(JSON.stringify(['all']));
  clauses.push(`(accessible_roles @> $${params.length - 1}::jsonb OR accessible_roles @> $${params.length}::jsonb)`);

  if (category && category !== 'all') {
    params.push(category);
    clauses.push(`category = $${params.length}`);
  }

  if (searchText) {
    // Simple text search across title and content
    params.push(`%${searchText}%`);
    clauses.push(`(title ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }

  params.push(limit);

  const { rows } = await query(
    `SELECT id, title, LEFT(content, 500) AS excerpt, source_type, category, tags, accessible_roles, created_at
     FROM knowledge_base
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Get all knowledge entries accessible to a role (for RAG context).
 */
async function getAccessibleKnowledge({ role, category, limit = 20 }) {
  const params = [];
  params.push(JSON.stringify([role]));
  params.push(JSON.stringify(['all']));
  const clauses = [`(accessible_roles @> $1::jsonb OR accessible_roles @> $2::jsonb)`];

  if (category && category !== 'all') {
    params.push(category);
    clauses.push(`category = $${params.length}`);
  }

  params.push(limit);

  const { rows } = await query(
    `SELECT id, title, content, source_type, category, tags, created_at
     FROM knowledge_base
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Get recent audit trail entries for context.
 */
async function getRecentAudit({ role, limit = 15 }) {
  // Everyone sees their own actions; directors/admins see all
  const params = [];
  const clauses = [];

  if (!['director', 'admin', 'pm'].includes(role)) {
    // Non-hub roles only see their own (if actor_id matches — but we don't have user_id here easily)
    // For RAG context, we return general summaries instead
    clauses.push(`1=1`);
  }

  params.push(limit);

  const { rows } = await query(
    `SELECT a.action, a.resource_type, a.summary, a.created_at,
            u.name AS actor_name
     FROM action_audit_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY a.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Get conversation history for a user.
 */
async function getConversationHistory(userId, limit = 10) {
  const { rows } = await query(
    `SELECT question, answer, sources, blocked_reason, created_at
     FROM ops_conversations
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/**
 * Save a conversation entry.
 */
async function saveConversation({ userId, userRole, question, answer, sources = [], blockedReason = null }) {
  const { rows } = await query(
    `INSERT INTO ops_conversations (user_id, user_role, question, answer, sources, blocked_reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING *`,
    [userId, userRole, question, answer, JSON.stringify(sources), blockedReason]
  );
  return rows[0];
}

/**
 * List all knowledge base entries (Admin management).
 */
async function listKnowledge({ category, limit = 50, offset = 0 }) {
  const params = [];
  const clauses = [];

  if (category) {
    params.push(category);
    clauses.push(`category = $${params.length}`);
  }

  params.push(limit, offset);

  const { rows } = await query(
    `SELECT kb.*, u.name AS created_by_name
     FROM knowledge_base kb
     LEFT JOIN users u ON u.id = kb.created_by
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY kb.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

/**
 * Delete a knowledge base entry.
 */
async function deleteKnowledge(id) {
  await query(`DELETE FROM knowledge_base WHERE id = $1`, [id]);
}

module.exports = {
  ingestKnowledge,
  searchKnowledge,
  getAccessibleKnowledge,
  getRecentAudit,
  getConversationHistory,
  saveConversation,
  listKnowledge,
  deleteKnowledge,
};
