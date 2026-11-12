-- Website integration removed: drop the website payer contact log.
-- Idempotent.
DROP TABLE IF EXISTS website_payer_emails;
DELETE FROM system_settings WHERE key ILIKE '%website%';
DELETE FROM notifications WHERE type ILIKE '%website%';
