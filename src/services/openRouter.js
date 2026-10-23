/**
 * OpenRouter chat — used for the Admin same-day operations briefing.
 * Default model: anthropic/claude-sonnet-4.5 (best at factual, structured briefs).
 */
const config = require('../config');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonObject(text) {
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('OpenRouter response was not JSON');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function openRouterChat({
  messages,
  temperature = 0.2,
  model = config.openRouter.model,
  maxTokens = 1800,
}) {
  const key = config.openRouter.apiKey;
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.openRouter.siteUrl,
      'X-Title': config.openRouter.appName,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || `OpenRouter HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty OpenRouter response');
  return { text, model: data?.model || model, raw: data };
}

async function openRouterChatWithFallback(opts) {
  const primary = config.openRouter.model;
  const fallback = config.openRouter.fallbackModel;
  try {
    return await openRouterChat({ ...opts, model: primary });
  } catch (err) {
    const retryable = err.status === 404 || err.status === 400 || /model/i.test(err.message || '');
    if (!fallback || fallback === primary || !retryable) throw err;
    console.warn(`[openrouter] ${primary} failed (${err.message}); trying ${fallback}`);
    await sleep(250);
    return await openRouterChat({ ...opts, model: fallback });
  }
}

async function openRouterJson(opts) {
  const result = await openRouterChatWithFallback(opts);
  return { ...result, json: parseJsonObject(result.text) };
}

module.exports = {
  openRouterChat,
  openRouterChatWithFallback,
  openRouterJson,
  parseJsonObject,
};
