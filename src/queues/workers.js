const { query } = require('../config/database');
const { sendWithFailover } = require('../services/emailService');
const { queueInvoiceEmail, queueNotification, queueNotificationDigestEmail } = require('./jobs');
const { Worker, QUEUE_NAMES, connection, moveToDeadLetter, defaultJobOpts } = require('./index');
const { resolveDelivery } = require('../services/notificationPrefs');
const { isEmailAutomationOn, getEmailTemplates, fillTemplate } = require('../services/orgSettings');

/**
 * Build the PDF attachment for a receipt/invoice email at send time so the
 * figures always match the current balance state.
 */
async function buildPdfAttachment(receiptType, receiptId) {
  if (!receiptId) return null;
  const { invoiceReceipt, paymentReceipt, expenseReceipt } = require('../services/receipts');
  const {
    invoicePdf,
    paymentReceiptPdf,
    expenseReceiptPdf,
  } = require('../services/pdfService');

  try {
    if (receiptType === 'payment') {
      const receipt = await paymentReceipt(receiptId);
      const pdf = await paymentReceiptPdf(receipt);
      return {
        filename: `${String(receipt.documentNumber || 'payment-receipt').replace(/[^\w.\-]+/g, '_')}.pdf`,
        content: pdf,
      };
    }
    if (receiptType === 'invoice') {
      const receipt = await invoiceReceipt(receiptId);
      const pdf = await invoicePdf(receipt);
      return {
        filename: `${String(receipt.documentNumber || 'invoice').replace(/[^\w.\-]+/g, '_')}.pdf`,
        content: pdf,
      };
    }
    if (receiptType === 'expense') {
      const receipt = await expenseReceipt(receiptId);
      const pdf = await expenseReceiptPdf(receipt);
      return {
        filename: `${String(receipt.documentNumber || 'expense-receipt').replace(/[^\w.\-]+/g, '_')}.pdf`,
        content: pdf,
      };
    }
  } catch (err) {
    // Attachment is best-effort; never block the email itself
    console.warn(`[email] PDF attachment failed (${receiptType} ${receiptId}): ${err.message}`);
  }
  return null;
}

async function handleSideEffect(job) {
  const { name, data } = job;

  switch (name) {
    case 'invoice.create-on-approval': {
      // Invoice row is created synchronously; this job handles post-create fan-out
      const { invoiceId } = data;
      const { rows } = await query(
        `SELECT i.*, c.email AS client_email
         FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE i.id = $1`,
        [invoiceId]
      );
      const invoice = rows[0];
      if (!invoice) return { skipped: true };

      if (invoice.client_email) {
        await queueInvoiceEmail(invoice.id, invoice.client_email);
      }

      // Notify all finance users (respects notification prefs via queue)
      const { rows: financeUsers } = await query(
        `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.name = 'finance' AND u.status = 'active'`
      );
      for (const fu of financeUsers) {
        await queueNotification({
          userId: fu.id,
          type: 'invoice_issued',
          content: `Invoice issued for project ${invoice.project_id}`,
          meta: { invoiceId: invoice.id, projectId: invoice.project_id },
        });
      }
      return { notified: financeUsers.length };
    }

    case 'payment.sync-dashboards': {
      const { paymentId, invoiceId } = data;
      const { rows: invRows } = await query(
        `SELECT amount, COALESCE(amount_paid, 0)::float AS amount_paid, status
         FROM invoices WHERE id = $1`,
        [invoiceId]
      );
      const inv = invRows[0];
      if (!inv) return { skipped: true };

      const paid = Number(inv.amount_paid);
      const total = Number(inv.amount);
      let nextStatus = inv.status;
      if (paid >= total) nextStatus = 'paid';
      else if (paid > 0) nextStatus = 'partially_paid';
      else if (inv.status === 'overdue') nextStatus = 'overdue';
      else nextStatus = 'issued';

      await query(
        `UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2`,
        [nextStatus, invoiceId]
      );

      const { rows: targets } = await query(
        `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.name IN ('finance', 'admin', 'director') AND u.status = 'active'`
      );
      for (const t of targets) {
        await queueNotification({
          userId: t.id,
          type: nextStatus === 'paid' ? 'invoice_paid' : 'payment_recorded',
          content:
            nextStatus === 'paid'
              ? `Invoice ${invoiceId} fully paid`
              : `Payment recorded on invoice ${invoiceId} (${nextStatus})`,
          meta: { paymentId, invoiceId, status: nextStatus },
        });
      }
      return { synced: true, status: nextStatus };
    }

    case 'salary.sync-expense': {
      const { salaryPaymentId } = data;
      const { rows } = await query(
        `SELECT sp.* FROM salary_payments sp WHERE sp.id = $1`,
        [salaryPaymentId]
      );
      const sp = rows[0];
      if (!sp || sp.status !== 'settled') return { skipped: true };

      const existing = await query(
        `SELECT id FROM expenses WHERE linked_salary_id = $1`,
        [salaryPaymentId]
      );
      if (existing.rows.length) return { alreadySynced: true };

      await query(
        `INSERT INTO expenses (category, amount, description, linked_salary_id, approval_status, approved_at)
         VALUES ('salary', $1, $2, $3, 'approved', NOW())`,
        [sp.amount_paid, `Salary settlement ${sp.month}`, salaryPaymentId]
      );
      return { expenseCreated: true };
    }

    default:
      console.warn(`[worker:sideEffects] unknown job ${name}`);
      return { unknown: true };
  }
}

async function handleEmail(job) {
  const { name, data } = job;

  if (name === 'password.reset') {
    const templates = await getEmailTemplates();
    const tpl = templates.password_reset || {};
    const vars = { name: data.name || 'there', code: data.code, email: data.email };
    const result = await sendWithFailover({
      to: data.email,
      subject: fillTemplate(tpl.subject, vars) || 'Cres Dynamics password reset code',
      body:
        fillTemplate(tpl.body, vars) ||
        `Hi ${vars.name},\n\nYour password reset code is: ${data.code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`,
      meta: { type: 'password_reset', expiresAt: data.expiresAt },
    });
    return result;
  }

  if (name === 'user.invite') {
    if (!(await isEmailAutomationOn('userInvite'))) {
      return { skipped: true, reason: 'automation_off' };
    }
    const result = await sendWithFailover({
      to: data.email,
      subject: 'You are invited to Cres Dynamics',
      body: `Hi ${data.name || 'there'},\n\nYou have been invited to Cres Dynamics CRM.\n\nSet your password here:\n${data.acceptUrl}\n\nThis invite expires at ${data.expiresAt}.\n\nIf you did not expect this, ignore this email.`,
      meta: { type: 'user_invite' },
    });
    return result;
  }

  if (name === 'notification.digest') {
    return sendWithFailover({
      to: data.to,
      subject: `Cres Dynamics: ${data.type || 'notification'}`,
      body: `Hi ${data.name || 'there'},\n\n${data.content}\n\n— Cres Dynamics (email digest is on; in-app notifications still work)`,
      meta: { type: 'notification_digest', notificationType: data.type },
    });
  }

  if (name === 'client.outbound') {
    const result = await sendWithFailover({
      to: data.to,
      subject: data.subject,
      body: data.body,
      meta: { type: 'client_outbound', emailId: data.emailId },
    });
    await query(
      `UPDATE outbound_emails
       SET status = 'sent', sent_at = NOW()
       WHERE id = $1`,
      [data.emailId]
    );
    return result;
  }

  if (name === 'receipt.send') {
    const flag =
      data.receiptType === 'payment'
        ? 'paymentReceipt'
        : data.receiptType === 'invoice'
          ? 'invoiceIssued'
          : null;
    if (flag && !(await isEmailAutomationOn(flag))) {
      return { skipped: true, reason: 'automation_off' };
    }
    const attachment = await buildPdfAttachment(data.receiptType, data.receiptId);
    const result = await sendWithFailover({
      to: data.to,
      subject: data.subject,
      body: data.body,
      html: data.html,
      attachments: attachment ? [attachment] : undefined,
      meta: { type: 'receipt', receiptType: data.receiptType, receiptId: data.receiptId, fromRole: 'finance' },
    });
    if (data.receiptType === 'invoice' && data.receiptId) {
      await query(
        `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
         VALUES ($1, 'receipt', 'sent', $2)`,
        [data.receiptId, `Receipt emailed to ${data.to}`]
      );
    }
    return result;
  }

  if (name === 'site.payer-contact') {
    const result = await sendWithFailover({
      to: data.to,
      subject: data.subject,
      body: data.message,
      html: `<p style="font-family:Arial,Helvetica,sans-serif;color:#2F3B52;line-height:1.6;">${String(
        data.message || ''
      ).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p><p style="color:#8b9aab;font-size:12px;">Sent via CRES Dynamics CRM | Event: ${String(
        data.context?.event_title || ''
      ).replace(/&/g, '&amp;').replace(/</g, '&lt;')} · Ticket ${String(
        data.context?.ticket_type || ''
      ).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
      meta: {
        type: 'site_payer_contact',
        reservationId: data.reservationId,
        sentBy: data.sentBy,
      },
    });
    await query(
      `INSERT INTO website_payer_emails (reservation_id, payer_email, payer_name, send_by, status, detail)
       VALUES ($1, $2, $3, $4, 'sent', $5)`,
      [
        data.reservationId,
        data.to,
        data.name,
        data.sentBy?.name || 'finance',
        result?.messageId || result?.id || 'sent',
      ]
    );
    return result;
  }

  if (name === 'lead.message') {
    if (!(await isEmailAutomationOn('leadMessage'))) {
      return { skipped: true, reason: 'automation_off' };
    }
    const { sendLeadEmail } = require('../services/leadEmail');
    const { queueNotification } = require('./jobs');
    const { rows } = await query(
      `SELECT m.*, l.name AS lead_name, l.email AS lead_email, l.created_by AS owner_id
       FROM lead_messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.id = $1`,
      [data.messageId]
    );
    const msg = rows[0];
    if (!msg) return { skipped: true, reason: 'missing' };
    if (msg.status === 'sent') return { skipped: true, reason: 'already_sent' };
    if (!msg.lead_email) {
      await query(
        `UPDATE lead_messages
         SET status = 'failed', error = 'Lead has no email', updated_at = NOW()
         WHERE id = $1`,
        [msg.id]
      );
      throw new Error('Lead has no email');
    }

    try {
      const result = await sendLeadEmail({
        to: msg.lead_email,
        subject: msg.subject,
        body: msg.body,
        leadId: msg.lead_id,
        messageId: msg.id,
      });
      await query(
        `UPDATE lead_messages
         SET status = 'sent', sent_at = NOW(), error = NULL,
             provider_meta = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [msg.id, JSON.stringify(result)]
      );
      // Notify sales owner that the scheduled message went out
      if (msg.owner_id) {
        await queueNotification({
          userId: msg.owner_id,
          type: 'lead_message_sent',
          content: `Email sent to lead ${msg.lead_name}: ${msg.subject}`,
          meta: { leadId: msg.lead_id, messageId: msg.id },
        });
      }
      // If lead email matches a portal user, notify them too
      const { rows: portal } = await query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND status = 'active' LIMIT 1`,
        [msg.lead_email]
      );
      if (portal[0] && portal[0].id !== msg.owner_id) {
        await queueNotification({
          userId: portal[0].id,
          type: 'lead_message_received',
          content: `You received a message from Cres Dynamics: ${msg.subject}`,
          meta: { leadId: msg.lead_id, messageId: msg.id },
        });
      }
      return result;
    } catch (err) {
      await query(
        `UPDATE lead_messages
         SET status = 'failed', error = $2, updated_at = NOW()
         WHERE id = $1`,
        [msg.id, err.message]
      );
      throw err;
    }
  }

  // Overdue invoice automation emails (reminder-before / penalty / followup)
  if (name === 'invoice.overdue') {
    const kindFlag =
      data.kind === 'reminder_before'
        ? 'overdueReminder'
        : data.kind === 'followup'
          ? 'overdueFollowup'
          : 'overduePenalty';
    if (!(await isEmailAutomationOn(kindFlag))) {
      return { skipped: true, reason: 'automation_off' };
    }
    const { invoiceId, clientEmail, kind, penaltyAmount, newAmount, penaltyNumber } = data;
    const { rows } = await query(
      `SELECT i.id, i.invoice_number, i.amount, i.amount_paid, i.due_date,
              c.name AS client_name, p.name AS project_name
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.id = $1`,
      [invoiceId]
    );
    const inv = rows[0];
    if (!inv) return { skipped: true, reason: 'missing_invoice' };

    const label = inv.invoice_number ? `invoice ${inv.invoice_number}` : `invoice ${String(invoiceId).slice(0, 8)}`;
    const balance = Number(inv.amount) - Number(inv.amount_paid || 0);
    const dueIso = inv.due_date instanceof Date
      ? `${inv.due_date.getUTCFullYear()}-${String(inv.due_date.getUTCMonth() + 1).padStart(2, '0')}-${String(inv.due_date.getUTCDate()).padStart(2, '0')}`
      : String(inv.due_date || '').slice(0, 10);
    const dueText = dueIso ? new Date(`${dueIso}T00:00:00Z`).toLocaleDateString('en-KE') : '-';
    const ksh = (n) =>
      `KSh ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let subject;
    let greeting = `Hello ${inv.client_name || 'there'},`;
    let para1;
    let para2;

    if (kind === 'reminder_before') {
      subject = `Payment reminder — CRES Dynamics (2% penalty applies imminently)`;
      para1 = `This is a reminder that ${label}, due on ${dueText}, is still outstanding (balance ${ksh(balance)}).`;
      para2 = `Please arrange payment before the next working day, after which a 2% penalty will be added to the expected amount as per your agreement with CRES Dynamics.`;
    } else if (kind === 'followup') {
      subject = `Payment follow-up — CRES Dynamics`;
      para1 = `Following up on ${label} (due ${dueText}), outstanding balance ${ksh(balance)}.`;
      para2 = `Payment is now past due. Kindly settle your balance so we can keep your account in good standing.`;
    } else {
      subject = `Penalty applied to ${label} — CRES Dynamics Finance`;
      para1 = `A 2% penalty of ${ksh(penaltyAmount)} has been applied to ${label} (due ${dueText}), so the expected amount is now ${ksh(newAmount)} (outstanding balance ${ksh(balance)}).`;
      para2 = `If this is an error or you have already made payment, please let us know immediately. Otherwise kindly settle your account to avoid further penalties.`;
    }

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#2F3B52;line-height:1.6;max-width:560px;margin:0 auto;">
        <p>${greeting}</p>
        <p>${para1}</p>
        <p>${para2}</p>
        <p>Regards,<br><strong>CRES Dynamics — Finance</strong><br>info@cresdynamics.com · +254 708 805 496</p>
      </div>`;

    const attachment = await buildPdfAttachment('invoice', invoiceId);
    const result = await sendWithFailover({
      to: clientEmail,
      subject,
      body: `${greeting}\n\n${para1}\n\n${para2}\n\nRegards,\nCRES Dynamics — Finance`,
      html,
      attachments: attachment ? [attachment] : undefined,
      meta: { type: 'invoice_overdue', kind, invoiceId, penaltyNumber, fromRole: 'finance' },
    });

    await query(
      `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
       VALUES ($1, $2, 'sent', $3)`,
      [
        invoiceId,
        kind === 'penalty' ? 'overdue_penalty' : kind === 'followup' ? 'overdue_followup' : 'overdue_reminder',
        `${kind} reached ${clientEmail}`,
      ]
    );
    return result;
  }

  // Default: invoice email (issued / residual balance) — HTML tax invoice + PDF
  const { invoiceId, clientEmail, channel } = data;
  try {
    if (!(await isEmailAutomationOn('invoiceIssued'))) {
      return { skipped: true, reason: 'automation_off' };
    }
    const { invoiceReceipt } = require('../services/receipts');
    const receipt = await invoiceReceipt(invoiceId);
    const templates = await getEmailTemplates();
    const tpl = templates.invoice_issued || {};
    const vars = {
      invoiceId: receipt.documentNumber || invoiceId,
      amount: receipt.totals?.grandTotal || receipt.totals?.total || '',
    };
    const attachment = await buildPdfAttachment('invoice', invoiceId);
    const result = await sendWithFailover({
      to: clientEmail,
      subject: fillTemplate(tpl.subject, vars) || receipt.subject,
      body: receipt.text,
      html: receipt.html,
      attachments: attachment ? [attachment] : undefined,
      meta: { invoiceId, channel, type: 'invoice_send', fromRole: 'finance' },
    });

    await query(
      `UPDATE invoices SET auto_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [invoiceId]
    );
    await query(
      `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
       VALUES ($1, $2, 'sent', $3)`,
      [invoiceId, channel || 'primary', result.messageId || 'sent']
    );

    return result;
  } catch (err) {
    await query(
      `INSERT INTO invoice_email_log (invoice_id, channel, status, detail)
       VALUES ($1, $2, 'failed', $3)`,
      [invoiceId, channel || 'primary', err.message]
    );
    throw err;
  }
}

async function handleNotification(job) {
  const { userId, type, content, meta } = job.data;
  const delivery = await resolveDelivery(query, userId, type);

  if (!delivery.allowInApp) {
    // Type preference off — skip in-app (and skip digest for that type)
    return { skipped: true, reason: 'pref_disabled', prefKey: delivery.prefKey };
  }

  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, content, meta)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, type, content, JSON.stringify(meta || {})]
  );

  try {
    const { emitNotification } = require('../realtime/socket');
    emitNotification(userId, rows[0]);
  } catch {
    // socket not initialized (standalone worker) - REST poll still works
  }

  if (delivery.emailDigest) {
    const { rows: users } = await query(
      `SELECT name, email FROM users WHERE id = $1 AND status = 'active'`,
      [userId]
    );
    if (users[0]?.email) {
      await queueNotificationDigestEmail({
        to: users[0].email,
        name: users[0].name,
        type,
        content,
      });
    }
  }

  return rows[0];
}

function startWorkers() {
  const conn = connection();
  const workers = [];

  const sideEffects = new Worker(
    QUEUE_NAMES.sideEffects,
    async (job) => handleSideEffect(job),
    { connection: conn, ...defaultJobOpts }
  );
  sideEffects.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts || defaultJobOpts.attempts)) {
      await moveToDeadLetter(QUEUE_NAMES.sideEffects, job, err);
    }
  });
  workers.push(sideEffects);

  const email = new Worker(
    QUEUE_NAMES.email,
    async (job) => handleEmail(job),
    { connection: conn, ...defaultJobOpts }
  );
  email.on('failed', async (job, err) => {
    if (job?.name === 'client.outbound' && job.data?.emailId) {
      await query(
        `UPDATE outbound_emails SET status = 'failed' WHERE id = $1 AND status = 'queued'`,
        [job.data.emailId]
      ).catch(() => {});
    }
    if (job && job.attemptsMade >= (job.opts.attempts || defaultJobOpts.attempts)) {
      await moveToDeadLetter(QUEUE_NAMES.email, job, err);
    }
  });
  workers.push(email);

  const notifications = new Worker(
    QUEUE_NAMES.notifications,
    async (job) => handleNotification(job),
    { connection: conn, ...defaultJobOpts }
  );
  notifications.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts || defaultJobOpts.attempts)) {
      await moveToDeadLetter(QUEUE_NAMES.notifications, job, err);
    }
  });
  workers.push(notifications);

  console.log('[workers] side-effects, email, notifications started');
  return workers;
}

if (require.main === module) {
  require('dotenv').config();
  startWorkers();
  console.log('[workers] running standalone');
}

module.exports = {
  startWorkers,
  handleSideEffect,
  handleEmail,
  handleNotification,
  buildPdfAttachment,
};
