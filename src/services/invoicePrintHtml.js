/**
 * One-page Cres Dynamics tax invoice HTML (print + email).
 * Brand images are embedded as data URIs so downloads / email always show them.
 */
const { resolveBrandSrc } = require('./brandAssets');

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function absUrl(base, path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path) || /^data:/i.test(path)) return path;
  const root = (base || '').replace(/\/$/, '');
  return `${root}${path.startsWith('/') ? '' : '/'}${path}`;
}

function buildInvoicePrintHtml(receipt, { publicBaseUrl = '' } = {}) {
  const c = receipt.company || {};
  const bill = receipt.billTo || {};
  const meta = receipt.meta || {};
  const pay = receipt.paymentInstructions || {};
  const auth = receipt.authorisedBy || {};
  const invoiced = receipt.invoicedBy || {};
  const items = receipt.items || [];
  const totals = receipt.totals || {};
  const logo = resolveBrandSrc(c.logoUrl, 'logo.png', publicBaseUrl);
  const signature = resolveBrandSrc(
    auth.signatureUrl || c.signatureUrl,
    'signature.png',
    publicBaseUrl
  );
  const financeSig = resolveBrandSrc(
    invoiced.signatureUrl || c.financeSignatureUrl,
    'signature-scholastica.png',
    publicBaseUrl
  );
  const addr = (c.addressLines || []).map((l) => esc(l)).join('<br/>');
  const itemRows = (items.length
    ? items
    : [
        {
          no: 1,
          description: 'Professional services',
          detail: '',
          qty: 1,
          unitPriceFormatted: totals.amount,
          amountFormatted: totals.amount,
        },
      ]
  )
    .map(
      (it) => `<tr>
        <td class="c">${esc(it.no)}</td>
        <td><strong>${esc(it.description)}</strong>${
          it.detail ? `<div class="muted">${esc(it.detail)}</div>` : ''
        }</td>
        <td class="c">${esc(it.qty != null ? it.qty : 1)}</td>
        <td class="r">${esc(it.unitPriceFormatted || it.amountFormatted || '-')}</td>
        <td class="r">${esc(it.amountFormatted || '-')}</td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${esc(receipt.documentNumber || 'Invoice')} — Cres Dynamics Ltd</title>
<style>
  @page { size: A4; margin: 10mm; }
  :root { --ink:#1b2a4a; --muted:#5a6a78; --line:#cfd8e0; --accent:#00a8c5; --orange:#f5a623; --soft:#f4fbfc; }
  * { box-sizing:border-box; }
  html, body { margin:0; padding:0; background:#fff; color:var(--ink); }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size:11px; line-height:1.35; }
  .page { width:100%; max-width:190mm; margin:0 auto; padding:8px 4px; }
  .header { display:flex; gap:14px; align-items:flex-start; border-bottom:2px solid var(--accent); padding-bottom:8px; margin-bottom:10px; }
  .logo { height:52px; width:auto; max-width:200px; object-fit:contain; flex:0 0 auto; background:transparent; }
  .co h1 { margin:0; font-size:16px; letter-spacing:.02em; color:var(--ink); }
  .co .tag { color:var(--muted); font-size:10px; margin-top:2px; }
  .co .addr { margin-top:4px; color:var(--muted); font-size:10px; }
  .badge { margin-left:auto; text-align:right; }
  .badge .kind { font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .badge h2 { margin:2px 0 0; font-size:22px; }
  .titlebar { background:var(--soft); border:1px solid var(--line); padding:6px 10px; margin-bottom:10px; font-weight:700; letter-spacing:.04em; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px; }
  .box { border:1px solid var(--line); padding:8px 10px; border-radius:4px; }
  .label { font-size:9px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:4px; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:8px; }
  table.items th { background:var(--accent); color:#fff; text-align:left; padding:6px 8px; font-size:10px; }
  table.items td { border-bottom:1px solid var(--line); padding:6px 8px; vertical-align:top; }
  table.items .c { width:36px; text-align:center; }
  table.items .r { text-align:right; white-space:nowrap; font-weight:600; }
  .muted { color:var(--muted); font-size:10px; margin-top:2px; }
  .totals { display:flex; justify-content:flex-end; margin-bottom:10px; }
  .totals .card { min-width:220px; border:1px solid var(--line); border-radius:4px; padding:8px 10px; background:var(--soft); }
  .totals .row { display:flex; justify-content:space-between; gap:16px; margin:3px 0; }
  .totals .due { margin-top:6px; padding-top:6px; border-top:1px solid var(--line); font-size:13px; font-weight:700; color:var(--accent); }
  .pay { border:1px solid var(--line); border-radius:4px; padding:8px 10px; margin-bottom:8px; }
  .pay h3 { margin:0 0 6px; font-size:11px; }
  .pay ul { margin:0; padding-left:16px; }
  .notes { color:var(--muted); font-size:10px; margin-bottom:8px; }
  .auth { display:flex; justify-content:space-between; gap:24px; align-items:flex-end; padding-top:8px; border-top:1px solid var(--line); margin-top:12px; }
  .sig { flex:1; max-width:48%; min-width:0; }
  .sig .label { font-size:9px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
  .sig img {
    height:42px;
    width:auto;
    max-width:100%;
    object-fit:contain;
    object-position:left bottom;
    display:block;
    background:transparent;
    margin:0 0 2px;
  }
  .sig .line { border-bottom:1px solid var(--ink); width:100%; max-width:200px; margin-top:0; }
  .sig .who { margin-top:4px; font-size:10px; line-height:1.35; }
  .foot { text-align:center; color:var(--muted); font-size:9px; margin-top:10px; padding-top:6px; border-top:1px solid var(--line); }
  @media print {
    body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .no-print { display:none !important; }
  }
</style></head><body>
  <div class="page">
    <div class="header">
      <img class="logo" src="${esc(logo)}" alt="Cres Dynamics" />
      <div class="co">
        <h1>${esc(c.tradingName || c.legalName || 'Cres Dynamics Ltd')}</h1>
        ${c.tagline ? `<div class="tag">${esc(c.tagline)}</div>` : ''}
        <div class="addr">${addr}<br/>
          Tel: ${esc(c.phone || '')}<br/>
          Email: ${esc(c.email || '')}${c.website ? ` | ${esc(c.website)}` : ''}<br/>
          <strong>${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}</strong>
        </div>
      </div>
      <div class="badge">
        <div class="kind">Tax invoice</div>
        <h2>INVOICE</h2>
      </div>
    </div>

    <div class="titlebar">${esc(c.legalName || 'Cres Dynamics Ltd')} — TAX INVOICE</div>

    <div class="grid">
      <div class="box">
        <div class="label">From</div>
        <strong>${esc(c.legalName || 'Cres Dynamics Ltd')}</strong>
        <div class="muted">${addr}</div>
        <div><strong>${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}</strong></div>
      </div>
      <div class="box">
        <div class="label">To</div>
        <strong>${esc(bill.business || bill.name || 'Client')}</strong>
        ${bill.business && bill.name ? `<div>${esc(bill.name)}</div>` : ''}
        ${bill.email ? `<div class="muted">${esc(bill.email)}</div>` : ''}
        ${bill.phone ? `<div class="muted">${esc(bill.phone)}</div>` : ''}
      </div>
    </div>

    <div class="grid">
      <div class="box">
        <div class="label">Invoice details</div>
        <div><strong>Invoice Number:</strong> ${esc(receipt.documentNumber || '')}</div>
        <div><strong>Invoice Date:</strong> ${esc(meta.issuedAt || '-')}</div>
        <div><strong>Payment Due Date:</strong> ${esc(meta.dueDate || '-')}</div>
        <div><strong>Project Reference:</strong> ${esc(meta.projectReference || meta.project || '-')}</div>
        <div><strong>Status:</strong> ${esc(String(meta.status || '').replace(/_/g, ' '))}</div>
      </div>
      <div class="box">
        <div class="label">Totals (KES)</div>
        <div>Amount: <strong>${esc(totals.amount || '-')}</strong></div>
        <div>Paid: <strong>${esc(totals.amountPaid || '-')}</strong></div>
        <div>TOTAL DUE: <strong>${esc(totals.balanceDue || totals.amount || '-')}</strong></div>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th class="c">#</th><th>Description</th><th class="c">Qty</th>
          <th class="r">Unit (KES)</th><th class="r">Amount (KES)</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="totals">
      <div class="card">
        <div class="row"><span>Subtotal (no VAT)</span><strong>${esc(totals.amount || '-')}</strong></div>
        <div class="row"><span>Amount paid</span><strong>${esc(totals.amountPaid || '-')}</strong></div>
        <div class="row due"><span>TOTAL DUE</span><strong>${esc(totals.balanceDue || '-')}</strong></div>
      </div>
    </div>

    <div class="pay">
      <h3>Payment instructions</h3>
      <div>Pay within ${esc(pay.payWithinDays || 5)} days of invoice date.</div>
      <ul>
        <li><strong>M-Pesa:</strong> Paybill ${esc(pay.mpesaPaybill || c.mpesaPaybill || '542542')} | Account: ${esc(
          pay.mpesaAccount || c.mpesaAccount || '43869'
        )}</li>
        <li><strong>Bank Transfer:</strong> ${esc(pay.bankName || c.bankName || '')}
          | Account Name: ${esc(pay.bankAccountName || c.bankAccountName || '')}
          | Account No: <strong>${esc(pay.bankAccountNumber || c.bankAccountNumber || '')}</strong>
          ${pay.bankBranch || c.bankBranch ? ` | Branch: ${esc(pay.bankBranch || c.bankBranch)}` : ''}
        </li>
      </ul>
      <div style="margin-top:4px;">Please use Invoice Number <strong>${esc(
        pay.reference || receipt.documentNumber || ''
      )}</strong> as your payment reference.</div>
    </div>

    ${c.lateFeeNote ? `<div class="notes">${esc(c.lateFeeNote)}</div>` : ''}

    <div class="auth">
      <div class="sig">
        <div class="label">Invoiced by</div>
        <img src="${esc(financeSig)}" alt="Finance signature" />
        <div class="line"></div>
        <div class="who">
          <strong>${esc(invoiced.name || 'Scholastica Omoro')}</strong><br/>
          ${esc(invoiced.title || 'Finance, Cres Dynamics Ltd')}<br/>
          Date: ${esc(invoiced.date || meta.issuedAt || '')}
        </div>
      </div>
      <div class="sig">
        <div class="label">Authorised by</div>
        <img src="${esc(signature)}" alt="Authorised signature" />
        <div class="line"></div>
        <div class="who">
          <strong>${esc(auth.name || 'Nelson Were')}</strong><br/>
          ${esc(auth.title || 'Chief Executive Officer, Cres Dynamics Ltd')}<br/>
          Date: ${esc(auth.date || meta.issuedAt || '')}
        </div>
      </div>
    </div>

    <div class="foot">
      ${esc(c.footer || 'Thank you for your business. Building Intelligent Systems that Run Your Business — cresdynamics.com')}<br/>
      ${esc(c.legalName || 'Cres Dynamics Ltd')} | ${esc(c.tagline || '')}<br/>
      ${(c.addressLines || []).map((l) => esc(l)).join(' · ')}
      ${c.email ? ` | ${esc(c.email)}` : ''}
      ${c.website ? ` | ${esc(c.website)}` : ''}
      | ${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}
    </div>
  </div>
</body></html>`;
}

module.exports = { buildInvoicePrintHtml, esc, absUrl };
