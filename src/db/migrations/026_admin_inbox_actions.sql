-- Admin inbox: read/unread, scam flag, decline, soft delete, auto-drafts.
-- Idempotent. Adds columns and widens the status list; never drops rows.

ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS is_scam BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS scam_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS scam_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS scam_marked_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(255);
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS handled_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE admin_inbox_messages ADD COLUMN IF NOT EXISTS drafted_at TIMESTAMPTZ;

-- Everything already synced before this change counts as read (it was on screen).
UPDATE admin_inbox_messages SET is_read = TRUE, read_at = COALESCE(read_at, updated_at)
 WHERE is_read = FALSE AND status IN ('sent', 'ignored');

ALTER TABLE admin_inbox_messages DROP CONSTRAINT IF EXISTS admin_inbox_messages_status_check;
ALTER TABLE admin_inbox_messages ADD CONSTRAINT admin_inbox_messages_status_check
  CHECK (status IN ('pending', 'drafted', 'approved', 'sent', 'ignored', 'declined', 'error'));

CREATE INDEX IF NOT EXISTS idx_admin_inbox_live
  ON admin_inbox_messages (COALESCE(received_at, created_at) DESC) WHERE deleted_at IS NULL;
