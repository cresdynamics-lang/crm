-- Missing-report reminders for sales + developers, and the delay reasons they file.
-- Idempotent. Adds tables only.

-- One row per reminder sent (at most one per user every 12 hours).
CREATE TABLE IF NOT EXISTS report_reminder_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_report_at  TIMESTAMPTZ,
  hours_since     INTEGER NOT NULL,
  emailed         BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_reminder_user_sent ON report_reminder_log (user_id, sent_at DESC);

-- Why a report was late: filed by the staff member, seen by PM / Admin / Director / HR.
CREATE TABLE IF NOT EXISTS report_delay_notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id           UUID REFERENCES report_reminder_log(id) ON DELETE SET NULL,
  reason                TEXT NOT NULL,
  already_communicated  BOOLEAN NOT NULL DEFAULT FALSE,
  communicated_to       VARCHAR(255),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_delay_notes_user ON report_delay_notes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_delay_notes_created ON report_delay_notes (created_at DESC);
