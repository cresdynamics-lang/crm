/**
 * Meeting notes, live minutes (transcript) and the summary emailed to everyone
 * when the host ends the meeting.
 *
 * Notes: anyone in the meeting adds them. Transcript: each participant's own
 * browser transcribes their own voice while the host has minutes switched on
 * (everyone sees a notice). At the end, notes + transcript go to the AI on the
 * CRM's OpenRouter key, which writes the minutes; they are saved on the meeting
 * and emailed to the host, the invited and the admitted.
 */
const { query } = require('../config/database');
const { sendWithFailover } = require('./emailService');
const { openRouterChatWithFallback } = require('./openRouter');

const MAX_TRANSCRIPT_CHARS = 60000;

async function addNote({ meetingId, user, content }) {
  const text = String(content || '').trim().slice(0, 4000);
  if (!text) return null;
  const { rows } = await query(
    `INSERT INTO meeting_notes (meeting_id, user_id, author_name, content) VALUES ($1, $2, $3, $4)
     RETURNING id, meeting_id, user_id, author_name, content, created_at`,
    [meetingId, user.id, user.name, text]
  );
  return rows[0];
}

async function addTranscriptLine({ meetingId, user, text }) {
  const line = String(text || '').trim().slice(0, 2000);
  if (!line) return null;
  const { rows } = await query(
    `INSERT INTO meeting_transcript (meeting_id, user_id, speaker_name, text) VALUES ($1, $2, $3, $4)
     RETURNING id, meeting_id, user_id, speaker_name, text, spoken_at`,
    [meetingId, user.id, user.name, line]
  );
  return rows[0];
}

async function record(meetingId) {
  const [notes, transcript] = await Promise.all([
    query(`SELECT id, user_id, author_name, content, created_at FROM meeting_notes WHERE meeting_id = $1 ORDER BY created_at`, [meetingId]),
    query(`SELECT id, user_id, speaker_name, text, spoken_at FROM meeting_transcript WHERE meeting_id = $1 ORDER BY spoken_at`, [meetingId]),
  ]);
  return { notes: notes.rows, transcript: transcript.rows };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = (d) => new Date(d).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });

/** Plain text with "## Heading", "- bullet" and **bold** to safe HTML. */
function minutesHtml(text) {
  const lines = esc(text).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (/^\s*[-•]\s+/.test(line)) {
      if (!inList) {
        html += '<ul style="margin:4px 0 12px;padding-left:20px">';
        inList = true;
      }
      html += `<li style="margin:2px 0">${line.replace(/^\s*[-•]\s+/, '')}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (/^#{1,3}\s+/.test(line)) html += `<h3 style="margin:16px 0 6px;font-size:15px">${line.replace(/^#{1,3}\s+/, '')}</h3>`;
    else if (line.trim()) html += `<p style="margin:0 0 8px">${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

async function writeMinutes({ meeting, people, notes, transcript }) {
  const attendees = people.map((p) => `${p.name} (${p.role || p.status})`).join(', ');
  let said = transcript.map((t) => `[${hhmm(t.spoken_at)}] ${t.speaker_name}: ${t.text}`).join('\n');
  if (said.length > MAX_TRANSCRIPT_CHARS) said = `${said.slice(0, MAX_TRANSCRIPT_CHARS)}\n…(transcript truncated)`;
  const noteText = notes.map((n) => `[${hhmm(n.created_at)}] ${n.author_name}: ${n.content}`).join('\n');

  const fallback = () =>
    [
      '## Notes',
      ...(notes.length ? notes.map((n) => `- **${n.author_name}:** ${n.content}`) : ['- No notes were taken.']),
      ...(transcript.length ? ['', '## Transcript', ...transcript.map((t) => `- **${t.speaker_name}:** ${t.text}`)] : []),
    ].join('\n');

  try {
    const { text } = await openRouterChatWithFallback({
      maxTokens: 1800,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You write concise, accurate meeting minutes for Cres Dynamics. Use only what is in the notes and transcript; ' +
            'never invent decisions, owners or dates. Format with these headings exactly: "## Summary" (3-5 sentences), ' +
            '"## Key points", "## Decisions", "## Action items" (each "- Owner: task (due date if stated)"), "## Next steps". ' +
            'Use "- " bullets. If a section has nothing, write "- None recorded."',
        },
        {
          role: 'user',
          content: `Meeting: ${meeting.title}\nHost: ${meeting.host_name}\nAttendees: ${attendees}\n\nNOTES:\n${noteText || '(none)'}\n\nTRANSCRIPT:\n${said || '(none)'}`,
        },
      ],
    });
    return text.trim();
  } catch (err) {
    console.warn(`[meetings] AI minutes failed (${err.message}); sending notes instead`);
    return fallback();
  }
}

/**
 * After the meeting: write the minutes and email them to everyone. Runs once
 * per meeting (summary_sent_at). Skips quietly if nothing was noted or said.
 */
async function summarizeAndSend(meetingId) {
  const { rows } = await query(
    `SELECT m.*, u.name AS host_name FROM meetings m JOIN users u ON u.id = m.host_id WHERE m.id = $1`,
    [meetingId]
  );
  const meeting = rows[0];
  if (!meeting || meeting.summary_sent_at) return null;
  const { notes, transcript } = await record(meetingId);
  if (!notes.length && !transcript.length) return null;

  const { rows: people } = await query(
    `SELECT u.id, u.name, u.email, r.name AS role, mp.status
     FROM meeting_participants mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE mp.meeting_id = $1 AND mp.status IN ('host', 'invited', 'admitted')`,
    [meetingId]
  );

  const minutes = await writeMinutes({ meeting, people, notes, transcript });
  await query(`UPDATE meetings SET summary = $2, summary_sent_at = NOW() WHERE id = $1`, [meetingId, minutes]);

  const when = new Date(meeting.started_at || meeting.created_at).toLocaleString('en-KE', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Nairobi',
  });
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1b2430;font-size:14px;line-height:1.5">
  <h2 style="margin:0 0 4px">Minutes: ${esc(meeting.title)}</h2>
  <p style="margin:0 0 16px;color:#667">${esc(when)} · Host: ${esc(meeting.host_name)} · ${people.length} people</p>
  ${minutesHtml(minutes)}
  <p style="margin:20px 0 0;font-size:12px;color:#889">Sent automatically by CRES OS after the meeting ended.</p>
</div>`;

  for (const p of people) {
    if (!p.email) continue;
    sendWithFailover({
      to: p.email,
      subject: `Minutes: ${meeting.title}`,
      html,
      body: minutes,
      meta: { type: 'meeting_minutes', meetingId },
    }).catch((err) => console.warn(`[meetings] minutes email to ${p.id} failed: ${err.message}`));
  }
  return minutes;
}

module.exports = { addNote, addTranscriptLine, record, summarizeAndSend, minutesHtml };
