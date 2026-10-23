-- Community chat: delivery/read ticks, edit within 30 minutes, delete for me / for everyone.
-- Idempotent. Only backfills the new delivered_at column; existing content is untouched.
--   delivered_at  set when the recipient was online at send time, or when they next connect
--   read_at       (already existed) set when the recipient opens the conversation
--   edited_at     set when the sender edits (allowed for 30 minutes after sending)
--   deleted_at    set when the sender deletes for everyone; content is blanked
--   deleted_for   users who deleted the message just for themselves

ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for UUID[] NOT NULL DEFAULT '{}';

-- Messages already read count as delivered.
UPDATE messages SET delivered_at = read_at WHERE delivered_at IS NULL AND read_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(conversation_id) WHERE delivered_at IS NULL;
