/**
 * Build printable / emailable receipt payloads for invoices, payments, expenses.
 * Includes Cres Dynamics Caribbean letterhead for invoice-style printing.
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');
const { loadCompanyProfile } = require('../config/company');

function money(n, currency = 'USD') {
  const num = Number(n);
  if (Number.isNaN(num)) return '-';
  return num.toLocaleString(undefined, { style: 'currency', currency });
}

function fmtDate(v) {
  if (!v) return '-';
  return new Date(v).toLocaleString();
}

function fmtDay(v) {
  if (!v) return '-';
  return new Date(v).toLocaleDateString();
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
    bankSwift: company.bankSwift,
    paymentNote: company.paymentNote,
    footer: company.footer,
    currency: company.currency || 'USD',
  };
}

async function invoiceReceipt(id) {
  const company = await loadCompanyProfile(query);
  const currency = company.currency || 'USD';
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
  const balance = total - paid;
  const invNo = `INV-${i.id.slice(0, 8).toUpperCase()}`;
  const lines = [
    ['Document', 'Tax invoice'],
    ['Invoice number', invNo],
    ['Invoice ID', i.id],
    ['Bill to', i.client_business || i.client_name || '-'],
    ['Contact', i.client_name || '-'],
    ['Email', i.client_email || '-'],
    ['Phone', i.client_phone || '-'],
    ['Project', i.project_name || '-'],
    ['Amount', money(total, currency)],
    ['Amount paid', money(paid, currency)],
    ['Balance due', money(balance, currency)],
    ['Status', i.status],
    ['Due date', i.due_date ? fmtDay(i.due_date) : '-'],
    ['Issued', fmtDate(i.created_at)],
  ];
  return {
    type: 'invoice',
    layout: 'invoice',
    id: i.id,
    documentNumber: invNo,
    title: 'Invoice',
    to: i.client_email || null,
    company: companyBlock(company),
    billTo: {
      name: i.client_name || '-',
      business: i.client_business || null,
      email: i.client_email || null,
      phone: i.client_phone || null,
    },
    meta: {
      project: i.project_name || null,
      status: i.status,
      dueDate: i.due_date ? fmtDay(i.due_date) : null,
      issuedAt: fmtDate(i.created_at),
    },
    totals: {
      amount: money(total, currency),
      amountPaid: money(paid, currency),
      balanceDue: money(balance, currency),
      amountRaw: total,
      paidRaw: paid,
      balanceRaw: balance,
    },
    lines,
    text: `${company.legalName} - Invoice ${invNo}\n\n${linesToText(lines)}\n\n${company.footer || ''}`,
    subject: `Invoice ${invNo} - ${company.legalName}`,
  };
}

async function paymentReceipt(id) {
  const company = await loadCompanyProfile(query);
  const currency = company.currency || 'USD';
  const { rows } = await query(
    `SELECT pay.*,
            i.amount AS invoice_amount, i.amount_paid, i.status AS invoice_status,
            c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
            c.business_name AS client_business,
            p.name AS project_name,
            u.name AS recorded_by_name
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
  const lines = [
    ['Document', 'Payment receipt'],
    ['Receipt number', payNo],
    ['Payment ID', p.id],
    ['Invoice ID', p.invoice_id],
    ['Client', p.client_business || p.client_name || '-'],
    ['Email', p.client_email || '-'],
    ['Project', p.project_name || '-'],
    ['Payment amount', money(p.amount, currency)],
    ['Invoice total', money(p.invoice_amount, currency)],
    ['Invoice paid to date', money(p.amount_paid, currency)],
    ['Invoice status', p.invoice_status],
    ['Paid at', fmtDate(p.paid_at)],
    ['Bank reference', p.bank_reference || '-'],
    ['Recorded by', p.recorded_by_name || '-'],
  ];
  return {
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
      recordedBy: p.recorded_by_name || null,
      invoiceId: p.invoice_id,
      bankReference: p.bank_reference || null,
    },
    totals: {
      amount: money(p.amount, currency),
      invoiceTotal: money(p.invoice_amount, currency),
      amountPaid: money(p.amount_paid, currency),
    },
    lines,
    text: `${company.legalName} - Payment receipt ${payNo}\n\n${linesToText(lines)}\n\n${company.footer || 'Thank you for your payment.'}`,
    subject: `Payment receipt ${payNo} - ${company.legalName}`,
  };
}

async function expenseReceipt(id) {
  const company = await loadCompanyProfile(query);
  const currency = company.currency || 'USD';
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
