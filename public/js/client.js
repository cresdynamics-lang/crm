/**
 * Step 9 - Client portal (external-facing, no Community)
 */
const CresClient = (() => {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(v) {
    return CresFormat.date(v);
  }

  function fmtMoney(n) {
    return CresFormat.money(n);
  }

  function statusPill(s) {
    const label = (s || '').replace(/_/g, ' ');
    return `<span class="status-pill ${esc(s || '')}">${esc(label)}</span>`;
  }

  function flash(el, msg, ok = true) {
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  function progressBar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="progress-track"><div class="progress-fill" style="width:${p}%"></div><span class="progress-label">${p}%</span></div>`;
  }

  async function mountHome() {
    const host = document.getElementById('client-dashboard');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/client/dashboard');
      const d = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Your projects</div><div class="kpi-value">${d.kpis.projectCount}</div></div>
          <div class="kpi-card"><div class="kpi-label">In progress</div><div class="kpi-value">${d.kpis.activeCount}</div></div>
          <div class="kpi-card"><div class="kpi-label">Avg progress</div><div class="kpi-value">${d.kpis.avgProgress}%</div></div>
          <div class="kpi-card"><div class="kpi-label">Completed</div><div class="kpi-value">${d.kpis.completedCount}</div></div>
        </div>
        <div class="settings-section" style="margin-top:16px;max-width:none;">
          <h3>Project overview</h3>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>Project</th><th>Status</th><th>Progress</th></tr></thead>
              <tbody>
                ${
                  d.projects.length
                    ? d.projects
                        .map(
                          (p) => `<tr class="clickable-row" data-id="${esc(p.id)}">
                            <td>${esc(p.name)}</td>
                            <td>${statusPill(p.status)}</td>
                            <td>${progressBar(p.progress_pct)}</td>
                          </tr>`
                        )
                        .join('')
                    : '<tr><td colspan="3" class="empty-state">No projects yet.</td></tr>'
                }
              </tbody>
            </table>
          </div>
          <p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">
            Open a project to message Sales or the PM, or request a change. Invoices are under Invoices.
          </p>
        </div>`;

      host.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', () => {
          location.hash = `#/projects/${tr.dataset.id}`;
        });
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountProjects(projectId) {
    const list = document.getElementById('client-projects-panel');
    const detail = document.getElementById('client-project-detail');
    const salesChrome = document.getElementById('sales-projects-chrome');
    const pmPanel = document.getElementById('pm-projects-panel');
    if (salesChrome) salesChrome.hidden = true;
    if (pmPanel) pmPanel.hidden = true;

    if (!list || !detail) return;

    if (!projectId) {
      list.hidden = false;
      detail.hidden = true;
      const res = await CresAPI.request('/api/client/projects');
      const tbody = document.getElementById('client-projects-tbody');
      tbody.innerHTML = res.data.length
        ? res.data
            .map(
              (p) => `<tr class="clickable-row" data-id="${esc(p.id)}">
                <td>${esc(p.name)}</td>
                <td>${statusPill(p.status)}</td>
                <td>${progressBar(p.progress_pct)}</td>
                <td>${fmtDate(p.updated_at)}</td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="empty-state">No projects yet.</td></tr>';
      tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', () => {
          location.hash = `#/projects/${tr.dataset.id}`;
        });
      });
      return;
    }

    list.hidden = true;
    detail.hidden = false;
    try {
      const res = await CresAPI.request(`/api/client/projects/${projectId}`);
      const { project: p, documents } = res.data;
      const milestones = p.milestones || [];

      detail.innerHTML = `
        <button type="button" class="btn btn-ghost" id="client-project-back" style="margin-bottom:12px;">Back to projects</button>
        <div class="face-hero" style="margin-bottom:12px;">
          <h2 style="margin:0;">${esc(p.name)}</h2>
          <p style="margin:6px 0 0;">${statusPill(p.status)} · ${progressBar(p.progress_pct)}</p>
          ${
            p.preview_url
              ? `<p style="margin:10px 0 0;"><a class="btn btn-primary btn-sm" href="${esc(p.preview_url)}" target="_blank" rel="noopener">Open project preview</a></p>`
              : ''
          }
          ${p.due_date ? `<p class="meta" style="margin:8px 0 0;">Due ${fmtDate(p.due_date)}</p>` : ''}
        </div>
        <div id="client-signoff-flash" class="flash"></div>
        ${
          p.summary
            ? `<div class="settings-section" style="max-width:640px;"><h3>Summary</h3><p style="margin:0;white-space:pre-wrap;">${esc(p.summary)}</p></div>`
            : ''
        }
        <div class="settings-section" style="max-width:720px;">
          <h3>Timeline &amp; sign-off</h3>
          <ol class="client-timeline">
            ${
              milestones.length
                ? milestones
                    .map((m, i) => {
                      const so = m.signoff;
                      return `<li class="timeline-item status-${esc(m.status)}">
                        <div class="timeline-dot"></div>
                        <div class="timeline-body">
                          <div class="timeline-title">${esc(m.title)}</div>
                          <div class="timeline-meta">${statusPill(m.status)}${
                            m.due_date ? ` · Due ${fmtDate(m.due_date)}` : ''
                          }${so ? ` · Sign-off: ${statusPill(so.status)}` : ''}</div>
                          ${so?.client_note ? `<div class="meta" style="margin-top:4px;">Note: ${esc(so.client_note)}</div>` : ''}
                          <div class="toolbar" style="margin-top:8px;gap:8px;">
                            <button type="button" class="btn btn-primary btn-sm" data-signoff="approved" data-ms="${esc(m.title)}">Approve</button>
                            <button type="button" class="btn btn-ghost btn-sm" data-signoff="changes_requested" data-ms="${esc(m.title)}">Request changes</button>
                          </div>
                        </div>
                      </li>`;
                    })
                    .join('')
                : '<li class="empty-state">Milestones will appear as work is planned.</li>'
            }
          </ol>
        </div>
        <div id="client-project-extras"></div>
        <div class="settings-section" style="max-width:640px;">
          <h3>Shared documents</h3>
          <ul class="engagement-list">
            ${
              documents.length
                ? documents
                    .map(
                      (d) => `<li>
                        <div class="meta">${esc(d.title)} · ${fmtDate(d.created_at)}</div>
                        <a href="${esc(d.file_path)}" target="_blank" rel="noopener">${esc(d.original_name || 'Download')}</a>
                      </li>`
                    )
                    .join('')
                : '<li class="empty-state">No documents shared yet.</li>'
            }
          </ul>
        </div>`;

      document.getElementById('client-project-back')?.addEventListener('click', () => {
        location.hash = '#/projects';
      });

      const extras = document.getElementById('client-project-extras');
      if (extras && typeof CresProjectDetail !== 'undefined') {
        await CresProjectDetail.mountExtras(extras, {
          id: projectId,
          project: p,
          meta: { canUseThread: true },
          user: CresAPI.getUser(),
          onRefresh: () => mountProjects(projectId),
          showContact: false,
          showMoney: false,
          allowMessages: true,
          allowDecide: false,
          allowBlocked: false,
          allowChangeForm: true,
        });
      }

      detail.querySelectorAll('[data-signoff]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const status = btn.dataset.signoff;
          const milestone_title = btn.dataset.ms;
          let client_note;
          if (status === 'changes_requested') {
            client_note = prompt('What changes do you need?') || '';
            if (!client_note.trim()) return;
          }
          try {
            await CresAPI.request(`/api/client/projects/${projectId}/signoffs`, {
              method: 'POST',
              body: { milestone_title, status, client_note: client_note || undefined },
            });
            flash(document.getElementById('client-signoff-flash'), status === 'approved' ? 'Milestone approved' : 'Changes requested');
            await mountProjects(projectId);
          } catch (err) {
            flash(document.getElementById('client-signoff-flash'), err.message, false);
          }
        });
      });
    } catch (err) {
      detail.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountInvoices() {
    const panel = document.getElementById('client-invoices-panel');
    if (!panel) return;
    panel.hidden = false;

    const [invoices, docs] = await Promise.all([
      CresAPI.request('/api/client/invoices'),
      CresAPI.request('/api/client/documents'),
    ]);

    const invBody = document.getElementById('client-invoices-tbody');
    invBody.innerHTML = invoices.data.length
      ? invoices.data
          .map((i) => {
            const unpaid = ['issued', 'partially_paid', 'overdue'].includes(i.status);
            const due = Math.max(0, Number(i.amount || 0) - Number(i.amount_paid || 0));
            const payBtn = unpaid
              ? `<button type="button" class="btn btn-primary btn-sm" data-pay="${esc(i.id)}" data-due="${esc(due)}" data-claimed="${esc(i.mpesa_claim_code || '')}">${
                  i.mpesa_claim_code ? 'Update M-Pesa code' : 'Pay with M-Pesa'
                }</button>`
              : '—';
            return `<tr>
              <td>${esc(i.project_name || '-')}</td>
              <td>${fmtMoney(i.amount)}</td>
              <td>${statusPill(i.status)}${
                i.mpesa_claim_code && unpaid
                  ? `<div class="meta">Code sent ${esc(i.mpesa_claim_code)}</div>`
                  : ''
              }</td>
              <td>${fmtDate(i.created_at)}</td>
              <td>${payBtn}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="5" class="empty-state">No invoices yet.</td></tr>';

    const mpesaPanel = document.getElementById('client-mpesa-panel');
    invBody.querySelectorAll('[data-pay]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!mpesaPanel) return;
        mpesaPanel.hidden = false;
        mpesaPanel.dataset.invoiceId = btn.dataset.pay;
        const amountEl = document.getElementById('mpesa-amount');
        if (amountEl) amountEl.textContent = fmtMoney(btn.dataset.due);
        const codeEl = document.getElementById('mpesa-code');
        if (codeEl) codeEl.value = btn.dataset.claimed || '';
        mpesaPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    const docsList = document.getElementById('client-docs-list');
    docsList.innerHTML = docs.data.length
      ? docs.data
          .map(
            (d) => `<li>
              <div class="meta">${esc(d.project_name)} · ${fmtDate(d.created_at)}</div>
              <div>${esc(d.title)} - <a href="${esc(d.file_path)}" target="_blank" rel="noopener">${esc(d.original_name || 'Open')}</a></div>
            </li>`
          )
          .join('')
      : '<li class="empty-state">No shared documents.</li>';
  }

  async function mountChanges(user) {
    const formWrap = document.getElementById('change-request-form')?.closest('.settings-section');
    const isClient = user?.role === 'client';
    if (formWrap) formWrap.hidden = !isClient;
    const heroP = document.querySelector('#face-changes .face-hero p');
    if (heroP && !isClient) {
      heroP.textContent = 'Open a request to see what the client asked for.';
    }

    const list = await CresAPI.request('/api/client/change-requests');
    if (isClient) {
      const projects = await CresAPI.request('/api/client/projects');
      const sel = document.getElementById('cr-project');
      if (sel) {
        sel.innerHTML =
          `<option value="">Select project</option>` +
          (projects.data || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      }
    }

    const tbody = document.getElementById('changes-tbody');
    if (!tbody) return;
    const cols = isClient ? 4 : 5;
    tbody.innerHTML = list.data.length
      ? list.data
          .map(
            (c) => `<tr>
              ${!isClient ? `<td>${esc(c.client_name || '-')}</td>` : ''}
              <td>${esc(c.project_name || '-')}</td>
              <td>${esc(c.subject)}</td>
              <td>${statusPill(c.status || 'open')}</td>
              <td>${fmtDate(c.created_at)}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="${cols}" class="empty-state">No change requests yet.</td></tr>`;

    const thead = document.querySelector('#face-changes thead tr');
    if (thead) {
      thead.innerHTML = isClient
        ? `<th>Project</th><th>Subject</th><th>Status</th><th>Submitted</th>`
        : `<th>Client</th><th>Project</th><th>Subject</th><th>Status</th><th>Submitted</th>`;
    }
  }

  async function submitChangeRequest(e) {
    e.preventDefault();
    await CresAPI.request('/api/client/change-requests', {
      method: 'POST',
      body: {
        project_id: document.getElementById('cr-project').value,
        subject: document.getElementById('cr-subject').value.trim(),
        details: document.getElementById('cr-details').value.trim(),
      },
    });
    e.target.reset();
    flash(document.getElementById('changes-flash'), 'Change request submitted');
    await mountChanges({ role: 'client' });
  }

  async function submitMpesa(e) {
    e.preventDefault();
    const panel = document.getElementById('client-mpesa-panel');
    const invoiceId = panel?.dataset.invoiceId;
    if (!invoiceId) throw new Error('Choose an invoice first');
    const code = document.getElementById('mpesa-code').value.trim();
    await CresAPI.request(`/api/client/invoices/${invoiceId}/mpesa`, {
      method: 'POST',
      body: { code },
    });
    flash(document.getElementById('client-mpesa-flash'), 'Code sent to Finance. They will confirm the payment.');
    await mountInvoices();
  }

  function bind() {
    document.getElementById('change-request-form')?.addEventListener('submit', (e) =>
      submitChangeRequest(e).catch((err) => flash(document.getElementById('changes-flash'), err.message, false))
    );
    document.getElementById('client-mpesa-form')?.addEventListener('submit', (e) =>
      submitMpesa(e).catch((err) => flash(document.getElementById('client-mpesa-flash'), err.message, false))
    );
  }

  async function mount(faceId, user, faceParam) {
    if (faceId === 'changes' && ['client', 'sales', 'pm', 'admin', 'director'].includes(user.role)) {
      await mountChanges(user);
      return;
    }
    if (user.role !== 'client') return;
    if (faceId === 'home') await mountHome();
    else if (faceId === 'projects') await mountProjects(faceParam || null);
    else if (faceId === 'invoices') await mountInvoices();
  }

  return { bind, mount };
})();
