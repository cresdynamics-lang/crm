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

const ROLE_LABELS = {
  admin: 'Admin', director: 'Director', finance: 'Finance', hr: 'HR',
  pm: 'Project Manager', sales: 'Sales', developer: 'Developer', client: 'Client',
};

/** The public address of CRES OS (never the internal http:// one nginx forwards). */
function publicBase(fallback) {
  const env = process.env.PUBLIC_WEB_URL || process.env.PUBLIC_APP_URL || process.env.APP_URL;
  let base = String(env || fallback || 'https://cresos.cresdynamics.com').replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') base = base.replace(/^http:\/\//i, 'https://');
  return base;
}

function whenText(meeting) {
  return meeting.scheduled_at && meeting.status === 'scheduled'
    ? new Date(meeting.scheduled_at).toLocaleString('en-KE', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Nairobi' }) + ' (Nairobi time)'
    : 'Now - the meeting is live';
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Calendar invite (.ics) so people can add a scheduled meeting in one tap. */
function meetingIcs({ meeting, inviter, link }) {
  if (!meeting.scheduled_at || meeting.status !== 'scheduled') return null;
  const start = new Date(meeting.scheduled_at);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (t) => String(t || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cres Dynamics//CRES OS//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${meeting.id}@cresos`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${clean(meeting.title)}`,
    `DESCRIPTION:${clean(`Invited by ${inviter.name}. Join on CRES OS: ${link}`)}`,
    `URL:${link}`,
    `LOCATION:${clean(link)}`,
    inviter.email ? `ORGANIZER;CN=${clean(inviter.name)}:mailto:${inviter.email}` : null,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'DESCRIPTION:Meeting in 10 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

function inviteEmail({ meeting, inviter, invitee, link, others = [] }) {
  const roleLabel = ROLE_LABELS[inviter.role] || inviter.role || '';
  const who = `${inviter.name}${roleLabel ? ` (${roleLabel})` : ''}`;
  const when = whenText(meeting);
  const first = String(invitee.name || '').trim().split(/\s+/)[0] || 'there';
  const othersText = others.length ? others.slice(0, 8).join(', ') + (others.length > 8 ? ` and ${others.length - 8} more` : '') : null;
  const live = meeting.status === 'live';
  const subject = live ? `Join now: ${meeting.title} (invited by ${inviter.name})` : `Meeting invite: ${meeting.title} - ${when}`;

  const body = [
    `Hi ${first},`,
    '',
    `${who} invited you to a meeting on CRES OS.`,
    '',
    `Meeting: ${meeting.title}`,
    `When: ${when}`,
    `Host: ${meeting.host_name || inviter.name}`,
    `Invited by: ${who}${inviter.email ? ` - ${inviter.email}` : ''}`,
    othersText ? `Also invited: ${othersText}` : null,
    '',
    `Join: ${link}`,
    '',
    'Open the link in Chrome, Edge or Safari, allow your microphone (and camera if you want video), then click Join.',
    "You'll be asked to sign in to CRES OS if you aren't already.",
    'Reply to this email to reach the person who invited you.',
    '',
    '- Cres Dynamics',
  ].filter((l) => l !== null).join('\n');

  const row = (k, v) => `<tr><td style="padding:5px 14px 5px 0;color:#778;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:5px 0">${v}</td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:8px 0;color:#1b2430">
  <h2 style="margin:0 0 6px">${live ? 'A meeting is live - join now' : "You're invited to a meeting"}</h2>
  <p style="margin:0 0 16px;color:#556">Hi ${escHtml(first)}, <b>${escHtml(who)}</b> invited you to a meeting on CRES OS.</p>
  <table style="border-collapse:collapse;margin:0 0 18px;font-size:14px">
    ${row('Meeting', `<b>${escHtml(meeting.title)}</b>`)}
    ${row('When', escHtml(when))}
    ${row('Host', escHtml(meeting.host_name || inviter.name))}
    ${row('Invited by', `${escHtml(who)}${inviter.email ? `<br><a href="mailto:${escHtml(inviter.email)}" style="color:#00a8c5">${escHtml(inviter.email)}</a>` : ''}`)}
    ${othersText ? row('Also invited', escHtml(othersText)) : ''}
  </table>
  <a href="${escHtml(link)}" style="display:inline-block;background:#00a8c5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">${live ? 'Join meeting now' : 'Open meeting'}</a>
  <p style="margin:18px 0 0;font-size:13px;color:#556;line-height:1.5">Before you join: use Chrome, Edge or Safari and allow your microphone (and camera if you want video) when asked.${meeting.scheduled_at && !live ? ' A calendar file is attached so you can add it to your calendar.' : ''}</p>
  <p style="margin:12px 0 0;font-size:12px;color:#889">Or open this link: <a href="${escHtml(link)}" style="color:#00a8c5">${escHtml(link)}</a><br>You'll be asked to sign in to CRES OS if you aren't already. Reply to this email to reach ${escHtml(inviter.name)}.</p>
</div>`;
  return { subject, body, html };
}

/**
 * Invite users: they may enter whenever the meeting is live. Sends an in-app
 * notification and an email (through the retrying email queue) with the join
 * link, who invited them, who else is coming and a calendar file. Never
 * downgrades the host or someone already admitted.
 */
async function inviteUsers({ meeting, userIds, invitedBy, inviterName, baseUrl }) {
  const ids = [...new Set((userIds || []).map(String))].filter((id) => /^[0-9a-f-]{36}$/i.test(id) && id !== meeting.host_id);
  if (!ids.length) return [];
  const { rows: users } = await query(
    `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'`,
    [ids]
  );
  const { rows: inv } = await query(
    `SELECT u.id, u.name, u.email, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [invitedBy]
  );
  const inviter = inv[0] || { id: invitedBy, name: inviterName || 'A colleague', email: null, role: null };
  if (!meeting.host_name) {
    const { rows: h } = await query(`SELECT name FROM users WHERE id = $1`, [meeting.host_id]);
    meeting = { ...meeting, host_name: h[0]?.name };
  }
  const link = meetingLink(publicBase(baseUrl), meeting.id);
  const ics = meetingIcs({ meeting, inviter, link });
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
    invited.push({ user_id: u.id, name: u.name, status: rows[0].status, email: u.email || null });
  }

  // Everyone on the list (for "Also invited")
  const { rows: everyone } = await query(
    `SELECT mp.user_id, u.name FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
      WHERE mp.meeting_id = $1 AND mp.status IN ('host', 'invited', 'admitted')`,
    [meeting.id]
  );

  for (const u of users) {
    try {
      const { rows: n } = await query(
        `INSERT INTO notifications (user_id, type, content, meta) VALUES ($1, 'meeting_invite', $2, $3) RETURNING *`,
        [u.id, `${inviter.name} invited you to "${meeting.title}"`, JSON.stringify({ meetingId: meeting.id, link, href: `/meeting/${meeting.id}` })]
      );
      const { emitNotification, emitToUser } = require('../realtime/socket');
      emitNotification(u.id, n[0]);
      emitToUser(u.id, 'meeting:invite', { meetingId: meeting.id, title: meeting.title, from: inviter.name, link });
    } catch {
      // in-app notice is best effort
    }

    if (!u.email) continue;
    const others = everyone.filter((p) => p.user_id !== u.id && p.user_id !== inviter.id).map((p) => p.name);
    const msg = inviteEmail({ meeting, inviter, invitee: u, link, others });
    const payload = {
      to: u.email,
      subject: msg.subject,
      body: msg.body,
      html: msg.html,
      replyTo: inviter.email || undefined,
      ics,
      meetingId: meeting.id,
      inviteeId: u.id,
      inviterId: inviter.id,
    };
    try {
      const { enqueue } = require('../queues');
      await enqueue('email', 'meeting.invite', payload);
    } catch (err) {
      // Queue down: send directly so the invite still goes out
      sendMeetingInvite(payload).catch((e) => console.warn(`[meetings] invite email to ${u.id} failed: ${e.message}`));
    }
  }
  return invited;
}

/** Deliver one invite email (used by the email worker and as a fallback). */
async function sendMeetingInvite(data) {
  return sendWithFailover({
    to: data.to,
    subject: data.subject,
    body: data.body,
    html: data.html,
    replyTo: data.replyTo,
    attachments: data.ics
      ? [{ filename: 'meeting.ics', content: Buffer.from(data.ics).toString('base64') }]
      : undefined,
    meta: { type: 'meeting_invite', meetingId: data.meetingId },
  });
}

/**
 * ICE servers for WebRTC.
 *
 * STUN finds a direct path; TURN relays the call through our own server when
 * there is none (mobile data, office/hotel Wi-Fi), so anyone online can talk.
 *
 * With MEETING_TURN_SECRET (coturn "use-auth-secret"), each person gets a
 * login that expires in 12 hours: username "<expiry>:<userId>", password
 * HMAC-SHA1(secret, username). Nothing long-lived is ever sent to browsers.
 * MEETING_TURN_USERNAME / MEETING_TURN_CREDENTIAL still work for a hosted relay.
 */
function iceServers(userId = 'guest') {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turn = (process.env.MEETING_TURN_URLS || process.env.MEETING_TURN_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!turn.length) return list;
  const secret = process.env.MEETING_TURN_SECRET;
  if (secret) {
    const crypto = require('crypto');
    const expiry = Math.floor(Date.now() / 1000) + 12 * 3600;
    const username = `${expiry}:${String(userId).replace(/[^a-zA-Z0-9-]/g, '')}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    list.push({ urls: turn, username, credential });
  } else {
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
  inviteEmail,
  meetingIcs,
  publicBase,
  sendMeetingInvite,
};
