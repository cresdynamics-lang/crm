-- Cres Dynamics CRM - core schema (Step 1)
-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Identity & RBAC
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
  id          SERIAL PRIMARY KEY,
  resource    VARCHAR(100) NOT NULL,
  action      VARCHAR(50) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource, action)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(200) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  phone         VARCHAR(50),
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Refresh tokens (server-side revocation / rotation)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Idempotency keys for write operations (prevents double-charge / double-create)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         VARCHAR(255) PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  method      VARCHAR(10) NOT NULL,
  path        VARCHAR(500) NOT NULL,
  status_code INTEGER,
  response    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- ---------------------------------------------------------------------------
-- Sales / CRM
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(200) NOT NULL,
  phone         VARCHAR(50),
  email         VARCHAR(255),
  business_name VARCHAR(255),
  created_by    UUID NOT NULL REFERENCES users(id),
  status        VARCHAR(30) NOT NULL DEFAULT 'contacting'
                CHECK (status IN ('contacting', 'follow_up', 'not_interested', 'converted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created_by ON leads(created_by);

CREATE TABLE IF NOT EXISTS lead_engagements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  note           TEXT NOT NULL,
  follow_up_date DATE,
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_engagements_lead ON lead_engagements(lead_id);

CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID REFERENCES leads(id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  name          VARCHAR(200) NOT NULL,
  business_name VARCHAR(255),
  email         VARCHAR(255),
  phone         VARCHAR(50),
  converted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_lead ON clients(lead_id);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(255) NOT NULL,
  client_id              UUID REFERENCES clients(id) ON DELETE SET NULL,
  description            TEXT,
  milestones             JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary                TEXT,
  assigned_developer_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by             UUID NOT NULL REFERENCES users(id),
  status                 VARCHAR(30) NOT NULL DEFAULT 'pending_approval'
                         CHECK (status IN (
                           'pending_approval', 'approved', 'rejected',
                           'in_progress', 'blocked', 'completed'
                         )),
  value_amount           NUMERIC(14, 2),
  approved_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_developer ON projects(assigned_developer_id);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);

CREATE TABLE IF NOT EXISTS project_updates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  updated_by       UUID NOT NULL REFERENCES users(id),
  milestone_status VARCHAR(50),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_updates_project ON project_updates(project_id);

-- Immutable audit fields on project_updates (append-only; never UPDATE/DELETE these rows in app code)
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS actor_role VARCHAR(30);
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS change_summary TEXT;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS changes JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS daily_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_user ON daily_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_project ON daily_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_created ON daily_reports(created_at);

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  amount      NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  status      VARCHAR(20) NOT NULL DEFAULT 'issued'
              CHECK (status IN ('issued', 'paid', 'overdue')),
  auto_sent_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);

CREATE TABLE IF NOT EXISTS payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount      NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_followups (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  assigned_sales_user_id UUID NOT NULL REFERENCES users(id),
  flagged_by            UUID NOT NULL REFERENCES users(id),
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'followed_up')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_followups_sales ON invoice_followups(assigned_sales_user_id);
CREATE INDEX IF NOT EXISTS idx_invoice_followups_status ON invoice_followups(status);

CREATE TABLE IF NOT EXISTS expenses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category         VARCHAR(30) NOT NULL
                   CHECK (category IN ('salary', 'operational', 'other')),
  amount           NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  description      TEXT,
  linked_salary_id UUID,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_salary ON expenses(linked_salary_id);

-- Account balances / cash health (Finance + Admin only)
CREATE TABLE IF NOT EXISTS account_balances (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      VARCHAR(100) NOT NULL,
  balance    NUMERIC(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- HR
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  position      VARCHAR(150),
  salary_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  pay_cycle     VARCHAR(20) NOT NULL DEFAULT 'monthly'
                CHECK (pay_cycle IN ('monthly', 'biweekly', 'weekly')),
  home_address  TEXT,
  next_of_kin   TEXT,
  kra_pin       VARCHAR(50),
  bank_account  VARCHAR(100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS salary_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month           CHAR(7) NOT NULL,
  amount_expected NUMERIC(14, 2) NOT NULL,
  amount_paid     NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'owed'
                  CHECK (status IN ('owed', 'settled')),
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, month)
);

CREATE INDEX IF NOT EXISTS idx_salary_payments_status ON salary_payments(status);

-- FK from expenses.linked_salary_id → salary_payments (added after both exist)
ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_linked_salary_id_fkey;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_linked_salary_id_fkey
  FOREIGN KEY (linked_salary_id) REFERENCES salary_payments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Community / Notifications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_ids UUID[] NOT NULL,
  muted_by        UUID[] NOT NULL DEFAULT '{}',
  archived_by     UUID[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_participants ON conversations USING GIN (participant_ids);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, sent_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  content    TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

-- Dead-letter / failed job audit (mirrors BullMQ DLQ for DB visibility)
CREATE TABLE IF NOT EXISTS failed_jobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue      VARCHAR(100) NOT NULL,
  job_name   VARCHAR(100) NOT NULL,
  payload    JSONB NOT NULL,
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- User settings (Step 2 - personal prefs, not role editing)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_project_update BOOLEAN NOT NULL DEFAULT TRUE,
  notify_invoice_paid BOOLEAN NOT NULL DEFAULT TRUE,
  notify_new_message BOOLEAN NOT NULL DEFAULT TRUE,
  notify_daily_report BOOLEAN NOT NULL DEFAULT TRUE,
  notify_system BOOLEAN NOT NULL DEFAULT TRUE,
  email_digest BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Password reset OTPs (Login face)
CREATE TABLE IF NOT EXISTS password_reset_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset_otps(email);

-- Sales outbound emails to clients (not Community)
CREATE TABLE IF NOT EXISTS outbound_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by UUID NOT NULL REFERENCES users(id),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  to_email VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbound_emails_client ON outbound_emails(client_id);
CREATE INDEX IF NOT EXISTS idx_outbound_emails_sender ON outbound_emails(sent_by);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Milestone JSONB contract (projects.milestones):
-- [{ "id", "title", "status": "not_started|in_progress|blocked|completed",
--    "due_date", "tasks": [{ "id", "title", "hours", "status": "pending|in_progress|done" }] }]

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

ALTER TABLE invoice_followups ADD COLUMN IF NOT EXISTS note TEXT;

-- Report routing: Sales/Dev → PM review → Director hub
ALTER TABLE daily_reports
  ADD COLUMN IF NOT EXISTS routing_status VARCHAR(30) NOT NULL DEFAULT 'pending_pm'
    CHECK (routing_status IN ('pending_pm', 'pm_reviewed', 'forwarded_director'));
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS forwarded_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS pm_note TEXT;
CREATE INDEX IF NOT EXISTS idx_daily_reports_routing ON daily_reports(routing_status);

CREATE TABLE IF NOT EXISTS invoice_email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  channel VARCHAR(40) NOT NULL DEFAULT 'primary',
  status VARCHAR(20) NOT NULL CHECK (status IN ('queued','sent','failed')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_email_log_invoice ON invoice_email_log(invoice_id);

-- ---------------------------------------------------------------------------
-- Admin: system config + report reactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_reactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   UUID NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_reactions_report ON report_reactions(report_id);

-- Client-shared project documents (portal view-only)
CREATE TABLE IF NOT EXISTS project_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  file_path   TEXT NOT NULL,
  original_name VARCHAR(255),
  mime_type   VARCHAR(120),
  file_size   INTEGER,
  shared_with_client BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id);

-- ---------------------------------------------------------------------------
-- Critical refinements (partial payments, expenses, leave, audit, invites…)
-- ---------------------------------------------------------------------------

-- Invoices: due dates + partial payment tracking
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0;
UPDATE invoices SET status = 'issued' WHERE status NOT IN ('issued','paid','overdue','partially_paid');
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('issued', 'partially_paid', 'paid', 'overdue'));

-- Backfill due_date = created_at + 14 days where null
UPDATE invoices SET due_date = (created_at::date + INTERVAL '14 days')::date WHERE due_date IS NULL;

-- Expenses: approval workflow (Director → Finance → Admin)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approval_status VARCHAR(40) NOT NULL DEFAULT 'approved';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approval_note TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS finance_approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS finance_approved_at TIMESTAMPTZ;
ALTER TABLE expenses ALTER COLUMN approval_status TYPE VARCHAR(40);

-- Milestone deliverables (developer uploads)
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS milestone_title VARCHAR(255);
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS kind VARCHAR(40) NOT NULL DEFAULT 'shared';

-- Client milestone sign-off
CREATE TABLE IF NOT EXISTS milestone_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_title VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'changes_requested')),
  client_note TEXT,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, milestone_title)
);
CREATE INDEX IF NOT EXISTS idx_milestone_signoffs_project ON milestone_signoffs(project_id);

-- Client change requests (no Community chat - routes to Sales)
CREATE TABLE IF NOT EXISTS client_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject VARCHAR(255) NOT NULL,
  details TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_change_requests_project ON client_change_requests(project_id);

-- HR leave / time-off
CREATE TABLE IF NOT EXISTS leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  leave_type VARCHAR(40) NOT NULL DEFAULT 'annual'
    CHECK (leave_type IN ('annual', 'sick', 'unpaid', 'other')),
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leave_employee ON leave_requests(employee_id);

-- Login / session audit
CREATE TABLE IF NOT EXISTS login_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email VARCHAR(255),
  success BOOLEAN NOT NULL,
  ip VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_audit_user ON login_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_login_audit_created ON login_audit(created_at);

-- Invite-based onboarding (Admin/HR)
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_hash VARCHAR(128);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_set_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Follow-up due notification dedupe
CREATE TABLE IF NOT EXISTS followup_alert_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, user_id, alert_date)
);

-- System setting for expense approval threshold
INSERT INTO system_settings (key, value)
VALUES ('expense_approval', '{"threshold": 500, "requireAboveThreshold": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Cres Dynamics invoice / receipt letterhead (Kenya)
INSERT INTO system_settings (key, value)
VALUES (
  'company_profile',
  '{
    "legalName": "Cres Dynamics Ltd",
    "tradingName": "Cres Dynamics Ltd",
    "tagline": "Building digital systems that Businesses Run On.",
    "addressLines": ["P.O. BOX 1112 – 00100, NAIROBI, KENYA", "Kivuli Towers, 3rd floor, Westlands, Nairobi"],
    "phone": "+254 743 869 564 / +254 708 805 496",
    "email": "info@cresdynamics.com",
    "financeEmail": "finance@cresdynamics.com",
    "emailFromName": "Cres Dynamics Finance",
    "website": "www.cresdynamics.com",
    "taxLabel": "KRA PIN",
    "taxId": "P052570833B",
    "currency": "KES",
    "bankName": "I & M Bank",
    "bankAccountName": "Cres Dynamics Ltd",
    "bankAccountNumber": "01209982836350",
    "bankBranch": "Ongata Rongai",
    "mpesaPaybill": "542542",
    "mpesaAccount": "43869",
    "paymentNote": "Please use the invoice number as your payment reference.",
    "lateFeeNote": "Late payments attract 2% monthly interest after the due date. For payment queries contact info@cresdynamics.com or +254 708 805 496.",
    "footer": "Thank you for your business. Cres Dynamics Ltd — cresdynamics.com",
    "logoUrl": "/brand/logo.png",
    "signatureUrl": "/brand/signature.png?v=20260815e",
    "financeSignatureUrl": "/brand/signature-scholastica.png?v=20260815f",
    "invoicedBy": {"name": "Scholastica Omoro", "title": "Finance, Cres Dynamics Ltd"},
    "authorisedBy": {"name": "Nelson Were", "title": "Chief Executive Officer, Cres Dynamics Ltd"}
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- ---------------------------------------------------------------------------
-- Role lock-down: developer assignment Accept/Swap/Reject + action audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  developer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'swapped', 'rejected', 'auto_reassigned', 'cancelled')),
  original_developer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  swap_of_assignment_id UUID REFERENCES project_assignments(id) ON DELETE SET NULL,
  note TEXT,
  expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assign_developer ON project_assignments(developer_id, status);
CREATE INDEX IF NOT EXISTS idx_assign_project ON project_assignments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assign_pending_expires ON project_assignments(status, expires_at)
  WHERE status = 'pending';

-- Active developer still mirrored on projects for fast scoping
ALTER TABLE projects ADD COLUMN IF NOT EXISTS assignment_status VARCHAR(30);

CREATE TABLE IF NOT EXISTS action_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role VARCHAR(40),
  action VARCHAR(80) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id UUID,
  summary TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_audit_created ON action_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_audit_resource ON action_audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_action_audit_actor ON action_audit_log(actor_id);

-- Lead business type + scheduled outbound messages
ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_type VARCHAR(255);

CREATE TABLE IF NOT EXISTS lead_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  error TEXT,
  provider_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_messages_lead ON lead_messages(lead_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_lead_messages_due ON lead_messages(status, scheduled_for)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS stale_lead_alert_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, user_id, alert_date)
);

-- Profile pictures (served from /uploads/avatars)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Live project preview URL (visible to ops roles + client; not Finance/HR)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_url TEXT;

-- Director remarks / clarifying questions on daily reports
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS remarks_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS remarks_at TIMESTAMPTZ;

-- HR employee onboarding fields
ALTER TABLE employees ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS next_of_kin TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS kra_pin VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100);

-- Salary funding requests: HR → Finance → Admin (not expenses)
CREATE TABLE IF NOT EXISTS salary_funding_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month CHAR(7) NOT NULL,
  amount_requested NUMERIC(14, 2) NOT NULL,
  amount_funded NUMERIC(14, 2),
  status VARCHAR(40) NOT NULL DEFAULT 'pending_finance'
    CHECK (status IN (
      'pending_finance',
      'finance_approved',
      'admin_approved',
      'rejected'
    )),
  note TEXT,
  finance_note TEXT,
  admin_note TEXT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  finance_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finance_approved_at TIMESTAMPTZ,
  admin_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_approved_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_salary_funding_month ON salary_funding_requests(month);
CREATE INDEX IF NOT EXISTS idx_salary_funding_status ON salary_funding_requests(status);
-- One active (non-rejected) request per month
CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_funding_active_month
  ON salary_funding_requests(month)
  WHERE status IN ('pending_finance', 'finance_approved', 'admin_approved');

-- Payments: bank / remittance reference per payment
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(120);

-- Residual invoices created when a partial payment closes the paid portion
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS parent_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_parent ON invoices(parent_invoice_id);

-- Track client overdue email so we do not spam
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS overdue_emailed_at TIMESTAMPTZ;

-- Salary funding: which employees HR selected for the month request
ALTER TABLE salary_funding_requests
  ADD COLUMN IF NOT EXISTS employee_ids UUID[] NOT NULL DEFAULT '{}';

-- Admin AI inbox (IMAP → draft → approve / regenerate / ignore)
CREATE TABLE IF NOT EXISTS admin_inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imap_uid BIGINT,
  message_id VARCHAR(512),
  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(255),
  to_emails TEXT[] NOT NULL DEFAULT '{}',
  cc_emails TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ,
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  attachment_summaries JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'drafted', 'approved', 'sent', 'ignored', 'error')),
  ai_draft TEXT,
  ai_summary TEXT,
  ai_instructions TEXT,
  final_body TEXT,
  error TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_inbox_message_id
  ON admin_inbox_messages(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_inbox_status ON admin_inbox_messages(status);
CREATE INDEX IF NOT EXISTS idx_admin_inbox_received ON admin_inbox_messages(received_at DESC);


-- Invoice create: line items, issue date, human number; project finance seq
ALTER TABLE projects ADD COLUMN IF NOT EXISTS finance_seq INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date DATE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_finance_seq ON projects(finance_seq);

-- Assigned director: users report to a specific director (set by Admin/HR)
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_director_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_assigned_director ON users(assigned_director_id);

-- Tasks: link to projects
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- ============================================================
-- CRES OPS: Knowledge Base / RAG Data Pool
-- ============================================================

-- Admin-fed knowledge base documents (text, voice transcriptions, uploaded docs)
CREATE TABLE IF NOT EXISTS knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(300) NOT NULL,
  content TEXT NOT NULL,
  source_type VARCHAR(40) NOT NULL DEFAULT 'text'
    CHECK (source_type IN ('text', 'document', 'voice', 'system')),
  source_file VARCHAR(500),
  category VARCHAR(80) NOT NULL DEFAULT 'general'
    CHECK (category IN (
      'general', 'onboarding', 'processes', 'policies', 'decisions',
      'finance', 'sales', 'development', 'hr', 'operations', 'strategy'
    )),
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  accessible_roles JSONB NOT NULL DEFAULT '["all"]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_created ON knowledge_base(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_source ON knowledge_base(source_type);
CREATE INDEX IF NOT EXISTS idx_kb_tags ON knowledge_base USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_kb_accessible ON knowledge_base USING GIN(accessible_roles);

-- Cres Ops conversation history (user questions + AI answers)
CREATE TABLE IF NOT EXISTS ops_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_role VARCHAR(40) NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ops_conv_user ON ops_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ops_conv_created ON ops_conversations(created_at DESC);

-- Expanded daily report sections (HR well-being + structured fields)
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS work_done TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS blockers_text TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS needs_attention TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS hard_today TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS easy_today TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS happiness TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS concerns TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS assigned_director_id UUID REFERENCES users(id) ON DELETE SET NULL;
