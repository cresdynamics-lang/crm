const { query } = require('../config/database');
const { sendWithFailover } = require('../services/emailService');
const { queueInvoiceEmail, queueNotification, queueNotificationDigestEmail } = require('./jobs');
const { Worker, QUEUE_NAMES, connection, moveToDeadLetter, defaultJobOpts } = require('./index');
const { resolveDelivery } = require('../services/notificationPrefs');

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
    const result = await sendWithFailover({
      to: data.email,
      subject: 'Cres Dynamics password reset code',
      body: `Hi ${data.name || 'there'},\n\nYour password reset code is: ${data.code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`,
      meta: { type: 'password_reset', expiresAt: data.expiresAt },
    });
    return result;
  }

  if (name === 'user.invite') {
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
    const result = await sendWithFailover({
      to: data.to,
      subject: data.subject,
      body: data.body,
      meta: { type: 'receipt', receiptType: data.receiptType, receiptId: data.receiptId },
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

  if (name === 'lead.message') {
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

  // Default: invoice email (issued / residual balance)
  const { invoiceId, clientEmail, channel } = data;
  try {
    const { rows: invRows } = await query(
      `SELECT i.amount, i.amount_paid, i.due_date, i.status, c.name AS client_name
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.id = $1`,
      [invoiceId]
    );
    const inv = invRows[0] || {};
    const balance = Number(inv.amount || 0) - Number(inv.amount_paid || 0);
    const due = inv.due_date ? new Date(inv.due_date).toLocaleDateString() : 'see invoice';
    const result = await sendWithFailover({
      to: clientEmail,
      subject: `Invoice ${String(invoiceId).slice(0, 8)} from Cres Dynamics Finance`,
      body:
        `Hello ${inv.client_name || 'there'},\n\n` +
        `Your invoice ${String(invoiceId).slice(0, 8)} has been issued by Cres Dynamics Finance.\n` +
        `Amount due: ${balance}.\n` +
        `Due date: ${due}.\n\n` +
        `Please arrange payment by the due date and include your bank reference on the remittance.\n\n` +
        `— Cres Dynamics Finance`,
      meta: { invoiceId, channel, type: 'invoice_send' },
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

module.exports = { startWorkers, handleSideEffect, handleEmail, handleNotification };
