-- Meeting notes, live transcript (minutes) and the emailed summary.
-- Idempotent. Adds tables/columns only.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS minutes_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary_sent_at TIMESTAMPTZ;

-- Notes anyone in the meeting writes.
CREATE TABLE IF NOT EXISTS meeting_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  author_name TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_meeting ON meeting_notes(meeting_id, created_at);

-- What was said, line by line, while the host has minutes switched on.
CREATE TABLE IF NOT EXISTS meeting_transcript (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  speaker_name TEXT NOT NULL,
  text         TEXT NOT NULL,
  spoken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_transcript_meeting ON meeting_transcript(meeting_id, spoken_at);
