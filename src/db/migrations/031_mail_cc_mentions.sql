-- CC inside CRES OS: staff can @mention colleagues on an email. They get a copy in Team mail
-- when it is sent, and every reply the company inbox receives is shared with them too.
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS cc_user_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE team_mail ADD COLUMN IF NOT EXISTS is_cc BOOLEAN NOT NULL DEFAULT FALSE;
