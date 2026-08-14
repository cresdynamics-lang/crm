/**
 * Periodic ops: invoice overdue detection + sales follow-up due alerts.
 */
const { query } = require('../config/database');
const { queueNotification } = require('../queues/jobs');

async function markOverdueInvoices() {
  const { rows } = await query(
    `UPDATE invoices
     SET status = 'overdue', updated_at = NOW()
     WHERE due_date IS NOT NULL
       AND due_date < CURRENT_DATE
       AND status IN ('issued', 'partially_paid')
       AND COALESCE(amount_paid, 0) < amount
     RETURNING id, client_id, amount, amount_paid, due_date, overdue_emailed_at`
  );

  if (!rows.length) return { marked: 0, clientEmails: 0 };

  const { rows: financeUsers } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('finance', 'admin') AND u.status = 'active'`
  );

  for (const inv of rows) {
    for (const fu of financeUsers) {
      await queueNotification({
        userId: fu.id,
        type: 'invoice_overdue',
        content: `Invoice overdue - consider flagging Sales for follow-up`,
        meta: { invoiceId: inv.id, promptFlag: true, href: '#/flag' },
      });
    }
  }

  // Email clients once when invoice becomes overdue (Cres Dynamics Finance)
  let clientEmails = 0;
  const { queueReceiptEmail } = require('../queues/jobs');
  for (const inv of rows) {
    if (inv.overdue_emailed_at || !inv.client_id) continue;
    const { rows: clients } = await query(
      `SELECT name, email FROM clients WHERE id = $1`,
      [inv.client_id]
    );
    const c = clients[0];
    if (!c?.email) continue;
    const balance = Number(inv.amount) - Number(inv.amount_paid || 0);
    const due = inv.due_date ? new Date(inv.due_date).toLocaleDateString() : '-';
    await queueReceiptEmail({
      to: c.email,
      subject: `Overdue invoice notice — Cres Dynamics Finance`,
      body:
        `Hello ${c.name},\n\n` +
        `This is a reminder that invoice ${inv.id.slice(0, 8)} is past its due date (${due}).\n` +
        `Outstanding balance: ${balance}.\n\n` +
        `Please arrange payment as soon as possible.\n\n` +
        `— Cres Dynamics Finance`,
      receiptType: 'invoice',
      receiptId: inv.id,
    });
    await query(
      `UPDATE invoices SET overdue_emailed_at = NOW() WHERE id = $1`,
      [inv.id]
    );
    clientEmails += 1;
  }

  return { marked: rows.length, clientEmails };
}

async function alertFollowUpsDue() {
  const { rows } = await query(
    `SELECT DISTINCT ON (l.id, l.created_by)
            l.id AS lead_id, l.name AS lead_name, l.created_by AS user_id, e.follow_up_date
     FROM leads l
     JOIN lead_engagements e ON e.lead_id = l.id
     WHERE l.status = 'follow_up'
       AND e.follow_up_date IS NOT NULL
       AND e.follow_up_date <= CURRENT_DATE
     ORDER BY l.id, l.created_by, e.follow_up_date ASC`
  );

  let sent = 0;
  for (const row of rows) {
    const inserted = await query(
      `INSERT INTO followup_alert_log (lead_id, user_id, alert_date)
       VALUES ($1, $2, CURRENT_DATE)
       ON CONFLICT (lead_id, user_id, alert_date) DO NOTHING
       RETURNING id`,
      [row.lead_id, row.user_id]
    );
    if (!inserted.rows[0]) continue;
    await queueNotification({
      userId: row.user_id,
      type: 'follow_up_due',
      content: `Follow-up due: ${row.lead_name}`,
      meta: { leadId: row.lead_id, followUpDate: row.follow_up_date },
    });
    sent += 1;
  }
  return { sent };
}

/** Queue due lead emails for automatic send */
async function sendDueLeadMessages() {
  const { queueLeadMessage } = require('../queues/jobs');
  const { rows } = await query(
    `SELECT id FROM lead_messages
     WHERE status = 'pending'
       AND scheduled_for <= NOW()
     ORDER BY scheduled_for ASC
     LIMIT 50`
  );
  for (const row of rows) {
    await queueLeadMessage({ messageId: row.id });
  }
  return { queued: rows.length };
}

/**
 * Leads with no engagement in 7+ days (or never engaged, created 7+ days ago).
 * Flag Sales owner + Directors.
 */
async function alertStaleLeads() {
  const { rows } = await query(
    `SELECT l.id AS lead_id, l.name AS lead_name, l.created_by AS owner_id,
            COALESCE(
              (SELECT MAX(e.created_at) FROM lead_engagements e WHERE e.lead_id = l.id),
              l.created_at
            ) AS last_contact_at
     FROM leads l
     WHERE l.status IN ('contacting', 'follow_up')
       AND COALESCE(
             (SELECT MAX(e.created_at) FROM lead_engagements e WHERE e.lead_id = l.id),
             l.created_at
           ) < NOW() - INTERVAL '7 days'`
  );

  const { rows: directors } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('director', 'admin') AND u.status = 'active'`
  );

  let sent = 0;
  for (const row of rows) {
    const recipients = [row.owner_id, ...directors.map((d) => d.id)];
    for (const userId of [...new Set(recipients.filter(Boolean))]) {
      const inserted = await query(
        `INSERT INTO stale_lead_alert_log (lead_id, user_id, alert_date)
         VALUES ($1, $2, CURRENT_DATE)
         ON CONFLICT (lead_id, user_id, alert_date) DO NOTHING
         RETURNING id`,
        [row.lead_id, userId]
      );
      if (!inserted.rows[0]) continue;
      await queueNotification({
        userId,
        type: 'lead_stale',
        content: `Stale lead (no contact 7+ days): ${row.lead_name}`,
        meta: { leadId: row.lead_id, lastContactAt: row.last_contact_at },
      });
      sent += 1;
    }
  }
  return { flagged: rows.length, notifications: sent };
}

async function runOpsJobs() {
  const overdue = await markOverdueInvoices().catch((e) => {
    console.error('[ops] overdue failed', e.message);
    return { marked: 0, error: e.message };
  });
  const followups = await alertFollowUpsDue().catch((e) => {
    console.error('[ops] followups failed', e.message);
    return { sent: 0, error: e.message };
  });
  let assignments = { expired: 0 };
  try {
    const { expireStaleAssignments } = require('./assignments');
    assignments = await expireStaleAssignments();
  } catch (e) {
    console.error('[ops] assignments expire failed', e.message);
  }
  const leadMails = await sendDueLeadMessages().catch((e) => {
    console.error('[ops] lead messages failed', e.message);
    return { queued: 0, error: e.message };
  });
  const stale = await alertStaleLeads().catch((e) => {
    console.error('[ops] stale leads failed', e.message);
    return { flagged: 0, error: e.message };
  });
  return { overdue, followups, assignments, leadMails, stale, at: new Date().toISOString() };
}

function startOpsScheduler(intervalMs = 5 * 60 * 1000) {
  runOpsJobs().catch(() => {});
  const timer = setInterval(() => {
    runOpsJobs().catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  runOpsJobs,
  markOverdueInvoices,
  alertFollowUpsDue,
  sendDueLeadMessages,
  alertStaleLeads,
  startOpsScheduler,
};
