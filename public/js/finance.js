/**
 * Step 6 - Finance module faces
 */
const CresFinance = (() => {
  let cashChart;
  let revenueChart;
  let expenseChart;
  let notifUnsub = null;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString();
  }

  function fmtMoney(n) {
    const num = Number(n);
    if (Number.isNaN(num)) return '-';
    return num.toLocaleString('en-KE', { style: 'currency', currency: 'KES' });
  }

  function statusPill(s) {
    return `<span class="status-pill ${esc(s || '')}">${esc((s || '').replace(/_/g, ' '))}</span>`;
  }

  function flash(el, msg, ok = true) {
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  async function mountHome() {
    const host = document.getElementById('finance-dashboard');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/finance/dashboard');
      const d = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Account balance</div><div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.accountBalance)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Revenue (payments)</div><div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.revenue)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Expenses (approved)</div><div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.expenses)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Net cash</div><div class="kpi-value" style="font-size:1.45rem;">${fmtMoney(d.kpis.netCash)}</div></div>
        </div>
        <div class="toolbar" style="margin-bottom:16px;">
          <div class="kpi-card" style="flex:1;"><div class="kpi-label">Outstanding invoices</div><div class="kpi-value" style="font-size:1.2rem;">${fmtMoney(d.kpis.outstanding)}</div></div>
          <div class="kpi-card" style="flex:1;"><div class="kpi-label">Issued / Overdue</div><div class="kpi-value" style="font-size:1.2rem;">${d.kpis.issuedCount} / ${d.kpis.overdueCount}</div></div>
          <a href="#/approvals" class="kpi-card" style="flex:1;text-decoration:none;color:inherit;">
            <div class="kpi-label">Awaiting your approval</div>
            <div class="kpi-value" style="font-size:1.2rem;">${d.kpis.pendingApprovals || 0}</div>
            <div class="meta" style="margin-top:4px;">Expenses ${d.kpis.pendingExpenses || 0} · Salary funding ${d.kpis.pendingSalaryFunding || 0}</div>
          </a>
        </div>
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:14px;margin-bottom:16px;">
          <div class="chart-panel">
            <h3>Cash flow (in vs out)</h3>
            <div class="chart-wrap"><canvas id="fin-cash-chart"></canvas></div>
          </div>
          <div class="chart-panel">
            <h3>Expense breakdown (approved)</h3>
            <div class="chart-wrap"><canvas id="fin-expense-chart"></canvas></div>
          </div>
        </div>
        <div class="chart-panel" style="margin-bottom:16px;max-width:none;">
          <h3>Revenue by project</h3>
          <div class="chart-wrap"><canvas id="fin-revenue-chart"></canvas></div>
        </div>
        <div class="settings-section" style="max-width:720px;">
          <h3>System notification feed</h3>
          <p style="margin:0 0 10px;color:var(--text-muted);font-size:0.85rem;">
            Finance has no Community chat. Live event updates appear here.
          </p>
          <ul class="engagement-list" id="fin-notif-feed"></ul>
        </div>`;

      renderNotifFeed(d.notifications || []);

      if (cashChart) cashChart.destroy();
      cashChart = new Chart(document.getElementById('fin-cash-chart'), {
        type: 'bar',
        data: {
          labels: d.cashFlowChart.labels,
          datasets: [
            { label: 'Money in', data: d.cashFlowChart.moneyIn, backgroundColor: 'rgba(31,167,160,0.65)', borderRadius: 6 },
            { label: 'Money out', data: d.cashFlowChart.moneyOut, backgroundColor: 'rgba(224,90,90,0.55)', borderRadius: 6 },
          ],
        },
        options: chartOpts(),
      });

      if (expenseChart) expenseChart.destroy();
      expenseChart = new Chart(document.getElementById('fin-expense-chart'), {
        type: 'doughnut',
        data: {
          labels: d.expenseBreakdown.labels.length ? d.expenseBreakdown.labels : ['None'],
          datasets: [{
            data: d.expenseBreakdown.values.length ? d.expenseBreakdown.values : [1],
            backgroundColor: ['#1fa7a0', '#5a96dc', '#d4a017', '#e05a5a'],
          }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#8b9aab' } } } },
      });

      if (revenueChart) revenueChart.destroy();
      revenueChart = new Chart(document.getElementById('fin-revenue-chart'), {
        type: 'bar',
        data: {
          labels: d.revenueByProject.labels.length ? d.revenueByProject.labels : ['None'],
          datasets: [{
            label: 'Invoice totals',
            data: d.revenueByProject.values.length ? d.revenueByProject.values : [0],
            backgroundColor: 'rgba(90,150,220,0.6)',
            borderRadius: 6,
          }],
        },
        options: chartOpts(false),
      });

      if (notifUnsub) notifUnsub();
      notifUnsub = CresRealtime.on('notification', (n) => {
        if (n?.__poll) return;
        if (n?.id) {
          const feed = document.getElementById('fin-notif-feed');
          if (!feed) return;
          const li = document.createElement('li');
          li.innerHTML = `<div class="meta">${esc(n.type)} · just now</div><div>${esc(n.content)}</div>`;
          feed.prepend(li);
        }
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  function chartOpts(legend = true) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: legend, labels: { color: '#8b9aab' } } },
      scales: {
        x: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(42,52,65,0.5)' } },
        y: { beginAtZero: true, ticks: { color: '#8b9aab' }, grid: { color: 'rgba(42,52,65,0.5)' } },
      },
    };
  }

  function renderNotifFeed(items) {
    const feed = document.getElementById('fin-notif-feed');
    if (!feed) return;
    feed.innerHTML = items.length
      ? items
          .map(
            (n) => `<li class="${n.read_at ? '' : 'unread'}">
              <div class="meta">${esc(n.type)} · ${fmtDate(n.created_at)}</div>
              <div>${esc(n.content)}</div>
            </li>`
          )
          .join('')
      : `<li class="empty-state">No system events yet. Approvals, payments, and payroll settlements show up here.</li>`;
  }

  function invoiceBalance(i) {
    return Math.max(0, Number(i.amount || 0) - Number(i.amount_paid || 0));
  }

  async function mountInvoices() {
    const params = new URLSearchParams();
    const q = document.getElementById('fin-inv-search')?.value;
    const status = document.getElementById('fin-inv-status')?.value;
    const from = document.getElementById('fin-inv-from')?.value;
    const to = document.getElementById('fin-inv-to')?.value;
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const res = await CresAPI.request(`/api/invoices?${params}`);
    const tbody = document.getElementById('finance-invoices-tbody');
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No invoices match.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.data
      .map(
        (i) => `<tr data-id="${i.id}">
          <td>${esc(i.invoice_number || i.id.slice(0, 8))}</td>
          <td>${esc(i.client_name || i.client_business || '-')}</td>
          <td>${esc(i.project_name || '-')}</td>
          <td>${fmtMoney(i.amount)}</td>
          <td>${fmtMoney(i.amount_paid || 0)}</td>
          <td>${fmtMoney(invoiceBalance(i))}</td>
          <td>${i.due_date ? new Date(i.due_date).toLocaleDateString() : '-'}</td>
          <td>${statusPill(i.status)}</td>
        </tr>`
      )
      .join('');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openInvoice(tr.dataset.id));
    });
  }

  async function openInvoice(id) {
    const res = await CresAPI.request(`/api/invoices/${id}`);
    const { invoice: i, payments, emailLog, deadLetters, followups } = res.data;
    const balance = invoiceBalance(i);
    document.getElementById('fin-inv-title').textContent = `Invoice ${
      i.invoice_number || i.id.slice(0, 8)
    }`;
    document.getElementById('fin-inv-body').innerHTML = `
      ${
        i.status === 'overdue'
          ? `<div class="flash visible err" style="margin-bottom:14px;">
              This invoice is overdue (balance ${fmtMoney(balance)}).
              <a href="#/flag" style="color:inherit;margin-left:8px;text-decoration:underline;">Flag for sales follow-up →</a>
            </div>`
          : ''
      }
      <div class="form-grid" style="margin-bottom:14px;">
        <div><strong>Number</strong><div>${esc(i.invoice_number || '-')}</div></div>
        <div><strong>Client</strong><div>${esc(i.client_name || '-')} ${i.client_email ? `&lt;${esc(i.client_email)}&gt;` : ''}</div></div>
        <div><strong>Project</strong><div>${esc(i.project_name || '-')}</div></div>
        <div><strong>Amount</strong><div>${fmtMoney(i.amount)}</div></div>
        <div><strong>Paid</strong><div>${fmtMoney(i.amount_paid || 0)}</div></div>
        <div><strong>Balance</strong><div>${fmtMoney(balance)}</div></div>
        <div><strong>Issue date</strong><div>${i.issue_date ? new Date(i.issue_date).toLocaleDateString() : fmtDate(i.created_at)}</div></div>
        <div><strong>Due date</strong><div>${i.due_date ? new Date(i.due_date).toLocaleDateString() : '-'}</div></div>
        <div><strong>Status</strong><div>${statusPill(i.status)}</div></div>
        <div><strong>Auto-sent</strong><div>${i.auto_sent_at ? fmtDate(i.auto_sent_at) : 'Never'}</div></div>
      </div>
      <div id="fin-inv-flash" class="flash"></div>
      <div class="form-actions" style="margin-bottom:16px;">
        <button type="button" class="btn btn-primary" id="btn-download-invoice-receipt">Download invoice</button>
        ${
          ['overdue', 'issued', 'partially_paid'].includes(i.status)
            ? `<a href="#/flag" class="btn btn-ghost">Flag follow-up</a>`
            : ''
        }
      </div>
      <p class="meta" style="margin:0 0 14px;">Email is sent automatically when the invoice is created or when payments change project balances.</p>
      <h4 style="margin:0 0 8px;font-size:0.9rem;">Send history</h4>
      <ul class="engagement-list" id="fin-email-log"></ul>
      ${
        deadLetters?.length
          ? `<h4 style="margin:16px 0 8px;font-size:0.9rem;color:#ffb4b4;">Dead-letter / failed sends</h4>
             <ul class="engagement-list">${deadLetters
               .map(
                 (f) => `<li><div class="meta">${fmtDate(f.created_at)} · attempts ${f.attempts}</div><div>${esc(f.error || '')}</div></li>`
               )
               .join('')}</ul>`
          : ''
      }
      <h4 style="margin:16px 0 8px;font-size:0.9rem;">Payments</h4>
      <ul class="engagement-list">${
        payments.length
          ? payments
              .map(
                (p) => `<li>
                  <div class="meta">${esc(p.recorded_by_name)} · ${fmtDate(p.paid_at)}</div>
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <span>${fmtMoney(p.amount)}</span>
                    <button type="button" class="btn btn-ghost btn-sm" data-download-pay="${esc(p.id)}" style="padding:4px 8px;font-size:0.75rem;">Download</button>
                  </div>
                </li>`
              )
              .join('')
          : '<li class="empty-state">No payments recorded.</li>'
      }</ul>
      <h4 style="margin:16px 0 8px;font-size:0.9rem;">Sales follow-ups</h4>
      <ul class="engagement-list">${
        followups.length
          ? followups
              .map(
                (f) => `<li><div class="meta">${esc(f.sales_name)} · ${statusPill(f.status)}</div><div>${esc(f.note || '')}</div></li>`
              )
              .join('')
          : '<li class="empty-state">Not flagged to sales.</li>'
      }</ul>`;

    const log = document.getElementById('fin-email-log');
    log.innerHTML = emailLog.length
      ? emailLog
          .map(
            (e) => `<li><div class="meta">${esc(e.channel)} · ${statusPill(e.status)} · ${fmtDate(e.created_at)}</div><div>${esc(e.detail || '')}</div></li>`
          )
          .join('')
      : `<li class="empty-state">No send attempts logged.</li>`;

    document.getElementById('finance-invoice-modal').classList.add('open');
    document.getElementById('btn-download-invoice-receipt').onclick = () =>
      CresReceipts.downloadFile(`/api/invoices/${id}/receipt`).catch((err) =>
        flash(document.getElementById('fin-inv-flash'), err.message, false)
      );
    document.querySelectorAll('[data-download-pay]').forEach((btn) => {
      btn.onclick = () =>
        CresReceipts.downloadFile(`/api/payments/${btn.dataset.downloadPay}/receipt`).catch((err) =>
          flash(document.getElementById('fin-inv-flash'), err.message, false)
        );
    });
  }

  let payInvoiceCache = {};

  async function refreshPayClientCard(invoiceId) {
    const card = document.getElementById('pay-client-card');
    const summary = document.getElementById('pay-client-summary');
    const addBtn = document.getElementById('btn-add-client-manual');
    const manual = document.getElementById('pay-client-manual');
    const hint = document.getElementById('pay-debt-hint');
    if (!card || !invoiceId) {
      if (card) card.hidden = true;
      return;
    }
    card.hidden = false;
    if (manual) manual.hidden = true;
    try {
      const res = await CresAPI.request(`/api/invoices/${invoiceId}`);
      const i = res.data?.invoice || res.data;
      payInvoiceCache[invoiceId] = i;
      const bal = invoiceBalance(i);
      if (hint) {
        hint.textContent = `Outstanding debt on this invoice: ${fmtMoney(bal)}. Pay in full or less — a partial payment issues a new balance invoice.`;
      }
      const amountEl = document.getElementById('pay-amount');
      if (amountEl && !amountEl.value) amountEl.value = bal;
      amountEl?.setAttribute('max', String(bal));

      const hasClient = !!i.client_id;
      const hasEmail = !!(i.client_email || '').trim();
      if (summary) {
        if (!hasClient) {
          summary.innerHTML = `<span class="status-pill overdue">No client linked</span>
            <div class="meta" style="margin-top:6px;">Add client details before recording this payment.</div>`;
          if (addBtn) addBtn.hidden = false;
        } else if (!hasEmail) {
          summary.innerHTML = `<strong>${esc(i.client_name || i.client_business || 'Client')}</strong>
            <div class="meta">In CRM — missing email (required for receipts / balance invoice).</div>`;
          if (addBtn) addBtn.hidden = false;
        } else {
          summary.innerHTML = `<strong>${esc(i.client_business || i.client_name || 'Client')}</strong>
            <div class="meta">${esc(i.client_name || '')} · ${esc(i.client_email)} ${i.client_phone ? `· ${esc(i.client_phone)}` : ''}</div>
            <div style="margin-top:6px;"><span class="status-pill paid">Client found in CRM</span></div>`;
          if (addBtn) addBtn.hidden = true;
        }
      }
    } catch (err) {
      if (summary) summary.textContent = err.message;
    }
  }

  async function mountPayments() {
    const [issued, partial, overdue, payments] = await Promise.all([
      CresAPI.request('/api/invoices?status=issued'),
      CresAPI.request('/api/invoices?status=partially_paid').catch(() => ({ data: [] })),
      CresAPI.request('/api/invoices?status=overdue').catch(() => ({ data: [] })),
      CresAPI.request('/api/payments'),
    ]);
    const byId = new Map();
    [...issued.data, ...(partial.data || []), ...(overdue.data || [])].forEach((i) => byId.set(i.id, i));
    const openInvoices = [...byId.values()];

    const select = document.getElementById('pay-invoice');
    select.innerHTML =
      `<option value="">Select invoice</option>` +
      openInvoices
        .map((i) => {
          const bal = invoiceBalance(i);
          return `<option value="${i.id}" data-balance="${bal}">${esc(i.client_name || 'No client')} — balance ${fmtMoney(bal)} of ${fmtMoney(i.amount)} (${esc(i.status)})</option>`;
        })
        .join('');

    select.onchange = () => {
      const opt = select.selectedOptions[0];
      const bal = opt?.dataset.balance;
      if (bal) document.getElementById('pay-amount').value = bal;
      refreshPayClientCard(select.value).catch(console.error);
      updateBankCard();
    };

    document.getElementById('pay-bank-ref')?.addEventListener('input', updateBankCard);
    document.getElementById('pay-amount')?.addEventListener('input', updateBankCard);

    document.getElementById('btn-check-client')?.addEventListener('click', async () => {
      const id = select.value;
      if (!id) return flash(document.getElementById('payments-flash'), 'Select an invoice first', false);
      await refreshPayClientCard(id);
      const i = payInvoiceCache[id];
      if (i?.client_id && i?.client_email) {
        flash(document.getElementById('payments-flash'), 'Client is already in the CRM with an email');
      } else {
        flash(document.getElementById('payments-flash'), 'Client missing — add details manually', false);
        const addBtn = document.getElementById('btn-add-client-manual');
        if (addBtn) addBtn.hidden = false;
        document.getElementById('pay-client-manual').hidden = false;
      }
    });

    document.getElementById('btn-add-client-manual')?.addEventListener('click', () => {
      document.getElementById('pay-client-manual').hidden = false;
    });

    document.getElementById('btn-save-pay-client')?.addEventListener('click', async () => {
      const id = select.value;
      if (!id) return;
      const name = document.getElementById('pay-new-client-name').value.trim();
      const email = document.getElementById('pay-new-client-email').value.trim();
      if (!name || !email) {
        flash(document.getElementById('payments-flash'), 'Name and email required', false);
        return;
      }
      try {
        await CresAPI.request(`/api/invoices/${id}/client`, {
          method: 'PATCH',
          body: {
            client: {
              name,
              email,
              business_name: document.getElementById('pay-new-client-business').value.trim() || undefined,
              phone: document.getElementById('pay-new-client-phone').value.trim() || undefined,
            },
          },
          idempotencyKey: `inv-client-${id}-${Date.now()}`,
        });
        flash(document.getElementById('payments-flash'), 'Client saved on invoice');
        document.getElementById('pay-client-manual').hidden = true;
        await refreshPayClientCard(id);
      } catch (err) {
        flash(document.getElementById('payments-flash'), err.message, false);
      }
    });

    if (select.value) await refreshPayClientCard(select.value);

    const tbody = document.getElementById('payments-tbody');
    tbody.innerHTML = payments.data.length
      ? payments.data
          .slice(0, 50)
          .map(
            (p) => `<tr>
              <td>${esc(p.client_name || String(p.invoice_id).slice(0, 8))}</td>
              <td>${fmtMoney(p.amount)}</td>
              <td>${esc(p.bank_reference || '-')}</td>
              <td>${fmtDate(p.paid_at)}</td>
              <td>
                <button type="button" class="btn btn-ghost btn-sm" data-download-pay="${esc(p.id)}" style="padding:4px 8px;font-size:0.75rem;">Download</button>
              </td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="empty-state">No payments yet.</td></tr>`;

    tbody.querySelectorAll('[data-download-pay]').forEach((btn) => {
      btn.addEventListener('click', () =>
        CresReceipts.downloadFile(`/api/payments/${btn.dataset.downloadPay}/receipt`).catch((err) =>
          flash(document.getElementById('payments-flash'), err.message, false)
        )
      );
    });
  }

  function updateBankCard() {
    const card = document.getElementById('pay-bank-card');
    const body = document.getElementById('pay-bank-card-body');
    const ref = document.getElementById('pay-bank-ref')?.value?.trim();
    const amount = Number(document.getElementById('pay-amount')?.value || 0);
    if (!card || !body) return;
    if (!ref && !amount) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    body.innerHTML = `${esc(ref || '(no reference yet)')}<div class="meta" style="margin-top:4px;font-weight:400;">Amount ${fmtMoney(amount || 0)}</div>`;
  }

  async function submitPayment(e) {
    e.preventDefault();
    const invoice_id = document.getElementById('pay-invoice').value;
    const amount = Number(document.getElementById('pay-amount').value);
    const paid_at = document.getElementById('pay-date').value || undefined;
    const bank_reference = document.getElementById('pay-bank-ref').value.trim();
    if (!bank_reference) {
      flash(document.getElementById('payments-flash'), 'Bank reference is required', false);
      return;
    }

    const inv = payInvoiceCache[invoice_id];
    if (!inv?.client_id || !inv?.client_email) {
      flash(
        document.getElementById('payments-flash'),
        'Check / add client details before recording the payment',
        false
      );
      document.getElementById('pay-client-manual').hidden = false;
      document.getElementById('btn-add-client-manual').hidden = false;
      return;
    }

    const maxBal = invoiceBalance(inv);
    if (amount > maxBal + 0.001) {
      flash(document.getElementById('payments-flash'), `Amount cannot exceed outstanding debt ${fmtMoney(maxBal)}`, false);
      return;
    }

    const res = await CresAPI.request('/api/payments', {
      method: 'POST',
      body: { invoice_id, amount, paid_at, bank_reference },
      idempotencyKey: `pay-${invoice_id}-${amount}-${bank_reference}-${paid_at || 'now'}`,
    });
    const data = res.data || {};
    const payId = data.payment?.id;
    let msg = `Payment recorded. Debt remaining: ${fmtMoney(data.debt?.remaining || 0)}.`;
    if (data.receipt_emailed) {
      msg += ` Receipt emailed to ${data.receipt_to}.`;
    } else if (data.receipt_email_error) {
      msg += ` WARNING: receipt email failed (${data.receipt_email_error}).`;
    }
    if (data.residualInvoice) {
      msg += ` New balance invoice ${fmtMoney(data.residualInvoice.amount)} issued and emailed (due ${data.residualInvoice.due_date ? new Date(data.residualInvoice.due_date).toLocaleDateString() : '-'}).`;
    } else if (data.receipt_emailed) {
      msg += ' Invoice paid in full.';
    }
    flash(document.getElementById('payments-flash'), msg, data.receipt_emailed !== false);
    e.target.reset();
    document.getElementById('pay-client-card').hidden = true;
    document.getElementById('pay-bank-card').hidden = true;
    await mountPayments();
    if (payId && typeof CresReceipts !== 'undefined') {
      try {
        await CresReceipts.downloadFile(`/api/payments/${payId}/receipt`);
      } catch {
        /* download optional after record — email already queued server-side */
      }
    }
  }

  async function mountEmail() {
    const heading = document.getElementById('email-heading');
    const blurb = document.getElementById('email-blurb');
    if (heading) heading.textContent = 'Finance email';
    if (blurb) {
      blurb.textContent =
        'Send as Cres Dynamics Finance. Use this for invoice / payment follow-ups. Outbound mail is logged.';
    }
    const clients = await CresAPI.request('/api/clients');
    const select = document.getElementById('email-client');
    select.innerHTML =
      `<option value="">- Type address below -</option>` +
      clients.data
        .map((c) => `<option value="${c.id}" data-email="${esc(c.email || '')}">${esc(c.name)}${c.email ? ` (${esc(c.email)})` : ''}</option>`)
        .join('');
    select.onchange = () => {
      const email = select.selectedOptions[0]?.dataset.email;
      if (email) document.getElementById('email-to').value = email;
    };

    const hist = await CresAPI.request('/api/emails?all=1');
    const list = document.getElementById('email-history');
    list.innerHTML = hist.data.length
      ? hist.data
          .map(
            (m) => `<li>
              <div class="meta">${new Date(m.created_at).toLocaleString()} · ${esc(m.status)} · to ${esc(m.to_email)}${m.sender_name ? ` · from ${esc(m.sender_name)}` : ''}</div>
              <strong>${esc(m.subject)}</strong>
              <div style="margin-top:4px;color:var(--text-muted);font-size:0.85rem;">${esc((m.body || '').slice(0, 160))}${(m.body || '').length > 160 ? '…' : ''}</div>
            </li>`
          )
          .join('')
      : `<li class="empty-state">No emails sent yet.</li>`;
  }

  async function sendFinanceEmail(e) {
    e.preventDefault();
    const client_id = document.getElementById('email-client').value || null;
    const to_email = document.getElementById('email-to').value.trim();
    await CresAPI.request('/api/emails', {
      method: 'POST',
      body: {
        client_id,
        to_email: to_email || undefined,
        subject: document.getElementById('email-subject').value.trim(),
        body: document.getElementById('email-body').value.trim(),
      },
      idempotencyKey: `fin-email-${Date.now()}`,
    });
    e.target.reset();
    flash(document.getElementById('email-flash'), 'Email queued from Cres Dynamics Finance');
    await mountEmail();
  }

  async function mountExpenses() {
    const me = CresAPI.getUser();
    const cat = document.getElementById('exp-category')?.value;
    const status = document.getElementById('exp-approval-filter')?.value;
    const params = new URLSearchParams();
    if (cat) params.set('category', cat);
    if (status) params.set('approval_status', status);
    const qs = params.toString() ? `?${params}` : '';
    const res = await CresAPI.request(`/api/expenses${qs}`);
    const tbody = document.getElementById('expenses-tbody');
    const copy = document.getElementById('expenses-hero-copy');
    if (copy) {
      if (me?.role === 'director') {
        copy.textContent =
          'Submit an expense → Finance approves → Admin approves. Only then can the transaction proceed.';
      } else if (me?.role === 'finance') {
        copy.textContent =
          'Approve Director expenses to escalate to Admin. Print/send receipts only after Admin approval.';
      } else if (me?.role === 'admin') {
        copy.textContent =
          'Final approval for expenses escalated by Finance. Approval unlocks the transaction and receipts.';
      }
    }

    const canFinanceApprove = me?.role === 'finance' || me?.role === 'admin';
    const canAdminApprove = me?.role === 'admin';

    tbody.innerHTML = res.data.length
      ? res.data
          .map((x) => {
            const st = x.approval_status || 'approved';
            let actions = '';
            if (
              canFinanceApprove &&
              me.role === 'finance' &&
              (st === 'pending_finance' || st === 'pending')
            ) {
              actions = `<button type="button" class="btn btn-primary btn-sm" data-fin-exp="${esc(x.id)}">Approve → Admin</button>
                <button type="button" class="btn btn-ghost btn-sm" data-rej-exp="${esc(x.id)}">Reject</button>`;
            } else if (canAdminApprove && (st === 'pending_admin' || st === 'pending')) {
              actions = `<button type="button" class="btn btn-primary btn-sm" data-adm-exp="${esc(x.id)}">Final approve</button>
                <button type="button" class="btn btn-ghost btn-sm" data-rej-exp="${esc(x.id)}">Reject</button>`;
            } else if (st === 'approved' && ['finance', 'admin'].includes(me?.role)) {
              actions = `<button type="button" class="btn btn-ghost btn-sm" data-print-exp="${esc(x.id)}">Download</button>
                <button type="button" class="btn btn-ghost btn-sm" data-send-exp="${esc(x.id)}">Send</button>`;
            } else {
              actions = '<span class="meta">—</span>';
            }
            return `<tr>
              <td>${statusPill(x.category)}</td>
              <td>${fmtMoney(x.amount)}</td>
              <td>${esc(x.description || '-')}</td>
              <td>${statusPill(st)}</td>
              <td>${esc(x.created_by_name || '-')} <span class="role-tag">(${esc(x.created_by_role || '-')})</span></td>
              <td>${fmtDate(x.created_at)}</td>
              <td class="toolbar" style="gap:4px;flex-wrap:wrap;">${actions}</td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="7" class="empty-state">No expenses yet.</td></tr>`;

    tbody.querySelectorAll('[data-fin-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/expenses/${btn.dataset.finExp}/finance-approve`, {
            method: 'POST',
            body: {},
            idempotencyKey: `exp-fin-${btn.dataset.finExp}-${Date.now()}`,
          });
          flash(document.getElementById('expenses-flash'), 'Escalated to Admin');
          await mountExpenses();
        } catch (err) {
          flash(document.getElementById('expenses-flash'), err.message, false);
        }
      });
    });
    tbody.querySelectorAll('[data-adm-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/expenses/${btn.dataset.admExp}/approve`, {
            method: 'POST',
            body: {},
            idempotencyKey: `exp-adm-${btn.dataset.admExp}-${Date.now()}`,
          });
          flash(document.getElementById('expenses-flash'), 'Approved — transaction unlocked');
          await mountExpenses();
        } catch (err) {
          flash(document.getElementById('expenses-flash'), err.message, false);
        }
      });
    });
    tbody.querySelectorAll('[data-rej-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Rejection note (required):');
        if (!note?.trim()) return;
        try {
          await CresAPI.request(`/api/expenses/${btn.dataset.rejExp}/reject`, {
            method: 'POST',
            body: { note: note.trim() },
          });
          flash(document.getElementById('expenses-flash'), 'Expense rejected');
          await mountExpenses();
        } catch (err) {
          flash(document.getElementById('expenses-flash'), err.message, false);
        }
      });
    });
    tbody.querySelectorAll('[data-print-exp]').forEach((btn) => {
      btn.addEventListener('click', () =>
        CresReceipts.fetchAndPrint(`/api/expenses/${btn.dataset.printExp}/receipt`).catch((err) =>
          flash(document.getElementById('expenses-flash'), err.message, false)
        )
      );
    });
    tbody.querySelectorAll('[data-send-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const to = prompt('Send expense receipt to email:');
          if (!to) return;
          const sendRes = await CresReceipts.send(
            `/api/expenses/${btn.dataset.sendExp}/receipt/send`,
            to
          );
          flash(document.getElementById('expenses-flash'), `Receipt queued to ${sendRes.data.to}`);
        } catch (err) {
          flash(document.getElementById('expenses-flash'), err.message, false);
        }
      });
    });
  }

  async function mountMoneyApprovals() {
    const me = CresAPI.getUser();
    const flashEl = document.getElementById('money-approvals-flash');
    const expBody = document.getElementById('money-exp-approvals-tbody');
    const fundBody = document.getElementById('money-fund-approvals-tbody');
    if (!expBody || !fundBody) return;

    const isAdmin = me?.role === 'admin';
    const expStatus = isAdmin ? 'pending_admin' : 'pending_finance';
    const [expenses, funding] = await Promise.all([
      CresAPI.request(`/api/expenses?approval_status=${expStatus}`),
      CresAPI.request('/api/salaries/funding?inbox=1').catch(() => ({ data: [] })),
    ]);

    const expRows = (expenses.data || []).filter((x) =>
      isAdmin
        ? x.approval_status === 'pending_admin'
        : ['pending_finance', 'pending'].includes(x.approval_status)
    );
    expBody.innerHTML = expRows.length
      ? expRows
          .map((x) => {
            const actions = isAdmin
              ? `<button type="button" class="btn btn-primary btn-sm" data-money-adm-exp="${esc(x.id)}">Final approve</button>
                 <button type="button" class="btn btn-ghost btn-sm" data-money-rej-exp="${esc(x.id)}">Reject</button>`
              : `<button type="button" class="btn btn-primary btn-sm" data-money-fin-exp="${esc(x.id)}">Approve → Admin</button>
                 <button type="button" class="btn btn-ghost btn-sm" data-money-rej-exp="${esc(x.id)}">Reject</button>`;
            return `<tr>
              <td>${esc(x.category)}</td>
              <td>${fmtMoney(x.amount)}</td>
              <td>${esc(x.created_by_name || '-')}</td>
              <td>${esc(x.description || '-')}</td>
              <td>${fmtDate(x.created_at)}</td>
              <td class="toolbar" style="gap:6px;">${actions}</td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="6" class="empty-state">${
          isAdmin ? 'No expenses waiting for Admin.' : 'No Director expenses waiting for Finance.'
        }</td></tr>`;

    const fundRows = (funding.data || []).filter((r) =>
      isAdmin ? r.status === 'finance_approved' : r.status === 'pending_finance'
    );
    fundBody.innerHTML = fundRows.length
      ? fundRows
          .map((r) => {
            const people =
              (r.people || []).map((p) => p.name).slice(0, 4).join(', ') +
              ((r.people || []).length > 4 ? '…' : '');
            const actions = isAdmin
              ? `<button type="button" class="btn btn-primary btn-sm" data-money-adm-fund="${esc(r.id)}">Approve</button>
                 <button type="button" class="btn btn-ghost btn-sm" data-money-rej-fund="${esc(r.id)}">Reject</button>`
              : `<button type="button" class="btn btn-primary btn-sm" data-money-fin-fund="${esc(r.id)}" data-amt="${esc(r.amount_requested)}">Add &amp; escalate</button>
                 <button type="button" class="btn btn-ghost btn-sm" data-money-rej-fund="${esc(r.id)}">Reject</button>`;
            return `<tr>
              <td>${esc(r.month)}</td>
              <td>${fmtMoney(r.amount_requested)}${
                r.amount_funded != null ? ` → ${fmtMoney(r.amount_funded)}` : ''
              }</td>
              <td>${esc(r.requested_by_name || '-')}</td>
              <td>${esc(people || r.note || '-')}</td>
              <td>${fmtDate(r.created_at)}</td>
              <td class="toolbar" style="gap:6px;">${actions}</td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="6" class="empty-state">${
          isAdmin
            ? 'No salary funding waiting for Admin.'
            : 'No HR salary funding waiting for Finance.'
        }</td></tr>`;

    expBody.querySelectorAll('[data-money-fin-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/expenses/${btn.dataset.moneyFinExp}/finance-approve`, {
            method: 'POST',
            body: {},
            idempotencyKey: `money-fin-exp-${btn.dataset.moneyFinExp}-${Date.now()}`,
          });
          flash(flashEl, 'Expense approved — escalated to Admin');
          await mountMoneyApprovals();
        } catch (err) {
          flash(flashEl, err.message, false);
        }
      });
    });
    expBody.querySelectorAll('[data-money-adm-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/expenses/${btn.dataset.moneyAdmExp}/approve`, {
            method: 'POST',
            body: {},
            idempotencyKey: `money-adm-exp-${btn.dataset.moneyAdmExp}-${Date.now()}`,
          });
          flash(flashEl, 'Expense finally approved');
          await mountMoneyApprovals();
        } catch (err) {
          flash(flashEl, err.message, false);
        }
      });
    });
    expBody.querySelectorAll('[data-money-rej-exp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = window.prompt('Rejection note (optional)') || undefined;
        try {
          await CresAPI.request(`/api/expenses/${btn.dataset.moneyRejExp}/reject`, {
            method: 'POST',
            body: { note },
            idempotencyKey: `money-rej-exp-${btn.dataset.moneyRejExp}-${Date.now()}`,
          });
          flash(flashEl, 'Expense rejected');
          await mountMoneyApprovals();
        } catch (err) {
          flash(flashEl, err.message, false);
        }
      });
    });

    fundBody.querySelectorAll('[data-money-fin-fund]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const entered = window.prompt('Funded amount (Finance adds this)', btn.dataset.amt);
        if (entered == null) return;
        const amount_funded = Number(entered);
        if (!(amount_funded > 0)) {
          flash(flashEl, 'Enter a valid funded amount', false);
          return;
        }
        try {
          await CresAPI.request(`/api/salaries/funding/${btn.dataset.moneyFinFund}/finance-approve`, {
            method: 'POST',
            body: { amount_funded },
            idempotencyKey: `money-fin-fund-${btn.dataset.moneyFinFund}-${Date.now()}`,
          });
          flash(flashEl, 'Salary funding approved — escalated to Admin');
          await mountMoneyApprovals();
        } catch (err) {
          flash(flashEl, err.message, false);
        }
      });
    });
    fundBody.querySelectorAll('[data-money-adm-fund]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/salaries/funding/${btn.dataset.moneyAdmFund}/admin-approve`, {
            method: 'POST',
            body: {},
            idempotencyKey: `money-adm-fund-${btn.dataset.moneyAdmFund}-${Date.now()}`,
          });
          flash(flashEl, 'Salary funding approved — HR can settle');
          await mountMoneyApprovals();
        } catch (err) {
          flash(flashEl, err.message, false);
        }
      });
    });
    fundBody.querySelectorAll('[data-money-rej-fund]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = window.prompt('Rejection note (optional)') || undefined;
        try {
          await CresAPI.request(`/api/salaries/funding/${btn.dataset.moneyRejFund}/reject`, {
            method: 'POST',
            body: { note },
            idempotencyKey: `money-rej-fund-${btn.dataset.moneyRejFund}-${Date.now()}`,
          });
          flash(flashEl, 'Funding request rejected');
          await mountMoneyApprovals();
        } catch (err) {
          flash(flashEl, err.message, false);
        }
      });
    });
  }

  async function mountFlag() {
    const [issued, overdue, partial, followups, users] = await Promise.all([
      CresAPI.request('/api/invoices?status=issued'),
      CresAPI.request('/api/invoices?status=overdue'),
      CresAPI.request('/api/invoices?status=partially_paid').catch(() => ({ data: [] })),
      CresAPI.request('/api/invoices/followups'),
      CresAPI.request('/api/users/sales'),
    ]);
    const seen = new Set();
    const invoices = [...issued.data, ...overdue.data, ...(partial.data || [])].filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
    document.getElementById('flag-invoice').innerHTML =
      `<option value="">Select invoice</option>` +
      invoices
        .map(
          (i) =>
            `<option value="${i.id}">${esc(i.client_name || 'Client')} - ${fmtMoney(i.amount)} (${esc(i.status)})</option>`
        )
        .join('');
    document.getElementById('flag-sales').innerHTML =
      `<option value="">Select sales rep</option>` +
      users.data.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');

    const tbody = document.getElementById('flag-tbody');
    tbody.innerHTML = followups.data.length
      ? followups.data
          .map(
            (f) => `<tr>
              <td>${esc(f.client_name || '-')}</td>
              <td>${fmtMoney(f.amount)}</td>
              <td>${esc(f.sales_name || '-')}</td>
              <td>${statusPill(f.status)}</td>
              <td>${esc(f.note || '-')}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="empty-state">No flags yet.</td></tr>`;
  }

  async function submitFlag(e) {
    e.preventDefault();
    await CresAPI.request('/api/expenses/flag-invoice', {
      method: 'POST',
      body: {
        invoice_id: document.getElementById('flag-invoice').value,
        assigned_sales_user_id: document.getElementById('flag-sales').value,
        note: document.getElementById('flag-note').value.trim() || undefined,
      },
      idempotencyKey: `flag-${Date.now()}`,
    });
    flash(document.getElementById('flag-flash'), 'Flagged for sales follow-up');
    e.target.reset();
    await mountFlag();
  }

  let lastFinReport = null;

  function defaultReportDates() {
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - 5);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
  }

  function renderFinReportTables(d) {
    const body = document.getElementById('fin-report-body');
    if (!body) return;
    const section = (title, tableHtml) =>
      `<div class="settings-section" style="max-width:none;margin-bottom:18px;">
        <h3 style="margin:0 0 10px;font-size:0.95rem;">${title}</h3>
        <div class="data-table-wrap">${tableHtml}</div>
      </div>`;

    const accounts = d.accounts?.length
      ? `<table class="data-table"><thead><tr><th>Account</th><th>Balance</th><th>Updated</th></tr></thead><tbody>${d.accounts
          .map(
            (a) =>
              `<tr><td>${esc(a.label)}</td><td>${fmtMoney(a.balance)}</td><td>${fmtDate(a.updated_at)}</td></tr>`
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state">No accounts.</div>`;

    const projects = d.by_project?.length
      ? `<table class="data-table"><thead><tr><th>Project</th><th>Money in</th><th>Money out</th><th>Net</th></tr></thead><tbody>${d.by_project
          .map(
            (r) =>
              `<tr><td>${esc(r.project)}</td><td>${fmtMoney(r.money_in)}</td><td>${fmtMoney(r.money_out)}</td><td>${fmtMoney(r.net)}</td></tr>`
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state">No project payments in this period.</div>`;

    const clients = d.by_client?.length
      ? `<table class="data-table"><thead><tr><th>Client</th><th>Money in</th><th>Payments</th></tr></thead><tbody>${d.by_client
          .map(
            (r) =>
              `<tr><td>${esc(r.client)}</td><td>${fmtMoney(r.money_in)}</td><td>${r.payments}</td></tr>`
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state">No client payments in this period.</div>`;

    const categories = d.by_category?.length
      ? `<table class="data-table"><thead><tr><th>Outflow category</th><th>Money out</th><th>Count</th></tr></thead><tbody>${d.by_category
          .map(
            (r) =>
              `<tr><td>${esc(r.category)}</td><td>${fmtMoney(r.money_out)}</td><td>${r.count}</td></tr>`
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state">No approved outflows in this period.</div>`;

    const salaries = d.salaries?.length
      ? `<table class="data-table"><thead><tr><th>Employee</th><th>Month</th><th>Amount</th><th>Settled</th></tr></thead><tbody>${d.salaries
          .map(
            (r) =>
              `<tr><td>${esc(r.employee)}</td><td>${esc(r.month)}</td><td>${fmtMoney(r.amount)}</td><td>${fmtDate(r.settled_at)}</td></tr>`
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state">No salary settlements in this period.</div>`;

    const ledger = d.ledger?.length
      ? `<table class="data-table"><thead><tr><th>Date</th><th>Flow</th><th>Type</th><th>Amount</th><th>Detail</th></tr></thead><tbody>${d.ledger
          .slice(0, 200)
          .map(
            (r) => `<tr>
              <td>${fmtDate(r.occurred_at)}</td>
              <td><span class="status-pill ${r.direction === 'in' ? 'paid' : 'overdue'}">${esc(r.direction)}</span></td>
              <td>${esc(r.kind)}</td>
              <td>${fmtMoney(r.amount)}</td>
              <td><strong>${esc(r.label)}</strong><div class="meta">${esc(r.detail || '')}</div></td>
            </tr>`
          )
          .join('')}</tbody></table>${
          d.ledger.length > 200
            ? `<p class="meta" style="margin-top:8px;">Showing first 200 of ${d.ledger.length} ledger lines. Full set is in CSV/PDF export.</p>`
            : ''
        }`
      : `<div class="empty-state">No ledger movements in this period.</div>`;

    body.innerHTML =
      section('Accounts', accounts) +
      section('Money by project', projects) +
      section('Money by client', clients) +
      section('Outflows (expenses & salaries)', categories) +
      section('Salary settlements', salaries) +
      section('Cash flow ledger (in & out)', ledger);
  }

  function printFinReportPdf(d) {
    const money = (n) =>
      Number(n || 0).toLocaleString('en-KE', { style: 'currency', currency: 'KES' });
    const rows = (d.ledger || [])
      .map(
        (r) => `<tr>
          <td>${esc(new Date(r.occurred_at).toLocaleString())}</td>
          <td>${esc(r.direction)}</td>
          <td>${esc(r.kind)}</td>
          <td style="text-align:right;">${esc(money(r.amount))}</td>
          <td>${esc(r.label)}${r.detail ? `<div style="color:#555;font-size:0.85em;">${esc(r.detail)}</div>` : ''}</td>
        </tr>`
      )
      .join('');
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Cres Dynamics — Cash flow ${esc(d.period.from)} to ${esc(d.period.to)}</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;color:#15202b;margin:36px;font-size:12px;}
  h1{margin:0;font-size:1.5rem;color:#0f6e6a;}
  .sub{color:#5c6b7a;margin:4px 0 18px;}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;}
  .kpi{border:1px solid #d7dee6;border-radius:8px;padding:10px;}
  .kpi span{display:block;color:#5c6b7a;font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em;}
  .kpi strong{font-size:1.1rem;}
  h2{font-size:1rem;margin:20px 0 8px;border-bottom:2px solid #0f6e6a;padding-bottom:4px;}
  table{width:100%;border-collapse:collapse;margin-bottom:12px;}
  th,td{border-bottom:1px solid #e3e8ee;padding:7px 6px;text-align:left;vertical-align:top;}
  th{color:#5c6b7a;font-size:0.75rem;text-transform:uppercase;}
  .foot{margin-top:24px;color:#5c6b7a;font-size:0.8rem;}
  @media print{body{margin:12px;} .kpis{grid-template-columns:repeat(4,1fr);}}
</style></head><body>
  <h1>Cres Dynamics — Financial cash flow</h1>
  <div class="sub">Period ${esc(d.period.from)} → ${esc(d.period.to)} · Generated ${esc(new Date(d.generated_at).toLocaleString())}</div>
  <div class="kpis">
    <div class="kpi"><span>Money in</span><strong>${esc(money(d.summary.money_in))}</strong></div>
    <div class="kpi"><span>Money out</span><strong>${esc(money(d.summary.money_out))}</strong></div>
    <div class="kpi"><span>Net cash</span><strong>${esc(money(d.summary.net))}</strong></div>
    <div class="kpi"><span>Account balance</span><strong>${esc(money(d.summary.account_balance))}</strong></div>
  </div>
  <h2>Accounts</h2>
  <table><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>
    ${(d.accounts || []).map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(money(a.balance))}</td></tr>`).join('') || '<tr><td colspan="2">None</td></tr>'}
  </tbody></table>
  <h2>By project</h2>
  <table><thead><tr><th>Project</th><th>In</th><th>Out</th><th>Net</th></tr></thead><tbody>
    ${(d.by_project || []).map((r) => `<tr><td>${esc(r.project)}</td><td>${esc(money(r.money_in))}</td><td>${esc(money(r.money_out))}</td><td>${esc(money(r.net))}</td></tr>`).join('') || '<tr><td colspan="4">None</td></tr>'}
  </tbody></table>
  <h2>By client</h2>
  <table><thead><tr><th>Client</th><th>Money in</th><th>Payments</th></tr></thead><tbody>
    ${(d.by_client || []).map((r) => `<tr><td>${esc(r.client)}</td><td>${esc(money(r.money_in))}</td><td>${r.payments}</td></tr>`).join('') || '<tr><td colspan="3">None</td></tr>'}
  </tbody></table>
  <h2>Outflows by category</h2>
  <table><thead><tr><th>Category</th><th>Money out</th><th>Count</th></tr></thead><tbody>
    ${(d.by_category || []).map((r) => `<tr><td>${esc(r.category)}</td><td>${esc(money(r.money_out))}</td><td>${r.count}</td></tr>`).join('') || '<tr><td colspan="3">None</td></tr>'}
  </tbody></table>
  <h2>Ledger</h2>
  <table><thead><tr><th>Date</th><th>Flow</th><th>Type</th><th>Amount</th><th>Detail</th></tr></thead><tbody>
    ${rows || '<tr><td colspan="5">No movements</td></tr>'}
  </tbody></table>
  <p class="foot">Cres Dynamics Finance · Outstanding invoices ${esc(money(d.summary.outstanding_invoices))} · Use your browser’s Print → Save as PDF.</p>
  <script>window.onload=function(){window.print();}</script>
</body></html>`;
    const w = window.open('', '_blank', 'width=960,height=1000');
    if (!w) throw new Error('Pop-up blocked — allow pop-ups to download PDF');
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  async function mountReports() {
    const panel = document.getElementById('finance-reports-panel');
    const salesReports = document.getElementById('sales-reports-panel');
    if (panel) panel.hidden = false;
    if (salesReports) salesReports.hidden = true;

    const heading = document.getElementById('reports-heading');
    const blurb = document.getElementById('reports-blurb');
    if (heading) heading.textContent = 'Financial reports';
    if (blurb) {
      blurb.textContent =
        'Cash flow in and out across projects, clients, accounts, expenses, and salaries. Export CSV or PDF.';
    }

    const defaults = defaultReportDates();
    const fromEl = document.getElementById('fin-report-from');
    const toEl = document.getElementById('fin-report-to');
    if (fromEl && !fromEl.value) fromEl.value = defaults.from;
    if (toEl && !toEl.value) toEl.value = defaults.to;

    const params = new URLSearchParams();
    if (fromEl?.value) params.set('date_from', fromEl.value);
    if (toEl?.value) params.set('date_to', toEl.value);

    try {
      const res = await CresAPI.request(`/api/finance/cash-flow-report?${params}`);
      const d = res.data;
      lastFinReport = d;
      const summary = document.getElementById('fin-report-summary');
      if (summary) {
        summary.innerHTML = `
          <div class="kpi-card"><div class="kpi-label">Money in</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(d.summary.money_in)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Money out</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(d.summary.money_out)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Net cash</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(d.summary.net)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Account balance</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(d.summary.account_balance)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Outstanding invoices</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(d.summary.outstanding_invoices)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Period</div><div class="kpi-value" style="font-size:0.95rem;">${esc(d.period.from)} → ${esc(d.period.to)}</div></div>`;
      }
      renderFinReportTables(d);
    } catch (err) {
      flash(document.getElementById('fin-reports-flash'), err.message, false);
      const body = document.getElementById('fin-report-body');
      if (body) body.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountProjects() {
    const panel = document.getElementById('finance-projects-panel');
    const sales = document.getElementById('sales-projects-chrome');
    const pm = document.getElementById('pm-projects-panel');
    const client = document.getElementById('client-projects-panel');
    if (panel) panel.hidden = false;
    if (sales) sales.hidden = true;
    if (pm) pm.hidden = true;
    if (client) client.hidden = true;
    document.getElementById('btn-new-project') && (document.getElementById('btn-new-project').hidden = true);

    const res = await CresAPI.request('/api/finance/projects');
    const tbody = document.getElementById('finance-projects-tbody');
    if (!tbody) return;
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No billed projects yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.data
      .map(
        (p) => `<tr class="clickable-row" data-invoice="${esc(p.invoice_id || '')}" data-id="${esc(p.id)}">
          <td>${esc(p.name)}</td>
          <td>${esc(p.client_name || p.client_business || '-')}</td>
          <td style="font-size:0.8rem;">${esc(p.client_email || '')} ${esc(p.client_phone || '')}</td>
          <td>${p.value_amount != null ? fmtMoney(p.value_amount) : '-'}</td>
          <td>${p.invoice_amount != null ? fmtMoney(p.invoice_amount) : '—'}</td>
          <td>${p.invoice_id ? fmtMoney(p.amount_paid) : '—'}</td>
          <td>${p.invoice_id ? fmtMoney(p.balance_due) : '—'}</td>
          <td>${p.due_date ? new Date(p.due_date).toLocaleDateString() : '—'}</td>
          <td>${p.invoice_status ? statusPill(p.invoice_status) : statusPill(p.status)}</td>
        </tr>`
      )
      .join('');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        if (tr.dataset.invoice) {
          openInvoice(tr.dataset.invoice).catch((err) => alert(err.message));
        } else {
          alert('No invoice linked to this project yet.');
        }
      });
    });
  }

  function bindVoicePayment() {
    const btn = document.getElementById('btn-voice-payment');
    const timer = document.getElementById('vp-timer');
    const transcriptSection = document.getElementById('vp-transcript');
    const transcriptText = document.getElementById('vp-transcript-text');
    const previewSection = document.getElementById('vp-preview');
    if (!btn) return;

    let stream = null, recorder = null, chunks = [], timerInterval = null, seconds = 0;

    btn.addEventListener('click', async () => {
      if (recorder && recorder.state === 'recording') {
        // Stop recording
        btn.textContent = 'Speak payment';
        btn.classList.remove('btn-danger');
        clearInterval(timerInterval);
        const blob = await new Promise((res) => {
          recorder.onstop = () => { stream?.getTracks().forEach((t) => t.stop()); res(new Blob(chunks, { type: 'audio/webm' })); };
          recorder.stop();
        });
        chunks = [];
        if (!blob || blob.size < 500) return;

        btn.disabled = true; btn.textContent = 'Analyzing...';
        try {
          const fd = new FormData();
          fd.append('audio', blob, `payment-${Date.now()}.webm`);
          const res = await CresAPI.request('/api/payments/voice-capture', { method: 'POST', body: fd });

          transcriptSection.style.display = '';
          transcriptText.textContent = res.data.transcript || '';

          previewSection.style.display = '';
          document.getElementById('vp-amount').value = res.data.amount || '';
          document.getElementById('vp-client').value = res.data.client_name || '';
          document.getElementById('vp-project').value = res.data.project_name || '';
          document.getElementById('vp-bank-ref').value = res.data.bank_reference || '';
          document.getElementById('vp-description').value = res.data.description || '';

          // Store resolved IDs for submission
          previewSection.dataset.clientId = res.data.client_id || '';
          previewSection.dataset.projectId = res.data.project_id || '';
          previewSection.dataset.invoiceId = res.data.invoice_id || '';
        } catch (err) {
          flash(document.getElementById('payments-flash'), err.message, false);
        }
        btn.disabled = false; btn.textContent = 'Speak payment';
        return;
      }

      // Start recording
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.start();
        btn.textContent = 'Stop'; btn.classList.add('btn-danger');
        seconds = 0; timer.style.display = '';
        timerInterval = setInterval(() => { seconds++; const m = String(Math.floor(seconds / 60)).padStart(2, '0'); const s = String(seconds % 60).padStart(2, '0'); timer.textContent = `${m}:${s}`; }, 1000);
        transcriptSection.style.display = 'none';
        previewSection.style.display = 'none';
      } catch { /* mic denied */ }
    });

    // Use these details → fill the main payment form
    document.getElementById('btn-vp-use')?.addEventListener('click', () => {
      const amount = document.getElementById('vp-amount').value;
      const bankRef = document.getElementById('vp-bank-ref').value;
      const invoiceId = previewSection.dataset.invoiceId;

      if (invoiceId) {
        const select = document.getElementById('pay-invoice');
        if (select) { select.value = invoiceId; select.dispatchEvent(new Event('change')); }
      }
      if (amount) document.getElementById('pay-amount').value = amount;
      if (bankRef) document.getElementById('pay-bank-ref').value = bankRef;

      previewSection.style.display = 'none';
      transcriptSection.style.display = 'none';
      flash(document.getElementById('payments-flash'), 'Voice details loaded — review and submit');
    });

    document.getElementById('btn-vp-cancel')?.addEventListener('click', () => {
      previewSection.style.display = 'none';
      transcriptSection.style.display = 'none';
    });
  }

  function bind() {
    document.getElementById('payment-form')?.addEventListener('submit', (e) =>
      submitPayment(e).catch((err) => flash(document.getElementById('payments-flash'), err.message, false))
    );

    // Voice payment capture
    bindVoicePayment();

    document.getElementById('btn-fin-report-refresh')?.addEventListener('click', () =>
      mountReports().catch(console.error)
    );
    document.getElementById('btn-fin-report-csv')?.addEventListener('click', () => {
      const from = document.getElementById('fin-report-from')?.value || '';
      const to = document.getElementById('fin-report-to')?.value || '';
      const qs = new URLSearchParams();
      if (from) qs.set('date_from', from);
      if (to) qs.set('date_to', to);
      CresAPI.download(`/api/export/cash-flow.csv?${qs}`, `cres-cash-flow.csv`).catch((err) =>
        flash(document.getElementById('fin-reports-flash'), err.message, false)
      );
    });
    document.getElementById('btn-fin-report-pdf')?.addEventListener('click', () => {
      try {
        if (!lastFinReport) throw new Error('Refresh the report first');
        printFinReportPdf(lastFinReport);
      } catch (err) {
        flash(document.getElementById('fin-reports-flash'), err.message, false);
      }
    });
    ['fin-report-from', 'fin-report-to'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => mountReports().catch(console.error));
    });
    const emailForm = document.getElementById('email-form');
    if (emailForm && !emailForm.dataset.finBound) {
      emailForm.dataset.finBound = '1';
      emailForm.addEventListener('submit', (e) => {
        const user = CresAPI.getUser();
        if (user?.role !== 'finance') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        sendFinanceEmail(e).catch((err) =>
          flash(document.getElementById('email-flash'), err.message, false)
        );
      });
    }
    document.getElementById('flag-form')?.addEventListener('submit', (e) =>
      submitFlag(e).catch((err) => flash(document.getElementById('flag-flash'), err.message, false))
    );
    document.getElementById('btn-new-expense')?.addEventListener('click', () => {
      document.getElementById('new-expense-modal').classList.add('open');
    });
    document.getElementById('new-expense-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await CresAPI.request('/api/expenses', {
          method: 'POST',
          body: {
            category: document.getElementById('new-exp-category').value,
            amount: Number(document.getElementById('new-exp-amount').value),
            description: document.getElementById('new-exp-desc').value.trim() || undefined,
          },
          idempotencyKey: `exp-${Date.now()}`,
        });
        document.getElementById('new-expense-modal').classList.remove('open');
        e.target.reset();
        if (res.meta?.approval_status === 'pending_finance') {
          flash(
            document.getElementById('expenses-flash'),
            'Expense submitted — awaiting Finance, then Admin'
          );
        } else if (res.meta?.approval_status === 'pending_admin') {
          flash(document.getElementById('expenses-flash'), 'Expense saved — pending Admin approval');
        } else {
          flash(document.getElementById('expenses-flash'), 'Expense saved');
        }
        await mountExpenses();
      } catch (err) {
        alert(err.message);
      }
    });

    let newInvClients = [];
    let newInvProjects = [];

    function newInvRecalc() {
      let total = 0;
      document.querySelectorAll('#new-inv-items tr').forEach((tr) => {
        const qty = Number(tr.querySelector('[data-qty]')?.value || 0);
        const unit = Number(tr.querySelector('[data-unit]')?.value || 0);
        const amt = Math.round(qty * unit * 100) / 100;
        total += amt;
        const cell = tr.querySelector('[data-amt]');
        if (cell) cell.textContent = fmtMoney(amt);
      });
      const label = document.getElementById('new-inv-total');
      if (label) label.textContent = `Total: ${fmtMoney(total)}`;
    }

    function addNewInvItem(prefill = {}) {
      const tbody = document.getElementById('new-inv-items');
      if (!tbody) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input data-desc type="text" required placeholder="Description" value="${esc(
          prefill.description || ''
        )}" style="width:100%;" /></td>
        <td><input data-qty type="number" min="0.01" step="0.01" value="${esc(
          prefill.qty || 1
        )}" style="width:80px;" required /></td>
        <td><input data-unit type="number" min="0" step="0.01" value="${esc(
          prefill.unit_price || ''
        )}" style="width:120px;" required /></td>
        <td data-amt>${fmtMoney(0)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-remove>Remove</button></td>`;
      tbody.appendChild(tr);
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', newInvRecalc));
      tr.querySelector('[data-remove]')?.addEventListener('click', () => {
        tr.remove();
        newInvRecalc();
      });
      newInvRecalc();
    }

    function fillNewInvClients(filter = '') {
      const sel = document.getElementById('new-inv-client');
      if (!sel) return;
      const q = filter.trim().toLowerCase();
      const list = newInvClients.filter(
        (c) =>
          !q ||
          (c.name || '').toLowerCase().includes(q) ||
          (c.business_name || '').toLowerCase().includes(q) ||
          (c.email || '').toLowerCase().includes(q)
      );
      const prev = sel.value;
      sel.innerHTML =
        `<option value="">Select client</option>` +
        list
          .map(
            (c) =>
              `<option value="${esc(c.id)}">${esc(c.business_name || c.name)}${
                c.email ? ` — ${esc(c.email)}` : ''
              }</option>`
          )
          .join('');
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    }

    function fillNewInvProjects(clientId) {
      const sel = document.getElementById('new-inv-project');
      if (!sel) return;
      const list = newInvProjects.filter((p) => !clientId || p.client_id === clientId);
      sel.innerHTML =
        `<option value="">Select project</option>` +
        list
          .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
          .join('');
    }

    function showNewInvContact(clientId) {
      const card = document.getElementById('new-inv-contact');
      const body = document.getElementById('new-inv-contact-body');
      const hint = document.getElementById('new-inv-email-hint');
      if (!clientId) {
        if (card) card.hidden = true;
        if (body) body.innerHTML = '';
        if (hint) hint.textContent = 'Select a client to email the invoice.';
        return;
      }
      const c = newInvClients.find((x) => x.id === clientId);
      if (!c) {
        if (card) card.hidden = true;
        return;
      }
      if (card) card.hidden = false;
      if (body) {
        body.innerHTML = `
          <div><strong>Name:</strong> ${esc(c.name || '—')}</div>
          <div><strong>Business:</strong> ${esc(c.business_name || '—')}</div>
          <div><strong>Email:</strong> ${esc(c.email || '—')}</div>
          <div><strong>Phone:</strong> ${esc(c.phone || '—')}</div>`;
      }
      if (hint) {
        hint.textContent = c.email
          ? `Will download and email to ${c.email}`
          : 'Client has no email — add email on the client record before creating.';
        hint.style.color = c.email ? '' : '#c0392b';
      }
    }

    async function openNewInvoiceModal() {
      const modal = document.getElementById('new-invoice-modal');
      if (!modal) return;
      const [clients, projects] = await Promise.all([
        CresAPI.request('/api/clients'),
        // Finance is blocked from /api/projects (ops list) — use money view
        CresAPI.request('/api/finance/projects'),
      ]);
      newInvClients = clients.data || [];
      newInvProjects = (projects.data || []).map((p) => ({
        id: p.id,
        name: p.name,
        client_id: p.client_id,
        client_name: p.client_name || p.client_business || '',
      }));
      fillNewInvClients();
      fillNewInvProjects('');
      showNewInvContact('');
      document.getElementById('new-inv-date').value = new Date().toISOString().slice(0, 10);
      document.getElementById('new-inv-items').innerHTML = '';
      addNewInvItem();
      modal.classList.add('open');
    }

    document.getElementById('btn-new-invoice')?.addEventListener('click', () =>
      openNewInvoiceModal().catch((err) => alert(err.message))
    );
    document.getElementById('btn-new-inv-add-item')?.addEventListener('click', () => addNewInvItem());
    document.getElementById('new-inv-client-filter')?.addEventListener('input', (e) => {
      fillNewInvClients(e.target.value);
      showNewInvContact(document.getElementById('new-inv-client')?.value || '');
    });
    document.getElementById('new-inv-client')?.addEventListener('change', (e) => {
      fillNewInvProjects(e.target.value);
      showNewInvContact(e.target.value);
    });
    document.getElementById('new-invoice-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const flashEl = document.getElementById('new-inv-flash');
      const client_id = document.getElementById('new-inv-client').value;
      const project_id = document.getElementById('new-inv-project').value;
      const issue_date = document.getElementById('new-inv-date').value;
      const client = newInvClients.find((c) => c.id === client_id);
      if (!client?.email?.trim()) {
        flash(flashEl, 'Selected client has no email — update the client record first', false);
        return;
      }
      const items = [...document.querySelectorAll('#new-inv-items tr')].map((tr) => ({
        description: tr.querySelector('[data-desc]')?.value?.trim(),
        qty: Number(tr.querySelector('[data-qty]')?.value),
        unit_price: Number(tr.querySelector('[data-unit]')?.value),
      }));
      if (!items.length || items.some((i) => !i.description || !(i.qty > 0))) {
        flash(flashEl, 'Add valid line items', false);
        return;
      }
      try {
        const res = await CresAPI.request('/api/invoices', {
          method: 'POST',
          body: {
            client_id,
            project_id,
            issue_date,
            items,
            send_email: true,
          },
          idempotencyKey: `inv-create-${Date.now()}`,
        });
        document.getElementById('new-invoice-modal')?.classList.remove('open');
        const invId = res.data?.invoice?.id;
        if (invId) {
          try {
            await CresReceipts.downloadFile(`/api/invoices/${invId}/receipt`);
          } catch (_) {
            /* download best-effort — email already queued on create */
          }
        }
        flash(
          document.getElementById('fin-inv-list-flash'),
          `Invoice ${res.data.invoice_number} created · downloaded · emailed to ${client.email}`
        );
        await mountInvoices();
        if (invId) await openInvoice(invId);
      } catch (err) {
        flash(flashEl, err.message, false);
      }
    });

    document.getElementById('btn-export-invoices')?.addEventListener('click', () => {
      CresAPI.download('/api/export/invoices.csv', 'invoices.csv').catch((err) => alert(err.message));
    });
    document.getElementById('btn-export-fin-projects')?.addEventListener('click', () => {
      CresAPI.download('/api/export/projects.csv', 'projects.csv').catch((err) => alert(err.message));
    });

    ['fin-inv-search', 'fin-inv-status', 'fin-inv-from', 'fin-inv-to'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => mountInvoices().catch(console.error));
      document.getElementById(id)?.addEventListener('input', () => {
        clearTimeout(mountInvoices._t);
        mountInvoices._t = setTimeout(() => mountInvoices().catch(console.error), 250);
      });
    });
    document.getElementById('exp-category')?.addEventListener('change', () => mountExpenses());
    document.getElementById('exp-approval-filter')?.addEventListener('change', () => mountExpenses());
  }

  async function mount(faceId, user) {
    if (!['finance', 'admin'].includes(user.role)) return;
    if (faceId === 'home' && user.role === 'finance') await mountHome();
    else if (faceId === 'approvals' && ['finance', 'admin'].includes(user.role))
      await mountMoneyApprovals();
    else if (faceId === 'projects' && user.role === 'finance') await mountProjects();
    else if (faceId === 'invoices') await mountInvoices();
    else if (faceId === 'payments') await mountPayments();
    else if (faceId === 'email' && user.role === 'finance') await mountEmail();
    else if (faceId === 'expenses') await mountExpenses();
    else if (faceId === 'flag') await mountFlag();
    else if (faceId === 'reports' && user.role === 'finance') await mountReports();
  }

  return { bind, mount, openInvoice, mountExpenses, mountMoneyApprovals };
})();
