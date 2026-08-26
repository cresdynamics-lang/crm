/**
 * Outbound email: Resend when MAIL_MAILER=resend, otherwise stub providers.
 */
const config = require('../config');
const { loadCompanyProfile } = require('../config/company');
const { query } = require('../config/database');

async function resolveFromAddress(meta = {}) {
  if (meta.from) return meta.from;
  const role = meta.fromRole || 'default';
  if (role === 'finance' && config.email.resendFromFinance) {
    return config.email.resendFromFinance;
  }
  if (role === 'sales' && config.email.resendFromSales) {
    return config.email.resendFromSales;
  }
  if (role === 'director' && config.email.resendFromDirector) {
    return config.email.resendFromDirector;
  }
  if (config.email.resendFrom) return config.email.resendFrom;
  try {
    const company = await loadCompanyProfile(query);
    const addr = company.financeEmail || company.email || config.email.from;
    const name = company.emailFromName || company.legalName || 'Cres Dynamics';
    return `${name} <${addr}>`;
  } catch {
    return config.email.from;
  }
}

function resolveReplyTo(meta = {}) {
  if (meta.replyTo) return meta.replyTo;
  const role = meta.fromRole || 'default';
  if (role === 'finance') return config.email.resendReplyToFinance || config.email.resendReplyTo;
  if (role === 'sales') return config.email.resendReplyToSales || config.email.resendReplyTo;
  if (role === 'director') return config.email.resendReplyToDirector || config.email.resendReplyTo;
  return config.email.resendReplyTo || undefined;
}

/** Normalize attachments to Resend's { filename, content(base64) } shape. */
function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return undefined;
  const out = attachments
    .filter(Boolean)
    .map((a) => ({
      filename: String(a.filename || 'attachment.pdf'),
      content: Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : String(a.content || ''),
    }))
    .filter((a) => a.content.length > 0);
  return out.length ? out : undefined;
}

async function sendViaResend({ to, subject, body, html, from, replyTo, cc, meta, attachments }) {
  const key = config.email.resendApiKey;
  if (!key) throw new Error('RESEND_API_KEY is not configured');

  const payload = {
    from: from || config.email.resendFrom || config.email.from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text: body || '',
  };
  if (html) payload.html = html;
  if (replyTo) payload.reply_to = replyTo;
  if (cc?.length) payload.cc = cc;

  const files = normalizeAttachments(attachments);
  if (files) {
    payload.attachments = files;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `Resend failed (${res.status})`);
  }
  console.log(
    `[email:resend] from=${payload.from} → ${payload.to.join(', ')} | ${subject}${
      files ? ` | +${files.length} attachment(s): ${files.map((f) => f.filename).join(', ')}` : ''
    }`
  );
  return {
    ok: true,
    provider: 'resend',
    messageId: data.id || `resend-${Date.now()}`,
    to: payload.to,
    from: payload.from,
    subject,
    meta,
  };
}

async function sendViaProvider(provider, { to, subject, body, html, from, replyTo, cc, meta, attachments }) {
  if (config.email.mailer === 'resend' || provider === 'resend') {
    return sendViaResend({ to, subject, body, html, from, replyTo, cc, meta, attachments });
  }
  console.log(`[email:${provider}] from=${from || '-'} → ${to} | ${subject}`);
  if (provider === 'force-fail') {
    throw new Error(`Provider ${provider} unavailable`);
  }
  return {
    ok: true,
    provider,
    messageId: `${provider}-${Date.now()}`,
    to,
    from: from || null,
    subject,
    meta,
    attachments: (attachments || []).map((a) => a.filename),
  };
}

async function sendWithFailover({ to, subject, body, html, meta = {}, from, replyTo, cc, attachments } = {}) {
  const fromAddr = from || (await resolveFromAddress(meta));
  const reply = replyTo || resolveReplyTo(meta);
  const primary = config.email.mailer === 'resend' ? 'resend' : config.email.primary;
  const fallback = config.email.mailer === 'resend' ? 'fallback' : config.email.fallback;

  try {
    return await sendViaProvider(primary, {
      to,
      subject,
      body,
      html,
      from: fromAddr,
      replyTo: reply,
      cc,
      attachments,
      meta,
    });
  } catch (primaryErr) {
    console.warn(`[email] primary (${primary}) failed: ${primaryErr.message}; trying fallback`);
    try {
      return await sendViaProvider(fallback, {
        to,
        subject,
        body,
        html,
        from: fromAddr,
        replyTo: reply,
        cc,
        attachments,
        meta: { ...meta, failoverFrom: primary },
      });
    } catch (fallbackErr) {
      const err = new Error(
        `All email providers failed. primary=${primaryErr.message}; fallback=${fallbackErr.message}`
      );
      err.code = 'EMAIL_ALL_FAILED';
      throw err;
    }
  }
}

module.exports = { sendWithFailover, sendViaProvider, resolveFromAddress };
