-- Phase 6: HR applicants + per-hire onboarding checklist.
-- Idempotent. Does not rewrite existing rows.
-- FKs are applied only when the referenced table has a unique id.

CREATE TABLE IF NOT EXISTS applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200),
  phone VARCHAR(50),
  role_applied VARCHAR(150) NOT NULL,
  stage VARCHAR(20) NOT NULL DEFAULT 'applied'
    CHECK (stage IN ('applied', 'interview', 'offer', 'hired', 'rejected')),
  interview_date DATE,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_applicants_stage ON applicants(stage);
CREATE INDEX IF NOT EXISTS idx_applicants_created ON applicants(created_at DESC);
DO $$ BEGIN
  ALTER TABLE applicants
    ADD CONSTRAINT applicants_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN OTHERS THEN
  RAISE NOTICE 'skip applicants_created_by_fkey: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS employee_onboarding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  goal_30 TEXT,
  goal_60 TEXT,
  goal_90 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_employee_onboarding_employee ON employee_onboarding(employee_id);
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS employee_onboarding_employee_id_key
    ON employee_onboarding(employee_id);
  ALTER TABLE employee_onboarding
    ADD CONSTRAINT employee_onboarding_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN OTHERS THEN
  RAISE NOTICE 'skip employee_onboarding unique/FK: %', SQLERRM;
END $$;
