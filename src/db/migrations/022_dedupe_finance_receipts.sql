-- Repeated invoice receipts, penalty notices, and event-payer emails
-- (same invoice, same day) left over from duplicate workers. Keep one
-- copy per day, restore penalty_count to the compounds actually on the
-- amount, and add unique keys so they cannot repeat.
-- Idempotent.

DELETE FROM invoice_email_log a
USING invoice_email_log b
WHERE a.ctid > b.ctid
  AND a.invoice_id = b.invoice_id
  AND a.channel IS NOT DISTINCT FROM b.channel
  AND a.status IS NOT DISTINCT FROM b.status
  AND a.created_at::date = b.created_at::date;

ALTER TABLE invoice_email_log ADD COLUMN IF NOT EXISTS day DATE;
UPDATE invoice_email_log
   SET day = created_at::date
 WHERE day IS NULL;
ALTER TABLE invoice_email_log ALTER COLUMN day SET DEFAULT CURRENT_DATE;

DO $$
BEGIN
  UPDATE invoice_email_log SET day = created_at::date WHERE day IS NULL;
  BEGIN
    ALTER TABLE invoice_email_log ALTER COLUMN day SET NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_email_log_once_per_day
  ON invoice_email_log (invoice_id, channel, status, day);

DELETE FROM notifications a
USING notifications b
WHERE a.ctid > b.ctid
  AND a.user_id = b.user_id
  AND a.type = b.type
  AND a.content = b.content
  AND a.created_at::date = b.created_at::date
  AND a.type LIKE 'invoice_%';

DELETE FROM website_payer_emails a
USING website_payer_emails b
WHERE a.ctid > b.ctid
  AND a.reservation_id = b.reservation_id
  AND lower(a.payer_email) = lower(b.payer_email);

CREATE UNIQUE INDEX IF NOT EXISTS website_payer_emails_once
  ON website_payer_emails (reservation_id, lower(payer_email));

CREATE UNIQUE INDEX IF NOT EXISTS payments_bank_reference_key
  ON payments (lower(btrim(bank_reference)))
  WHERE bank_reference IS NOT NULL AND btrim(bank_reference) <> '';

-- penalty_count was incremented by racing workers; amount compounded once per cycle.
UPDATE invoices
   SET penalty_count = 7,
       overdue_state = COALESCE(overdue_state, '{}'::jsonb) || jsonb_build_object('reminderBeforeCycle', 7, 'followupCycle', 7)
 WHERE id = '4aff633f-5cd6-58ab-83d2-14c929ca4b7c'
   AND penalty_count > 7;

UPDATE invoices
   SET penalty_count = 3,
       overdue_state = COALESCE(overdue_state, '{}'::jsonb) || jsonb_build_object('reminderBeforeCycle', 3, 'followupCycle', 3)
 WHERE id = '64a10992-285d-4845-b06b-2ae33d58cd91'
   AND penalty_count > 3;

UPDATE invoices
   SET penalty_count = 3,
       overdue_state = COALESCE(overdue_state, '{}'::jsonb) || jsonb_build_object('reminderBeforeCycle', 3, 'followupCycle', 3)
 WHERE id = '22b61f3a-2649-4359-88a3-a4bed901125e'
   AND penalty_count > 3;
