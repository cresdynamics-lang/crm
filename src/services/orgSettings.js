/**
 * Company / Organization settings helpers (system_settings).
 */
const { query } = require('../config/database');

const DEFAULT_EMAIL_AUTOMATIONS = {
  invoiceIssued: true,
  paymentReceipt: true,
  overdueReminder: true,
  overduePenalty: true,
  overdueFollowup: true,
  userInvite: true,
  leadMessage: true,
};

async function getOrgValue(key, fallback = {}) {
  try {
    const { rows } = await query(`SELECT value FROM system_settings WHERE key = $1`, [key]);
    const v = rows[0]?.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...fallback };
    return { ...fallback, ...v };
  } catch {
    return { ...fallback };
  }
}

async function isEmailAutomationOn(name) {
  const flags = await getOrgValue('email_automations', DEFAULT_EMAIL_AUTOMATIONS);
  return flags[name] !== false;
}

async function getEmailTemplates() {
  return getOrgValue('email_templates', {});
}

function fillTemplate(str, vars = {}) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

module.exports = {
  DEFAULT_EMAIL_AUTOMATIONS,
  getOrgValue,
  isEmailAutomationOn,
  getEmailTemplates,
  fillTemplate,
};
