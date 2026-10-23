/**
 * Sync Admin mailbox via IMAP (Private Email / similar).
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../config');
const { query } = require('../config/database');
const { draftInboxReply } = require('./groq');

async function extractPdfSummary(buffer, filename) {
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer) });
    const result = await parser.getText();
    const text = String(result.text || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
    return { name: filename, mime: 'application/pdf', summary: text || '(PDF had no extractable text)' };
  } catch (err) {
    return { name: filename, mime: 'application/pdf', summary: `PDF could not be parsed: ${err.message}` };
  }
}

async function summarizeAttachments(parsed) {
  const out = [];
  for (const att of parsed.attachments || []) {
    const name = att.filename || 'attachment';
    const mime = att.contentType || 'application/octet-stream';
    if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) {
      out.push(await extractPdfSummary(att.content, name));
    } else {
      out.push({
        name,
        mime,
        summary: `Attachment (${mime}, ${att.size || 0} bytes)`,
      });
    }
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

      // Drafts are written on demand (Draft with Jarvis), not during sync.
      await query(
        `INSERT INTO admin_inbox_messages
           (imap_uid, message_id, from_email, from_name, to_emails, cc_emails,
            subject, body_text, body_html, received_at, has_attachments,
            attachment_summaries, status, ai_draft, ai_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
         ON CONFLICT DO NOTHING`,
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
        ]
      );
      synced += 1;
    } catch (err) {
      console.warn('[inbox] message sync failed', err.message);
    }
  }

  return { synced, mailbox: user };
}

module.exports = { syncAdminInbox };
