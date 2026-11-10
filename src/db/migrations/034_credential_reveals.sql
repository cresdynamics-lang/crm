-- "Click to see your login password": the email carries a private link, not the password.
-- The password is kept encrypted, shown after a click, and erased 15 minutes after it is first seen
-- (or after 7 days unseen). Changing the password invalidates the link.
CREATE TABLE IF NOT EXISTS credential_reveals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,
  secret_enc    TEXT,
  pw_fingerprint VARCHAR(64) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revealed_at   TIMESTAMPTZ,
  wiped_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_credential_reveals_user ON credential_reveals (user_id, created_at DESC);

-- Stale-lead alerts re-fired for every lead every day (thousands of unread). Anything older than 3 days is marked read.
UPDATE notifications SET read_at = NOW() WHERE type = 'lead_stale' AND read_at IS NULL AND created_at < NOW() - INTERVAL '3 days';
