/**
 * Jarvis drafts admin inbox replies as Cres Dynamics.
 *
 * Better than a bare reply: before writing, Jarvis looks the sender up in the
 * CRM (client or lead by email; their projects and unpaid invoices) and uses
 * the company profile for the sign-off and contact details. The admin always
 * reviews and edits the draft before anything is sent.
 *
 * Uses the CRM's OpenRouter key (Claude); falls back to the Groq drafter.
 */
const { query } = require('../config/database');
const { loadCompanyProfile } = require('../config/company');
const { openRouterChat, openRouterChatWithFallback } = require('./openRouter');

/** Jarvis's model first; the CRM's configured models if that one is unavailable. */
async function chat(opts) {
  try {
    return await openRouterChat({ ...opts, model: MODEL });
  } catch {
    return openRouterChatWithFallback(opts);
  }
}

const MODEL = process.env.JARVIS_MAIL_MODEL || 'anthropic/claude-sonnet-5.5';

/** What the CRM knows about whoever sent the email. */
async function senderContext(email) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr || !addr.includes('@')) return '';
  const lines = [];
  const { rows: clients } = await query(
    `SELECT id, name, business_name, phone FROM clients WHERE LOWER(email) = $1 LIMIT 1`,
    [addr]
  );
  const client = clients[0];
  if (client) {
    lines.push(`Existing client: ${client.name}${client.business_name ? ` (${client.business_name})` : ''}.`);
    const { rows: projects } = await query(
      `SELECT name, status, due_date, preview_url FROM projects WHERE client_id = $1 ORDER BY updated_at DESC LIMIT 5`,
      [client.id]
    );
    for (const p of projects) {
      lines.push(`- Project "${p.name}": status ${p.status}${p.due_date ? `, due ${new Date(p.due_date).toDateString()}` : ''}${p.preview_url ? `, preview ${p.preview_url}` : ''}`);
    }
    const { rows: invoices } = await query(
      `SELECT invoice_number, amount, amount_paid, status, due_date FROM invoices
       WHERE client_id = $1 AND status NOT IN ('paid', 'void', 'cancelled')
       ORDER BY due_date NULLS LAST LIMIT 5`,
      [client.id]
    );
    for (const i of invoices) {
      const balance = Number(i.amount || 0) - Number(i.amount_paid || 0);
      lines.push(`- Invoice ${i.invoice_number || ''}: ${i.status}, balance KES ${balance.toLocaleString('en-KE')}${i.due_date ? `, due ${new Date(i.due_date).toDateString()}` : ''}`);
    }
  } else {
    const { rows: leads } = await query(
      `SELECT name, business_name, business_type, status FROM leads WHERE LOWER(email) = $1 ORDER BY updated_at DESC LIMIT 1`,
      [addr]
    );
    if (leads[0]) {
      const l = leads[0];
      lines.push(`Sales lead: ${l.name}${l.business_name ? ` (${l.business_name})` : ''}, ${l.business_type || 'business'}, stage "${l.status}".`);
    }
  }
  return lines.join('\n');
}

/**
 * How Cres Dynamics operates, from the company knowledge base (Admin > Knowledge).
 * Only entries open to everyone, and only the client-safe categories.
 */
async function operatingNotes() {
  const { rows } = await query(
    `SELECT title, content FROM knowledge_base
      WHERE category IN ('general', 'onboarding', 'processes', 'policies', 'sales', 'finance', 'decisions', 'operations', 'strategy')
        AND (accessible_roles @> '["all"]'::jsonb OR accessible_roles @> '["admin"]'::jsonb)
      ORDER BY CASE category WHEN 'general' THEN 0 WHEN 'onboarding' THEN 1 WHEN 'policies' THEN 2 WHEN 'sales' THEN 3 WHEN 'finance' THEN 4 ELSE 5 END,
               updated_at DESC
      LIMIT 12`
  );
  let budget = 5000;
  const out = [];
  for (const r of rows) {
    const chunk = `## ${r.title}\n${String(r.content || '').replace(/\s+/g, ' ').trim()}`.slice(0, 900);
    if (budget - chunk.length < 0) break;
    budget -= chunk.length;
    out.push(chunk);
  }
  return out.join('\n\n');
}

/** Earlier emails with this sender (theirs and our replies), oldest first. */
async function conversationHistory(email, excludeId) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr) return '';
  const { rows } = await query(
    `(SELECT COALESCE(received_at, created_at) AS at, 'them' AS who, subject, LEFT(body_text, 1200) AS body
        FROM admin_inbox_messages
       WHERE LOWER(from_email) = $1 AND id <> $2 AND deleted_at IS NULL
       ORDER BY COALESCE(received_at, created_at) DESC LIMIT 6)
     UNION ALL
     (SELECT updated_at AS at, 'us' AS who, 'Re: ' || COALESCE(subject, '') AS subject, LEFT(final_body, 1200) AS body
        FROM admin_inbox_messages
       WHERE LOWER(from_email) = $1 AND id <> $2 AND final_body IS NOT NULL AND status IN ('sent', 'declined')
       ORDER BY updated_at DESC LIMIT 6)
     UNION ALL
     (SELECT created_at AS at, 'us' AS who, subject, LEFT(body, 1200) AS body
        FROM outbound_emails
       WHERE LOWER(to_email) = $1
       ORDER BY created_at DESC LIMIT 4)`,
    [addr, excludeId || '00000000-0000-0000-0000-000000000000']
  ).catch(() => ({ rows: [] }));
  if (!rows.length) return '';
  rows.sort((a, b) => new Date(a.at) - new Date(b.at));
  return rows
    .slice(-10)
    .map((r) => `[${new Date(r.at).toISOString().slice(0, 10)}] ${r.who === 'us' ? 'WE (Cres Dynamics) wrote' : 'THEY wrote'} - ${r.subject || ''}\n${String(r.body || '').replace(/\s+/g, ' ').trim()}`)
    .join('\n\n');
}

/** Up to 3 image attachments as model inputs (data URLs). */
function imageParts(attachmentSummaries) {
  const parts = [];
  try {
    const fs = require('fs');
    const { attachmentPath } = require('./adminInbox');
    for (const a of attachmentSummaries || []) {
      if (parts.length >= 3) break;
      if (!/^image\/(png|jpe?g|gif|webp)$/i.test(a.mime || '') || !a.file) continue;
      const full = attachmentPath(a.file);
      if (!full || !fs.existsSync(full)) continue;
      const buf = fs.readFileSync(full);
      if (buf.length > 4 * 1024 * 1024) continue;
      parts.push({ type: 'image_url', image_url: { url: `data:${a.mime.toLowerCase()};base64,${buf.toString('base64')}` } });
    }
  } catch {
    /* images are optional */
  }
  return parts;
}

function companyBlock(c) {
  return [
    `Company: ${c.tradingName || c.legalName || 'Cres Dynamics'}${c.tagline ? ` — ${c.tagline}` : ''}`,
    c.website && `Website: ${c.website}`,
    c.phone && `Phone: ${c.phone}`,
    c.email && `Email: ${c.email}`,
  ].filter(Boolean).join('\n');
}

/**
 * @returns {{ draft: string, summary: string|null, by: 'jarvis' }}
 */
async function jarvisDraftReply({ id, fromName, fromEmail, subject, bodyText, attachmentSummaries, instructions, mode = 'reply', signoff = null }) {
  let company = {};
  try {
    company = await loadCompanyProfile(query);
  } catch {
    /* defaults below */
  }
  const ctx = await senderContext(fromEmail).catch(() => '');
  const howWeWork = await operatingNotes().catch(() => '');
  const history = await conversationHistory(fromEmail, id).catch(() => '');
  const images = imageParts(attachmentSummaries);
  let budget = 14000;
  const attach = Array.isArray(attachmentSummaries) && attachmentSummaries.length
    ? attachmentSummaries.map((a) => {
        const text = String(a.summary || a.mime || '').slice(0, Math.max(0, budget));
        budget -= text.length;
        return `--- ${a.name || 'file'} (${a.mime || 'file'}) ---\n${text}`;
      }).join('\n\n')
    : 'None';
  const name = company.tradingName || company.legalName || 'Cres Dynamics';

  const system = `You are JARVIS, writing email replies on behalf of ${name} from the company inbox.
Write the reply body only (plain text, no subject line), ready for the admin to review and send.

Voice: warm, professional, confident and concise — a capable Kenyan technology company. Greet the
sender by first name when known. Answer what they asked, point by point. Propose a clear next step.

Who is writing: work out the sender's name and company from the signature, the email address and its
domain (e.g. @acme.co.ke -> Acme), the attachments and the CRM context. Greet them by first name, refer to
their company by its correct name, and use any details they gave (order numbers, dates, amounts, their
role) in the reply. If an attachment is a CV, quote, invoice, brief or photo, read it and respond to what
it actually says. If earlier conversation is shown, continue it naturally: don't repeat what we already
said, follow up on what we promised, and don't ask again for things they already sent.

This is a DRAFT for the admin. It is never sent automatically.

Accuracy: use only facts from the email, its attachments and the CRM context below. Never invent
prices, dates, deadlines, account numbers or commitments; where something needs confirming, say the
team will confirm it. Never promise refunds, discounts or legal positions.

How we work: follow the company's own processes below (how projects start, how invoices and payments
work, response times, who handles what). Use them to shape the next step you propose, but never paste
internal details to outsiders (staff names' salaries, internal tools, margins, internal decisions).
${mode === 'decline' ? `
TASK: politely DECLINE this request. Thank them, say clearly but kindly that we can't take it on (or
can't agree to it) right now, give a short honest reason only if the email makes one obvious, and leave
the door open. Keep it under 120 words.
` : ''}
Sign off exactly:
${signoff || `Kind regards,
${name} Team
${[company.phone, company.website].filter(Boolean).join(' | ')}`}

${companyBlock(company)}

HOW CRES DYNAMICS OPERATES (internal reference):
${howWeWork || 'No knowledge-base notes yet.'}`;

  const user = `INCOMING EMAIL
From: ${fromName || ''} <${fromEmail}>
Subject: ${subject || '(no subject)'}

${String(bodyText || '(empty)').slice(0, 12000)}

ATTACHMENTS (text extracted; images are attached to this message):
${attach}

EARLIER CONVERSATION WITH THIS SENDER (oldest first):
${history || 'None - first contact.'}

CRM CONTEXT ABOUT THE SENDER:
${ctx || 'Not found in the CRM (treat as a new contact).'}
${instructions ? `\nINSTRUCTIONS FROM THE ADMIN (follow these):\n${instructions}\n` : ''}`;

  const { text } = await chat({
    temperature: 0.3,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images] : user },
    ],
  });

  let summary = null;
  try {
    const s = await chat({
      temperature: 0.1,
      maxTokens: 120,
      messages: [
        { role: 'system', content: 'Summarize the incoming email for an admin inbox card in at most 2 short sentences. Start with the sender\'s name and company in the form "Name (Company):" worked out from the signature, address and domain (write "Name:" if there is no company). Mention any request, attachment or deadline.' },
        { role: 'user', content: `From ${fromName || ''} <${fromEmail}>\nSubject: ${subject}\nAttachments: ${(attachmentSummaries || []).map((a) => a.name).join(', ') || 'none'}\n\n${String(bodyText || '').slice(0, 4000)}` },
      ],
    });
    summary = s.text.trim();
  } catch {
    /* summary is optional */
  }
  return { draft: text.trim(), summary, by: 'jarvis' };
}

module.exports = { jarvisDraftReply, senderContext };
