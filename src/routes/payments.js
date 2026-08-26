const express = require('express');
const multer = require('multer');
const { withTransaction } = require('../config/database');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const {
  queuePaymentSync,
  queueInvoiceEmail,
  queueReceiptEmail,
  queueNotification,
} = require('../queues/jobs');
const { paymentReceipt } = require('../services/receipts');
const { capturePaymentVoice } = require('../services/voicePayments');

const router = express.Router();
router.use(authenticate);

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const EPS = 0.001;

async function ensureClientOnInvoice(tx, invoice, { client_id, client }, actorId) {
  let clientId = invoice.client_id || client_id || null;
  let clientRow = null;

  if (clientId) {
    const { rows } = await tx.query(`SELECT * FROM clients WHERE id = $1`, [clientId]);
    clientRow = rows[0] || null;
    if (!clientRow) throw new AppError('Client not found', 404, 'NOT_FOUND');
  }

  if (!clientRow && client && typeof client === 'object') {
    const name = String(client.name || '').trim();
    const email = String(client.email || '').trim() || null;
    if (!name) throw new AppError('Client name is required', 400, 'VALIDATION');
    if (!email) throw new AppError('Client email is required to record and notify payment', 400, 'VALIDATION');

    // Reuse existing client by email when possible
    const existing = await tx.query(
      `SELECT * FROM clients WHERE email IS NOT NULL AND LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (existing.rows[0]) {
      clientRow = existing.rows[0];
      clientId = clientRow.id;
    } else {
      const inserted = await tx.query(
        `INSERT INTO clients (name, business_name, email, phone)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          name,
          client.business_name ? String(client.business_name).trim() : null,
          email,
          client.phone ? String(client.phone).trim() : null,
        ]
      );
      clientRow = inserted.rows[0];
      clientId = clientRow.id;
    }
  }

  if (clientId && clientId !== invoice.client_id) {
    await tx.query(
      `UPDATE invoices SET client_id = $1, updated_at = NOW() WHERE id = $2`,
      [clientId, invoice.id]
    );
    invoice.client_id = clientId;
  }

  if (!invoice.client_id) {
    throw new AppError(
      'Invoice has no client. Add client details before recording the payment.',
      400,
      'CLIENT_REQUIRED'
    );
  }

  if (!clientRow) {
    const { rows } = await tx.query(`SELECT * FROM clients WHERE id = $1`, [invoice.client_id]);
    clientRow = rows[0];
  }

  if (!clientRow?.email) {
    throw new AppError(
      'Client has no email. Update client details so the receipt and balance invoice can be sent.',
      400,
      'CLIENT_EMAIL_REQUIRED'
    );
  }

  return clientRow;
}

router.get(
  '/',
  requirePermission('payments', 'view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const clauses = [];
    if (req.query.invoice_id) {
      params.push(req.query.invoice_id);
      clauses.push(`pay.invoice_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT pay.*,
              c.name AS client_name, c.email AS client_email,
              p.name AS project_name, i.status AS invoice_status, i.amount AS invoice_amount,
              (COALESCE(i.amount,0) - COALESCE(i.amount_paid,0))::float AS invoice_balance
       FROM payments pay
       JOIN invoices i ON i.id = pay.invoice_id
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN projects p ON p.id = i.project_id
       ${where}
       ORDER BY pay.paid_at DESC
       LIMIT 200`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/:id/receipt',
  requirePermission('payments', 'view'),
  asyncHandler(async (req, res) => {
    const receipt = await paymentReceipt(req.params.id);
    res.json({ ok: true, data: receipt });
  })
);

/** Force-download payment receipt as PDF */
router.get(
  '/:id/receipt/file',
  requirePermission('payments', 'view'),
  asyncHandler(async (req, res) => {
    const receipt = await paymentReceipt(req.params.id);
    const { paymentReceiptPdf } = require('../services/pdfService');
    const pdf = await paymentReceiptPdf(receipt);
    const filename = `${String(receipt.documentNumber || 'payment-receipt').replace(/[^\w.\-]+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  })
);

router.post(
  '/:id/receipt/send',
  requirePermission('payments', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const receipt = await paymentReceipt(req.params.id);
    const to = (req.body?.to || receipt.to || '').trim();
    if (!to) throw new AppError('No recipient email - set client email or pass to', 400, 'VALIDATION');
    await queueReceiptEmail({
      to,
      subject: receipt.subject,
      body: receipt.text,
      html: receipt.emailHtml || receipt.html,
      receiptType: 'payment',
      receiptId: receipt.id,
    });
    res.json({ ok: true, data: { queued: true, to } });
  })
);

router.post(
  '/',
  requirePermission('payments', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { invoice_id, amount, paid_at, bank_reference, client_id, client } = req.body || {};
    if (!invoice_id || amount == null) {
      throw new AppError('invoice_id and amount required', 400, 'VALIDATION');
    }
    const amt = Number(amount);
    if (!(amt > 0)) throw new AppError('amount must be positive', 400, 'VALIDATION');

    const bankRef = String(bank_reference || '').trim();
    if (!bankRef) {
      throw new AppError('bank_reference is required for the payment', 400, 'VALIDATION');
    }

    const result = await withTransaction(async (tx) => {
      const inv = await tx.query(
        `SELECT i.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
                c.business_name AS client_business
         FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE i.id = $1
         FOR UPDATE OF i`,
        [invoice_id]
      );
      const invoice = inv.rows[0];
      if (!invoice) throw new AppError('Invoice not found', 404, 'NOT_FOUND');

      const clientRow = await ensureClientOnInvoice(tx, invoice, { client_id, client }, req.user.id);
      if (!String(clientRow.email || '').trim()) {
        throw new AppError(
          'Client email is required before recording a payment — receipt must be emailed',
          400,
          'CLIENT_EMAIL_REQUIRED'
        );
      }

      const alreadyPaid = Number(invoice.amount_paid || 0);
      const total = Number(invoice.amount);
      const remaining = total - alreadyPaid;
      if (remaining <= 0) throw new AppError('Invoice already fully paid', 409, 'INVALID_STATE');
      if (amt > remaining + EPS) {
        throw new AppError(`Amount exceeds remaining balance (${remaining})`, 400, 'VALIDATION');
      }

      const { rows } = await tx.query(
        `INSERT INTO payments (invoice_id, amount, paid_at, recorded_by, bank_reference)
         VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4, $5)
         RETURNING *`,
        [invoice_id, amt, paid_at || null, req.user.id, bankRef]
      );
      const payment = rows[0];

      const newPaid = alreadyPaid + amt;
      const isFull = newPaid >= total - EPS;
      let residual = null;
      let paidInvoiceStatus = 'paid';
      let paidInvoiceAmount = total;
      let paidInvoicePaid = newPaid;

      if (isFull) {
        await tx.query(
          `UPDATE invoices
           SET amount_paid = $1, status = 'paid', updated_at = NOW()
           WHERE id = $2`,
          [total, invoice_id]
        );
        paidInvoicePaid = total;
      } else {
        // Close paid portion on original; issue a new invoice for remaining debt
        const remainder = Math.round((remaining - amt) * 100) / 100;
        paidInvoiceAmount = Math.round(newPaid * 100) / 100;
        paidInvoicePaid = paidInvoiceAmount;
        paidInvoiceStatus = 'paid';

        await tx.query(
          `UPDATE invoices
           SET amount = $1, amount_paid = $1, status = 'paid', updated_at = NOW()
           WHERE id = $2`,
          [paidInvoiceAmount, invoice_id]
        );

        const dueDate =
          invoice.due_date ||
          new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const residualIns = await tx.query(
          `INSERT INTO invoices
             (project_id, client_id, amount, status, due_date, amount_paid, parent_invoice_id)
           VALUES ($1, $2, $3, 'issued', $4::date, 0, $5)
           RETURNING *`,
          [invoice.project_id, invoice.client_id, remainder, dueDate, invoice_id]
        );
        residual = residualIns.rows[0];
      }

      await tx.query(
        `UPDATE account_balances
         SET balance = balance + $1, updated_at = NOW()
         WHERE id = (SELECT id FROM account_balances ORDER BY label LIMIT 1)`,
        [amt]
      );

      const debtRemaining = residual ? Number(residual.amount) : 0;

      return {
        payment,
        client: {
          id: clientRow.id,
          name: clientRow.name,
          email: clientRow.email,
          business_name: clientRow.business_name,
          phone: clientRow.phone,
        },
        invoice: {
          id: invoice_id,
          amount: paidInvoiceAmount,
          amount_paid: paidInvoicePaid,
          status: paidInvoiceStatus,
          balance_due: 0,
        },
        residualInvoice: residual
          ? {
              id: residual.id,
              amount: Number(residual.amount),
              due_date: residual.due_date,
              status: residual.status,
              parent_invoice_id: residual.parent_invoice_id,
            }
          : null,
        debt: {
          paid_now: amt,
          remaining: debtRemaining,
          bank_reference: bankRef,
        },
      };
    });

    await queuePaymentSync(result.payment.id, result.payment.invoice_id);

    const clientEmail = String(result.client?.email || '').trim();

    // Always email the payment receipt to the client (queue, with direct fallback)
    let receiptEmailed = false;
    let receiptEmailError = null;
    try {
      const receipt = await paymentReceipt(result.payment.id, { embedImages: true });
      const html = receipt.emailHtml || receipt.html;
      try {
        await queueReceiptEmail({
          to: clientEmail,
          subject: receipt.subject,
          body: receipt.text,
          html,
          receiptType: 'payment',
          receiptId: receipt.id,
        });
        receiptEmailed = true;
      } catch (queueErr) {
        console.warn('[payments] queue failed, sending receipt directly', queueErr.message);
        const { sendWithFailover } = require('../services/emailService');
        const { paymentReceiptPdf } = require('../services/pdfService');
        const pdf = await paymentReceiptPdf(receipt);
        await sendWithFailover({
          to: clientEmail,
          subject: receipt.subject,
          body: receipt.text,
          html,
          attachments: [
            {
              filename: `${String(receipt.documentNumber || 'payment-receipt').replace(/[^\w.\-]+/g, '_')}.pdf`,
              content: pdf,
            },
          ],
          meta: {
            type: 'receipt',
            receiptType: 'payment',
            receiptId: receipt.id,
            fromRole: 'finance',
          },
        });
        receiptEmailed = true;
      }
      console.log('[payments] receipt emailed', {
        paymentId: result.payment.id,
        to: clientEmail,
        outstanding: receipt.balance?.outstandingFormatted,
      });
    } catch (err) {
      receiptEmailError = err.message;
      console.error('[payments] receipt email FAILED', err.message);
    }

    // Email residual balance invoice when funds / debt change
    if (result.residualInvoice && clientEmail) {
      try {
        const { invoiceReceipt } = require('../services/receipts');
        const balReceipt = await invoiceReceipt(result.residualInvoice.id);
        await queueReceiptEmail({
          to: clientEmail,
          subject: balReceipt.subject,
          body: balReceipt.text,
          html: balReceipt.html,
          receiptType: 'invoice',
          receiptId: result.residualInvoice.id,
        });
        await query(`UPDATE invoices SET auto_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [
          result.residualInvoice.id,
        ]);
      } catch (err) {
        console.warn('[payments] balance invoice email failed', err.message);
        try {
          await queueInvoiceEmail(result.residualInvoice.id, clientEmail, 'primary');
        } catch (_) {
          /* already logged */
        }
      }
    }

    // Notify finance peers of debt update
    const { rows: financeUsers } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('finance', 'admin') AND u.status = 'active' AND u.id <> $1`,
      [req.user.id]
    );
    for (const fu of financeUsers) {
      await queueNotification({
        userId: fu.id,
        type: 'payment_recorded',
        content: result.residualInvoice
          ? `Partial payment ${result.debt.paid_now} recorded (ref ${result.debt.bank_reference}). New balance invoice ${result.residualInvoice.amount} issued.`
          : `Payment ${result.debt.paid_now} recorded (ref ${result.debt.bank_reference}). Invoice paid in full.`,
        meta: {
          paymentId: result.payment.id,
          invoiceId: result.invoice.id,
          residualInvoiceId: result.residualInvoice?.id,
          href: '#/payments',
        },
      });
    }

    const { recordAction } = require('../services/actionAudit');
    await recordAction({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'payment.create',
      resourceType: 'payment',
      resourceId: result.payment.id,
      summary: `Recorded payment ${result.payment.amount} (ref ${bankRef}) on invoice ${result.payment.invoice_id}`,
      after: result.payment,
      meta: {
        invoiceId: result.payment.invoice_id,
        residualInvoiceId: result.residualInvoice?.id || null,
        bankReference: bankRef,
      },
    });

    res.status(201).json({
      ok: true,
      data: {
        ...result,
        receipt_emailed: receiptEmailed,
        receipt_to: clientEmail,
        receipt_email_error: receiptEmailError,
      },
    });
  })
);

/**
 * Voice payment capture: transcribe audio and parse into payment fields.
 * POST /api/payments/voice-capture
 */
router.post(
  '/voice-capture',
  requirePermission('payments', 'create'),
  memUpload.single('audio'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('No audio file', 400, 'VALIDATION');
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Finance can use voice payments', 403, 'FORBIDDEN');
    }

    // Fetch clients and projects for matching
    const [clientsRes, projectsRes] = await Promise.all([
      query(`SELECT id, name, business_name FROM clients ORDER BY name LIMIT 200`),
      query(`SELECT id, name FROM projects WHERE status NOT IN ('pending_approval','rejected','deleted') ORDER BY name LIMIT 200`),
    ]);

    const result = await capturePaymentVoice({
      buffer: req.file.buffer,
      filename: req.file.originalname || 'payment-voice.webm',
      mimetype: req.file.mimetype || 'audio/webm',
      clients: clientsRes.rows,
      projects: projectsRes.rows,
    });

    // Try to find matching invoice if client + project are resolved
    let invoice = null;
    if (result.invoice_id) {
      const { rows } = await query(
        `SELECT i.*, c.name AS client_name FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE i.id = $1`, [result.invoice_id]
      );
      invoice = rows[0] || null;
    } else if (result.project_id || result.client_id) {
      const params = [`issued`, `partially_paid`];
      let where = `i.status IN ($1, $2)`;
      if (result.project_id) {
        params.push(result.project_id);
        where += ` AND i.project_id = $${params.length}`;
      }
      if (result.client_id) {
        params.push(result.client_id);
        where += ` AND i.client_id = $${params.length}`;
      }
      const { rows } = await query(
        `SELECT i.*, c.name AS client_name FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE ${where}
         ORDER BY i.created_at DESC LIMIT 1`,
        params
      );
      invoice = rows[0] || null;
    }

    res.json({
      ok: true,
      data: {
        transcript: result.transcript,
        amount: result.amount,
        client_name: result.client_name,
        client_id: result.client_id,
        project_name: result.project_name,
        project_id: result.project_id,
        bank_reference: result.bank_reference,
        description: result.description,
        paid_at: result.paid_at,
        invoice_id: invoice?.id || null,
        invoice_amount: invoice?.amount != null ? Number(invoice.amount) : null,
        invoice_balance: invoice ? Number(invoice.amount || 0) - Number(invoice.amount_paid || 0) : null,
        client_name_resolved: invoice?.client_name || result.client_name || null,
      },
    });
  })
);

module.exports = router;
