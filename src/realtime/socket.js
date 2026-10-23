/**
 * Socket.io realtime layer - messages + notification push.
 * Auth: JWT in handshake; role re-verified from DB (same rule as HTTP).
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { findActiveUserById, loadUserPermissions } = require('../services/authService');
const { query } = require('../config/database');
const { canMessage, STAFF_ROLES } = require('../lib/messagingMatrix');

let io = null;
const liveCalls = new Map();

function isStaffRole(role) {
  return (STAFF_ROLES || []).includes(role);
}

function getIo() {
  return io;
}

function userRoom(userId) {
  return `user:${userId}`;
}

function conversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}

function roleRoom(role) {
  return `role:${role}`;
}

function initSocket(server) {
  io = new Server(server, {
    cors: { origin: true, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('AUTH_REQUIRED'));

      let payload;
      try {
        payload = jwt.verify(token, config.jwt.secret);
      } catch {
        return next(new Error('AUTH_TOKEN_INVALID'));
      }

      const user = await findActiveUserById(payload.sub);
      if (!user || user.status !== 'active') return next(new Error('AUTH_USER_INACTIVE'));

      const permissions = await loadUserPermissions(user.role_id);
      socket.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        permissions,
      };
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    socket.join(userRoom(socket.user.id));
    socket.join(roleRoom(socket.user.role));
    socket.emit('realtime:ready', {
      userId: socket.user.id,
      role: socket.user.role,
    });

    socket.on('conversation:join', async (conversationId, ack) => {
      try {
        const { rows } = await query(
          `SELECT id FROM conversations
           WHERE id = $1 AND $2 = ANY(participant_ids)`,
          [conversationId, socket.user.id]
        );
        if (!rows[0]) {
          if (typeof ack === 'function') ack({ ok: false, error: 'FORBIDDEN' });
          return;
        }
        socket.join(conversationRoom(conversationId));
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('conversation:leave', (conversationId) => {
      socket.leave(conversationRoom(conversationId));
    });

    socket.on('message:send', async (payload, ack) => {
      try {
        if (socket.user.role === 'client') {
          throw new Error('ROLE_NO_CHAT');
        }
        if (!socket.user.permissions.includes('messages:create')) {
          throw new Error('FORBIDDEN');
        }

        const { conversationId, content } = payload || {};
        if (!conversationId || !content?.trim()) throw new Error('VALIDATION');

        const { rows: conv } = await query(
          `SELECT * FROM conversations WHERE id = $1 AND $2 = ANY(participant_ids)`,
          [conversationId, socket.user.id]
        );
        if (!conv[0]) throw new Error('FORBIDDEN');

        const { rows } = await query(
          `INSERT INTO messages (conversation_id, sender_id, content)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [conversationId, socket.user.id, content.trim()]
        );
        await query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);

        const message = rows[0];
        io.to(conversationRoom(conversationId)).emit('message:new', message);

        // Notify other participants (in-app + socket)
        for (const participantId of conv[0].participant_ids) {
          if (participantId === socket.user.id) continue;
          io.to(userRoom(participantId)).emit('message:new', message);

          const prefs = await query(
            `SELECT notify_new_message FROM user_settings WHERE user_id = $1`,
            [participantId]
          );
          const allow = prefs.rows[0]?.notify_new_message !== false;
          if (allow) {
            const { rows: n } = await query(
              `INSERT INTO notifications (user_id, type, content, meta)
               VALUES ($1, 'new_message', $2, $3)
               RETURNING *`,
              [
                participantId,
                `New message from ${socket.user.name}`,
                JSON.stringify({ conversationId, messageId: message.id }),
              ]
            );
            io.to(userRoom(participantId)).emit('notification:new', n[0]);
          }
        }

        if (typeof ack === 'function') ack({ ok: true, data: message });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('call:invite', (payload = {}) => {
      const to = payload.to;
      const kind = ['audio', 'video', 'screen'].includes(payload.kind) ? payload.kind : 'audio';
      if (!to || to === socket.user.id) return;
      if (!isStaffRole(socket.user.role)) return;
      const callId = String(payload.callId || '').trim();
      if (!callId) return;
      liveCalls.set(callId, { from: socket.user.id, to, kind });
      io.to(userRoom(to)).emit('call:invite', {
        callId,
        from: socket.user.id,
        fromName: socket.user.name,
        fromRole: socket.user.role,
        kind,
        conversationId: payload.conversationId || null,
      });
    });

    socket.on('call:accept', (payload = {}) => {
      const call = liveCalls.get(payload.callId);
      if (!call || call.to !== socket.user.id) return;
      io.to(userRoom(call.from)).emit('call:accept', {
        callId: payload.callId,
        from: socket.user.id,
      });
    });

    socket.on('call:reject', (payload = {}) => {
      const call = liveCalls.get(payload.callId);
      if (!call || (call.to !== socket.user.id && call.from !== socket.user.id)) return;
      const other = call.from === socket.user.id ? call.to : call.from;
      liveCalls.delete(payload.callId);
      io.to(userRoom(other)).emit('call:reject', { callId: payload.callId });
    });

    socket.on('call:offer', (payload = {}) => {
      const call = liveCalls.get(payload.callId);
      if (!call || (call.from !== socket.user.id && call.to !== socket.user.id)) return;
      const other = call.from === socket.user.id ? call.to : call.from;
      io.to(userRoom(other)).emit('call:offer', {
        callId: payload.callId,
        sdp: payload.sdp,
      });
    });

    socket.on('call:answer', (payload = {}) => {
      const call = liveCalls.get(payload.callId);
      if (!call || (call.from !== socket.user.id && call.to !== socket.user.id)) return;
      const other = call.from === socket.user.id ? call.to : call.from;
      io.to(userRoom(other)).emit('call:answer', {
        callId: payload.callId,
        sdp: payload.sdp,
      });
    });

    socket.on('call:ice', (payload = {}) => {
      const call = liveCalls.get(payload.callId);
      if (!call || (call.from !== socket.user.id && call.to !== socket.user.id)) return;
      const other = call.from === socket.user.id ? call.to : call.from;
      io.to(userRoom(other)).emit('call:ice', {
        callId: payload.callId,
        candidate: payload.candidate,
      });
    });

    socket.on('call:hangup', (payload = {}) => {
      const call = liveCalls.get(payload.callId);
      if (!call) return;
      if (call.from !== socket.user.id && call.to !== socket.user.id) return;
      const other = call.from === socket.user.id ? call.to : call.from;
      liveCalls.delete(payload.callId);
      io.to(userRoom(other)).emit('call:hangup', { callId: payload.callId });
    });

    socket.on('disconnect', () => {
      for (const [callId, call] of liveCalls) {
        if (call.from === socket.user.id || call.to === socket.user.id) {
          const other = call.from === socket.user.id ? call.to : call.from;
          liveCalls.delete(callId);
          io.to(userRoom(other)).emit('call:hangup', { callId, reason: 'disconnect' });
        }
      }
    });
  });

  return io;
}

function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
}

function emitToRole(role, event, payload) {
  if (!io) return;
  io.to(roleRoom(role)).emit(event, payload);
}

function emitNotification(userId, notification) {
  emitToUser(userId, 'notification:new', notification);
}

module.exports = {
  initSocket,
  getIo,
  emitToUser,
  emitToRole,
  emitNotification,
  userRoom,
  conversationRoom,
  roleRoom,
  canMessage,
};
