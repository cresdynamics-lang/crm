/**
 * Meetings - /api/meetings
 * Staff create meetings (start now or schedule) and invite people, who get an
 * email + in-app invite with a link. Anyone signed in who opens the link but
 * was not invited can ask to join; the host admits or denies them live.
 */
const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../lib/errors');
const {
  meetingAccess,
  participants,
  inviteUsers,
  iceServers,
} = require('../services/meetingService');
const { record, summarizeAndSend } = require('../services/meetingMinutes');

const router = express.Router();
router.use(authenticate);

function requireStaff(req) {
  if (req.user.role === 'client') throw new AppError('Only staff can create or manage meetings', 403, 'FORBIDDEN');
}

function baseUrl(req) {
  return process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
}

function realtime() {
  try {
    return require('../realtime/socket');
  } catch {
    return null;
  }
}

/** GET /api/meetings/config - ICE servers for the browser. */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: { iceServers: iceServers() } });
  })
);

/** GET /api/meetings/people - who can be invited. */
router.get(
  '/people',
  asyncHandler(async (req, res) => {
    requireStaff(req);
    const { rows } = await query(
      `SELECT u.id, u.name, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.status = 'active' AND u.id <> $1
       ORDER BY u.name`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  })
);

/** GET /api/meetings - my meetings (hosting or invited), live and upcoming first. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT m.id, m.title, m.status, m.scheduled_at, m.started_at, m.ended_at, m.host_id,
              u.name AS host_name, mp.status AS my_status,
              (SELECT COUNT(*)::int FROM meeting_participants x
                WHERE x.meeting_id = m.id AND x.status IN ('host','invited','admitted')) AS people
       FROM meetings m
       JOIN users u ON u.id = m.host_id
       JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = $1
       WHERE mp.status IN ('host','invited','admitted','pending')
         AND (m.status <> 'ended' OR m.ended_at > NOW() - INTERVAL '7 days')
       ORDER BY (m.status = 'live') DESC, (m.status = 'scheduled') DESC,
                COALESCE(m.scheduled_at, m.created_at) ASC
       LIMIT 100`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  })
);

/** POST /api/meetings { title, scheduled_at?, start_now?, invitee_ids? } */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    requireStaff(req);
    const title = String(req.body?.title || '').trim().slice(0, 200) || `${req.user.name}'s meeting`;
    const startNow = Boolean(req.body?.start_now) || !req.body?.scheduled_at;
    let scheduledAt = null;
    if (!startNow) {
      scheduledAt = new Date(req.body.scheduled_at);
      if (Number.isNaN(scheduledAt.getTime())) throw new AppError('Invalid scheduled time', 400, 'VALIDATION');
    }
    const { rows } = await query(
      `INSERT INTO meetings (title, host_id, status, scheduled_at, started_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, req.user.id, startNow ? 'live' : 'scheduled', scheduledAt, startNow ? new Date() : null]
    );
    const meeting = rows[0];
    await query(
      `INSERT INTO meeting_participants (meeting_id, user_id, status, invited_by) VALUES ($1, $2, 'host', $2)`,
      [meeting.id, req.user.id]
    );
    const invited = await inviteUsers({
      meeting,
      userIds: req.body?.invitee_ids,
      invitedBy: req.user.id,
      inviterName: req.user.name,
      baseUrl: baseUrl(req),
    });
    res.status(201).json({ ok: true, data: { ...meeting, invited } });
  })
);

/**
 * GET /api/meetings/:id - full details for participants; for anyone else
 * signed in, just enough to ask to join.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    const m = access.meeting;
    const base = {
      id: m.id,
      title: m.title,
      status: m.status,
      scheduled_at: m.scheduled_at,
      started_at: m.started_at,
      host_id: m.host_id,
      host_name: m.host_name,
      my_status: access.status,
      can_enter: access.canEnter,
      is_host: access.isHost,
      minutes_enabled: m.minutes_enabled,
      // Minutes are shown to the people who were in it, once written.
      summary: access.canEnter ? m.summary : null,
    };
    if (!access.canEnter && access.status !== 'pending') return res.json({ ok: true, data: base });
    res.json({ ok: true, data: { ...base, participants: await participants(m.id) } });
  })
);

/** POST /api/meetings/:id/invite { user_ids } - host invites more people. */
router.post(
  '/:id/invite',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    if (!access.isHost) throw new AppError('Only the host can invite people', 403, 'FORBIDDEN');
    if (access.meeting.status === 'ended') throw new AppError('This meeting has ended', 409, 'ENDED');
    const invited = await inviteUsers({
      meeting: access.meeting,
      userIds: req.body?.user_ids,
      invitedBy: req.user.id,
      inviterName: req.user.name,
      baseUrl: baseUrl(req),
    });
    res.json({ ok: true, data: invited });
  })
);

/** POST /api/meetings/:id/start - host opens a scheduled meeting. */
router.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    if (!access.isHost) throw new AppError('Only the host can start the meeting', 403, 'FORBIDDEN');
    if (access.meeting.status === 'ended') throw new AppError('This meeting has ended', 409, 'ENDED');
    const { rows } = await query(
      `UPDATE meetings SET status = 'live', started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING *`,
      [access.meeting.id]
    );
    const rt = realtime();
    if (rt) {
      const people = await participants(access.meeting.id);
      for (const p of people) {
        if (p.user_id !== req.user.id && ['invited', 'admitted'].includes(p.status)) {
          rt.emitToUser(p.user_id, 'meeting:started', { meetingId: access.meeting.id, title: access.meeting.title });
        }
      }
    }
    res.json({ ok: true, data: rows[0] });
  })
);

/** POST /api/meetings/:id/end - host ends it for everyone. */
router.post(
  '/:id/end',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    if (!access.isHost) throw new AppError('Only the host can end the meeting', 403, 'FORBIDDEN');
    const { rows } = await query(
      `UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, NOW()) WHERE id = $1 RETURNING *`,
      [access.meeting.id]
    );
    realtime()?.endMeetingRoom?.(access.meeting.id);
    // Write the minutes and email them to everyone, in the background.
    summarizeAndSend(access.meeting.id).catch((err) => console.warn(`[meetings] minutes failed: ${err.message}`));
    res.json({ ok: true, data: rows[0] });
  })
);

/** GET /api/meetings/:id/record - notes + transcript, for people in the meeting. */
router.get(
  '/:id/record',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    if (!access.canEnter) throw new AppError('Only people in the meeting can see its notes', 403, 'FORBIDDEN');
    res.json({ ok: true, data: { ...(await record(access.meeting.id)), summary: access.meeting.summary } });
  })
);

/** POST /api/meetings/:id/request - ask the host to let you in. */
router.post(
  '/:id/request',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    if (access.canEnter) return res.json({ ok: true, data: { status: access.status } });
    if (access.meeting.status === 'ended') throw new AppError('This meeting has ended', 409, 'ENDED');
    await query(
      `INSERT INTO meeting_participants (meeting_id, user_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'pending', updated_at = NOW()`,
      [access.meeting.id, req.user.id]
    );
    const rt = realtime();
    if (rt) {
      rt.emitToUser(access.meeting.host_id, 'meeting:request', {
        meetingId: access.meeting.id,
        title: access.meeting.title,
        user: { id: req.user.id, name: req.user.name, role: req.user.role },
      });
      try {
        const { rows: n } = await query(
          `INSERT INTO notifications (user_id, type, content, meta) VALUES ($1, 'meeting_request', $2, $3) RETURNING *`,
          [
            access.meeting.host_id,
            `${req.user.name} asked to join "${access.meeting.title}"`,
            JSON.stringify({ meetingId: access.meeting.id, userId: req.user.id, href: `/meeting/${access.meeting.id}` }),
          ]
        );
        rt.emitNotification(access.meeting.host_id, n[0]);
      } catch {
        // best effort
      }
    }
    res.json({ ok: true, data: { status: 'pending' } });
  })
);

/** POST /api/meetings/:id/admit { user_id, allow } - host answers a join request. */
router.post(
  '/:id/admit',
  asyncHandler(async (req, res) => {
    const access = await meetingAccess(req.params.id, req.user.id);
    if (!access.isHost) throw new AppError('Only the host can admit people', 403, 'FORBIDDEN');
    const userId = String(req.body?.user_id || '');
    const allow = req.body?.allow !== false;
    const { rows } = await query(
      `UPDATE meeting_participants SET status = $3, updated_at = NOW()
       WHERE meeting_id = $1 AND user_id = $2 AND status IN ('pending', 'denied', 'admitted')
       RETURNING user_id, status`,
      [access.meeting.id, userId, allow ? 'admitted' : 'denied']
    );
    if (!rows[0]) throw new AppError('No join request from that person', 404, 'NOT_FOUND');
    realtime()?.emitToUser(userId, 'meeting:admission', { meetingId: access.meeting.id, allowed: allow });
    res.json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
