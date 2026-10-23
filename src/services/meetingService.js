/**
 * Meetings: who may see, enter, invite and admit — one place for the rules,
 * used by both the HTTP routes and the realtime signalling.
 *
 *   host      created the meeting; starts, ends, invites, admits
 *   invited   may enter whenever the meeting is live
 *   admitted  asked to join and the host said yes; may enter
 *   pending   asked to join; waiting for the host
 *   denied    host said no
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');
const { sendWithFailover } = require('./emailService');

const ENTER_STATUSES = new Set(['host', 'invited', 'admitted']);

async function loadMeeting(meetingId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(meetingId))) throw new AppError('Meeting not found', 404, 'NOT_FOUND');
  const { rows } = await query(
    `SELECT m.*, u.name AS host_name
     FROM meetings m JOIN users u ON u.id = m.host_id
     WHERE m.id = $1`,
    [meetingId]
  );
  if (!rows[0]) throw new AppError('Meeting not found', 404, 'NOT_FOUND');
  return rows[0];
}

async function myParticipation(meetingId, userId) {
  const { rows } = await query(
    `SELECT status FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  return rows[0]?.status || null;
}

/** Meeting + this user's standing in it. */
async function meetingAccess(meetingId, userId) {
  const meeting = await loadMeeting(meetingId);
  const status = meeting.host_id === userId ? 'host' : await myParticipation(meetingId, userId);
  return { meeting, status, isHost: status === 'host', canEnter: ENTER_STATUSES.has(status) };
}

async function participants(meetingId) {
  const { rows } = await query(
    `SELECT mp.user_id, mp.status, u.name, r.name AS role, u.avatar_url
     FROM meeting_participants mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE mp.meeting_id = $1
     ORDER BY (mp.status = 'host') DESC, u.name`,
    [meetingId]
  );
  return rows;
}

function meetingLink(baseUrl, meetingId) {
  return `${String(baseUrl).replace(/\/+$/, '')}/meeting/${meetingId}`;
}

function inviteEmailHtml({ meeting, hostName, link }) {
  const when = meeting.scheduled_at && meeting.status === 'scheduled'
    ? new Date(meeting.scheduled_at).toLocaleString('en-KE', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Nairobi' })
    : 'Now';
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1b2430">
  <h2 style="margin:0 0 8px">You're invited to a meeting</h2>
  <p style="margin:0 0 16px;color:#556">${esc(hostName)} invited you to join a meeting on CRES OS.</p>
  <table style="border-collapse:collapse;margin:0 0 20px;font-size:14px">
    <tr><td style="padding:4px 12px 4px 0;color:#778">Meeting</td><td style="padding:4px 0"><b>${esc(meeting.title)}</b></td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#778">When</td><td style="padding:4px 0">${esc(when)} (Nairobi time)</td></tr>
  </table>
  <a href="${esc(link)}" style="display:inline-block;background:#00a8c5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Join meeting</a>
  <p style="margin:20px 0 0;font-size:12px;color:#889">Or open this link: ${esc(link)}<br>You'll be asked to sign in to CRES OS if you aren't already.</p>
</div>`;
}

/**
 * Invite users: they may enter whenever the meeting is live. Sends an in-app
 * notification and an email with the join link. Never downgrades the host or
 * someone already admitted.
 */
async function inviteUsers({ meeting, userIds, invitedBy, inviterName, baseUrl }) {
  const ids = [...new Set((userIds || []).map(String))].filter((id) => /^[0-9a-f-]{36}$/i.test(id) && id !== meeting.host_id);
  if (!ids.length) return [];
  const { rows: users } = await query(
    `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'`,
    [ids]
  );
  const link = meetingLink(baseUrl, meeting.id);
  const invited = [];
  for (const u of users) {
    const { rows } = await query(
      `INSERT INTO meeting_participants (meeting_id, user_id, status, invited_by)
       VALUES ($1, $2, 'invited', $3)
       ON CONFLICT (meeting_id, user_id) DO UPDATE
         SET status = CASE WHEN meeting_participants.status IN ('host', 'admitted') THEN meeting_participants.status ELSE 'invited' END,
             invited_by = EXCLUDED.invited_by, updated_at = NOW()
       RETURNING status`,
      [meeting.id, u.id, invitedBy]
    );
    invited.push({ user_id: u.id, name: u.name, status: rows[0].status });

    try {
      const { rows: n } = await query(
        `INSERT INTO notifications (user_id, type, content, meta) VALUES ($1, 'meeting_invite', $2, $3) RETURNING *`,
        [u.id, `${inviterName} invited you to "${meeting.title}"`, JSON.stringify({ meetingId: meeting.id, link, href: `/meeting/${meeting.id}` })]
      );
      const { emitNotification, emitToUser } = require('../realtime/socket');
      emitNotification(u.id, n[0]);
      emitToUser(u.id, 'meeting:invite', { meetingId: meeting.id, title: meeting.title, from: inviterName, link });
    } catch {
      // in-app notice is best effort
    }

    if (u.email) {
      sendWithFailover({
        to: u.email,
        subject: `Meeting invite: ${meeting.title}`,
        html: inviteEmailHtml({ meeting, hostName: inviterName, link }),
        body: `${inviterName} invited you to "${meeting.title}". Join: ${link}`,
        meta: { type: 'meeting_invite', meetingId: meeting.id },
      }).catch((err) => console.warn(`[meetings] invite email to ${u.id} failed: ${err.message}`));
    }
  }
  return invited;
}

/** ICE servers for WebRTC. Set MEETING_TURN_URL(S)/USERNAME/CREDENTIAL for calls across strict networks. */
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turn = (process.env.MEETING_TURN_URLS || process.env.MEETING_TURN_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turn.length) {
    list.push({
      urls: turn,
      username: process.env.MEETING_TURN_USERNAME || '',
      credential: process.env.MEETING_TURN_CREDENTIAL || '',
    });
  }
  return list;
}

module.exports = {
  ENTER_STATUSES,
  loadMeeting,
  meetingAccess,
  participants,
  inviteUsers,
  meetingLink,
  iceServers,
};
