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
 * Staff directory minus clients, filtered server-side.
 */
router.get(
  '/contacts',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'client') {
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
    if (req.user.role === 'client') {
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
      `SELECT id, conversation_id, sender_id, sent_at, read_at, delivered_at, edited_at, deleted_at,
              CASE WHEN deleted_at IS NULL THEN content ELSE '' END AS content
       FROM messages
       WHERE conversation_id = $1 AND NOT ($2 = ANY(deleted_for))
       ORDER BY sent_at ASC`,
      [req.params.id, req.user.id]
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

    let message = rows[0];
    try {
      const { deliverIfOnline } = require('../realtime/socket');
      message = await deliverIfOnline(message, conv[0].participant_ids);
    } catch {
      // realtime optional
    }
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

    // Clears the chat for this user only: the other person keeps their history
    // (it used to permanently delete the messages for both people).
    const { rowCount } = await query(
      `UPDATE messages SET deleted_for = array_append(deleted_for, $2::uuid)
       WHERE conversation_id = $1 AND NOT ($2 = ANY(deleted_for))`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true, data: { cleared: true, hidden: rowCount } });
  })
);

const EDIT_WINDOW_MS = 30 * 60 * 1000;

/** The message plus its conversation, if this user is a participant. */
async function messageForParticipant(messageId, userId) {
  const { rows } = await query(
    `SELECT m.*, c.participant_ids
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = $1 AND $2 = ANY(c.participant_ids)`,
    [messageId, userId]
  );
  if (!rows[0]) throw new AppError('Message not found', 404, 'NOT_FOUND');
  return rows[0];
}

function emitToConversation(conversationId, participantIds, event, payload) {
  try {
    const { getIo, conversationRoom, userRoom } = require('../realtime/socket');
    const io = getIo();
    if (!io) return;
    io.to(conversationRoom(conversationId)).emit(event, payload);
    for (const p of participantIds) io.to(userRoom(p)).emit(event, payload);
  } catch {
    // realtime optional
  }
}

/**
 * GET /api/messages/presence - which staff are online now (fallback when the
 * socket is down; normally presence arrives over the socket).
 */
router.get(
  '/presence',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'client') return res.json({ ok: true, data: [] });
    const { onlineUserIds } = require('../realtime/socket');
    res.json({ ok: true, data: onlineUserIds() });
  })
);

/**
 * POST /api/messages/conversations/:id/read - the user has seen this chat:
 * everything the others sent becomes read (blue ticks for them).
 */
router.post(
  '/conversations/:id/read',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    const { rows: conv } = await query(
      `SELECT id FROM conversations WHERE id = $1 AND $2 = ANY(participant_ids)`,
      [req.params.id, req.user.id]
    );
    if (!conv[0]) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
    const { rows } = await query(
      `UPDATE messages
       SET read_at = NOW(), delivered_at = COALESCE(delivered_at, NOW())
       WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL AND deleted_at IS NULL
       RETURNING id, conversation_id, sender_id, read_at, delivered_at`,
      [req.params.id, req.user.id]
    );
    if (rows.length) {
      try {
        const { emitMessageStatus } = require('../realtime/socket');
        emitMessageStatus(rows, { read_at: rows[0].read_at, delivered_at: rows[0].delivered_at });
      } catch {
        // realtime optional
      }
    }
    res.json({ ok: true, data: { read: rows.length } });
  })
);

/**
 * PATCH /api/messages/:id - edit your own message, within 30 minutes of sending.
 */
router.patch(
  '/:id',
  requirePermission('messages', 'create'),
  asyncHandler(async (req, res) => {
    const content = String(req.body?.content || '').trim();
    if (!content) throw new AppError('content required', 400, 'VALIDATION');
    const msg = await messageForParticipant(req.params.id, req.user.id);
    if (msg.sender_id !== req.user.id) throw new AppError('You can only edit your own messages', 403, 'FORBIDDEN');
    if (msg.deleted_at) throw new AppError('This message was deleted', 409, 'DELETED');
    if (Date.now() - new Date(msg.sent_at).getTime() > EDIT_WINDOW_MS) {
      throw new AppError('Messages can only be edited for 30 minutes after sending', 409, 'EDIT_WINDOW_PASSED');
    }
    const { rows } = await query(
      `UPDATE messages SET content = $2, edited_at = NOW() WHERE id = $1
       RETURNING id, conversation_id, sender_id, content, sent_at, read_at, delivered_at, edited_at, deleted_at`,
      [msg.id, content]
    );
    emitToConversation(msg.conversation_id, msg.participant_ids, 'message:update', rows[0]);
    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * DELETE /api/messages/:id?scope=me|everyone
 *   me       - hide it for this user only (any message in their chat)
 *   everyone - sender only: the text is removed for all participants
 */
router.delete(
  '/:id',
  requirePermission('messages', 'view'),
  asyncHandler(async (req, res) => {
    const scope = req.query.scope === 'everyone' ? 'everyone' : 'me';
    const msg = await messageForParticipant(req.params.id, req.user.id);

    if (scope === 'me') {
      await query(
        `UPDATE messages SET deleted_for = array_append(deleted_for, $2::uuid)
         WHERE id = $1 AND NOT ($2 = ANY(deleted_for))`,
        [msg.id, req.user.id]
      );
      return res.json({ ok: true, data: { id: msg.id, scope } });
    }

    if (msg.sender_id !== req.user.id) {
      throw new AppError('Only the sender can delete a message for everyone', 403, 'FORBIDDEN');
    }
    const { rows } = await query(
      `UPDATE messages SET content = '', deleted_at = COALESCE(deleted_at, NOW()) WHERE id = $1
       RETURNING id, conversation_id, sender_id, content, sent_at, read_at, delivered_at, edited_at, deleted_at`,
      [msg.id]
    );
    emitToConversation(msg.conversation_id, msg.participant_ids, 'message:update', rows[0]);
    res.json({ ok: true, data: { ...rows[0], scope } });
  })
);

module.exports = router;
