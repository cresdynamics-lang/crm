/** Invoice / receipt helper — forced file download + email (never opens print dialog) */
const CresReceipts = (() => {
  function filePathFromReceiptPath(receiptPath) {
    const base = String(receiptPath || '').replace(/\/$/, '');
    if (base.endsWith('/file')) return base;
    return `${base}/file`;
  }

  function guessFilename(receiptPath) {
    if (String(receiptPath).includes('/payments/')) return 'payment-receipt.pdf';
    if (String(receiptPath).includes('/expenses/')) return 'expense-receipt.pdf';
    return 'invoice.pdf';
  }

  /** Download via authenticated attachment endpoint — saves to disk, does not open/print. */
  async function downloadFile(receiptPath) {
    const filePath = filePathFromReceiptPath(receiptPath);
    await CresAPI.download(filePath, guessFilename(receiptPath));
  }

  async function send(path, to) {
    const body = to ? { to } : {};
    return CresAPI.request(path, {
      method: 'POST',
      body,
      idempotencyKey: `receipt-${path}-${Date.now()}`,
    });
  }

  /** Download the document; optionally email to client in the same action. */
  async function deliver(receiptPath, { to, sendPath } = {}) {
    await downloadFile(receiptPath);
    let emailed = null;
    const sendTo = (to || '').trim();
    if (sendPath && sendTo) {
      emailed = await send(sendPath, sendTo);
    }
    return { emailed, to: sendTo || null };
  }

  /** Always downloads (never print). */
  async function fetchAndPrint(path) {
    await downloadFile(path);
    return null;
  }

  return { deliver, downloadFile, fetchAndPrint, send };
})();
