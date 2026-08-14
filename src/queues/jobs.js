/**
 * Job producers - call these from sync route handlers for async side-effects.
 */
const { enqueue } = require('./index');

async function queueInvoiceOnProjectApproval(projectId, invoiceId) {
  return enqueue('sideEffects', 'invoice.create-on-approval', { projectId, invoiceId });
}

async function queueInvoiceEmail(invoiceId, clientEmail, attemptChannel = 'primary') {
  return enqueue('email', 'invoice.send', {
    invoiceId,
    clientEmail,
    channel: attemptChannel,
  }, {
    jobId: `invoice-email-${invoiceId}-${attemptChannel}`,
  });
}

async function queuePaymentSync(paymentId, invoiceId) {
  return enqueue('sideEffects', 'payment.sync-dashboards', { paymentId, invoiceId });
}

async function queueNotification({ userId, type, content, meta = {} }) {
  return enqueue('notifications', 'notification.push', { userId, type, content, meta });
}

async function queueSalaryExpenseSync(salaryPaymentId) {
  return enqueue('sideEffects', 'salary.sync-expense', { salaryPaymentId });
}

async function queuePasswordResetEmail({ email, code, name, expiresAt }) {
  return enqueue('email', 'password.reset', {
    email,
    code,
    name,
    expiresAt,
  });
}

async function queueOutboundClientEmail({ emailId, to, subject, body }) {
  return enqueue('email', 'client.outbound', {
    emailId,
    to,
    subject,
    body,
  }, {
    jobId: `outbound-email-${emailId}`,
  });
}

async function queueReceiptEmail({ to, subject, body, receiptType, receiptId }) {
  return enqueue('email', 'receipt.send', {
    to,
    subject,
    body,
    receiptType,
    receiptId,
  });
}

async function queueLeadMessage({ messageId }) {
  return enqueue('email', 'lead.message', { messageId }, {
    jobId: `lead-message-${messageId}-${Date.now()}`,
  });
}

async function queueNotificationDigestEmail({ to, name, type, content }) {
  return enqueue('email', 'notification.digest', {
    to,
    name,
    type,
    content,
  });
}

module.exports = {
  queueInvoiceOnProjectApproval,
  queueInvoiceEmail,
  queuePaymentSync,
  queueNotification,
  queueSalaryExpenseSync,
  queuePasswordResetEmail,
  queueOutboundClientEmail,
  queueReceiptEmail,
  queueLeadMessage,
  queueNotificationDigestEmail,
};
