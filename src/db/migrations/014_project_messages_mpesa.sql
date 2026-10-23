-- Phase 4–5: project messages, change-request decisions, M-Pesa claims.
-- Idempotent. Does not rewrite existing rows.
-- FKs are applied only when the referenced table has a unique id (skipped on
-- live DBs that were duplicated without primary keys).

CREATE TABLE IF NOT EXISTS project_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_messages_project ON project_messages(project_id, created_at);
DO $$ BEGIN
  ALTER TABLE project_messages
    ADD CONSTRAINT project_messages_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  ALTER TABLE project_messages
    ADD CONSTRAINT project_messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN OTHERS THEN
  RAISE NOTICE 'skip project_messages FKs: %', SQLERRM;
END $$;

ALTER TABLE client_change_requests DROP CONSTRAINT IF EXISTS client_change_requests_status_check;
ALTER TABLE client_change_requests ADD CONSTRAINT client_change_requests_status_check
  CHECK (status IN ('open', 'acknowledged', 'closed', 'accepted', 'quoted', 'declined'));
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(14, 2);
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS staff_note TEXT;
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS decided_by UUID;
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mpesa_claim_code VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mpesa_claimed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mpesa_claimed_by UUID;
DO $$ BEGIN
  ALTER TABLE client_change_requests
    ADD CONSTRAINT client_change_requests_decided_by_fkey
    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE invoices
    ADD CONSTRAINT invoices_mpesa_claimed_by_fkey
    FOREIGN KEY (mpesa_claimed_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN OTHERS THEN
  RAISE NOTICE 'skip decided_by/mpesa_claimed_by FKs: %', SQLERRM;
END $$;
