-- Phase 4–5: project messages, change-request decisions, M-Pesa claims.
-- Idempotent. Does not rewrite existing rows.

CREATE TABLE IF NOT EXISTS project_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_messages_project ON project_messages(project_id, created_at);

ALTER TABLE client_change_requests DROP CONSTRAINT IF EXISTS client_change_requests_status_check;
ALTER TABLE client_change_requests ADD CONSTRAINT client_change_requests_status_check
  CHECK (status IN ('open', 'acknowledged', 'closed', 'accepted', 'quoted', 'declined'));
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(14, 2);
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS staff_note TEXT;
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE client_change_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mpesa_claim_code VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mpesa_claimed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mpesa_claimed_by UUID REFERENCES users(id) ON DELETE SET NULL;
