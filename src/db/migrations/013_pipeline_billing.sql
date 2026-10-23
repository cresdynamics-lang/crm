-- Phase 3: pipeline stages, deal value, payment method, expense categories, project deadline.
-- Idempotent. Does not rewrite existing lead/payment/expense rows.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS value_amount NUMERIC(14, 2);

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN (
    'contacting', 'follow_up', 'not_interested', 'converted',
    'new', 'contacted', 'meeting', 'proposal', 'won', 'lost'
  ));

ALTER TABLE payments ADD COLUMN IF NOT EXISTS method VARCHAR(20) NOT NULL DEFAULT 'bank';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('mpesa', 'bank', 'cash'));

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_check
  CHECK (category IN (
    'salary', 'operational', 'other',
    'hosting', 'domains', 'transport', 'ads', 'salaries', 'drawings'
  ));

ALTER TABLE projects ADD COLUMN IF NOT EXISTS due_date DATE;

-- Finance can use Community chat (permission rows only; no existing data changed)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.resource = 'messages' AND p.action IN ('view', 'create')
WHERE r.name = 'finance'
ON CONFLICT DO NOTHING;
