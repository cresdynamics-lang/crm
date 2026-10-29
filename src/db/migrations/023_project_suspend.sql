-- Finance can suspend a project. After 3 overdue invoice penalties the
-- linked project is suspended and further 2% penalties stop.
-- Idempotent. Does not delete existing rows.

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.projects'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%pending_approval%'
  LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE projects DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN (
    'pending_approval', 'approved', 'rejected',
    'in_progress', 'blocked', 'completed', 'suspended'
  ));

ALTER TABLE projects ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS suspended_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS suspend_reason TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_before_suspend VARCHAR(30);
