/** Shared printable receipt / invoice helper for Finance */
const CresReceipts = (() => {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function companyHtml(company) {
    if (!company) {
      return `<div class="brand"><h1>Cres Dynamics</h1></div>`;
    }
    const addr = (company.addressLines || []).map((l) => esc(l)).join('<br/>');
    return `<div class="brand">
      <h1>${esc(company.tradingName || company.legalName || 'Cres Dynamics')}</h1>
      ${company.tagline ? `<div class="tag">${esc(company.tagline)}</div>` : ''}
      <div class="addr">${addr}</div>
      <div class="contact">
        ${company.phone ? esc(company.phone) : ''}
        ${company.email ? ` · ${esc(company.email)}` : ''}
        ${company.website ? ` · ${esc(company.website)}` : ''}
      </div>
      ${
        company.taxId
          ? `<div class="tax">${esc(company.taxLabel || 'Tax ID')}: ${esc(company.taxId)}</div>`
          : ''
      }
    </div>`;
  }

  function billToHtml(billTo) {
    if (!billTo) return '';
    return `<div class="box">
      <div class="label">Bill to</div>
      <strong>${esc(billTo.business || billTo.name || '-')}</strong>
      ${billTo.business && billTo.name ? `<div>${esc(billTo.name)}</div>` : ''}
      ${billTo.email ? `<div>${esc(billTo.email)}</div>` : ''}
      ${billTo.phone ? `<div>${esc(billTo.phone)}</div>` : ''}
    </div>`;
  }

  function bankHtml(company) {
    if (!company?.bankName) return '';
    return `<div class="bank">
      <div class="label">Remittance / banking</div>
      <div>${esc(company.bankName)}</div>
      <div>Account: ${esc(company.bankAccountName || '-')} · ${esc(company.bankAccountNumber || '-')}</div>
      ${company.bankSwift ? `<div>SWIFT: ${esc(company.bankSwift)}</div>` : ''}
      ${company.paymentNote ? `<div class="note">${esc(company.paymentNote)}</div>` : ''}
    </div>`;
  }

  function print(receipt) {
    const company = receipt.company || null;
    const isInvoice = receipt.layout === 'invoice' || receipt.type === 'invoice';
    const rows = (receipt.lines || [])
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
      .join('');

    const totals = receipt.totals
      ? `<div class="totals">
          ${receipt.totals.amount ? `<div><span>Amount</span><strong>${esc(receipt.totals.amount)}</strong></div>` : ''}
          ${receipt.totals.amountPaid ? `<div><span>Paid</span><strong>${esc(receipt.totals.amountPaid)}</strong></div>` : ''}
          ${receipt.totals.balanceDue ? `<div class="due"><span>Balance due</span><strong>${esc(receipt.totals.balanceDue)}</strong></div>` : ''}
          ${receipt.totals.invoiceTotal && !receipt.totals.balanceDue ? `<div><span>Invoice total</span><strong>${esc(receipt.totals.invoiceTotal)}</strong></div>` : ''}
        </div>`
      : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${esc(receipt.title || 'Document')} ${esc(receipt.documentNumber || '')}</title>
<style>
  :root { --ink:#15202b; --muted:#5c6b7a; --line:#d7dee6; --accent:#0f6e6a; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: var(--ink); margin: 0; padding: 36px 44px; }
  .sheet { max-width: 800px; margin: 0 auto; }
  .top { display:flex; justify-content:space-between; gap:24px; border-bottom: 2px solid var(--accent); padding-bottom: 16px; margin-bottom: 22px; }
  .brand h1 { margin:0; font-size:1.55rem; letter-spacing:0.02em; color: var(--accent); }
  .tag { color: var(--muted); font-size:0.85rem; margin-top:2px; }
  .addr, .contact, .tax { font-size:0.8rem; color: var(--muted); margin-top:6px; line-height:1.45; }
  .doc { text-align:right; }
  .doc .kind { font-size:0.75rem; text-transform:uppercase; letter-spacing:0.08em; color: var(--muted); }
  .doc h2 { margin:4px 0 8px; font-size:1.35rem; }
  .doc .meta { font-size:0.85rem; color: var(--muted); line-height:1.5; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:22px; }
  .box { border:1px solid var(--line); border-radius:8px; padding:12px 14px; font-size:0.9rem; }
  .label { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.06em; color: var(--muted); margin-bottom:6px; }
  table { width:100%; border-collapse:collapse; margin-bottom:18px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; font-size:0.9rem; }
  th { width:36%; color: var(--muted); font-weight:600; }
  .totals { margin-left:auto; width:min(320px, 100%); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .totals div { display:flex; justify-content:space-between; gap:12px; margin:6px 0; font-size:0.92rem; }
  .totals .due { margin-top:10px; padding-top:10px; border-top:1px solid var(--line); font-size:1.05rem; }
  .bank { margin-top:22px; padding:12px 14px; background:#f4f7f8; border-radius:8px; font-size:0.85rem; color: var(--muted); }
  .bank .note { margin-top:8px; color: var(--ink); }
  .foot { margin-top:28px; font-size:0.8rem; color: var(--muted); border-top:1px solid var(--line); padding-top:12px; }
  @media print { body { padding: 12px; } .sheet { max-width:none; } }
</style></head><body>
  <div class="sheet">
    <div class="top">
      ${companyHtml(company)}
      <div class="doc">
        <div class="kind">${esc(isInvoice ? 'Invoice' : receipt.title || 'Receipt')}</div>
        <h2>${esc(receipt.documentNumber || receipt.id?.slice?.(0, 8) || '')}</h2>
        <div class="meta">
          ${receipt.meta?.issuedAt ? `Issued ${esc(receipt.meta.issuedAt)}<br/>` : ''}
          ${receipt.meta?.dueDate ? `Due ${esc(receipt.meta.dueDate)}<br/>` : ''}
          ${receipt.meta?.paidAt ? `Paid ${esc(receipt.meta.paidAt)}<br/>` : ''}
          ${receipt.meta?.status ? `Status: ${esc(String(receipt.meta.status).replace(/_/g, ' '))}` : ''}
        </div>
      </div>
    </div>
    <div class="grid">
      ${billToHtml(receipt.billTo)}
      <div class="box">
        <div class="label">Details</div>
        ${receipt.meta?.project ? `<div>Project: ${esc(receipt.meta.project)}</div>` : ''}
        ${receipt.meta?.invoiceId ? `<div>Invoice: ${esc(receipt.meta.invoiceId)}</div>` : ''}
        ${receipt.meta?.recordedBy ? `<div>Recorded by: ${esc(receipt.meta.recordedBy)}</div>` : ''}
        <div>Printed ${esc(new Date().toLocaleString())}</div>
      </div>
    </div>
    <table>${rows}</table>
    ${totals}
    ${isInvoice ? bankHtml(company) : ''}
    <p class="foot">${esc(company?.footer || 'Generated by Cres Dynamics CRM.')}</p>
  </div>
  <script>window.onload = function () { window.print(); }</script>
</body></html>`;
    const w = window.open('', '_blank', 'noopener,noreferrer,width=860,height=980');
    if (!w) {
      throw new Error('Pop-up blocked - allow pop-ups to print receipts');
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  async function fetchAndPrint(path) {
    const res = await CresAPI.request(path);
    print(res.data);
    return res.data;
  }

  async function send(path, to) {
    const body = to ? { to } : {};
    return CresAPI.request(path, {
      method: 'POST',
      body,
      idempotencyKey: `receipt-${path}-${Date.now()}`,
    });
  }

  return { print, fetchAndPrint, send };
})();
