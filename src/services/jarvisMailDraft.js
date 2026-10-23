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
async function jarvisDraftReply({ fromName, fromEmail, subject, bodyText, attachmentSummaries, instructions }) {
  let company = {};
  try {
    company = await loadCompanyProfile(query);
  } catch {
    /* defaults below */
  }
  const ctx = await senderContext(fromEmail).catch(() => '');
  const attach = Array.isArray(attachmentSummaries) && attachmentSummaries.length
    ? attachmentSummaries.map((a) => `- ${a.name || 'file'}: ${a.summary || a.mime || ''}`).join('\n')
    : 'None';
  const name = company.tradingName || company.legalName || 'Cres Dynamics';

  const system = `You are JARVIS, writing email replies on behalf of ${name} from the company inbox.
Write the reply body only (plain text, no subject line), ready for the admin to review and send.

Voice: warm, professional, confident and concise — a capable Kenyan technology company. Greet the
sender by first name when known. Answer what they asked, point by point. Propose a clear next step.

Accuracy: use only facts from the email, its attachments and the CRM context below. Never invent
prices, dates, deadlines, account numbers or commitments; where something needs confirming, say the
team will confirm it. Never promise refunds, discounts or legal positions.

Sign off exactly:
Kind regards,
${name} Team
${[company.phone, company.website].filter(Boolean).join(' | ')}

${companyBlock(company)}`;

  const user = `INCOMING EMAIL
From: ${fromName || ''} <${fromEmail}>
Subject: ${subject || '(no subject)'}

${String(bodyText || '(empty)').slice(0, 12000)}

Attachment notes:
${attach}

CRM CONTEXT ABOUT THE SENDER:
${ctx || 'Not found in the CRM (treat as a new contact).'}
${instructions ? `\nINSTRUCTIONS FROM THE ADMIN (follow these):\n${instructions}\n` : ''}`;

  const { text } = await chat({
    temperature: 0.3,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  let summary = null;
  try {
    const s = await chat({
      temperature: 0.1,
      maxTokens: 120,
      messages: [
        { role: 'system', content: 'Summarize the incoming email in 2 short sentences for an admin inbox card. Mention any request or deadline.' },
        { role: 'user', content: `From ${fromEmail}\nSubject: ${subject}\n\n${String(bodyText || '').slice(0, 4000)}` },
      ],
    });
    summary = s.text.trim();
  } catch {
    /* summary is optional */
  }
  return { draft: text.trim(), summary, by: 'jarvis' };
}

module.exports = { jarvisDraftReply, senderContext };
