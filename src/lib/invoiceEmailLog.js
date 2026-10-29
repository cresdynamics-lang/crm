const { query } = require('../config/database');

/** One log row per invoice / channel / status / day. Extra copies are ignored. */
async function logInvoiceEmail(invoiceId, channel, status, detail, exec = query) {
  if (!invoiceId) return;
  await exec(
    `INSERT INTO invoice_email_log (invoice_id, channel, status, detail, day)
     VALUES ($1, $2, $3, $4, CURRENT_DATE)
     ON CONFLICT (invoice_id, channel, status, day) DO NOTHING`,
    [invoiceId, channel || 'primary', status || 'queued', detail || null]
  );
}

module.exports = { logInvoiceEmail };
