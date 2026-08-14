/**
 * Lead outbound email - uses current mail failover by default.
 * When LEAD_EMAIL_API_URL is set, POSTs to that API instead (plug in shared provider later).
 *
 * Expected external API (when configured):
 *   POST {LEAD_EMAIL_API_URL}
 *   Headers: Authorization: Bearer {LEAD_EMAIL_API_KEY} (optional)
 *   Body: { to, subject, body, leadId, messageId, meta }
 *   Response: { ok: true, messageId?: string } or 2xx
 */
const config = require('../config');
const { sendWithFailover } = require('./emailService');

async function sendLeadEmail({ to, subject, body, leadId, messageId, meta = {} }) {
  const apiUrl = process.env.LEAD_EMAIL_API_URL || config.leadEmail?.apiUrl;
  const apiKey = process.env.LEAD_EMAIL_API_KEY || config.leadEmail?.apiKey;

  if (apiUrl) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        to,
        subject,
        body,
        leadId,
        messageId,
        meta,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Lead email API failed (${res.status})`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return {
      provider: 'external_api',
      messageId: data.messageId || data.id || `ext-${Date.now()}`,
      raw: data,
    };
  }

  const result = await sendWithFailover({
    to,
    subject,
    body,
    meta: { type: 'lead_message', leadId, messageId, ...meta },
  });
  return {
    provider: result.provider || 'failover',
    messageId: result.messageId || `lead-${messageId}`,
    raw: result,
  };
}

module.exports = { sendLeadEmail };
