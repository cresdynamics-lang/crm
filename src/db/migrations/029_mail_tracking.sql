-- Reply tracking for Team mail: every email staff send out carries a unique
-- reference (in the signature) and our own Message-ID; incoming mail keeps its
-- In-Reply-To / References headers so replies are routed to the right person.
-- Idempotent; adds columns only.
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS ref_code VARCHAR(20);
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS message_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_mail_sent_ref ON team_mail_sent (ref_code) WHERE ref_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_mail_sent_msgid ON team_mail_sent (message_id) WHERE message_id IS NOT NULL;

ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS in_reply_to VARCHAR(512);
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS reference_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS routed_by VARCHAR(20); -- header | reference | sender

ALTER TABLE team_mail ADD COLUMN IF NOT EXISTS sent_ref_id UUID REFERENCES team_mail_sent(id) ON DELETE SET NULL;
ALTER TABLE team_mail ADD COLUMN IF NOT EXISTS reply_message_id VARCHAR(512);
