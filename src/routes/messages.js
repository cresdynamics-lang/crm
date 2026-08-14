const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { canMessage } = require('../lib/messagingMatrix');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/messages/contacts
 * Contact list filtered SERVER-SIDE by messaging matrix.
 * A developer's request never receives client records.
 * Finance gets empty list (notification feed only).
 */
router.get(
  '/contacts',
  asyncHandler(async (req, res) => {
    // Finance / clients: no Community chat - empty list, not a leakable contact dump
    if (req.user.role === 'finance' || req.user.role === 'client') {
      return res.json({ ok: true, data: [], meta: { reason: 'role_has_no_community_chat' } });
    }

    if (!req.user.permissions.includes('messages:view')) {
      throw new AppError('Forbidden: missing permission messages:view', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.avatar_url, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.status = 'active'
         AND u.id <> $1
         AND r.name <> 'client'`,
      [req.user.id]
    );

    const filtered = rows.filter((u) => canMessage(req.user.role, u.role));
    res.json({ ok: true, data: filtered });
  })
);

router.get(
  '/conversations',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'finance' || req.user.role === 'client') {
      return res.json({ ok: true, data: [] });
    }

    const { rows } = await query(
      `SELECT c.*
       FROM conversations c
       WHERE $1 = ANY(c.participant_ids)
         AND NOT ($1 = ANY(c.archived_by))
       ORDER BY c.updated_at DESC`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/conversations',
  requirePermission('messages', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { participant_id } = req.body || {};
    if (!participant_id) throw new AppError('participant_id required', 400, 'VALIDATION');

    const { rows: others } = await query(
      `SELECT u.id, r.name AS role FROM users u
       JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [participant_id]
    );
    const other = others[0];
    if (!other) throw new AppError('User not found', 404, 'NOT_FOUND');
    if (!canMessage(req.user.role, other.role)) {
      throw new AppError('Messaging not allowed between these roles', 403, 'FORBIDDEN');
    }

    const existing = await query(
      `SELECT * FROM conversations
       WHERE participant_ids @> ARRAY[$1::uuid, $2::uuid]
         AND cardinality(participant_ids) = 2
       LIMIT 1`,
      [req.user.id, participant_id]
    );
    if (existing.rows[0]) {
      return res.json({ ok: true, data: existing.rows[0] });
    }

    const { rows } = await query(
      `INSERT INTO conversations (participant_ids)
       VALUES (ARRAY[$1::uuid, $2::uuid])
       RETURNING *`,
      [req.user.id, participant_id]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/conversations/:id/messages',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    const { rows: conv } = await query(
      `SELECT * FROM conversations WHERE id = $1 AND $2 = ANY(participant_ids)`,
      [req.params.id, req.user.id]
    );
    if (!conv[0]) throw new AppError('Conversation not found', 404, 'NOT_FOUND');

    const { rows } = await query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at ASC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/conversations/:id/messages',
  requirePermission('messages', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { content } = req.body || {};
    if (!content?.trim()) throw new AppError('content required', 400, 'VALIDATION');

    const { rows: conv } = await query(
      `SELECT * FROM conversations WHERE id = $1 AND $2 = ANY(participant_ids)`,
      [req.params.id, req.user.id]
    );
    if (!conv[0]) throw new AppError('Conversation not found', 404, 'NOT_FOUND');

    const { rows } = await query(
      `INSERT INTO messages (conversation_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.id, req.user.id, content.trim()]
    );
    await query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [req.params.id]);

    const message = rows[0];
    try {
      const { getIo, conversationRoom, userRoom, emitNotification } = require('../realtime/socket');
      const io = getIo();
      if (io) {
        io.to(conversationRoom(req.params.id)).emit('message:new', message);
        for (const participantId of conv[0].participant_ids) {
          if (participantId === req.user.id) continue;
          io.to(userRoom(participantId)).emit('message:new', message);
          const { rows: n } = await query(
            `INSERT INTO notifications (user_id, type, content, meta)
             VALUES ($1, 'new_message', $2, $3)
             RETURNING *`,
            [
              participantId,
              `New message from ${req.user.name}`,
              JSON.stringify({ conversationId: req.params.id, messageId: message.id }),
            ]
          );
          emitNotification(participantId, n[0]);
        }
      }
    } catch {
      // realtime optional
    }

    res.status(201).json({ ok: true, data: message });
  })
);

router.post(
  '/conversations/:id/mute',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE conversations
       SET muted_by = CASE
         WHEN $2 = ANY(muted_by) THEN muted_by
         ELSE array_append(muted_by, $2::uuid)
       END
       WHERE id = $1 AND $2 = ANY(participant_ids)
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/conversations/:id/archive',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE conversations
       SET archived_by = CASE
         WHEN $2 = ANY(archived_by) THEN archived_by
         ELSE array_append(archived_by, $2::uuid)
       END
       WHERE id = $1 AND $2 = ANY(participant_ids)
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.post(
  '/conversations/:id/clear',
  requirePermission('messages', 'create'),
  asyncHandler(async (req, res) => {
    const { rows: conv } = await query(
      `SELECT * FROM conversations WHERE id = $1 AND $2 = ANY(participant_ids)`,
      [req.params.id, req.user.id]
    );
    if (!conv[0]) throw new AppError('Conversation not found', 404, 'NOT_FOUND');

    await query(`DELETE FROM messages WHERE conversation_id = $1`, [req.params.id]);
    res.json({ ok: true, data: { cleared: true } });
  })
);

module.exports = router;
