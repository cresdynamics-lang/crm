/**
 * Sync Admin mailbox via IMAP (Private Email / similar).
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../config');
const { query } = require('../config/database');
const { draftInboxReply } = require('./groq');
const { assessScam } = require('./inboxGuard');

/*
 * Attachments are kept privately in uploads/.inbox (never served as static
 * files; admins download them through the inbox API). Text is extracted from
 * PDF, Word (.docx) and text files so Jarvis can read them; images are kept so
 * Jarvis can look at them when drafting.
 */
const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');
const ATTACH_DIR = pathMod.join(__dirname, '..', '..', 'uploads', '.inbox');
const MAX_SAVE_BYTES = 10 * 1024 * 1024;

function saveAttachment(att) {
  try {
    if (!att.content || att.size > MAX_SAVE_BYTES) return null;
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const hash = crypto.createHash('sha256').update(att.content).digest('hex').slice(0, 24);
    const ext = (pathMod.extname(att.filename || '') || '').replace(/[^.\w]/g, '').slice(0, 8);
    const file = `${hash}${ext}`;
    const full = pathMod.join(ATTACH_DIR, file);
    if (!fs.existsSync(full)) fs.writeFileSync(full, att.content, { mode: 0o640 });
    return file;
  } catch {
    return null;
  }
}

function attachmentPath(file) {
  const safe = pathMod.basename(String(file || ''));
  return safe ? pathMod.join(ATTACH_DIR, safe) : null;
}

const clip = (t, n = 6000) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function extractText(att) {
  const name = att.filename || 'attachment';
  const mime = att.contentType || 'application/octet-stream';
  const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content || '');
  if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) {
    const { PDFParse } = require('pdf-parse');
    const result = await new PDFParse({ data: buf }).getText();
    return clip(result.text) || '(PDF had no extractable text - may be a scan)';
  }
  if (/wordprocessingml|msword/i.test(mime) || /\.docx$/i.test(name)) {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return clip(value) || '(Word file had no text)';
  }
  if (/^text\/|json|csv|xml/i.test(mime) || /\.(txt|csv|md|json|xml|html?)$/i.test(name)) {
    return clip(buf.toString('utf8').replace(/<[^>]+>/g, ' '));
  }
  return null;
}

async function summarizeAttachments(parsed) {
  const out = [];
  for (const att of parsed.attachments || []) {
    if (att.related && /^image\//i.test(att.contentType || '') && att.size < 40000) continue; // inline logos/signatures
    const name = att.filename || 'attachment';
    const mime = att.contentType || 'application/octet-stream';
    const item = { name, mime, size: att.size || 0, file: saveAttachment(att) };
    try {
      const text = await extractText(att);
      if (text) item.summary = text;
      else if (/^image\//i.test(mime)) item.summary = 'Image - Jarvis looks at it when drafting.';
      else item.summary = `Attachment (${mime}, ${att.size || 0} bytes)`;
    } catch (err) {
      item.summary = `Could not read this file: ${err.message}`;
    }
    out.push(item);
  }
  return out;
}

function addresses(list) {
  if (!list?.value?.length) return [];
  return list.value.map((a) => a.address).filter(Boolean);
}

async function syncAdminInbox({ limit = 20 } = {}) {
  const { host, port, user, password, secure } = config.imap;
  if (!host || !user || !password) {
    throw new Error('IMAP is not configured (IMAP_HOST / IMAP_USER / IMAP_PASSWORD)');
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: password },
    logger: false,
  });

  // Download first, process after: the slow part (PDF summaries) happens with
  // the mailbox connection already closed, so the server cannot time it out.
  await client.connect();
  const fresh = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists || 0;
      if (!total) return { synced: 0, total: 0 };
      const start = Math.max(1, total - limit + 1);
      const wanted = [];
      for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true })) {
        const id = msg.envelope?.messageId || `uid-${msg.uid}`;
        const existing = await query(`SELECT 1 FROM admin_inbox_messages WHERE message_id = $1`, [id]);
        if (!existing.rows[0]) wanted.push(msg.uid);
      }
      if (wanted.length) {
        for await (const msg of client.fetch(wanted.join(','), { uid: true, source: true, envelope: true }, { uid: true })) {
          fresh.push({ uid: msg.uid, source: msg.source, envelope: msg.envelope });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  let synced = 0;
  const inserted = [];
  for (const msg of fresh) {
    try {
      const parsed = await simpleParser(msg.source);
      const messageId = parsed.messageId || msg.envelope?.messageId || `uid-${msg.uid}`;
      const existing = await query(`SELECT id FROM admin_inbox_messages WHERE message_id = $1`, [messageId]);
      if (existing.rows[0]) continue;

      const fromEmail = parsed.from?.value?.[0]?.address || 'unknown@unknown';
      const fromName = parsed.from?.value?.[0]?.name || null;
      const toEmails = addresses(parsed.to);
      const ccEmails = addresses(parsed.cc);
      const attachmentSummaries = await summarizeAttachments(parsed);
      const bodyText = parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '';
      const replyTo = parsed.replyTo?.value?.[0]?.address || null;
      const scam = assessScam({
        fromEmail,
        fromName,
        replyTo,
        subject: parsed.subject,
        bodyText,
        attachments: attachmentSummaries,
      });

      const { rows: ins } = await query(
        `INSERT INTO admin_inbox_messages
           (imap_uid, message_id, from_email, from_name, to_emails, cc_emails,
            subject, body_text, body_html, received_at, has_attachments,
            attachment_summaries, status, ai_draft, ai_summary,
            reply_to_email, scam_score, scam_reasons, is_scam)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb,$19)
         ON CONFLICT DO NOTHING
         RETURNING id, from_email, from_name, subject, is_scam, scam_score`,
        [
          msg.uid,
          messageId,
          fromEmail,
          fromName,
          toEmails,
          ccEmails,
          parsed.subject || '(no subject)',
          bodyText.slice(0, 50000),
          parsed.html ? String(parsed.html).slice(0, 100000) : null,
          parsed.date || new Date(),
          attachmentSummaries.length > 0,
          JSON.stringify(attachmentSummaries),
          'pending',
          null,
          null,
          replyTo,
          scam.score,
          JSON.stringify(scam.reasons),
          scam.likely,
        ]
      );
      if (ins[0]) {
        synced += 1;
        inserted.push(ins[0]);
      }
    } catch (err) {
      console.warn('[inbox] message sync failed', err.message);
    }
  }

  if (inserted.length) announceNewMail(inserted).catch(() => {});
  return { synced, mailbox: user, ids: inserted.map((m) => m.id) };
}

/**
 * Email synced before attachments were stored: fetch it again from the
 * mailbox (by UID) and save + read its attachments now.
 */
async function refetchAttachments(msg) {
  if (!msg.imap_uid) return null;
  const { host, port, user, password, secure } = config.imap;
  if (!host || !user || !password) return null;
  const client = new ImapFlow({ host, port, secure, auth: { user, pass: password }, logger: false });
  await client.connect();
  let source = null;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const m = await client.fetchOne(String(msg.imap_uid), { source: true }, { uid: true });
      source = m?.source || null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  if (!source) return null;
  const parsed = await simpleParser(source);
  const list = await summarizeAttachments(parsed);
  await query(`UPDATE admin_inbox_messages SET attachment_summaries = $1::jsonb, has_attachments = $2 WHERE id = $3`, [
    JSON.stringify(list),
    list.length > 0,
    msg.id,
  ]);
  return list;
}

/** Tell admins (live screen + bell), then pre-draft replies in the background. */
async function announceNewMail(list) {
  const { emitToRole } = require('../realtime/socket');
  emitToRole('admin', 'inbox:new', { count: list.length, ids: list.map((m) => m.id) });
  // Replies to emails staff sent from Team Mail go straight back to that person too
  try {
    await require('./teamMail').routeReplies(list);
  } catch (e) {
    console.warn('[inbox] reply routing failed:', e.message);
  }
  const { rows: admins } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'admin' AND u.status = 'active'`
  );
  const { queueNotification } = require('../queues/jobs');
  for (const m of list.slice(0, 5)) {
    const who = m.from_name || m.from_email;
    for (const a of admins) {
      await queueNotification({
        userId: a.id,
        type: m.is_scam ? 'inbox_scam' : 'inbox_new',
        content: m.is_scam
          ? `Possible scam email from ${who}: ${m.subject || '(no subject)'}`
          : `New email from ${who}: ${m.subject || '(no subject)'}`,
        meta: { inboxId: m.id, href: '/inbox' },
      }).catch(() => {});
    }
  }
  // Jarvis drafts, one at a time, never for likely scams (INBOX_AUTO_DRAFT=false turns this off)
  if (process.env.INBOX_AUTO_DRAFT === 'false') return;
  const automated = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce|notifications?)@/i;
  for (const m of list) {
    const self = String(m.from_email || '').toLowerCase() === String(config.imap.user || '').toLowerCase();
    if (m.is_scam || self || automated.test(m.from_email || '')) continue; // no replies to scams, bounces, robots or ourselves
    try {
      await draftForMessage(m.id, { auto: true });
    } catch (e) {
      console.warn(`[inbox] auto-draft failed for ${m.id}: ${e.message}`);
    }
  }
}

/**
 * Write (or rewrite) the reply draft for one message.
 * mode 'reply' (default) or 'decline' (a polite no). Jarvis first, Groq backup.
 */
async function draftForMessage(id, { instructions = '', mode = 'reply', auto = false } = {}) {
  const { rows } = await query(`SELECT * FROM admin_inbox_messages WHERE id = $1`, [id]);
  const msg = rows[0];
  if (!msg) throw new Error('Message not found');
  if (auto && (msg.ai_draft || msg.status !== 'pending')) return msg; // admin already working on it
  if (msg.has_attachments && !(msg.attachment_summaries || []).some((a) => a.file)) {
    const refreshed = await refetchAttachments(msg).catch(() => null);
    if (refreshed) msg.attachment_summaries = refreshed;
  }
  const source = {
    id: msg.id,
    fromName: msg.from_name,
    fromEmail: msg.from_email,
    subject: msg.subject,
    bodyText: msg.body_text,
    attachmentSummaries: msg.attachment_summaries,
    instructions,
    mode,
  };
  let drafted;
  try {
    const { jarvisDraftReply } = require('./jarvisMailDraft');
    drafted = await jarvisDraftReply(source);
  } catch (err) {
    console.warn(`[inbox] Jarvis draft failed (${err.message}); using Groq`);
    const declineNote = mode === 'decline'
      ? 'Politely decline this request. Thank them, say we are unable to proceed, keep it short and leave the door open.'
      : '';
    drafted = { ...(await draftInboxReply({ ...source, instructions: [declineNote, instructions].filter(Boolean).join(' ') })), by: 'groq' };
  }
  const { rows: updated } = await query(
    `UPDATE admin_inbox_messages
        SET ai_draft = $1,
            ai_summary = COALESCE($2, ai_summary),
            ai_instructions = $3,
            status = CASE WHEN status IN ('sent','ignored','declined') THEN status ELSE 'drafted' END,
            drafted_at = NOW(),
            updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
    [drafted.draft, drafted.summary, instructions || null, msg.id]
  );
  try {
    const { emitToRole } = require('../realtime/socket');
    emitToRole('admin', 'inbox:updated', { id: msg.id, status: updated[0]?.status });
  } catch {
    /* live update is optional */
  }
  return { ...updated[0], draftedBy: drafted.by || 'groq' };
}

module.exports = { syncAdminInbox, draftForMessage, attachmentPath, refetchAttachments };
