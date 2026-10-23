/**
 * Finance / Admin — website event payers (cresdynamics.com registrations).
 * See who paid, view/contact attendees, trigger a payer email.
 */
const CresWebsitePayments = (() => {
  let wired = false;
  let payers = [];

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function wire() {
    if (wired) return;
    wired = true;
    el('wp-refresh').onclick = refresh;
    el('wp-status').onchange = refresh;
    el('wp-event').onchange = refresh;
    el('wp-from').onchange = refresh;
    el('wp-to').onchange = refresh;
    el('wp-email-send').onclick = sendEmail;
    document.querySelector('[data-close-modal="wp-email-modal"]')?.addEventListener('click', () => {
      el('wp-email-modal').hidden = true;
    });
  }

  async function refresh() {
    const flash = el('wp-flash');
    const q = new URLSearchParams();
    if (el('wp-status').value) q.set('status', el('wp-status').value);
    if (el('wp-event').value) q.set('event', el('wp-event').value);
    const from = el('wp-from').value;
    if (from) q.set('from', from);
    const to = el('wp-to').value;
    if (to) q.set('to', to);
    try {
      const res = await CresAPI.request(`/api/finance/website-payments?${q.toString()}`);
      const disconnected = res.connected === false || res.data?.connected === false;
      const off = el('wp-disconnected');
      const on = el('wp-connected');
      if (off) off.hidden = !disconnected;
      if (on) on.hidden = disconnected;
      if (disconnected) {
        payers = [];
        flash.textContent = '';
        return;
      }
      payers = res.data.payments || [];
      render(res.data);
      flash.textContent = '';
    } catch (e) {
      const off = el('wp-disconnected');
      const on = el('wp-connected');
      if (off) off.hidden = false;
      if (on) on.hidden = true;
      flash.textContent = '';
    }
  }

  function render(d) {
    const s = d.summary;
    el('wp-summary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Paid registrations</div><div class="kpi-value" style="font-size:1.45rem;">${s.paidCount}</div></div>
        <div class="kpi-card"><div class="kpi-label">Attendees</div><div class="kpi-value" style="font-size:1.45rem;">${s.paidPeople}</div></div>
        <div class="kpi-card"><div class="kpi-label">Latest payment</div><div class="kpi-value" style="font-size:0.95rem;">${esc(fmtDate(s.latestPayment))}</div></div>
        <div class="kpi-card"><div class="kpi-label">Currency</div><div class="kpi-value">${esc(d.currency)}</div></div>
      </div>`;
    el('wp-count').textContent =
      `${payers.length} registration${payers.length === 1 ? '' : 's'} shown · website tickets are recorded when paid via M-PESA / event day` +
      (d.websiteDbOffline ? ' · website DB offline' : '');

    const events = [...new Set(payers.map((p) => p.eventTitle).filter(Boolean))];
    const current = el('wp-event').value;
    const keep = events.includes(current) ? current : '';
    el('wp-event').innerHTML = '<option value="">All events</option>' +
      events.map((e) => `<option value="${esc(e)}"${e === keep ? ' selected' : ''}>${esc(e)}</option>`).join('');

    el('wp-list').innerHTML = payers.map((p) => `
      <tr>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${esc(p.email)}<br><span class="meta">${esc(p.phone || '—')}</span></td>
        <td>${esc(p.eventTitle)}<br><span class="meta">${esc(p.eventDate || '')}</span></td>
        <td>${esc(p.ticketType || '—')}</td>
        <td>${esc(fmtDate(p.paidAt))}</td>
        <td>${p.emailSent ? '<span class="status-pill paid">Emailed</span>' : '<span class="status-pill">Not emailed</span>'}</td>
        <td>${p.emailSent ? '' : `<button type="button" class="btn btn-ghost" data-email="${p.id}">Email</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="meta">No matching payments.</td></tr>';

    el('wp-list').querySelectorAll('[data-email]').forEach((btn) => {
      btn.onclick = () => openEmail(payers.find((p) => String(p.id) === btn.dataset.email));
    });
  }

  function openEmail(p) {
    if (!p) return;
    el('wp-email-to').innerHTML =
      `To: <strong>${esc(p.name)}</strong> · ${esc(p.email)} · ${esc(p.phone || '—')}<br>Event: ${esc(p.eventTitle)} ${esc(p.eventDate || '')}`;
    el('wp-email-message').value = '';
    el('wp-email-flash').textContent = '';
    const m = el('wp-email-modal');
    m.dataset.pid = p.id;
    m.hidden = false;
  }

  async function sendEmail() {
    const m = el('wp-email-modal');
    const pid = m.dataset.pid;
    const message = el('wp-email-message').value.trim();
    const flash = el('wp-email-flash');
    if (!message) { flash.textContent = 'Write a message first.'; return; }
    try {
      await CresAPI.request(`/api/finance/website-payments/${pid}/email`, { method: 'POST', body: { message } });
      m.hidden = true;
      await refresh();
      el('wp-flash').textContent = 'Email queued to attendee.';
      setTimeout(() => { el('wp-flash').textContent = ''; }, 5000);
    } catch (e) {
      flash.textContent = e.message;
    }
  }

  async function mount(faceId, user) {
    if (faceId !== 'website-payments' || !['finance', 'admin'].includes(user.role)) return;
    wire();
    await refresh();
  }

  return { mount };
})();