/**
 * Groq chat completions for Admin inbox AI drafts.
 */
const config = require('../config');

function apiKeys() {
  return [config.groq.apiKey, config.groq.apiKeySecondary, config.groq.apiKeyTertiary].filter(
    Boolean
  );
}

async function groqChat({ messages, temperature = 0.4 }) {
  const keys = apiKeys();
  if (!keys.length) {
    throw new Error('GROQ_API_KEY is not configured');
  }
  let lastErr;
  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.groq.model,
          messages,
          temperature,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error?.message || `Groq HTTP ${res.status}`);
      }
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('Empty Groq response');
      return { text, model: config.groq.model, raw: data };
    } catch (err) {
      lastErr = err;
      console.warn(`[groq] key failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('Groq unavailable');
}

async function draftInboxReply({ fromName, fromEmail, subject, bodyText, attachmentSummaries, instructions }) {
  const attach =
    Array.isArray(attachmentSummaries) && attachmentSummaries.length
      ? attachmentSummaries.map((a) => `- ${a.name || 'file'}: ${a.summary || a.mime || ''}`).join('\n')
      : 'None';

  const system = `You are the Cres Dynamics Admin email assistant.
Write a professional reply email body (plain text) on behalf of Cres Dynamics Admin.
Be concise, accurate, and actionable. Do not invent facts not present in the source email or attachments.
If PDFs/attachments are summarized, use those facts. Sign off as Cres Dynamics Admin.`;

  const user = `Incoming email
From: ${fromName || ''} <${fromEmail}>
Subject: ${subject || '(no subject)'}

Body:
${bodyText || '(empty)'}

Attachment notes:
${attach}

${instructions ? `Extra regeneration instructions from Admin:\n${instructions}\n` : ''}
Write only the reply body.`;

  const { text } = await groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const summaryPrompt = await groqChat({
    messages: [
      {
        role: 'system',
        content: 'Summarize the incoming email in 2 short sentences for an admin inbox card.',
      },
      {
        role: 'user',
        content: `From ${fromEmail}\nSubject: ${subject}\n\n${(bodyText || '').slice(0, 4000)}`,
      },
    ],
    temperature: 0.2,
  });

  return { draft: text, summary: summaryPrompt.text };
}

module.exports = { groqChat, draftInboxReply };
