-- Migration 012: AI Report Review + Attendance Tracking + Salary Workflow
-- Run: node src/db/runMigration.js 012

-- AI analysis cache on reports
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS ai_analysis JSONB;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS remarks_reply TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS remarks_reply_at TIMESTAMPTZ;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS remarks_reply_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Attendance tracking: one row per user per expected work day
CREATE TABLE IF NOT EXISTS report_attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  submitted   BOOLEAN NOT NULL DEFAULT FALSE,
  report_id   UUID REFERENCES daily_reports(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, report_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_user ON report_attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON report_attendance(report_date);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON report_attendance(user_id, report_date);

-- Attendance deduction snapshot on salary payments
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS attendance_deductions JSONB;

-- Salary workflow: support partial payments
ALTER TABLE salary_payments DROP CONSTRAINT IF EXISTS salary_payments_status_check;
ALTER TABLE salary_payments ADD CONSTRAINT salary_payments_status_check
  CHECK (status IN ('owed', 'partially_paid', 'settled'));

-- Salary workflow: HR notes per individual salary payment
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS hr_note TEXT;
