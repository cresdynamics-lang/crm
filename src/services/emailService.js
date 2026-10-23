/**
 * Outbound email: Resend when MAIL_MAILER=resend, with the company mailbox
 * (SMTP, MAIL_HOST / MAIL_USERNAME / MAIL_PASSWORD) as the real fallback when
 * it is configured. Otherwise stub providers.
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

async function sendViaResend({ to, subject, body, html, from, replyTo, cc, meta, attachments, headers }) {
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
  if (headers) payload.headers = headers;

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

/** SMTP settings from MAIL_* (e.g. Namecheap Private Email), or null when not set. */
function smtpSettings() {
  const host = process.env.MAIL_HOST;
  const user = process.env.MAIL_USERNAME;
  const pass = process.env.MAIL_PASSWORD;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.MAIL_PORT || 465);
  const enc = String(process.env.MAIL_ENCRYPTION || '').toLowerCase();
  return { host, port, secure: enc === 'ssl' || port === 465, auth: { user, pass } };
}

let smtpTransport = null;
async function sendViaSmtp({ to, subject, body, html, replyTo, cc, meta, attachments, headers }) {
  const settings = smtpSettings();
  if (!settings) throw new Error('SMTP is not configured');
  // eslint-disable-next-line global-require
  smtpTransport ||= require('nodemailer').createTransport(settings);
  // The mailbox server only sends as its own address.
  const name = process.env.MAIL_FROM_NAME || 'Cres Dynamics';
  const fromAddr = `${name} <${process.env.MAIL_FROM_ADDRESS || settings.auth.user}>`;
  const info = await smtpTransport.sendMail({
    from: fromAddr,
    to: Array.isArray(to) ? to : [to],
    cc: cc?.length ? cc : undefined,
    replyTo: replyTo || undefined,
    inReplyTo: headers?.['In-Reply-To'],
    references: headers?.References,
    subject,
    text: body || '',
    html: html || undefined,
    attachments: (attachments || []).filter(Boolean).map((a) => ({
      filename: String(a.filename || 'attachment.pdf'),
      content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content || ''), 'base64'),
    })),
  });
  console.log(`[email:smtp] from=${fromAddr} → ${Array.isArray(to) ? to.join(', ') : to} | ${subject}`);
  return { ok: true, provider: 'smtp', messageId: info.messageId, to, from: fromAddr, subject, meta };
}

async function sendViaProvider(provider, { to, subject, body, html, from, replyTo, cc, meta, attachments, headers }) {
  if (provider === 'resend') {
    return sendViaResend({ to, subject, body, html, from, replyTo, cc, meta, attachments, headers });
  }
  if (provider === 'smtp') {
    return sendViaSmtp({ to, subject, body, html, replyTo, cc, meta, attachments, headers });
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

function wrapBrandHtml(html) {
  if (!html) return html;
  const raw = String(html);
  if (/<!DOCTYPE|<html[\s>]/i.test(raw)) return raw;
  const root = (
    process.env.PUBLIC_WEB_URL ||
    process.env.APP_URL ||
    'https://cresos.cresdynamics.com'
  ).replace(/\/$/, '');
  const logo = `${root}/brand/logo.png?v=20261023`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1b2a4a;">
  <div style="padding:16px 0 12px;border-bottom:3px solid #00a8c5;margin-bottom:16px;">
    <img src="${logo}" alt="CRES Dynamics" width="180" height="82" style="height:48px;width:auto;max-width:200px;border:0;display:block;" />
  </div>
  ${raw}
  <p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #cfd8e0;color:#8b9aab;font-size:12px;line-height:1.5;">CRES Dynamics · cresdynamics.com</p>
</div>`;
}

async function sendWithFailover({ to, subject, body, html, meta = {}, from, replyTo, cc, attachments, headers } = {}) {
  // Test-safety valve: when EMAIL_TEST_OVERRIDE is set OUTSIDE production, every
  // outbound email is redirected to that address (with the original recipient kept
  // in the subject). This is IGNORED in production so real mail is never misrouted.
  const isProduction = process.env.NODE_ENV === 'production';
  const testOverride = !isProduction && (process.env.EMAIL_TEST_OVERRIDE || '').trim();

  let sendTo = to;
  let sendSubject = subject;
  let sendMeta = meta;
  if (testOverride) {
    sendTo = testOverride;
    sendSubject = subject ? `[TEST→${to}] ${subject}` : subject;
    sendMeta = { ...meta, testOverride: true, originalTo: to };
    console.warn(`[email:test-override] redirected '${to}' -> ${testOverride}`);
  }

  const fromAddr = from || (await resolveFromAddress(sendMeta));
  const reply = replyTo || resolveReplyTo(sendMeta);
  const primary = config.email.mailer === 'resend' ? 'resend' : config.email.primary;
  // With Resend as primary, the company mailbox is the fallback when configured,
  // so a Resend problem (e.g. unverified domain) does not stop mail going out.
  const fallback = config.email.mailer === 'resend' ? (smtpSettings() ? 'smtp' : 'resend') : config.email.fallback;
  const brandedHtml = wrapBrandHtml(html);

  try {
    return await sendViaProvider(primary, {
      to: sendTo,
      subject: sendSubject,
      body,
      html: brandedHtml,
      from: fromAddr,
      replyTo: reply,
      cc,
      attachments,
      headers,
      meta: sendMeta,
    });
  } catch (primaryErr) {
    console.warn(`[email] primary (${primary}) failed: ${primaryErr.message}; trying fallback`);
    try {
      return await sendViaProvider(fallback, {
        to: sendTo,
        subject: sendSubject,
        body,
        html: brandedHtml,
        from: fromAddr,
        replyTo: reply,
        cc,
        attachments,
        headers,
        meta: { ...sendMeta, failoverFrom: primary },
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
