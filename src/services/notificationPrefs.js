/**
 * Map notification types → user_settings preference columns.
 * Missing settings row = all prefs default ON (except email_digest).
 */
function prefKeyForType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('message')) return 'notify_new_message';
  if (t.includes('invoice') || t.includes('payment')) return 'notify_invoice_paid';
  if (t.includes('report')) return 'notify_daily_report';
  if (
    t.includes('project') ||
    t.includes('milestone') ||
    t.includes('approval') ||
    t.includes('assignment') ||
    t.includes('reject')
  ) {
    return 'notify_project_update';
  }
  return 'notify_system';
}

/**
 * @returns {{ allowInApp: boolean, emailDigest: boolean, prefKey: string }}
 */
async function resolveDelivery(query, userId, type) {
  const prefKey = prefKeyForType(type);
  const { rows } = await query(
    `SELECT notify_project_update, notify_invoice_paid, notify_new_message,
            notify_daily_report, notify_system, email_digest
     FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  const prefs = rows[0];
  if (!prefs) {
    return { allowInApp: true, emailDigest: false, prefKey };
  }
  const allowInApp = prefs[prefKey] !== false;
  const emailDigest = prefs.email_digest === true;
  return { allowInApp, emailDigest, prefKey };
}

module.exports = { prefKeyForType, resolveDelivery };
