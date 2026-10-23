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
/** meetingId -> Map(socketId -> { userId, name, isHost, audio, video, screen, locked, hand }) */
const meetingRooms = new Map();
/** meetingId -> Set(userId) the host has muted; survives leaving and rejoining. */
const meetingLocks = new Map();

function mediaState(meetingId, socketId, m) {
  return {
    meetingId, socketId,
    audio: m.audio, video: m.video, screen: m.screen, locked: m.locked, hand: m.hand,
  };
}

function meetingRoom(meetingId) {
  return `meeting:${meetingId}`;
}

function leaveMeeting(socket, meetingId) {
  const room = meetingRooms.get(meetingId);
  if (!room || !room.has(socket.id)) return;
  room.delete(socket.id);
  socket.leave(meetingRoom(meetingId));
  io.to(meetingRoom(meetingId)).emit('meeting:peer-left', { meetingId, socketId: socket.id });
  if (!room.size) meetingRooms.delete(meetingId);
}

/** Host ended the meeting: tell everyone in it and close the room. */
function endMeetingRoom(meetingId) {
  if (!io) return;
  io.to(meetingRoom(meetingId)).emit('meeting:ended', { meetingId });
  io.in(meetingRoom(meetingId)).socketsLeave(meetingRoom(meetingId));
  meetingRooms.delete(meetingId);
  meetingLocks.delete(meetingId);
}

/** userId -> number of open sockets (a user may have several tabs). */
const onlineCounts = new Map();

function isOnline(userId) {
  return (onlineCounts.get(userId) || 0) > 0;
}

function onlineUserIds() {
  return [...onlineCounts.keys()].filter(isOnline);
}

/** Presence goes to staff only; clients never learn who is online. */
function emitToStaff(event, payload) {
  if (!io) return;
  for (const role of STAFF_ROLES || []) io.to(roleRoom(role)).emit(event, payload);
}

/**
 * Tell each sender (and anyone viewing the chat) that their messages moved on:
 * { conversationId, ids, delivered_at?, read_at? }.
 */
function emitMessageStatus(rows, patch) {
  if (!io || !rows.length) return;
  const byConversation = new Map();
  for (const r of rows) {
    const key = r.conversation_id;
    if (!byConversation.has(key)) byConversation.set(key, { ids: [], senders: new Set() });
    byConversation.get(key).ids.push(r.id);
    byConversation.get(key).senders.add(r.sender_id);
  }
  for (const [conversationId, { ids, senders }] of byConversation) {
    const payload = { conversationId, ids, ...patch };
    io.to(conversationRoom(conversationId)).emit('message:status', payload);
    for (const s of senders) io.to(userRoom(s)).emit('message:status', payload);
  }
}

/** Mark a just-sent message delivered if any other participant is online now. */
async function deliverIfOnline(message, participantIds) {
  const someoneOnline = (participantIds || []).some((id) => id !== message.sender_id && isOnline(id));
  if (!someoneOnline) return message;
  const { rows } = await query(
    `UPDATE messages SET delivered_at = NOW() WHERE id = $1 AND delivered_at IS NULL RETURNING delivered_at`,
    [message.id]
  );
  return rows[0] ? { ...message, delivered_at: rows[0].delivered_at } : message;
}

/** When a user connects, everything waiting for them counts as delivered. */
async function deliverPendingFor(userId) {
  const { rows } = await query(
    `UPDATE messages m SET delivered_at = NOW()
     FROM conversations c
     WHERE m.conversation_id = c.id
       AND $1 = ANY(c.participant_ids)
       AND m.sender_id <> $1
       AND m.delivered_at IS NULL
       AND m.deleted_at IS NULL
     RETURNING m.id, m.conversation_id, m.sender_id, m.delivered_at`,
    [userId]
  );
  if (rows.length) emitMessageStatus(rows, { delivered_at: rows[0].delivered_at });
}

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
    // Same rule as the HTTP API: only our own site(s) may open a live connection.
    cors: {
      origin(origin, cb) {
        const allowed = (process.env.CORS_ORIGINS || process.env.PUBLIC_APP_URL || 'https://cresos.cresdynamics.com')
          .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
        const ok = !origin || allowed.includes(origin.replace(/\/+$/, '')) ||
          (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
        cb(null, ok);
      },
      credentials: true,
    },
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

    // Presence (staff only) and delivery of anything that arrived while away.
    if (isStaffRole(socket.user.role)) {
      const wasOnline = isOnline(socket.user.id);
      onlineCounts.set(socket.user.id, (onlineCounts.get(socket.user.id) || 0) + 1);
      socket.emit('presence:list', onlineUserIds());
      if (!wasOnline) emitToStaff('presence:update', { userId: socket.user.id, online: true });
      deliverPendingFor(socket.user.id).catch(() => {});
      socket.on('disconnect', () => {
        const left = (onlineCounts.get(socket.user.id) || 1) - 1;
        if (left > 0) {
          onlineCounts.set(socket.user.id, left);
        } else {
          onlineCounts.delete(socket.user.id);
          emitToStaff('presence:update', { userId: socket.user.id, online: false, lastSeen: new Date().toISOString() });
        }
      });
    }

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

    // ----- Meetings: many-to-many WebRTC signalling (mesh) -----
    socket.on('meeting:join', async (payload = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { meetingAccess } = require('../services/meetingService');
        const meetingId = String(payload.meetingId || '');
        const access = await meetingAccess(meetingId, socket.user.id);
        if (!access.canEnter) return reply({ ok: false, error: 'NOT_ADMITTED' });
        if (access.meeting.status === 'ended') return reply({ ok: false, error: 'ENDED' });
        if (access.meeting.status !== 'live') {
          if (!access.isHost) return reply({ ok: false, error: 'NOT_STARTED' });
          await query(
            `UPDATE meetings SET status = 'live', started_at = COALESCE(started_at, NOW()) WHERE id = $1`,
            [meetingId]
          );
        }
        if (!meetingRooms.has(meetingId)) meetingRooms.set(meetingId, new Map());
        const room = meetingRooms.get(meetingId);
        const peers = [...room.entries()].map(([socketId, p]) => ({ socketId, ...p }));
        const locked = !access.isHost && Boolean(meetingLocks.get(meetingId)?.has(socket.user.id));
        const me = {
          userId: socket.user.id,
          name: socket.user.name,
          isHost: access.isHost,
          audio: payload.audio !== false && !locked,
          video: payload.video !== false,
          screen: false,
          locked,
          hand: false,
        };
        room.set(socket.id, me);
        socket.join(meetingRoom(meetingId));
        socket.to(meetingRoom(meetingId)).emit('meeting:peer-joined', { meetingId, socketId: socket.id, ...me });
        reply({
          ok: true, socketId: socket.id, peers, isHost: access.isHost, locked,
          title: access.meeting.title, minutesEnabled: access.meeting.minutes_enabled,
        });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    // Offer / answer / ICE, only between two sockets in the same meeting.
    socket.on('meeting:signal', (payload = {}) => {
      const room = meetingRooms.get(String(payload.meetingId || ''));
      if (!room || !room.has(socket.id) || !room.has(payload.to)) return;
      io.to(payload.to).emit('meeting:signal', { meetingId: payload.meetingId, from: socket.id, data: payload.data });
    });

    // Camera / mic / screen on-off, so tiles show the right state.
    socket.on('meeting:media', (payload = {}) => {
      const meetingId = String(payload.meetingId || '');
      const room = meetingRooms.get(meetingId);
      const me = room?.get(socket.id);
      if (!me) return;
      for (const k of ['audio', 'video', 'screen']) if (typeof payload[k] === 'boolean') me[k] = payload[k];
      // Muted by the host: the mic stays off whatever this client says.
      if (me.locked && me.audio) {
        me.audio = false;
        socket.emit('meeting:lock', { meetingId, locked: true });
      }
      socket.to(meetingRoom(meetingId)).emit('meeting:media', mediaState(meetingId, socket.id, me));
    });

    // Notes anyone in the meeting writes; everyone sees them live.
    socket.on('meeting:note', async (payload = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const meetingId = String(payload.meetingId || '');
      if (!meetingRooms.get(meetingId)?.has(socket.id)) return reply({ ok: false, error: 'NOT_IN_MEETING' });
      try {
        const { addNote } = require('../services/meetingMinutes');
        const note = await addNote({ meetingId, user: socket.user, content: payload.content });
        if (note) io.to(meetingRoom(meetingId)).emit('meeting:note', { meetingId, note });
        reply({ ok: Boolean(note) });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    // A line of what this person said, from their own browser, while minutes are on.
    socket.on('meeting:transcript', async (payload = {}) => {
      const meetingId = String(payload.meetingId || '');
      const me = meetingRooms.get(meetingId)?.get(socket.id);
      if (!me || me.locked || !me.audio) return;
      try {
        const { rows } = await query(`SELECT minutes_enabled FROM meetings WHERE id = $1`, [meetingId]);
        if (!rows[0]?.minutes_enabled) return;
        const { addTranscriptLine } = require('../services/meetingMinutes');
        const line = await addTranscriptLine({ meetingId, user: socket.user, text: payload.text });
        if (line) io.to(meetingRoom(meetingId)).emit('meeting:transcript', { meetingId, line });
      } catch {
        // a lost line is not worth failing the call over
      }
    });

    // Host switches minutes (live transcription) on or off; everyone is told.
    socket.on('meeting:minutes', async (payload = {}) => {
      const meetingId = String(payload.meetingId || '');
      if (!meetingRooms.get(meetingId)?.get(socket.id)?.isHost) return;
      const enabled = Boolean(payload.enabled);
      await query(`UPDATE meetings SET minutes_enabled = $2 WHERE id = $1`, [meetingId, enabled]).catch(() => {});
      io.to(meetingRoom(meetingId)).emit('meeting:minutes', { meetingId, enabled, by: socket.user.name });
    });

    // Raise / lower hand (to ask the host for the mic).
    socket.on('meeting:hand', (payload = {}) => {
      const meetingId = String(payload.meetingId || '');
      const me = meetingRooms.get(meetingId)?.get(socket.id);
      if (!me) return;
      me.hand = Boolean(payload.up);
      io.to(meetingRoom(meetingId)).emit('meeting:media', mediaState(meetingId, socket.id, me));
    });

    /**
     * Host mutes (locks) or releases someone, or everyone: { meetingId, target: socketId | 'all', locked }.
     * A locked participant cannot unmute until the host releases them; every
     * other participant's browser also silences them while locked.
     */
    socket.on('meeting:host-mute', (payload = {}) => {
      const meetingId = String(payload.meetingId || '');
      const room = meetingRooms.get(meetingId);
      const host = room?.get(socket.id);
      if (!host?.isHost) return;
      const locked = payload.locked !== false;
      if (!meetingLocks.has(meetingId)) meetingLocks.set(meetingId, new Set());
      const locks = meetingLocks.get(meetingId);
      const targets = payload.target === 'all'
        ? [...room.entries()].filter(([, m]) => !m.isHost)
        : [[payload.target, room.get(payload.target)]].filter(([, m]) => m && !m.isHost);
      for (const [sid, m] of targets) {
        m.locked = locked;
        if (locked) {
          m.audio = false;
          locks.add(m.userId);
        } else {
          locks.delete(m.userId);
        }
        m.hand = false;
        io.to(sid).emit('meeting:lock', { meetingId, locked, by: host.name });
        io.to(meetingRoom(meetingId)).emit('meeting:media', mediaState(meetingId, sid, m));
      }
    });

    socket.on('meeting:leave', (payload = {}) => leaveMeeting(socket, String(payload.meetingId || '')));
    socket.on('disconnect', () => {
      for (const meetingId of [...meetingRooms.keys()]) leaveMeeting(socket, meetingId);
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

        const message = await deliverIfOnline(rows[0], conv[0].participant_ids);
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
  emitToStaff,
  emitMessageStatus,
  endMeetingRoom,
  deliverIfOnline,
  isOnline,
  onlineUserIds,
  userRoom,
  conversationRoom,
  roleRoom,
  canMessage,
};
