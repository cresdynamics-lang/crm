-- Admin notes on daily reports are visible to Director only, never the reporter.
-- Idempotent. Does not rewrite existing rows.
-- FK is applied only when users.id is unique (skipped on duplicated live DBs).

ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS admin_director_note TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS admin_director_note_by UUID;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS admin_director_note_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE daily_reports
    ADD CONSTRAINT daily_reports_admin_director_note_by_fkey
    FOREIGN KEY (admin_director_note_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN OTHERS THEN
  RAISE NOTICE 'skip daily_reports_admin_director_note_by_fkey: %', SQLERRM;
END $$;
