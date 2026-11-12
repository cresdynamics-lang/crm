-- Follow-up reminders: emails sent with no reply after 2 days, and received mail nobody answered.
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS followup_reminded_at TIMESTAMPTZ;
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS followup_dismissed_at TIMESTAMPTZ;
ALTER TABLE outbound_emails ADD COLUMN IF NOT EXISTS followup_reminded_at TIMESTAMPTZ;
ALTER TABLE outbound_emails ADD COLUMN IF NOT EXISTS followup_dismissed_at TIMESTAMPTZ;
ALTER TABLE team_mail ADD COLUMN IF NOT EXISTS followup_reminded_at TIMESTAMPTZ;
ALTER TABLE team_mail ADD COLUMN IF NOT EXISTS followup_dismissed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_team_mail_sent_user_created ON team_mail_sent (user_id, created_at DESC);
