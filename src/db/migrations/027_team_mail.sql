-- Team mail: emails forwarded inside CRES OS (never to anyone's personal mailbox),
-- and emails staff send to outside people as "<Name> - <Team>, Cres Dynamics Ltd"
-- with replies going to the company inbox. Idempotent; new tables only.

CREATE TABLE IF NOT EXISTS team_mail (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_message_id    UUID REFERENCES admin_inbox_messages(id) ON DELETE SET NULL,
  parent_id           UUID REFERENCES team_mail(id) ON DELETE SET NULL,
  from_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_team             VARCHAR(40),
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  note                TEXT,
  original_from_email VARCHAR(255),
  original_from_name  VARCHAR(255),
  original_subject    TEXT,
  original_received_at TIMESTAMPTZ,
  attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_routed         BOOLEAN NOT NULL DEFAULT FALSE,
  status              VARCHAR(20) NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'done')),
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_mail_to ON team_mail (to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_mail_inbox ON team_mail (inbox_message_id);

CREATE TABLE IF NOT EXISTS team_mail_sent (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_mail_id  UUID REFERENCES team_mail(id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  team_label    VARCHAR(80) NOT NULL,
  to_email      VARCHAR(255) NOT NULL,
  cc            TEXT[] NOT NULL DEFAULT '{}',
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  provider      VARCHAR(40),
  message_ref   VARCHAR(255),
  status        VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_mail_sent_user ON team_mail_sent (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_mail_sent_to ON team_mail_sent (LOWER(to_email), created_at DESC);

ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS routed_to UUID REFERENCES users(id) ON DELETE SET NULL;
