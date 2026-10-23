/**
 * Periodic ops: invoice overdue detection + sales follow-up due alerts.
 */
const { query } = require('../config/database');
const { queueNotification } = require('../queues/jobs');

/**
 * Africa/Nairobi date (UTC+3, no DST) serialized as YYYY-MM-DD.
 */
function nairobiToday(now = new Date()) {
  const nrb = new Date(now.getTime() + 3 * 3600 * 1000);
  const y = nrb.getUTCFullYear();
  const m = String(nrb.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nrb.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toIsoDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value || '').slice(0, 10);
}

/**
 * Whole weekdays (Mon-Fri) strictly AFTER fromDate, through (inclusive) today.
 */
function workingDaysSince(fromDate, todayIso) {
  const from = new Date(`${toIsoDate(fromDate)}T00:00:00Z`);
  const to = new Date(`${toIsoDate(todayIso)}T00:00:00Z`);
  let count = 0;
  const cur = new Date(from);
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= to) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

function formatKsh(num) {
  const n = Number(num || 0);
  return `KSh ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function invoiceLabel(inv) {
  return inv.invoice_number ? `${inv.invoice_number}` : `INV-${String(inv.id).slice(0, 8)}`;
}

/**
 * Queues a reminder email (kind: reminder_before | followup) for an overdue
 * invoice and marks the cycle flag so it can't re-send. Returns true if queued.
 */
async function queueOverdueEmail(inv, kind, { penaltyNumber, state }) {
  const flagKey = kind === 'followup' ? 'followupCycle' : 'reminderBeforeCycle';
  const updated = await query(
    `UPDATE invoices
     SET overdue_state = $1::jsonb, updated_at = NOW()
     WHERE id = $2 AND overdue_state->>$3 <> $4::text
     RETURNING id`,
    [JSON.stringify({ ...state, [flagKey]: penaltyNumber }), inv.id, flagKey, String(penaltyNumber)]
  );
  if (!updated.rows[0]) return false; // already handled this cycle

  if (!inv.client_email) {
    await query(
      `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
       VALUES ($1, $2, 'failed', $3)`,
      [inv.id, kind === 'followup' ? 'overdue_followup' : 'overdue_reminder', 'No client email on file']
    );
    return true;
  }

  const { enqueue } = require('../queues');
  await enqueue('email', 'invoice.overdue', {
    invoiceId: inv.id,
    clientEmail: inv.client_email,
    kind,
    penaltyNumber,
  });
  await query(
    `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
     VALUES ($1, $2, 'queued', $3)`,
    [
      inv.id,
      kind === 'followup' ? 'overdue_followup' : 'overdue_reminder',
      `Reminder (cycle ${penaltyNumber}) queued to ${inv.client_email}`,
    ]
  );
  await notifyFinance(
    'invoice_overdue',
    `Invoice ${invoiceLabel(inv)} ${kind === 'followup' ? 'follow-up reminder sent (day after penalty)' : 'reminder sent before 2% penalty'}`,
    inv.id
  );
  return true;
}

async function notifyFinance(type, content, invoiceId) {
  const { rows: financeUsers } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('finance', 'admin', 'director') AND u.status = 'active'`
  );
  for (const fu of financeUsers) {
    await queueNotification({
      userId: fu.id,
      type,
      content,
      meta: { invoiceId, href: '#/invoices' },
    });
  }
}

/**
 * Applies one 2% penalty (amount grows 2% per 5-working-day period overdue).
 * Guarded UPDATE so concurrent runs only apply once. Emails + logs after.
 */
async function applyPenalty(inv, penaltyNumber, state) {
  const penalty = Math.round(Number(inv.amount) * 2) / 100;
  const newAmount = Math.round((Number(inv.amount) + penalty) * 100) / 100;

  const updated = await query(
    `UPDATE invoices
     SET amount = $1,
         penalty_count = penalty_count + 1,
         last_penalty_at = NOW(),
         overdue_state = $2::jsonb,
         updated_at = NOW()
     WHERE id = $3
     RETURNING id`,
    [
      String(newAmount),
      JSON.stringify({ ...state, reminderBeforeCycle: penaltyNumber }),
      inv.id,
    ]
  );
  if (!updated.rows[0]) return false;

  const detail = `2% penalty ${formatKsh(penalty)} applied (cycle ${penaltyNumber}) - amount now ${formatKsh(newAmount)}`;

  await query(
    `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
     VALUES ($1, 'overdue_penalty', $2, $3)`,
    [inv.id, inv.client_email ? 'queued' : 'failed', inv.client_email ? `${detail} - emailed ${inv.client_email}` : `${detail} - no client email`]
  );

  if (inv.client_email) {
    const { enqueue } = require('../queues');
    await enqueue('email', 'invoice.overdue', {
      invoiceId: inv.id,
      clientEmail: inv.client_email,
      kind: 'penalty',
      penaltyAmount: penalty,
      newAmount,
      penaltyNumber,
    });
  }

  await notifyFinance(
    'invoice_penalty',
    `Invoice ${invoiceLabel(inv)}: 2% penalty ${formatKsh(penalty)} added (expected amount now ${formatKsh(newAmount)})`,
    inv.id
  );
  return true;
}

/**
 * Overdue automation: from 5 working days past due (unpaid / partially paid),
 * every 5 working days: reminder BEFORE the 2% penalty, the penalty itself,
 * and a follow-up reminder the following working day.
 */
async function runInvoiceOverdueCycle() {
  const { rows } = await query(
    `SELECT i.id, i.amount, i.amount_paid, i.status, i.due_date, i.invoice_number,
            i.penalty_count, i.last_penalty_at, i.overdue_state,
            c.email AS client_email, c.name AS client_name,
            p.name AS project_name
     FROM invoices i
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.status IN ('issued', 'overdue', 'partially_paid')
       AND i.due_date IS NOT NULL
       AND COALESCE(i.amount_paid, 0) < i.amount`
  );

  let reminderBefore = 0;
  let penalties = 0;
  let followups = 0;

  for (const inv of rows) {
    const today = nairobiToday();
    const elapsed = workingDaysSince(inv.due_date, today);
    if (elapsed < 5) continue;

    const applied = Number(inv.penalty_count || 0);
    const nextCycle = applied + 1;
    const nextThreshold = 5 * nextCycle;
    const state =
      inv.overdue_state && typeof inv.overdue_state === 'object' ? inv.overdue_state : {};
    const followedUp = Number(state.followupCycle || 0);

    // 1) Penalty due when the next 5-working-day threshold is crossed.
    //    Pace catch-up so penalties never stack faster than one per 5 working
    //    days (a go-live can't compound many missed penalties in a single day).
    const sinceLastPenalty = inv.last_penalty_at
      ? workingDaysSince(inv.last_penalty_at, today)
      : Infinity;
    if (elapsed >= nextThreshold && sinceLastPenalty >= 5) {
      if (await applyPenalty(inv, nextCycle, state)) {
        penalties += 1;
        continue;
      }
    }

    // 2) Reminder the working day BEFORE the cutoff (penalty about to be added)
    if (elapsed === nextThreshold - 1 && Number(state.reminderBeforeCycle || 0) < nextCycle) {
      if (await queueOverdueEmail(inv, 'reminder_before', { penaltyNumber: nextCycle, state })) {
        reminderBefore += 1;
      }
    }

    // 3) Follow-up reminder the working day AFTER a penalty was applied
    if (followedUp < applied) {
      const owed = followedUp + 1;
      if (elapsed >= 5 * owed + 1 && elapsed < 5 * (owed + 1)) {
        if (await queueOverdueEmail(inv, 'followup', { penaltyNumber: owed, state })) {
          followups += 1;
        }
      }
    }
  }

  return { candidates: rows.length, reminderBefore, penalties, followups, at: new Date().toISOString() };
}

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
  const penaltyCycle = await runInvoiceOverdueCycle().catch((e) => {
    console.error('[ops] overdue penalty cycle failed', e.message);
    return { candidates: 0, error: e.message };
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
  return { overdue, penaltyCycle, followups, assignments, leadMails, stale, at: new Date().toISOString() };
}

function startOpsScheduler(intervalMs = 5 * 60 * 1000) {
  const { backfillPayroll } = require('./payrollRows');
  const payroll = () => backfillPayroll().catch((e) => console.error('[ops] payroll backfill failed', e.message));
  const { prewarmDigest } = require('./dailyOpsDigest');
  const digest = () => prewarmDigest();
  payroll();
  digest();
  runOpsJobs().catch(() => {});
  const timer = setInterval(() => {
    payroll();
    digest();
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
  runInvoiceOverdueCycle,
  workingDaysSince,
  nairobiToday,
};
