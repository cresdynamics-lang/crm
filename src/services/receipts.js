/**
 * Build printable / emailable receipt payloads for invoices, payments, expenses.
 * Invoice layout mirrors Cres Dynamics Ltd tax invoice (one page).
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');
const { loadCompanyProfile } = require('../config/company');
const { buildInvoicePrintHtml } = require('./invoicePrintHtml');

function publicBaseUrl() {
  return (
    process.env.PUBLIC_WEB_URL ||
    process.env.APP_URL ||
    'https://cresos.cresdynamics.com'
  ).replace(/\/$/, '');
}

function money(n, currency = 'KES') {
  const num = Number(n);
  if (Number.isNaN(num)) return '-';
  return num.toLocaleString('en-KE', { style: 'currency', currency });
}

function fmtDate(v) {
  if (!v) return '-';
  return new Date(v).toLocaleString('en-KE');
}

function fmtDay(v) {
  if (!v) return '-';
  return new Date(v).toLocaleDateString('en-GB');
}

function linesToText(lines) {
  return lines.map(([k, v]) => `${k}: ${v}`).join('\n');
}

function companyBlock(company) {
  return {
    legalName: company.legalName,
    tradingName: company.tradingName,
    tagline: company.tagline,
    addressLines: company.addressLines || [],
    phone: company.phone,
    email: company.email,
    website: company.website,
    taxLabel: company.taxLabel,
    taxId: company.taxId,
    bankName: company.bankName,
    bankAccountName: company.bankAccountName,
    bankAccountNumber: company.bankAccountNumber,
    bankBranch: company.bankBranch || null,
    bankSwift: company.bankSwift || null,
    mpesaPaybill: company.mpesaPaybill || '542542',
    mpesaAccount: company.mpesaAccount || '43869',
    paymentNote: company.paymentNote,
    lateFeeNote: company.lateFeeNote || null,
    footer: company.footer,
    currency: company.currency || 'KES',
    logoUrl: company.logoUrl || '/brand/logo.png',
    signatureUrl: company.signatureUrl || '/brand/signature.png',
    financeSignatureUrl:
      company.financeSignatureUrl || '/brand/signature-scholastica.png',
    invoicedBy: company.invoicedBy || null,
    authorisedBy: company.authorisedBy || null,
  };
}

async function invoiceDisplayNumber(invoice) {
  if (invoice.invoice_number) return invoice.invoice_number;
  const issued = invoice.issue_date || invoice.created_at || new Date();
  const yy = String(new Date(issued).getFullYear()).slice(-2);
  if (invoice.project_id) {
    const { rows: proj } = await query(
      `SELECT finance_seq FROM projects WHERE id = $1`,
      [invoice.project_id]
    );
    const seq = String(proj[0]?.finance_seq || 0).padStart(3, '0');
    const { rows: ord } = await query(
      `SELECT COUNT(*)::int AS n FROM invoices
       WHERE project_id = $1 AND created_at <= $2`,
      [invoice.project_id, invoice.created_at || new Date()]
    );
    return `${seq}/${String(ord[0]?.n || 1).padStart(2, '0')}/${yy}`;
  }
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM invoices WHERE created_at <= $1`,
    [invoice.created_at || new Date()]
  );
  return `000/${String(rows[0]?.n || 1).padStart(2, '0')}/${yy}`;
}

async function invoiceReceipt(id) {
  const company = await loadCompanyProfile(query);
  const currency = company.currency || 'KES';
  const { rows } = await query(
    `SELECT i.*,
            c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
            c.business_name AS client_business,
            p.name AS project_name
     FROM invoices i
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError('Invoice not found', 404, 'NOT_FOUND');
  const i = rows[0];
  const paid = Number(i.amount_paid || 0);
  const total = Number(i.amount);
  const balance = Math.max(0, total - paid);
  const invNo = await invoiceDisplayNumber(i);
  const issueDate = i.issue_date || i.created_at;
  const dueDate = i.due_date
    ? fmtDay(i.due_date)
    : fmtDay(new Date(new Date(issueDate).getTime() + 5 * 86400000));

  let items = [];
  const rawItems = Array.isArray(i.line_items)
    ? i.line_items
    : typeof i.line_items === 'string'
      ? JSON.parse(i.line_items || '[]')
      : [];
  if (rawItems.length) {
    items = rawItems.map((it, idx) => {
      const qty = Number(it.qty || it.quantity || 1);
      const unit = Number(it.unit_price ?? it.unitPrice ?? it.amount ?? 0);
      const amount = Number(it.amount != null ? it.amount : qty * unit);
      return {
        no: idx + 1,
        description: it.description || it.name || 'Item',
        detail: it.detail || '',
        qty,
        unitPrice: unit,
        unitPriceFormatted: money(unit, currency),
        amount,
        amountFormatted: money(amount, currency),
      };
    });
  } else {
    items = [
      {
        no: 1,
        description: i.project_name
          ? `Project delivery — ${i.project_name}`
          : 'Professional services',
        detail: 'Software / digital systems',
        qty: 1,
        unitPrice: total,
        unitPriceFormatted: money(total, currency),
        amount: total,
        amountFormatted: money(total, currency),
      },
    ];
  }

  const lines = [
    ['Document', 'Tax invoice'],
    ['Invoice number', invNo],
    ['Bill to', i.client_business || i.client_name || '-'],
    ['Contact', i.client_name || '-'],
    ['Email', i.client_email || '-'],
    ['Phone', i.client_phone || '-'],
    ['Project', i.project_name || '-'],
    ['Amount', money(total, currency)],
    ['Amount paid', money(paid, currency)],
    ['Balance due', money(balance, currency)],
    ['Status', i.status],
    ['Due date', dueDate],
    ['Issued', fmtDay(issueDate)],
    [company.taxLabel || 'KRA PIN', company.taxId || '-'],
  ];

  const receipt = {
    type: 'invoice',
    layout: 'invoice',
    id: i.id,
    documentNumber: invNo,
    title: 'Tax Invoice',
    to: i.client_email || null,
    company: companyBlock(company),
    billTo: {
      name: i.client_name || '-',
      business: i.client_business || null,
      email: i.client_email || null,
      phone: i.client_phone || null,
      address: null,
    },
    meta: {
      project: i.project_name || null,
      projectReference: i.project_name || null,
      status: i.status,
      dueDate,
      issuedAt: fmtDay(issueDate),
      paymentStage: paid > 0 && balance > 0 ? 'Partial' : paid >= total ? 'Paid' : 'Full',
    },
    items,
    totals: {
      amount: money(total, currency),
      amountPaid: money(paid, currency),
      balanceDue: money(balance, currency),
      amountRaw: total,
      paidRaw: paid,
      balanceRaw: balance,
      currency,
    },
    paymentInstructions: {
      payWithinDays: 5,
      mpesaPaybill: company.mpesaPaybill || '542542',
      mpesaAccount: company.mpesaAccount || '43869',
      bankName: company.bankName,
      bankAccountName: company.bankAccountName,
      bankAccountNumber: company.bankAccountNumber,
      bankBranch: company.bankBranch,
      reference: invNo,
      note: company.paymentNote,
    },
    authorisedBy: {
      ...(company.authorisedBy || {}),
      signatureUrl: company.signatureUrl || '/brand/signature.png',
      date: fmtDay(issueDate),
    },
    invoicedBy: {
      ...(company.invoicedBy || {}),
      signatureUrl:
        company.financeSignatureUrl || '/brand/signature-scholastica.png',
      date: fmtDay(issueDate),
    },
    lines,
    text: `${company.legalName} - Invoice ${invNo}\nKRA PIN: ${company.taxId}\n\n${linesToText(lines)}\n\nM-Pesa: Paybill ${company.mpesaPaybill || '542542'} · Account ${company.mpesaAccount || '43869'}\nBank: ${company.bankName} · ${company.bankAccountNumber}\n\n${company.footer || ''}`,
    subject: `Invoice ${invNo} - ${company.legalName}`,
  };

  receipt.html = buildInvoicePrintHtml(receipt, { publicBaseUrl: publicBaseUrl() });
  return receipt;
}

async function paymentReceipt(id, { embedImages = true } = {}) {
  const company = await loadCompanyProfile(query);
  const currency = company.currency || 'KES';
  const { rows } = await query(
    `SELECT pay.*,
            i.amount AS invoice_amount, i.amount_paid, i.status AS invoice_status,
            i.invoice_number, i.parent_invoice_id,
            c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
            c.business_name AS client_business,
            p.name AS project_name,
            u.name AS recorded_by_name,
            (
              SELECT COALESCE(SUM(GREATEST(r.amount - COALESCE(r.amount_paid, 0), 0)), 0)::float
              FROM invoices r
              WHERE r.parent_invoice_id = i.id
                AND r.status IN ('issued', 'partially_paid', 'overdue')
            ) AS linked_outstanding,
            (
              SELECT r.invoice_number
              FROM invoices r
              WHERE r.parent_invoice_id = i.id
              ORDER BY r.created_at DESC
              LIMIT 1
            ) AS balance_invoice_number,
            (
              SELECT r.amount
              FROM invoices r
              WHERE r.parent_invoice_id = i.id
              ORDER BY r.created_at DESC
              LIMIT 1
            ) AS balance_invoice_amount
     FROM payments pay
     JOIN invoices i ON i.id = pay.invoice_id
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN projects p ON p.id = i.project_id
     LEFT JOIN users u ON u.id = pay.recorded_by
     WHERE pay.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError('Payment not found', 404, 'NOT_FOUND');
  const p = rows[0];
  const payNo = `PAY-${p.id.slice(0, 8).toUpperCase()}`;
  const invNo = p.invoice_number || String(p.invoice_id).slice(0, 8);
  const invoiceBal = Math.max(0, Number(p.invoice_amount || 0) - Number(p.amount_paid || 0));
  const linkedOutstanding = Number(p.linked_outstanding || 0);
  const outstanding = Math.round((invoiceBal + linkedOutstanding) * 100) / 100;
  const isNil = outstanding <= 0.001;
  const outstandingLabel = isNil ? 'NIL — Paid in full' : money(outstanding, currency);
  const paymentAmt = money(p.amount, currency);

  const lines = [
    ['Document', 'Payment receipt'],
    ['Receipt number', payNo],
    ['Invoice number', invNo],
    ['Client', p.client_business || p.client_name || '-'],
    ['Email', p.client_email || '-'],
    ['Project', p.project_name || '-'],
    ['Payment amount received', paymentAmt],
    ['Invoice total (this invoice)', money(p.invoice_amount, currency)],
    ['Total paid on this invoice', money(p.amount_paid, currency)],
    ['Outstanding balance', outstandingLabel],
    ...(p.balance_invoice_number || linkedOutstanding > 0
      ? [
          [
            'Balance invoice',
            `${p.balance_invoice_number || 'issued'} — ${money(
              p.balance_invoice_amount || linkedOutstanding,
              currency
            )}`,
          ],
        ]
      : []),
    ['Invoice status', p.invoice_status],
    ['Paid at', fmtDate(p.paid_at)],
    ['Bank reference', p.bank_reference || '-'],
    ['Recorded by', p.recorded_by_name || '-'],
    [company.taxLabel || 'KRA PIN', company.taxId || '-'],
  ];

  const receipt = {
    type: 'payment',
    layout: 'receipt',
    id: p.id,
    documentNumber: payNo,
    title: 'Payment receipt',
    to: p.client_email || null,
    company: companyBlock(company),
    billTo: {
      name: p.client_name || '-',
      business: p.client_business || null,
      email: p.client_email || null,
      phone: p.client_phone || null,
    },
    meta: {
      project: p.project_name || null,
      status: p.invoice_status,
      paidAt: fmtDate(p.paid_at),
      paidDay: fmtDay(p.paid_at || p.created_at),
      recordedBy: p.recorded_by_name || null,
      invoiceId: p.invoice_id,
      invoiceNumber: invNo,
      bankReference: p.bank_reference || null,
      paymentAmount: paymentAmt,
    },
    balance: {
      paymentFormatted: paymentAmt,
      invoiceTotalFormatted: money(p.invoice_amount, currency),
      invoicePaidFormatted: money(p.amount_paid, currency),
      outstandingFormatted: outstandingLabel,
      outstandingRaw: outstanding,
      balanceInvoiceNumber: p.balance_invoice_number || null,
      balanceInvoiceAmountFormatted: p.balance_invoice_amount
        ? money(p.balance_invoice_amount, currency)
        : linkedOutstanding > 0
          ? money(linkedOutstanding, currency)
          : null,
    },
    paymentInstructions: {
      mpesaPaybill: company.mpesaPaybill || '542542',
      mpesaAccount: company.mpesaAccount || '43869',
    },
    totals: {
      amount: paymentAmt,
      invoiceTotal: money(p.invoice_amount, currency),
      amountPaid: money(p.amount_paid, currency),
      outstanding: outstandingLabel,
    },
    invoicedBy: {
      ...(company.invoicedBy || {}),
      signatureUrl:
        company.financeSignatureUrl || '/brand/signature-scholastica.png',
      date: fmtDay(p.paid_at || p.created_at),
    },
    authorisedBy: {
      ...(company.authorisedBy || {}),
      signatureUrl: company.signatureUrl || '/brand/signature.png',
      date: fmtDay(p.paid_at || p.created_at),
    },
    lines,
    text: `${company.legalName} - Payment receipt ${payNo}\n\n${linesToText(
      lines
    )}\n\nOutstanding balance: ${outstandingLabel}\nM-Pesa: Paybill ${
      company.mpesaPaybill || '542542'
    } · Account ${company.mpesaAccount || '43869'}\n\n${
      company.footer || 'Thank you for your payment.'
    }`,
    subject: `Payment receipt ${payNo} - ${company.legalName}`,
  };

  const { buildPaymentReceiptHtml } = require('./paymentReceiptHtml');
  receipt.html = buildPaymentReceiptHtml(receipt, {
    publicBaseUrl: publicBaseUrl(),
    embedImages,
  });
  // Email-safe HTML uses hosted brand URLs (many clients block data: images)
  receipt.emailHtml = embedImages
    ? buildPaymentReceiptHtml(receipt, {
        publicBaseUrl: publicBaseUrl(),
        embedImages: false,
      })
    : receipt.html;
  return receipt;
}

async function expenseReceipt(id) {
  const company = await loadCompanyProfile(query);
  const currency = company.currency || 'KES';
  const { rows } = await query(
    `SELECT e.*, u.name AS created_by_name, a.name AS approved_by_name
     FROM expenses e
     LEFT JOIN users u ON u.id = e.created_by
     LEFT JOIN users a ON a.id = e.approved_by
     WHERE e.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError('Expense not found', 404, 'NOT_FOUND');
  const e = rows[0];
  const lines = [
    ['Receipt type', 'Expense'],
    ['Expense ID', e.id],
    ['Category', e.category],
    ['Amount', money(e.amount, currency)],
    ['Description', e.description || '-'],
    ['Approval', e.approval_status || 'approved'],
    ['Submitted by', e.created_by_name || '-'],
    ['Approved by', e.approved_by_name || '-'],
    ['Created', fmtDate(e.created_at)],
  ];
  return {
    type: 'expense',
    layout: 'receipt',
    id: e.id,
    documentNumber: `EXP-${e.id.slice(0, 8).toUpperCase()}`,
    title: 'Expense receipt',
    to: null,
    company: companyBlock(company),
    lines,
    text: `${company.legalName} - Expense receipt\n\n${linesToText(lines)}\n\n${company.footer || ''}`,
    subject: `Expense receipt ${e.id.slice(0, 8)} - ${company.legalName}`,
  };
}

module.exports = { invoiceReceipt, paymentReceipt, expenseReceipt };
