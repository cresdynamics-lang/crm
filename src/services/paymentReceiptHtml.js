/**
 * Cres Dynamics payment receipt HTML (download + email).
 * Embeds brand assets so file:// downloads always show logo/signatures.
 */
const { resolveBrandSrc } = require('./brandAssets');

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPaymentReceiptHtml(receipt, { publicBaseUrl = '', embedImages = true } = {}) {
  const c = receipt.company || {};
  const bill = receipt.billTo || {};
  const meta = receipt.meta || {};
  const bal = receipt.balance || {};
  const pay = receipt.paymentInstructions || {};
  const auth = receipt.authorisedBy || {};
  const invoiced = receipt.invoicedBy || {};
  const embedOpts = { embed: embedImages };

  const logo = resolveBrandSrc(c.logoUrl, 'logo.png', publicBaseUrl, embedOpts);
  const nelsonSig = resolveBrandSrc(
    auth.signatureUrl || c.signatureUrl,
    'signature.png',
    publicBaseUrl,
    embedOpts
  );
  const finSig = resolveBrandSrc(
    invoiced.signatureUrl || c.financeSignatureUrl,
    'signature-scholastica.png',
    publicBaseUrl,
    embedOpts
  );
  const addr = (c.addressLines || []).map((l) => esc(l)).join('<br/>');
  const outstandingRaw = Number(bal.outstandingRaw || 0);
  const isNil = !(outstandingRaw > 0.001);
  const outstandingDisplay = isNil
    ? 'NIL — Paid in full'
    : esc(bal.outstandingFormatted || '-');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>${esc(receipt.documentNumber || 'Payment receipt')} — Cres Dynamics Ltd</title>
<style>
  @page { size: A4; margin: 12mm; }
  :root { --ink:#1b2a4a; --muted:#5a6a78; --line:#cfd8e0; --accent:#00a8c5; --orange:#f5a623; --soft:#f4fbfc; --ok:#1b7a3d; }
  * { box-sizing:border-box; }
  body { margin:0; padding:0; font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif; font-size:12px; color:var(--ink); background:#fff; }
  .page { max-width:190mm; margin:0 auto; padding:10px 6px; }
  .header { display:flex; gap:14px; align-items:flex-start; border-bottom:2px solid var(--accent); padding-bottom:8px; margin-bottom:12px; }
  .logo { height:52px; width:auto; max-width:200px; object-fit:contain; background:transparent; }
  .co h1 { margin:0; font-size:16px; color:var(--ink); }
  .co .tag { color:var(--muted); font-size:10px; margin-top:2px; }
  .co .addr { margin-top:4px; color:var(--muted); font-size:10px; }
  .badge { margin-left:auto; text-align:right; }
  .badge .kind { font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .badge h2 { margin:2px 0 0; font-size:20px; }
  .titlebar { background:var(--soft); border:1px solid var(--line); padding:8px 12px; margin-bottom:12px; font-weight:700; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px; }
  .box { border:1px solid var(--line); padding:10px 12px; border-radius:4px; }
  .box h3 { margin:0 0 6px; font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  table.lines { width:100%; border-collapse:collapse; margin-bottom:14px; }
  table.lines th, table.lines td { border-bottom:1px solid var(--line); padding:8px 6px; text-align:left; vertical-align:top; }
  table.lines th { width:38%; color:var(--muted); font-weight:600; }
  .balance {
    border:2px solid ${isNil ? 'var(--ok)' : 'var(--accent)'};
    background:${isNil ? '#f0faf3' : 'var(--soft)'};
    border-radius:6px; padding:12px 14px; margin-bottom:14px;
  }
  .balance .label { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .balance .value { font-size:18px; font-weight:700; margin-top:4px; color:${isNil ? 'var(--ok)' : 'var(--accent)'}; }
  .note { color:var(--muted); font-size:11px; margin-bottom:14px; }
  .pay { border:1px solid var(--line); border-radius:4px; padding:8px 10px; margin-bottom:14px; }
  .pay h3 { margin:0 0 6px; font-size:11px; }
  .pay ul { margin:0; padding-left:16px; }
  .auth { display:flex; justify-content:space-between; gap:24px; align-items:flex-end; padding-top:10px; border-top:1px solid var(--line); }
  .sig { flex:1; max-width:48%; }
  .sig .label { font-size:9px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
  .sig img { height:40px; width:auto; max-width:100%; object-fit:contain; display:block; }
  .sig .line { border-bottom:1px solid var(--ink); width:100%; max-width:200px; margin-top:2px; }
  .sig .who { margin-top:4px; font-size:10px; line-height:1.35; }
  .foot { text-align:center; color:var(--muted); font-size:9px; margin-top:12px; padding-top:8px; border-top:1px solid var(--line); }
</style></head><body>
  <div class="page">
    <div class="header">
      <img class="logo" src="${esc(logo)}" alt="Cres Dynamics" />
      <div class="co">
        <h1>${esc(c.tradingName || c.legalName || 'Cres Dynamics Ltd')}</h1>
        ${c.tagline ? `<div class="tag">${esc(c.tagline)}</div>` : ''}
        <div class="addr">${addr}<br/>
          Tel: ${esc(c.phone || '')}<br/>
          Email: ${esc(c.email || '')}<br/>
          <strong>${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}</strong>
        </div>
      </div>
      <div class="badge">
        <div class="kind">Official receipt</div>
        <h2>PAYMENT</h2>
      </div>
    </div>

    <div class="titlebar">Payment receipt — ${esc(receipt.documentNumber || '')}</div>

    <div class="grid">
      <div class="box">
        <h3>Received from</h3>
        <div><strong>${esc(bill.business || bill.name || '-')}</strong></div>
        ${bill.name && bill.business ? `<div>${esc(bill.name)}</div>` : ''}
        ${bill.email ? `<div>${esc(bill.email)}</div>` : ''}
        ${bill.phone ? `<div>${esc(bill.phone)}</div>` : ''}
      </div>
      <div class="box">
        <h3>Payment details</h3>
        <div><strong>Amount received:</strong> ${esc(bal.paymentFormatted || meta.paymentAmount || '-')}</div>
        <div><strong>Date:</strong> ${esc(meta.paidAt || '-')}</div>
        <div><strong>Payment method:</strong> M-Pesa Paybill ${esc(pay.mpesaPaybill || c.mpesaPaybill || '542542')} · Account ${esc(pay.mpesaAccount || c.mpesaAccount || '43869')}</div>
        <div><strong>Bank reference:</strong> ${esc(meta.bankReference || '-')}</div>
        <div><strong>Invoice:</strong> ${esc(meta.invoiceNumber || meta.invoiceId || '-')}</div>
        <div><strong>Project:</strong> ${esc(meta.project || '-')}</div>
      </div>
    </div>

    <table class="lines">
      <tr><th>Payment amount received</th><td><strong>${esc(bal.paymentFormatted || '-')}</strong></td></tr>
      <tr><th>Invoice total (this invoice)</th><td>${esc(bal.invoiceTotalFormatted || '-')}</td></tr>
      <tr><th>Total paid on this invoice</th><td>${esc(bal.invoicePaidFormatted || '-')}</td></tr>
      <tr><th>Invoice status</th><td>${esc(meta.status || '-')}</td></tr>
      ${
        bal.balanceInvoiceNumber
          ? `<tr><th>New balance invoice issued</th><td>${esc(bal.balanceInvoiceNumber)} — ${esc(
              bal.balanceInvoiceAmountFormatted || ''
            )}</td></tr>`
          : ''
      }
      <tr><th>Recorded by</th><td>${esc(meta.recordedBy || '-')}</td></tr>
    </table>

    <div class="balance">
      <div class="label">Outstanding balance after this payment</div>
      <div class="value">${outstandingDisplay}</div>
    </div>

    <div class="note">
      ${
        isNil
          ? 'Thank you. This invoice is fully settled — outstanding balance is NIL.'
          : 'A balance remains outstanding. Please settle using the balance invoice / payment instructions from Cres Dynamics Finance.'
      }
      ${c.paymentNote ? `<br/>${esc(c.paymentNote)}` : ''}
    </div>

    <div class="pay">
      <h3>Payment method</h3>
      <ul>
        <li><strong>M-Pesa:</strong> Paybill ${esc(pay.mpesaPaybill || c.mpesaPaybill || '542542')} | Account: ${esc(
          pay.mpesaAccount || c.mpesaAccount || '43869'
        )}</li>
      </ul>
    </div>

    <div class="auth">
      <div class="sig">
        <div class="label">Invoiced / recorded by</div>
        <img src="${esc(finSig)}" alt="Finance signature" />
        <div class="line"></div>
        <div class="who">
          <strong>${esc(invoiced.name || 'Scholastica Omoro')}</strong><br/>
          ${esc(invoiced.title || 'Finance, Cres Dynamics Ltd')}<br/>
          Date: ${esc(invoiced.date || meta.paidDay || '')}
        </div>
      </div>
      <div class="sig">
        <div class="label">Authorised by</div>
        <img src="${esc(nelsonSig)}" alt="Authorised signature" />
        <div class="line"></div>
        <div class="who">
          <strong>${esc(auth.name || 'Nelson Were')}</strong><br/>
          ${esc(auth.title || 'Chief Executive Officer, Cres Dynamics Ltd')}<br/>
          Date: ${esc(auth.date || meta.paidDay || '')}
        </div>
      </div>
    </div>

    <div class="foot">
      ${esc(c.footer || 'Thank you for your payment. Building Intelligent Systems that Run Your Business — cresdynamics.com')}<br/>
      ${esc(c.legalName || 'Cres Dynamics Ltd')} | ${esc(c.tagline || 'Building Intelligent Systems that Run Your Business')}<br/>
      ${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}
    </div>
  </div>
</body></html>`;
}

module.exports = { buildPaymentReceiptHtml, esc };
