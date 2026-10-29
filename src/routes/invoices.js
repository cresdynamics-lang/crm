const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueInvoiceEmail } = require('../queues/jobs');
const { logInvoiceEmail } = require('../lib/invoiceEmailLog');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/invoices
 * Money visibility rules enforced here.
 */
router.get(
  '/',
  requirePermission('invoices', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'sales') {
      throw new AppError(
        'Forbidden: sales may only view flagged follow-ups via /api/invoices/followups',
        403,
        'FORBIDDEN'
      );
    }

    if (req.user.role === 'client') {
      const { rows } = await query(
        `SELECT i.*, c.name AS client_name, p.name AS project_name
         FROM invoices i
         JOIN clients c ON c.id = i.client_id
         LEFT JOIN projects p ON p.id = i.project_id
         WHERE c.user_id = $1 OR c.email = $2
         ORDER BY i.created_at DESC`,
        [req.user.id, req.user.email]
      );
      return res.json({ ok: true, data: rows });
    }

    const params = [];
    const clauses = [];
    if (req.query.status) {
      params.push(req.query.status);
      clauses.push(`i.status = $${params.length}`);
    }
    if (req.query.client_id) {
      params.push(req.query.client_id);
      clauses.push(`i.client_id = $${params.length}`);
    }
    if (req.query.date_from) {
      params.push(req.query.date_from);
      clauses.push(`i.created_at >= $${params.length}::date`);
    }
    if (req.query.date_to) {
      params.push(req.query.date_to);
      clauses.push(`i.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      clauses.push(
        `(c.name ILIKE $${params.length} OR p.name ILIKE $${params.length} OR COALESCE(c.business_name,'') ILIKE $${params.length})`
      );
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT DISTINCT ON (i.id) i.*,
              c.name AS client_name, c.business_name AS client_business, c.email AS client_email,
              c.phone AS client_phone,
              p.name AS project_name
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN projects p ON p.id = i.project_id
       ${where}
       ORDER BY i.id, i.created_at DESC`,
      params
    );
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/followups',
  requirePermission('invoice_followups', 'view'),
  asyncHandler(async (req, res) => {
    const params = [];
    let where = '';

    if (req.user.role === 'sales') {
      params.push(req.user.id);
      where = `WHERE f.assigned_sales_user_id = $${params.length}`;
    }

    if (req.query.status) {
      params.push(req.query.status);
      where += where ? ` AND f.status = $${params.length}` : `WHERE f.status = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT f.id, f.invoice_id, f.assigned_sales_user_id, f.flagged_by, f.status,
              f.note, f.created_at,
              i.amount, i.status AS invoice_status, i.client_id, i.project_id,
              c.name AS client_name, c.business_name AS client_business,
              s.name AS sales_name
       FROM invoice_followups f
       JOIN invoices i ON i.id = f.invoice_id
       LEFT JOIN clients c ON c.id = i.client_id
       JOIN users s ON s.id = f.assigned_sales_user_id
       ${where}
       ORDER BY f.created_at DESC`,
      params
    );
    const data =
      req.user.role === 'sales'
        ? rows.map(({ amount, ...rest }) => rest)
        : rows;
    res.json({ ok: true, data });
  })
);

router.post(
  '/followups/:id/followed-up',
  requirePermission('invoice_followups', 'edit'),
  asyncHandler(async (req, res) => {
    const params = [req.params.id];
    let scope = '';
    if (req.user.role === 'sales') {
      params.push(req.user.id);
      scope = ` AND assigned_sales_user_id = $2`;
    }

    const { rows } = await query(
      `UPDATE invoice_followups
       SET status = 'followed_up'
       WHERE id = $1 AND status = 'pending'${scope}
       RETURNING *`,
      params
    );
    if (!rows[0]) throw new AppError('Follow-up not found or already completed', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/meta/balances',
  requirePermission('account_balance', 'view'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(`SELECT * FROM account_balances ORDER BY label`);
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/meta/cash-flow',
  requirePermission('cash_flow', 'view'),
  asyncHandler(async (_req, res) => {
    const { rows: paid } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM payments`
    );
    const { rows: exp } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses`
    );
    const { rows: outstanding } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM invoices WHERE status IN ('issued','overdue')`
    );
    res.json({
      ok: true,
      data: {
        paymentsIn: paid[0].total,
        expensesOut: exp[0].total,
        outstandingInvoices: outstanding[0].total,
        net: paid[0].total - exp[0].total,
      },
    });
  })
);

/**
 * Finance creates invoice: client + project + line items (no VAT).
 * Numbering matches CresOS style: {projectSeq}/{invoiceOrdinal}/{yy} e.g. 009/02/26
 * Due date = issue_date + 5 days.
 */
router.post(
  '/',
  requirePermission('invoices', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Finance can create invoices', 403, 'FORBIDDEN');
    }
    const { client_id, project_id, items, issue_date } = req.body || {};
    if (!client_id || !project_id) {
      throw new AppError('client_id and project_id are required', 400, 'VALIDATION');
    }
    const lineItems = Array.isArray(items) ? items : [];
    if (!lineItems.length) {
      throw new AppError('Add at least one line item', 400, 'VALIDATION');
    }

    const clientCheck = await query(`SELECT id, email, name FROM clients WHERE id = $1`, [
      client_id,
    ]);
    if (!clientCheck.rows[0]) throw new AppError('Client not found', 404, 'NOT_FOUND');
    if (!String(clientCheck.rows[0].email || '').trim()) {
      throw new AppError(
        'Client has no email — add contact email before creating an invoice',
        400,
        'VALIDATION'
      );
    }

    const normalized = lineItems.map((it) => {
      const qty = Number(it.qty ?? it.quantity ?? 1);
      const unit_price = Number(it.unit_price ?? it.unitPrice ?? 0);
      if (!(qty > 0) || !(unit_price >= 0)) {
        throw new AppError('Each item needs positive qty and unit_price', 400, 'VALIDATION');
      }
      const amount = Math.round(qty * unit_price * 100) / 100;
      return {
        description: String(it.description || it.name || 'Item').trim(),
        detail: it.detail ? String(it.detail).trim() : '',
        qty,
        unit_price,
        amount,
      };
    });
    const total = Math.round(normalized.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    if (!(total > 0)) throw new AppError('Invoice total must be positive', 400, 'VALIDATION');

    const issue =
      issue_date && /^\d{4}-\d{2}-\d{2}$/.test(issue_date)
        ? issue_date
        : new Date().toISOString().slice(0, 10);
    const due = new Date(`${issue}T12:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 5);
    const dueDate = due.toISOString().slice(0, 10);
    const yy = issue.slice(2, 4);

    const { withTransaction } = require('../config/database');
    const result = await withTransaction(async (tx) => {
      const client = await tx.query(`SELECT id, email, name FROM clients WHERE id = $1`, [
        client_id,
      ]);
      if (!client.rows[0]) throw new AppError('Client not found', 404, 'NOT_FOUND');
      const project = await tx.query(
        `SELECT id, name, finance_seq, client_id FROM projects WHERE id = $1`,
        [project_id]
      );
      if (!project.rows[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');

      let financeSeq = project.rows[0].finance_seq;
      if (!financeSeq) {
        const max = await tx.query(
          `SELECT COALESCE(MAX(finance_seq), 0)::int AS m FROM projects WHERE finance_seq IS NOT NULL`
        );
        financeSeq = (max.rows[0].m || 0) + 1;
        await tx.query(`UPDATE projects SET finance_seq = $1 WHERE id = $2`, [
          financeSeq,
          project_id,
        ]);
      }

      const ord = await tx.query(
        `SELECT COUNT(*)::int AS n FROM invoices WHERE project_id = $1`,
        [project_id]
      );
      const ordinal = (ord.rows[0].n || 0) + 1;
      const invoiceNumber = `${String(financeSeq).padStart(3, '0')}/${String(ordinal).padStart(
        2,
        '0'
      )}/${yy}`;

      const { rows } = await tx.query(
        `INSERT INTO invoices
           (project_id, client_id, amount, status, due_date, amount_paid,
            invoice_number, line_items, issue_date)
         VALUES ($1,$2,$3,'issued',$4,0,$5,$6::jsonb,$7::date)
         RETURNING *`,
        [
          project_id,
          client_id,
          total,
          dueDate,
          invoiceNumber,
          JSON.stringify(normalized),
          issue,
        ]
      );
      return { invoice: rows[0], client: client.rows[0], project: project.rows[0] };
    });

    // Always email client the tax invoice (HTML)
    let emailed = false;
    try {
      const { invoiceReceipt } = require('../services/receipts');
      const { queueReceiptEmail, queueInvoiceEmail } = require('../queues/jobs');
      const receipt = await invoiceReceipt(result.invoice.id);
      await queueReceiptEmail({
        to: result.client.email,
        subject: receipt.subject,
        body: receipt.text,
        html: receipt.html,
        receiptType: 'invoice',
        receiptId: result.invoice.id,
      });
      await query(`UPDATE invoices SET auto_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [
        result.invoice.id,
      ]);
      emailed = true;
    } catch (err) {
      console.warn('[invoices] create email queue failed', err.message);
      try {
        const { queueInvoiceEmail } = require('../queues/jobs');
        await queueInvoiceEmail(result.invoice.id, result.client.email);
        await query(`UPDATE invoices SET auto_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [
          result.invoice.id,
        ]);
        emailed = true;
      } catch (e2) {
        console.warn('[invoices] fallback email failed', e2.message);
      }
    }

    res.status(201).json({
      ok: true,
      data: {
        invoice: result.invoice,
        invoice_number: result.invoice.invoice_number,
        emailed,
        to: result.client.email || null,
      },
    });
  })
);

router.patch(
  '/:id/client',
  requirePermission('invoices', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { client_id, client } = req.body || {};
    let clientId = client_id || null;

    if (!clientId && client) {
      const name = String(client.name || '').trim();
      const email = String(client.email || '').trim();
      if (!name || !email) {
        throw new AppError('client.name and client.email required', 400, 'VALIDATION');
      }
      const existing = await query(
        `SELECT id FROM clients WHERE email IS NOT NULL AND LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      );
      if (existing.rows[0]) {
        clientId = existing.rows[0].id;
        await query(
          `UPDATE clients
           SET name = COALESCE($2, name),
               business_name = COALESCE($3, business_name),
               phone = COALESCE($4, phone)
           WHERE id = $1`,
          [
            clientId,
            name,
            client.business_name ? String(client.business_name).trim() : null,
            client.phone ? String(client.phone).trim() : null,
          ]
        );
      } else {
        const ins = await query(
          `INSERT INTO clients (name, business_name, email, phone)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [
            name,
            client.business_name ? String(client.business_name).trim() : null,
            email,
            client.phone ? String(client.phone).trim() : null,
          ]
        );
        clientId = ins.rows[0].id;
      }
    }

    if (!clientId) throw new AppError('client_id or client required', 400, 'VALIDATION');

    const { rows } = await query(
      `UPDATE invoices SET client_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [clientId, req.params.id]
    );
    if (!rows[0]) throw new AppError('Invoice not found', 404, 'NOT_FOUND');

    const { rows: crows } = await query(`SELECT * FROM clients WHERE id = $1`, [clientId]);
    res.json({ ok: true, data: { invoice: rows[0], client: crows[0] } });
  })
);

router.get(
  '/:id',
  requirePermission('invoices', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'sales') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT i.*,
              c.name AS client_name, c.business_name AS client_business,
              c.email AS client_email, c.phone AS client_phone,
              p.name AS project_name, p.summary AS project_summary,
              p.status AS project_status, p.suspend_reason AS project_suspend_reason
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Invoice not found', 404, 'NOT_FOUND');

    if (req.user.role === 'client') {
      const inv = rows[0];
      const { rows: owned } = await query(
        `SELECT 1 FROM clients c
         WHERE c.id = $1 AND (c.user_id = $2 OR c.email = $3)`,
        [inv.client_id, req.user.id, req.user.email]
      );
      if (!owned[0]) throw new AppError('Forbidden', 403, 'FORBIDDEN');
      // Client portal: view-only invoice summary - no payments/DLQ/followups internals
      return res.json({
        ok: true,
        data: {
          invoice: {
            id: inv.id,
            amount: inv.amount,
            status: inv.status,
            created_at: inv.created_at,
            updated_at: inv.updated_at,
            auto_sent_at: inv.auto_sent_at,
            client_name: inv.client_name,
            project_name: inv.project_name,
            project_id: inv.project_id,
          },
        },
      });
    }

    const { rows: payments } = await query(
      `SELECT DISTINCT ON (pay.id) pay.*, u.name AS recorded_by_name
       FROM payments pay
       JOIN users u ON u.id = pay.recorded_by
       WHERE pay.invoice_id = $1
       ORDER BY pay.id, pay.paid_at DESC`,
      [req.params.id]
    );
    payments.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));

    const { rows: emailLog } = await query(
      `SELECT DISTINCT ON (channel, status, COALESCE(day, created_at::date)) *
       FROM invoice_email_log
       WHERE invoice_id = $1
       ORDER BY channel, status, COALESCE(day, created_at::date) DESC, created_at DESC`,
      [req.params.id]
    );
    emailLog.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const { rows: deadLetters } = await query(
      `SELECT * FROM failed_jobs
       WHERE queue LIKE '%email%'
         AND (payload->>'invoiceId') = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.params.id]
    );

    const { rows: followups } = await query(
      `SELECT f.*, u.name AS sales_name
       FROM invoice_followups f
       JOIN users u ON u.id = f.assigned_sales_user_id
       WHERE f.invoice_id = $1
       ORDER BY f.created_at DESC`,
      [req.params.id]
    );

    res.json({
      ok: true,
      data: {
        invoice: rows[0],
        payments,
        emailLog,
        deadLetters,
        followups,
      },
    });
  })
);

/** Manual resend - re-queues invoice email (failover/retry path) */
router.post(
  '/:id/resend',
  requirePermission('invoices', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT i.*, c.email AS client_email
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    const invoice = rows[0];
    if (!invoice) throw new AppError('Invoice not found', 404, 'NOT_FOUND');
    if (!invoice.client_email) {
      throw new AppError('Client has no email on file', 400, 'VALIDATION');
    }

    await logInvoiceEmail(invoice.id, 'manual_resend', 'queued', 'Manual resend by finance');

    // Unique job id so retries don't collide with original send
    const { enqueue } = require('../queues');
    await enqueue('email', 'invoice.send', {
      invoiceId: invoice.id,
      clientEmail: invoice.client_email,
      channel: 'manual_resend',
    });

    // Clear matching dead-letter rows for this invoice
    await query(
      `DELETE FROM failed_jobs
       WHERE queue LIKE '%email%'
         AND (payload->>'invoiceId') = $1`,
      [invoice.id]
    );

    res.json({ ok: true, data: { queued: true, to: invoice.client_email } });
  })
);

/** Printable invoice receipt payload */
router.get(
  '/:id/receipt',
  requirePermission('invoices', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'sales') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { invoiceReceipt } = require('../services/receipts');
    const receipt = await invoiceReceipt(req.params.id);
    res.json({ ok: true, data: receipt });
  })
);

/** Force-download invoice as PDF (no print dialog / no inline open) */
router.get(
  '/:id/receipt/file',
  requirePermission('invoices', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'sales') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { invoiceReceipt } = require('../services/receipts');
    const { invoicePdf } = require('../services/pdfService');
    const receipt = await invoiceReceipt(req.params.id);
    const pdf = await invoicePdf(receipt);
    const filename = `${String(receipt.documentNumber || 'invoice').replace(/[^\w.\-]+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  })
);

/** Email invoice receipt to client (or override to) */
router.post(
  '/:id/receipt/send',
  requirePermission('invoices', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { invoiceReceipt } = require('../services/receipts');
    const { queueReceiptEmail } = require('../queues/jobs');
    const receipt = await invoiceReceipt(req.params.id);
    const to = (req.body?.to || receipt.to || '').trim();
    if (!to) throw new AppError('No recipient email - set client email or pass to', 400, 'VALIDATION');

    await logInvoiceEmail(receipt.id, 'receipt', 'queued', `Receipt queued to ${to}`);
    await queueReceiptEmail({
      to,
      subject: receipt.subject,
      body: receipt.text,
      html: receipt.html,
      receiptType: 'invoice',
      receiptId: receipt.id,
    });
    res.json({ ok: true, data: { queued: true, to } });
  })
);

module.exports = router;
