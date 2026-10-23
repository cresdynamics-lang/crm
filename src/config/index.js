require('dotenv').config();

function looksLikeApiKey(v) {
  return typeof v === 'string' && /^gsk_/i.test(v.trim());
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  websiteDatabaseUrl: process.env.WEBSITE_DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-insecure-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  email: {
    from: process.env.EMAIL_FROM || 'noreply@cresdynamics.local',
    primary: process.env.EMAIL_PRIMARY_PROVIDER || 'primary',
    fallback: process.env.EMAIL_FALLBACK_PROVIDER || 'fallback',
    mailer: process.env.MAIL_MAILER || 'stub',
    resendApiKey: process.env.RESEND_API_KEY || '',
    resendFrom: process.env.RESEND_FROM_EMAIL || process.env.MAIL_FROM_ADDRESS || '',
    resendReplyTo: process.env.RESEND_REPLY_TO || '',
    resendFromFinance: process.env.RESEND_FROM_EMAIL_FINANCE || '',
    resendReplyToFinance: process.env.RESEND_REPLY_TO_FINANCE || '',
    resendFromSales: process.env.RESEND_FROM_EMAIL_SALES || '',
    resendReplyToSales: process.env.RESEND_REPLY_TO_SALES || '',
    resendFromDirector: process.env.RESEND_FROM_EMAIL_DIRECTOR || '',
    resendReplyToDirector: process.env.RESEND_REPLY_TO_DIRECTOR || '',
  },
  imap: {
    host: process.env.IMAP_HOST || process.env.MAIL_HOST || '',
    port: Number(process.env.IMAP_PORT || 993),
    user: process.env.IMAP_USER || process.env.IMAP_USERNAME || process.env.MAIL_USERNAME || '',
    password: process.env.IMAP_PASSWORD || process.env.MAIL_PASSWORD || '',
    secure: String(process.env.IMAP_ENCRYPTION || 'ssl').toLowerCase() !== 'none',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    apiKeySecondary: process.env.GROQ_API_KEY_SECONDARY || '',
    apiKeyTertiary: process.env.GROQ_API_KEY_TERTIARY || '',
    model:
      process.env.GROQ_MODEL && !looksLikeApiKey(process.env.GROQ_MODEL)
        ? process.env.GROQ_MODEL
        : 'qwen/qwen3.8-27b',
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
  },
  // Daily ops briefing. Claude Sonnet is the strongest cheap brief-writer on OpenRouter:
  // it stays on the supplied numbers and organises Finance / Director / Admin cleanly.
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
    fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'openai/gpt-4.1-mini',
    siteUrl: process.env.OPENROUTER_SITE_URL || 'https://cresos.cresdynamics.com',
    appName: process.env.OPENROUTER_APP_NAME || 'CRES Dynamics CRM',
  },
  leadEmail: {
    apiUrl: process.env.LEAD_EMAIL_API_URL || '',
    apiKey: process.env.LEAD_EMAIL_API_KEY || '',
  },
  queue: {
    attempts: Number(process.env.QUEUE_ATTEMPTS) || 3,
    backoffMs: Number(process.env.QUEUE_BACKOFF_MS) || 2000,
  },
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

module.exports = config;
