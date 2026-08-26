/**
 * PDF rendering for finance documents (payment receipts, tax invoices, expense
 * receipts). Pure-JS via pdfkit - no headless browser needed, works on the
 * droplet. Layouts mirror the HTML templates in paymentReceiptHtml.js /
 * invoicePrintHtml.js so downloads and emails stay on-brand.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { localBrandPath } = require('./brandAssets');

const BRAND_DIR = path.join(__dirname, '..', '..', 'public', 'brand');

const C = {
  ink: '#14212b',
  muted: '#5a6a78',
  line: '#cfd8e0',
  accent: '#0d7c76',
  soft: '#f3f7f8',
  ok: '#1b7a3d',
  okBg: '#f0faf3',
  white: '#ffffff',
};

const PAGE = { width: 595.28, height: 841.89, marginX: 36 };
const USABLE = PAGE.width - PAGE.marginX * 2;

function esc(str) {
  return String(str ?? '');
}

function brandImageBuffer(urlOrPath, fallbackFile) {
  const candidates = [
    localBrandPath(urlOrPath),
    fallbackFile ? path.join(BRAND_DIR, fallbackFile) : null,
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file);
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Render an A4 doc built by `build(doc)` into a Buffer. */
function renderPdf(build, { title, author } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 30, bottom: 28, left: PAGE.marginX, right: PAGE.marginX },
      info: { Title: title || 'Document', Author: author || 'Cres Dynamics Ltd' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

/* ---------------------------------------------------------------- helpers */

function setFont(doc, { size = 9, bold = false, color = C.ink } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
}

/** Draw wrapped text starting at (x, y); returns y after the text block. */
function drawText(doc, text, { x, y, width, size = 9, bold = false, color = C.ink, lineGap = 1.5 }) {
  setFont(doc, { size, bold, color });
  doc.text(text, x, y, { width, lineGap });
  return doc.y;
}

function hairline(doc, x1, y, x2, color = C.line, thickness = 0.6) {
  doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(thickness).strokeColor(color).stroke().restore();
}

function box(doc, { x, y, w, h, radius = 3, stroke = C.line, fill = null, lineWidth = 0.8 }) {
  doc.save();
  if (fill) {
    doc.roundedRect(x, y, w, h, radius).fillColor(fill).fill();
  }
  if (stroke) {
    doc.roundedRect(x, y, w, h, radius).lineWidth(lineWidth).strokeColor(stroke).stroke();
  }
  doc.restore();
}

/**
 * Company header shared by all documents. Returns y below the accent rule.
 */
function companyHeader(doc, company, { badgeKind, badgeTitle }) {
  const m = PAGE.marginX;
  let y = 30;

  // Logo tile (dark rounded square, like HTML)
  const logoSize = 46;
  doc.save().fillColor('#111111').roundedRect(m, y, logoSize, logoSize, 6).fill().restore();
  const logoBuf = brandImageBuffer(company.logoUrl, 'logo.png');
  if (logoBuf) {
    try {
      doc.image(logoBuf, m + 4, y + 4, { fit: [logoSize - 8, logoSize - 8], align: 'center', valign: 'center' });
    } catch {
      /* skip bad image */
    }
  }

  // Badge (right)
  const badgeW = 150;
  const badgeX = PAGE.width - m - badgeW;
  setFont(doc, { size: 8, color: C.muted });
  doc.text(String(badgeKind || '').toUpperCase(), badgeX, y + 2, { width: badgeW, align: 'right', characterSpacing: 1.4 });
  setFont(doc, { size: 18, bold: true, color: C.ink });
  doc.text(badgeTitle, badgeX, doc.y + 2, { width: badgeW, align: 'right' });

  // Company block (center-left)
  const coX = m + logoSize + 12;
  const coW = badgeX - coX - 14;
  let coY = y;
  coY = drawText(doc, esc(company.tradingName || company.legalName || 'Cres Dynamics Ltd'), {
    x: coX, y: coY, width: coW, size: 13, bold: true, color: C.accent,
  });
  if (company.tagline) {
    coY = drawText(doc, esc(company.tagline), { x: coX, y: coY + 1, width: coW, size: 7.5, color: C.muted });
  }
  const addrLines = [...(company.addressLines || [])];
  const contactBits = [];
  if (company.phone) contactBits.push(`Tel: ${esc(company.phone)}`);
  if (company.email) contactBits.push(`Email: ${esc(company.email)}`);
  coY = drawText(doc, [...addrLines, ...contactBits].filter(Boolean).join('\n'), {
    x: coX, y: coY + 2, width: coW, size: 7.5, color: C.muted, lineGap: 1,
  });
  drawText(
    doc,
    `${esc(company.taxLabel || 'KRA PIN')}: ${esc(company.taxId || '')}`,
    { x: coX, y: coY + 1, width: coW, size: 8, bold: true, color: C.ink }
  );

  const headerBottom = Math.max(doc.y, y + logoSize) + 8;
  hairline(doc, m, headerBottom, PAGE.width - m, C.accent, 2);
  return headerBottom + 10;
}

/**
 * Dual signature blocks (invoiced/recorded by + authorised by).
 */
function signaturesBlock(doc, y, left, right) {
  const m = PAGE.marginX;
  const colW = (USABLE - 24) / 2;
  const sigH = 26;

  const drawCol = (x, data) => {
    let cy = y;
    cy = drawText(doc, String(data.label || '').toUpperCase(), {
      x, y: cy, width: colW, size: 6.5, color: C.muted, lineGap: 0,
    });
    cy += 3;
    const sigBuf = brandImageBuffer(data.signatureUrl, data.fallbackFile);
    if (sigBuf) {
      try {
        doc.image(sigBuf, x, cy, { fit: [colW - 20, sigH], align: 'left', valign: 'bottom' });
      } catch {
        /* skip bad image */
      }
    }
    cy += sigH + 2;
    hairline(doc, x, cy, x + 150, C.ink, 0.8);
    cy += 5;
    cy = drawText(doc, esc(data.name || '-'), { x, y: cy, width: colW, size: 8, bold: true, lineGap: 0 });
    cy = drawText(doc, esc(data.title || ''), { x, y: cy, width: colW, size: 7.5, color: C.muted, lineGap: 0 });
    drawText(doc, `Date: ${esc(data.date || '-')}`, { x, y: cy, width: colW, size: 7.5, color: C.muted, lineGap: 0 });
  };

  drawCol(m, left);
  drawCol(m + colW + 24, right);
  return y + sigH + 46;
}

function pageFooter(doc, lines) {
  const m = PAGE.marginX;
  const y = PAGE.height - 62;
  hairline(doc, m, y, PAGE.width - m);
  let cy = y + 6;
  setFont(doc, { size: 7, color: C.muted });
  for (const line of lines.filter(Boolean)) {
    doc.text(line, m, cy, { width: USABLE, align: 'center', lineGap: 1 });
    cy = doc.y;
  }
}

/* --------------------------------------------------------- payment receipt */

async function paymentReceiptPdf(receipt) {
  const c = receipt.company || {};
  const bill = receipt.billTo || {};
  const meta = receipt.meta || {};
  const bal = receipt.balance || {};
  const auth = receipt.authorisedBy || {};
  const invoiced = receipt.invoicedBy || {};
  const outstandingRaw = Number(bal.outstandingRaw || 0);
  const isNil = !(outstandingRaw > 0.001);

  return renderPdf(
    (doc) => {
      let y = companyHeader(doc, c, { badgeKind: 'Official receipt', badgeTitle: 'PAYMENT' });

      // Titlebar
      const tbH = 22;
      box(doc, { x: PAGE.marginX, y, w: USABLE, h: tbH, radius: 2, stroke: C.line, fill: C.soft });
      setFont(doc, { size: 9.5, bold: true });
      doc.text(`Payment receipt — ${esc(receipt.documentNumber || '')}`, PAGE.marginX + 10, y + 7, { width: USABLE - 20 });
      y += tbH + 12;

      // Two boxes: received from / payment details
      const colW = (USABLE - 12) / 2;
      const boxH = 74;
      box(doc, { x: PAGE.marginX, y, w: colW, h: boxH });
      box(doc, { x: PAGE.marginX + colW + 12, y, w: colW, h: boxH });

      let bx = PAGE.marginX + 9;
      let by = y + 7;
      by = drawText(doc, 'RECEIVED FROM', { x: bx, y: by, width: colW - 18, size: 6.5, color: C.muted, lineGap: 0 });
      by += 4;
      by = drawText(doc, esc(bill.business || bill.name || '-'), { x: bx, y: by, width: colW - 18, size: 9.5, bold: true, lineGap: 1 });
      const sub = [bill.business && bill.name ? bill.name : '', bill.email || '', bill.phone || ''].filter(Boolean).join('\n');
      if (sub) drawText(doc, sub, { x: bx, y: by + 2, width: colW - 18, size: 8, color: C.muted, lineGap: 1 });

      bx = PAGE.marginX + colW + 21;
      by = y + 7;
      by = drawText(doc, 'PAYMENT DETAILS', { x: bx, y: by, width: colW - 18, size: 6.5, color: C.muted, lineGap: 0 });
      by += 4;
      const detailRows = [
        ['Amount received:', bal.paymentFormatted || meta.paymentAmount || '-'],
        ['Date:', meta.paidAt || '-'],
        ['Bank reference:', meta.bankReference || '-'],
        ['Invoice:', meta.invoiceNumber || meta.invoiceId || '-'],
        ['Project:', meta.project || '-'],
      ];
      for (const [label, value] of detailRows) {
        setFont(doc, { size: 7.8 });
        const labelW = 72;
        doc.text(label, bx, by, { width: labelW, lineGap: 0.5 });
        setFont(doc, { size: 7.8, bold: true });
        doc.text(String(value), bx + labelW, by, { width: colW - 18 - labelW, lineGap: 0.5 });
        by = Math.max(doc.y, by + 10.5);
      }

      y += boxH + 12;

      // Lines table
      const tableRows = [
        ['Payment amount received', bal.paymentFormatted || '-', true],
        ['Invoice total (this invoice)', bal.invoiceTotalFormatted || '-'],
        ['Total paid on this invoice', bal.invoicePaidFormatted || '-'],
        ['Invoice status', meta.status || '-'],
      ];
      if (bal.balanceInvoiceNumber) {
        tableRows.push([
          'New balance invoice issued',
          `${bal.balanceInvoiceNumber} — ${bal.balanceInvoiceAmountFormatted || ''}`,
        ]);
      }
      tableRows.push(['Recorded by', meta.recordedBy || '-']);

      const labelW = 200;
      for (const [label, value, boldVal] of tableRows) {
        drawText(doc, label, { x: PAGE.marginX, y, width: labelW, size: 8.5, color: C.muted, lineGap: 0 });
        setFont(doc, { size: 8.8, bold: !!boldVal });
        doc.text(String(value), PAGE.marginX + labelW + 8, y, { width: USABLE - labelW - 8, lineGap: 0 });
        y = Math.max(doc.y, y + 11) + 4;
        hairline(doc, PAGE.marginX, y, PAGE.width - PAGE.marginX);
        y += 7;
      }
      y += 6;

      // Outstanding balance callout
      const calloutH = 52;
      box(doc, {
        x: PAGE.marginX,
        y,
        w: USABLE,
        h: calloutH,
        radius: 5,
        stroke: isNil ? C.ok : C.accent,
        fill: isNil ? C.okBg : C.soft,
        lineWidth: 1.6,
      });
      drawText(doc, 'OUTSTANDING BALANCE AFTER THIS PAYMENT', {
        x: PAGE.marginX + 14, y: y + 8, width: USABLE - 28, size: 7, color: C.muted, lineGap: 0,
      });
      setFont(doc, { size: 15, bold: true, color: isNil ? C.ok : C.accent });
      doc.text(isNil ? 'NIL — Paid in full' : esc(bal.outstandingFormatted || '-'), PAGE.marginX + 14, y + 22, {
        width: USABLE - 28,
      });
      y += calloutH + 12;

      // Note
      const note = isNil
        ? 'Thank you. This invoice is fully settled — outstanding balance is NIL.'
        : 'A balance remains outstanding. Please settle using the balance invoice / payment instructions from Cres Dynamics Finance.';
      const fullNote = c.paymentNote ? `${note}\n${esc(c.paymentNote)}` : note;
      y = drawText(doc, fullNote, { x: PAGE.marginX, y, width: USABLE, size: 8, color: C.muted, lineGap: 1.5 });
      y += 10;

      // Signatures
      y = signaturesBlock(
        doc,
        y,
        {
          label: 'Invoiced / recorded by',
          signatureUrl: invoiced.signatureUrl || c.financeSignatureUrl,
          fallbackFile: 'signature-scholastica.png',
          name: invoiced.name || 'Scholastica Omoro',
          title: invoiced.title || 'Finance, Cres Dynamics Ltd',
          date: invoiced.date || meta.paidDay,
        },
        {
          label: 'Authorised by',
          signatureUrl: auth.signatureUrl || c.signatureUrl,
          fallbackFile: 'signature.png',
          name: auth.name || 'Nelson Were',
          title: auth.title || 'Chief Executive Officer, Cres Dynamics Ltd',
          date: auth.date || meta.paidDay,
        }
      );

      pageFooter(doc, [
        esc(c.footer || 'Thank you for your payment. Cres Dynamics Ltd — cresdynamics.com'),
        `${esc(c.legalName || 'Cres Dynamics Ltd')} | ${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}`,
      ]);
    },
    { title: `Payment receipt ${receipt.documentNumber || ''}` }
  );
}

/* ------------------------------------------------------------ tax invoice */

async function invoicePdf(receipt) {
  const c = receipt.company || {};
  const bill = receipt.billTo || {};
  const meta = receipt.meta || {};
  const pay = receipt.paymentInstructions || {};
  const auth = receipt.authorisedBy || {};
  const invoiced = receipt.invoicedBy || {};
  const items = receipt.items || [];
  const totals = receipt.totals || {};

  return renderPdf(
    (doc) => {
      let y = companyHeader(doc, c, { badgeKind: 'Tax invoice', badgeTitle: 'INVOICE' });

      // Titlebar
      const tbH = 21;
      box(doc, { x: PAGE.marginX, y, w: USABLE, h: tbH, radius: 2, stroke: C.line, fill: C.soft });
      setFont(doc, { size: 9, bold: true });
      doc.text(`${esc(c.legalName || 'Cres Dynamics Ltd')} — TAX INVOICE`, PAGE.marginX + 10, y + 6.5, {
        width: USABLE - 20,
        characterSpacing: 0.5,
      });
      y += tbH + 10;

      const colW = (USABLE - 12) / 2;
      const drawInfoBox = (x, label, rows) => {
        const h = 66;
        box(doc, { x, y, w: colW, h });
        let by = y + 7;
        const bx = x + 9;
        by = drawText(doc, label.toUpperCase(), { x: bx, y: by, width: colW - 18, size: 6.5, color: C.muted, lineGap: 0 });
        by += 4;
        for (const row of rows) {
          if (!row) continue;
          if (typeof row === 'string') {
            by = drawText(doc, row, { x: bx, y: by, width: colW - 18, size: 8, color: C.muted, lineGap: 1 });
          } else {
            setFont(doc, { size: 8 });
            doc.text(row[0], bx, by, { width: colW - 18, lineGap: 0.5 });
            setFont(doc, { size: 8, bold: true });
            doc.text(row[1], bx, by, { width: colW - 18, lineBreak: false });
            by = Math.max(doc.y, by + 11);
          }
        }
      };

      const addrText = (c.addressLines || []).join(', ');
      drawInfoBox(PAGE.marginX, 'From', [
        ['', esc(c.legalName || 'Cres Dynamics Ltd')],
        addrText,
        [`${esc(c.taxLabel || 'KRA PIN')}: `, esc(c.taxId || '')],
      ]);
      drawInfoBox(PAGE.marginX + colW + 12, 'To', [
        ['', esc(bill.business || bill.name || 'Client')],
        bill.business && bill.name ? bill.name : '',
        bill.email || '',
        bill.phone || '',
      ]);
      y += 66 + 10;

      drawInfoBox(PAGE.marginX, 'Invoice details', [
        ['Invoice Number: ', esc(receipt.documentNumber || '')],
        ['Invoice Date: ', esc(meta.issuedAt || '-')],
        ['Payment Due Date: ', esc(meta.dueDate || '-')],
        ['Project Reference: ', esc(meta.projectReference || meta.project || '-')],
        ['Status: ', esc(String(meta.status || '-').replace(/_/g, ' '))],
      ]);
      drawInfoBox(PAGE.marginX + colW + 12, 'Totals (KES)', [
        ['Amount: ', esc(totals.amount || '-')],
        ['Paid: ', esc(totals.amountPaid || '-')],
        ['TOTAL DUE: ', esc(totals.balanceDue || totals.amount || '-')],
      ]);
      y += 66 + 12;

      // Items table
      const colNo = 26;
      const colQty = 40;
      const colUnit = 78;
      const colAmt = 88;
      const colDesc = USABLE - colNo - colQty - colUnit - colAmt;

      const headH = 18;
      doc.save().rect(PAGE.marginX, y, USABLE, headH).fill(C.accent).restore();
      setFont(doc, { size: 7.5, bold: true, color: C.white });
      const headY = y + 5.5;
      doc.text('#', PAGE.marginX + 6, headY, { width: colNo - 12, align: 'center' });
      doc.text('DESCRIPTION', PAGE.marginX + colNo, headY, { width: colDesc });
      doc.text('QTY', PAGE.marginX + colNo + colDesc, headY, { width: colQty, align: 'center' });
      doc.text('UNIT (KES)', PAGE.marginX + colNo + colDesc + colQty, headY, { width: colUnit, align: 'right' });
      doc.text('AMOUNT (KES)', PAGE.marginX + colNo + colDesc + colQty + colUnit, headY, {
        width: colAmt,
        align: 'right',
      });
      y += headH;

      const itemRows = items.length
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
          ];

      let rowY = y;
      let alt = false;
      for (const it of itemRows) {
        setFont(doc, { size: 8.3 });
        const descLines = doc.heightOfString(it.description || '-', { width: colDesc - 10 });
        const detailLines = it.detail ? doc.heightOfString(it.detail, { width: colDesc - 10 }) : 0;
        const rowH = Math.max(descLines + detailLines + 9, 18);

        if (alt) {
          doc.save().rect(PAGE.marginX, rowY, USABLE, rowH).fill(C.soft).restore();
        }
        alt = !alt;

        setFont(doc, { size: 8.3, color: C.ink });
        doc.text(String(it.no ?? ''), PAGE.marginX + 6, rowY + 5, { width: colNo - 12, align: 'center' });
        setFont(doc, { size: 8.3, bold: true });
        doc.text(esc(it.description || '-'), PAGE.marginX + colNo, rowY + 5, { width: colDesc - 10 });
        let descBottom = doc.y;
        if (it.detail) {
          descBottom = drawText(doc, esc(it.detail), {
            x: PAGE.marginX + colNo,
            y: descBottom + 1,
            width: colDesc - 10,
            size: 7.3,
            color: C.muted,
            lineGap: 0.5,
          });
        }
        setFont(doc, { size: 8.3 });
        doc.text(String(it.qty != null ? it.qty : 1), PAGE.marginX + colNo + colDesc, rowY + 5, {
          width: colQty,
          align: 'center',
        });
        doc.text(esc(it.unitPriceFormatted || it.amountFormatted || '-'), PAGE.marginX + colNo + colDesc + colQty, rowY + 5, {
          width: colUnit,
          align: 'right',
        });
        setFont(doc, { size: 8.3, bold: true });
        doc.text(esc(it.amountFormatted || '-'), PAGE.marginX + colNo + colDesc + colQty + colUnit, rowY + 5, {
          width: colAmt,
          align: 'right',
        });
        rowY = Math.max(descBottom + 4, rowY + rowH);
        hairline(doc, PAGE.marginX, rowY, PAGE.width - PAGE.marginX);
      }
      y = rowY + 10;

      // Totals card (right aligned)
      const cardW = 210;
      const cardX = PAGE.width - PAGE.marginX - cardW;
      const cardRows = [
        ['Subtotal (no VAT)', totals.amount || '-'],
        ['Amount paid', totals.amountPaid || '-'],
      ];
      const cardH = 16 + cardRows.length * 13 + 26;
      box(doc, { x: cardX, y, w: cardW, h: cardH, radius: 3, stroke: C.line, fill: C.soft });
      let cy = y + 8;
      for (const [label, value] of cardRows) {
        setFont(doc, { size: 8 });
        doc.text(label, cardX + 10, cy, { width: cardW - 90, lineGap: 0 });
        setFont(doc, { size: 8, bold: true });
        doc.text(String(value), cardX + cardW - 100, cy, { width: 90, align: 'right', lineGap: 0 });
        cy += 13;
      }
      hairline(doc, cardX + 10, cy + 1, cardX + cardW - 10);
      cy += 6;
      setFont(doc, { size: 10.5, bold: true, color: C.accent });
      doc.text('TOTAL DUE', cardX + 10, cy, { width: cardW - 110, lineGap: 0 });
      doc.text(String(totals.balanceDue || '-'), cardX + cardW - 110, cy - 1, { width: 100, align: 'right', lineGap: 0 });
      y += cardH + 12;

      // Payment instructions
      const bullets = [];
      if (pay.mpesaPaybill) {
        bullets.push(`M-Pesa: Paybill ${esc(pay.mpesaPaybill)} | Account: ${esc(pay.mpesaAccount || '')}`);
      }
      bullets.push(
        `Bank Transfer: ${esc(pay.bankName || c.bankName || '')} | Account Name: ${esc(
          pay.bankAccountName || c.bankAccountName || ''
        )} | Account No: ${esc(pay.bankAccountNumber || c.bankAccountNumber || '')}${
          pay.bankBranch || c.bankBranch ? ` | Branch: ${esc(pay.bankBranch || c.bankBranch)}` : ''
        }`
      );

      setFont(doc, { size: 8 });
      const bulletHeights = bullets.map((b) => doc.heightOfString(`•  ${b}`, { width: USABLE - 30 }));
      const payH =
        14 + 12 + bulletHeights.reduce((a, b) => a + b + 3, 0) + 20;
      box(doc, { x: PAGE.marginX, y, w: USABLE, h: payH, radius: 3, stroke: C.line });
      let py = y + 8;
      py = drawText(doc, 'Payment instructions', { x: PAGE.marginX + 10, y: py, width: USABLE - 20, size: 8.5, bold: true, lineGap: 0 });
      py = drawText(doc, `Pay within ${esc(pay.payWithinDays || 5)} days of invoice date.`, {
        x: PAGE.marginX + 10, y: py + 2, width: USABLE - 20, size: 8, lineGap: 0,
      });
      py += 4;
      bullets.forEach((b, i) => {
        drawText(doc, `•  ${b}`, { x: PAGE.marginX + 14, y: py, width: USABLE - 30, size: 8, color: C.ink, lineGap: 0.5 });
        py += bulletHeights[i] + 3;
      });
      setFont(doc, { size: 8 });
      doc.text('Please use Invoice Number ', PAGE.marginX + 10, py + 3, { width: USABLE - 20, continued: true, lineGap: 0 });
      doc.font('Helvetica-Bold').text(String(pay.reference || receipt.documentNumber || ''), { lineGap: 0, continued: true });
      doc.font('Helvetica').text(' as your payment reference.', { lineGap: 0 });
      y += payH + 10;

      if (c.lateFeeNote) {
        y = drawText(doc, esc(c.lateFeeNote), { x: PAGE.marginX, y, width: USABLE, size: 7.5, color: C.muted, lineGap: 1 });
        y += 6;
      }

      // Signatures
      y = signaturesBlock(
        doc,
        y + 4,
        {
          label: 'Invoiced by',
          signatureUrl: invoiced.signatureUrl || c.financeSignatureUrl,
          fallbackFile: 'signature-scholastica.png',
          name: invoiced.name || 'Scholastica Omoro',
          title: invoiced.title || 'Finance, Cres Dynamics Ltd',
          date: invoiced.date || meta.issuedAt,
        },
        {
          label: 'Authorised by',
          signatureUrl: auth.signatureUrl || c.signatureUrl,
          fallbackFile: 'signature.png',
          name: auth.name || 'Nelson Were',
          title: auth.title || 'Chief Executive Officer, Cres Dynamics Ltd',
          date: auth.date || meta.issuedAt,
        }
      );

      pageFooter(doc, [
        esc(c.footer || 'Thank you for your business. Cres Dynamics Ltd — cresdynamics.com'),
        `${esc(c.legalName || 'Cres Dynamics Ltd')} | ${esc(c.tagline || '')}`,
        `${(c.addressLines || []).join(' · ')}${c.email ? ` | ${c.email}` : ''}${c.website ? ` | ${c.website}` : ''} | ${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}`,
      ]);
    },
    { title: `Invoice ${receipt.documentNumber || ''}` }
  );
}

/* -------------------------------------------------------- expense receipt */

async function expenseReceiptPdf(receipt) {
  const c = receipt.company || {};
  const lines = receipt.lines || [];

  return renderPdf(
    (doc) => {
      let y = companyHeader(doc, c, { badgeKind: 'Internal document', badgeTitle: 'EXPENSE' });

      const tbH = 21;
      box(doc, { x: PAGE.marginX, y, w: USABLE, h: tbH, radius: 2, stroke: C.line, fill: C.soft });
      setFont(doc, { size: 9.5, bold: true });
      doc.text(`${esc(receipt.title || 'Expense receipt')} — ${esc(receipt.documentNumber || '')}`, PAGE.marginX + 10, y + 6.5, {
        width: USABLE - 20,
      });
      y += tbH + 14;

      const labelW = 170;
      for (const [label, value] of lines) {
        drawText(doc, esc(label), { x: PAGE.marginX, y, width: labelW, size: 8.5, color: C.muted, lineGap: 0 });
        setFont(doc, { size: 8.8 });
        doc.text(esc(value), PAGE.marginX + labelW + 8, y, { width: USABLE - labelW - 8, lineGap: 0 });
        y = Math.max(doc.y, y + 11) + 4;
        hairline(doc, PAGE.marginX, y, PAGE.width - PAGE.marginX);
        y += 7;
      }

      pageFooter(doc, [
        esc(c.footer || 'Cres Dynamics Ltd'),
        `${esc(c.legalName || 'Cres Dynamics Ltd')} | ${esc(c.taxLabel || 'KRA PIN')}: ${esc(c.taxId || '')}`,
      ]);
    },
    { title: `Expense receipt ${receipt.documentNumber || ''}` }
  );
}

module.exports = { paymentReceiptPdf, invoicePdf, expenseReceiptPdf };
