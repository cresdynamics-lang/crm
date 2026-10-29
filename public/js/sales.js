/**
 * Step 3 - Sales module faces
 */
const CresSales = (() => {
  let chart;
  let leadModalId = null;
  let resubmitProjectId = null;

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
    return `<span class="status-pill ${esc(s || '')}">${esc((s || '').replace(/_/g, ' '))}</span>`;
  }

  function flash(el, msg, ok = true) {
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  function canCrmMutate(role) {
    return ['admin', 'director', 'sales'].includes(role);
  }

  async function refreshProjectsView() {
    const role = CresAPI.getUser()?.role;
    if (role === 'admin' && typeof CresAdmin !== 'undefined' && CresAdmin.refreshProjects) {
      await CresAdmin.refreshProjects();
      return;
    }
    if (role === 'director' && typeof CresDirector !== 'undefined' && CresDirector.refreshProjects) {
      await CresDirector.refreshProjects();
      return;
    }
    await mountProjects();
  }

  async function fillProjectCreateOptions() {
    const [clients, developers, workload] = await Promise.all([
      CresAPI.request('/api/clients').catch(() => ({ data: [] })),
      CresAPI.request('/api/users/developers').catch(() => ({ data: [] })),
      CresAPI.request('/api/projects/meta/developer-workload').catch(() => ({ data: [] })),
    ]);
    const loadMap = Object.fromEntries((workload.data || []).map((w) => [w.id, w.active_count]));
    const clientSelect = document.getElementById('proj-client');
    if (clientSelect) {
      clientSelect.innerHTML =
        `<option value="">- Manual / none -</option>` +
        (clients.data || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    }
    const devSelect = document.getElementById('proj-developer');
    if (devSelect) {
      devSelect.innerHTML =
        `<option value="">- Unassigned -</option>` +
        (developers.data || [])
          .map((d) => {
            const n = loadMap[d.id];
            const load = n != null ? ` (${n} active)` : '';
            return `<option value="${d.id}">${esc(d.name)}${load}</option>`;
          })
          .join('');
    }
  }

  // ---------- Dashboard ----------
  async function mountHome() {
    const host = document.getElementById('sales-dashboard');
    if (!host) return;

    try {
      const res = await CresAPI.request('/api/sales/dashboard');
      const { kpis, chart: chartData } = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Calls today (target ${kpis.callsTarget || 5})</div><div class="kpi-value">${kpis.callsToday ?? 0}</div></div>
          <div class="kpi-card"><div class="kpi-label">Meetings this week</div><div class="kpi-value">${kpis.meetingsThisWeek ?? 0}</div></div>
          <div class="kpi-card"><div class="kpi-label">Deposits collected</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(kpis.depositsCollected || 0)}</div></div>
          <a href="#/pipeline" class="kpi-card kpi-link" id="kpi-followups-due" title="Overdue follow-ups">
            <div class="kpi-label">Overdue follow-ups</div>
            <div class="kpi-value">${kpis.followUpsDue}</div>
          </a>
        </div>
        <div class="chart-panel">
          <h3>Leads contacted this week</h3>
          <div class="chart-wrap"><canvas id="sales-leads-chart"></canvas></div>
        </div>`;

      document.getElementById('kpi-followups-due')?.addEventListener('click', (e) => {
        e.preventDefault();
        sessionStorage.setItem('cres_pipeline_stage', 'meeting');
        location.hash = '#/pipeline';
      });

      const ctx = document.getElementById('sales-leads-chart');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: chartData.labels,
          datasets: [{
            label: 'Engagements',
            data: chartData.values,
            backgroundColor: 'rgba(0, 168, 197, 0.65)',
            borderRadius: 6,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(42,52,65,0.5)' } },
            y: {
              beginAtZero: true,
              ticks: { color: '#8b9aab', precision: 0 },
              grid: { color: 'rgba(42,52,65,0.5)' },
            },
          },
        },
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  const PIPELINE_STAGES = {
    new: ['new', 'contacting'],
    contacted: ['contacted'],
    meeting: ['meeting', 'follow_up'],
    proposal: ['proposal'],
    won: ['won', 'converted'],
    lost: ['lost', 'not_interested'],
  };

  function pipelineStage(status) {
    for (const [stage, list] of Object.entries(PIPELINE_STAGES)) {
      if (list.includes(status)) return stage;
    }
    return 'new';
  }

  function stageLabel(status) {
    const s = pipelineStage(status);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------- Pipeline (leads + won clients) ----------
  async function mountLeads() {
    const me = CresAPI.getUser();
    const stored = sessionStorage.getItem('cres_pipeline_stage');
    if (stored) {
      document.querySelectorAll('#pipeline-tabs [data-stage]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.stage === stored);
      });
      sessionStorage.removeItem('cres_pipeline_stage');
    }
    const stage = document.querySelector('#pipeline-tabs button.active')?.dataset.stage || '';
    const leadsWrap = document.getElementById('pipeline-leads-wrap');
    const clientsWrap = document.getElementById('pipeline-clients-wrap');
    const canEditLeads = canCrmMutate(me?.role);
    ['btn-new-lead', 'btn-voice-capture'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !canEditLeads || stage === 'clients';
    });
    const newClientBtn = document.getElementById('btn-new-client');
    if (newClientBtn) newClientBtn.hidden = !canEditLeads || stage !== 'clients';
    if (stage === 'clients') {
      if (leadsWrap) leadsWrap.hidden = true;
      if (clientsWrap) clientsWrap.hidden = false;
      await mountClients();
      return;
    }
    if (leadsWrap) leadsWrap.hidden = false;
    if (clientsWrap) clientsWrap.hidden = true;
    const q = document.getElementById('leads-search')?.value || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const res = await CresAPI.request(`/api/leads?${params}`);
    const tbody = document.getElementById('leads-tbody');
    let rows = res.data || [];
    if (stage && PIPELINE_STAGES[stage]) {
      rows = rows.filter((l) => PIPELINE_STAGES[stage].includes(l.status));
    }
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No leads in this stage. Add a lead to start.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (l) => `<tr data-id="${l.id}">
          <td>${esc(l.name)}<div class="meta">${esc(l.email || '')}</div></td>
          <td>${esc(l.phone || '-')}</td>
          <td>${esc(l.business_name || '-')}</td>
          <td>${l.value_amount != null ? fmtMoney(l.value_amount) : '—'}</td>
          <td>${fmtDate(l.next_follow_up)}</td>
          <td>${statusPill(stageLabel(l.status))}</td>
          <td>${
            canEditLeads
              ? `<button type="button" class="btn btn-ghost btn-sm" data-delete-lead="${esc(l.id)}" style="padding:6px 10px;font-size:0.8rem;color:#ffb4b4;">Delete</button>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-delete-lead]')) return;
        openLeadDetail(tr.dataset.id);
      });
    });
    tbody.querySelectorAll('[data-delete-lead]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLead(btn.dataset.deleteLead).catch((err) => alert(err.message));
      });
    });
  }

  async function openLeadDetail(id) {
    leadModalId = id;
    const [leadRes, engRes, msgRes] = await Promise.all([
      CresAPI.request(`/api/leads/${id}`),
      CresAPI.request(`/api/leads/${id}/engagements`),
      CresAPI.request(`/api/leads/${id}/messages`).catch(() => ({ data: [] })),
    ]);
    const lead = leadRes.data;
    document.getElementById('lead-detail-title').textContent = lead.name;
    document.getElementById('lead-edit-name').value = lead.name || '';
    document.getElementById('lead-edit-phone').value = lead.phone || '';
    document.getElementById('lead-edit-email').value = lead.email || '';
    document.getElementById('lead-edit-business').value = lead.business_name || '';
    const typeEl = document.getElementById('lead-edit-business-type');
    if (typeEl) typeEl.value = lead.business_type || '';
    const mapped = pipelineStage(lead.status);
    document.getElementById('lead-edit-status').value = mapped;
    const valueEl = document.getElementById('lead-edit-value');
    if (valueEl) valueEl.value = lead.value_amount != null ? lead.value_amount : '';
    const winBox = document.getElementById('lead-win-box');
    const me = CresAPI.getUser();
    if (winBox) {
      winBox.hidden =
        ['won', 'converted'].includes(lead.status) || !canCrmMutate(me?.role);
    }
    const newLeadBtn = document.getElementById('btn-new-lead');
    if (newLeadBtn) newLeadBtn.hidden = !canCrmMutate(me?.role);
    const delLeadBtn = document.getElementById('btn-delete-lead');
    if (delLeadBtn) delLeadBtn.hidden = !canCrmMutate(me?.role);
    const winName = document.getElementById('win-project-name');
    if (winName && !winName.value) winName.value = `${lead.business_name || lead.name} project`;
    const winVal = document.getElementById('win-value');
    if (winVal && lead.value_amount != null) winVal.value = lead.value_amount;

    const list = document.getElementById('engagement-list');
    list.innerHTML = engRes.data.length
      ? engRes.data
          .map(
            (e) => `<li>
              <div class="meta">${esc(e.created_by_name || '')} · ${CresFormat.datetime(e.created_at)}${
                e.follow_up_date ? ` · follow-up ${fmtDate(e.follow_up_date)}` : ''
              }</div>
              <div>${esc(e.note)}</div>
            </li>`
          )
          .join('')
      : `<li class="empty-state">No engagements yet.</li>`;

    const msgList = document.getElementById('lead-messages-list');
    if (msgList) {
      msgList.innerHTML = msgRes.data.length
        ? msgRes.data
            .map(
              (m) => `<li>
                <div class="meta">${statusPill(m.status)} · scheduled ${CresFormat.datetime(m.scheduled_for)}${
                  m.sent_at ? ` · sent ${CresFormat.datetime(m.sent_at)}` : ''
                }</div>
                <div><strong>${esc(m.subject)}</strong></div>
                <div style="white-space:pre-wrap;margin-top:4px;">${esc(m.body)}</div>
                ${
                  m.status === 'pending' || m.status === 'failed'
                    ? `<div style="margin-top:8px;">
                        <button type="button" class="btn btn-ghost btn-sm" data-send-msg="${esc(m.id)}" style="padding:4px 8px;font-size:0.75rem;">Send now</button>
                      </div>`
                    : ''
                }
                ${m.error ? `<div class="meta" style="color:#ffb4b4;">${esc(m.error)}</div>` : ''}
              </li>`
            )
            .join('')
        : `<li class="empty-state">No scheduled emails yet.</li>`;

      msgList.querySelectorAll('[data-send-msg]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await CresAPI.request(`/api/leads/${leadModalId}/messages/${btn.dataset.sendMsg}/send`, {
              method: 'POST',
              body: {},
              idempotencyKey: `lead-send-${btn.dataset.sendMsg}-${Date.now()}`,
            });
            flash(document.getElementById('lead-detail-flash'), 'Email queued to lead');
            await openLeadDetail(leadModalId);
          } catch (err) {
            flash(document.getElementById('lead-detail-flash'), err.message, false);
          }
        });
      });
    }

    document.getElementById('lead-detail-modal').classList.add('open');
  }

  async function saveLeadEdit(e) {
    e.preventDefault();
    await CresAPI.request(`/api/leads/${leadModalId}`, {
      method: 'PATCH',
      body: {
        name: document.getElementById('lead-edit-name').value,
        phone: document.getElementById('lead-edit-phone').value,
        email: document.getElementById('lead-edit-email').value,
        business_name: document.getElementById('lead-edit-business').value,
        business_type: document.getElementById('lead-edit-business-type')?.value || null,
        status: document.getElementById('lead-edit-status').value,
        value_amount: document.getElementById('lead-edit-value')?.value
          ? Number(document.getElementById('lead-edit-value').value)
          : null,
      },
    });
    await mountLeads();
    flash(document.getElementById('lead-detail-flash'), 'Lead updated');
  }

  async function deleteLead(id) {
    const name = document.getElementById('lead-detail-title')?.textContent || 'this lead';
    if (!confirm(`Delete ${name}? It will leave the pipeline. Linked clients stay unless you delete them separately.`)) {
      return;
    }
    await CresAPI.request(`/api/leads/${id}`, { method: 'DELETE' });
    document.getElementById('lead-detail-modal')?.classList.remove('open');
    leadModalId = null;
    await mountLeads();
  }

  async function createClient(e) {
    e.preventDefault();
    await CresAPI.request('/api/clients', {
      method: 'POST',
      body: {
        name: document.getElementById('new-client-name').value.trim(),
        phone: document.getElementById('new-client-phone').value.trim() || null,
        email: document.getElementById('new-client-email').value.trim() || null,
        business_name: document.getElementById('new-client-business').value.trim() || null,
      },
      idempotencyKey: `client-${Date.now()}`,
    });
    document.getElementById('new-client-modal')?.classList.remove('open');
    e.target.reset();
    await mountClients();
  }

  async function deleteClient(id, name) {
    if (!confirm(`Delete client ${name || ''}? Their projects leave the board. Invoices and receipts stay.`)) {
      return;
    }
    await CresAPI.request(`/api/clients/${id}`, { method: 'DELETE' });
    document.getElementById('client-card-modal')?.classList.remove('open');
    await mountClients();
    await refreshProjectsView().catch(() => {});
  }

  async function addEngagement(e) {
    e.preventDefault();
    const note = document.getElementById('eng-note').value.trim();
    const follow_up_date = document.getElementById('eng-followup').value || null;
    const status = document.getElementById('eng-status').value || undefined;
    const res = await CresAPI.request(`/api/leads/${leadModalId}/engagements`, {
      method: 'POST',
      body: { note, follow_up_date, status },
      idempotencyKey: `eng-${leadModalId}-${Date.now()}`,
    });
    document.getElementById('eng-note').value = '';
    document.getElementById('eng-followup').value = '';
    document.getElementById('eng-status').value = '';
    if (res.data.client) {
      flash(document.getElementById('lead-detail-flash'), 'Lead converted to client');
    } else {
      flash(document.getElementById('lead-detail-flash'), 'Engagement logged');
    }
    await openLeadDetail(leadModalId);
    await mountLeads();
  }

  async function createLead(e) {
    e.preventDefault();
    const body = {
      name: document.getElementById('new-lead-name').value.trim(),
      phone: document.getElementById('new-lead-phone').value.trim(),
      email: document.getElementById('new-lead-email').value.trim(),
      business_name: document.getElementById('new-lead-business').value.trim(),
      business_type: document.getElementById('new-lead-business-type')?.value.trim() || '',
      value_amount: document.getElementById('new-lead-value')?.value
        ? Number(document.getElementById('new-lead-value').value)
        : null,
      status: 'new',
    };
    try {
      await CresAPI.request('/api/leads', {
        method: 'POST',
        body,
        idempotencyKey: `lead-${body.email || body.name}-${Date.now()}`,
      });
    } catch (err) {
      if (err.code === 'DUPLICATE_LEAD' && err.status === 409) {
        const dups = err.details?.duplicates || [];
        const lines = dups
          .map((d) => `• ${d.name || 'Lead'}${d.phone ? ` (${d.phone})` : ''}${d.business_name ? ` — ${d.business_name}` : ''}`)
          .join('\n');
        const msg = `Possible duplicate lead found:\n${lines || '(see existing records)'}\n\nCreate anyway?`;
        if (!confirm(msg)) return;
        await CresAPI.request('/api/leads', {
          method: 'POST',
          body: { ...body, force: true },
          idempotencyKey: `lead-force-${body.email || body.name}-${Date.now()}`,
        });
      } else {
        throw err;
      }
    }
    document.getElementById('new-lead-modal').classList.remove('open');
    e.target.reset();
    await mountLeads();
  }

  // ---------- Clients ----------
  async function mountClients() {
    const res = await CresAPI.request('/api/clients');
    const tbody = document.getElementById('clients-tbody');
    const canMutate = canCrmMutate(CresAPI.getUser()?.role);
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No clients yet. Add a client or mark a lead as won.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.data
      .map(
        (c) => `<tr class="clickable-row" data-id="${c.id}" data-name="${esc(c.name)}">
          <td>${esc(c.name)}</td>
          <td>${esc(c.phone || '-')}</td>
          <td>${esc(c.email || '-')}</td>
          <td>${esc(c.business_name || '-')}</td>
          <td>${c.project_count ?? 0}</td>
          <td>${
            canMutate
              ? `<button type="button" class="btn btn-ghost btn-sm" data-delete-client="${esc(c.id)}" style="padding:6px 10px;font-size:0.8rem;color:#ffb4b4;">Delete</button>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
    tbody.querySelectorAll('[data-delete-client]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('tr');
        deleteClient(btn.dataset.deleteClient, row?.dataset.name).catch((err) => alert(err.message));
      });
    });
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-delete-client]')) return;
        if (typeof CresClientCard !== 'undefined') {
          CresClientCard.open(tr.dataset.id).catch(console.error);
        } else {
          openClientProjects(tr.dataset.id);
        }
      });
    });
  }

  async function openClientProjects(id) {
    const [client, projects] = await Promise.all([
      CresAPI.request(`/api/clients/${id}`),
      CresAPI.request(`/api/clients/${id}/projects`),
    ]);
    document.getElementById('client-projects-title').textContent =
      `${client.data.name} - projects`;
    const list = document.getElementById('client-projects-list');
    if (!projects.data.length) {
      list.innerHTML = `<div class="empty-state">No linked projects yet.</div>`;
    } else {
      list.innerHTML = `<div class="data-table-wrap"><table class="data-table">
        <thead><tr><th>Name</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>${projects.data
          .map(
            (p) => `<tr>
              <td>${esc(p.name)}</td>
              <td>${statusPill(p.status)}</td>
              <td>${fmtDate(p.created_at)}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    }
    document.getElementById('client-projects-modal').classList.add('open');
  }

  // ---------- Reports ----------
  async function mountReports() {
    const res = await CresAPI.request('/api/reports');
    const list = document.getElementById('reports-list');
    list.innerHTML = res.data.length
      ? res.data
          .map((r) => {
            const reviewed =
              r.routing_status === 'pm_reviewed' || r.routing_status === 'forwarded_director'
                ? 'Yes'
                : 'Pending';
            const remarksHtml = r.remarks
              ? `<div class="rejection-banner" style="margin:0 0 6px;">${esc(r.remarks)}</div>
                 <div class="meta">${esc(r.remarks_by_name || 'Director')} · ${
                  r.remarks_at ? CresFormat.datetime(r.remarks_at) : ''
                }</div>
                 ${r.remarks_reply
                   ? `<div style="margin-top:6px;padding:8px;border-left:3px solid var(--accent);background:rgba(0,168,197,0.06);border-radius:0 6px 6px 0;">
                        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:2px;">Your reply</div>
                        <div>${esc(r.remarks_reply)}</div>
                      </div>`
                   : `<div style="margin-top:6px;">
                        <textarea data-reply-input="${esc(r.id)}" rows="2" placeholder="Reply to Director's remarks…" style="width:100%;font-size:0.85rem;"></textarea>
                        <button type="button" class="btn btn-primary btn-sm" data-reply="${esc(r.id)}" style="margin-top:4px;">Send reply</button>
                      </div>`
                 }`
              : '<span class="meta">No remarks yet</span>';
            return `<tr>
              <td>${CresFormat.datetime(r.created_at)}</td>
              <td>${statusPill(r.routing_status || 'pending_pm')}</td>
              <td>${esc(reviewed)}${r.reviewed_by_name ? ` · ${esc(r.reviewed_by_name)}` : ''}</td>
              <td>${esc(r.content)}${
                (r.attachments || []).length
                  ? `<div class="file-chips">${r.attachments
                      .map((a) => `<span>${esc(a.originalName || a.path)}</span>`)
                      .join('')}</div>`
                  : ''
              }</td>
              <td>${remarksHtml}</td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="5" class="empty-state">No reports submitted yet.</td></tr>`;

    // Bind reply buttons
    list.querySelectorAll('[data-reply]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.reply;
        const input = list.querySelector(`[data-reply-input="${id}"]`);
        const reply = input?.value?.trim();
        if (!reply) return;
        try {
          await CresAPI.request(`/api/reports/${id}/reply`, {
            method: 'POST',
            body: { reply },
          });
          await mountReports();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  async function submitReport(e) {
    e.preventDefault();
    const fd = new FormData();
    fd.append('content', document.getElementById('report-content').value.trim());
    const blockers = document.getElementById('report-blockers')?.value.trim();
    const attention = document.getElementById('report-attention')?.value.trim();
    const hard = document.getElementById('report-hard')?.value.trim();
    const easy = document.getElementById('report-easy')?.value.trim();
    const happy = document.getElementById('report-happiness')?.value.trim();
    const concerns = document.getElementById('report-concerns')?.value.trim();
    if (blockers) fd.append('blockers_text', blockers);
    if (attention) fd.append('needs_attention', attention);
    if (hard) fd.append('hard_today', hard);
    if (easy) fd.append('easy_today', easy);
    if (happy) fd.append('happiness', happy);
    if (concerns) fd.append('concerns', concerns);
    const projectId = document.getElementById('report-project').value;
    if (projectId) fd.append('project_id', projectId);
    const files = document.getElementById('report-files').files;
    for (const f of files) fd.append('attachments', f);

    await CresAPI.request('/api/reports', { method: 'POST', body: fd });
    e.target.reset();
    flash(document.getElementById('reports-flash'), 'Report submitted');
    await mountReports();
  }

  // ---------- Follow-ups ----------
  async function mountFollowups() {
    const res = await CresAPI.request('/api/invoices/followups');
    const tbody = document.getElementById('followups-tbody');
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No invoices flagged to you.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.data
      .map(
        (f) => `<tr>
          <td>${esc(f.client_name || f.client_business || '-')}</td>
          <td>${statusPill(f.invoice_status)}</td>
          <td>${statusPill(f.status)}</td>
          <td>${
            f.status === 'pending'
              ? `<button type="button" class="btn btn-ghost" data-follow="${f.id}" style="padding:6px 10px;font-size:0.8rem;">Mark followed up</button>`
              : '-'
          }</td>
        </tr>`
      )
      .join('');
    tbody.querySelectorAll('[data-follow]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await CresAPI.request(`/api/invoices/followups/${btn.dataset.follow}/followed-up`, {
          method: 'POST',
        });
        await mountFollowups();
      });
    });
  }

  async function pickDeveloper(title) {
    const developers = await CresAPI.request('/api/users/developers');
    const list = developers.data || [];
    if (!list.length) {
      alert('No developers available');
      return null;
    }
    const choice = prompt(
      `${title}\n\nEnter number:\n` + list.map((d, i) => `${i + 1}. ${d.name}`).join('\n')
    );
    if (choice == null || choice === '') return null;
    const idx = Number(choice) - 1;
    if (!list[idx]) {
      alert('Invalid selection');
      return null;
    }
    return list[idx].id;
  }

  async function reassignProject(projectId) {
    const developerId = await pickDeveloper('Reassign project to developer');
    if (!developerId) return;
    await CresAPI.request('/api/assignments', {
      method: 'POST',
      body: { project_id: projectId, developer_id: developerId },
      idempotencyKey: `assign-${projectId}-${Date.now()}`,
    });
    flash(document.getElementById('projects-flash'), 'Developer invitation sent');
    await mountProjects();
  }

  // ---------- Email ----------
  async function mountEmail() {
    const clients = await CresAPI.request('/api/clients');
    const select = document.getElementById('email-client');
    select.innerHTML =
      `<option value="">- Type address below -</option>` +
      clients.data
        .map((c) => `<option value="${c.id}" data-email="${esc(c.email || '')}">${esc(c.name)}${c.email ? ` (${esc(c.email)})` : ''}</option>`)
        .join('');

    const hist = await CresAPI.request('/api/emails');
    const list = document.getElementById('email-history');
    list.innerHTML = hist.data.length
      ? hist.data
          .map(
            (m) => `<li>
              <div class="meta">${CresFormat.datetime(m.created_at)} · ${esc(m.status)} · to ${esc(m.to_email)}</div>
              <strong>${esc(m.subject)}</strong>
              <div style="margin-top:4px;color:var(--text-muted);font-size:0.85rem;">${esc(m.body.slice(0, 160))}${m.body.length > 160 ? '…' : ''}</div>
            </li>`
          )
          .join('')
      : `<li class="empty-state">No emails sent yet.</li>`;
  }

  async function sendEmail(e) {
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
      idempotencyKey: `email-${Date.now()}`,
    });
    e.target.reset();
    flash(document.getElementById('email-flash'), 'Email queued for delivery');
    await mountEmail();
  }

  // ---------- Projects ----------
  async function mountProjects() {
    const [projects, clients, developers, workload] = await Promise.all([
      CresAPI.request('/api/projects'),
      CresAPI.request('/api/clients'),
      CresAPI.request('/api/users/developers'),
      CresAPI.request('/api/projects/meta/developer-workload').catch(() => ({ data: [] })),
    ]);

    const tbody = document.getElementById('projects-tbody');
    const devMap = Object.fromEntries(developers.data.map((d) => [d.id, d.name]));
    const clientMap = Object.fromEntries(clients.data.map((c) => [c.id, c.name]));
    const loadMap = Object.fromEntries((workload.data || []).map((w) => [w.id, w.active_count]));

    const exportBtn = document.getElementById('btn-export-projects');
    if (exportBtn) exportBtn.hidden = false;

    const thead = document.querySelector('#sales-projects-chrome thead tr');
    if (thead) {
      thead.innerHTML =
        '<th>Name</th><th>Client</th><th>Status</th><th>Value</th><th>Due</th><th>Progress</th><th>Developer</th><th></th>';
    }

    if (!projects.data.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No projects yet.</td></tr>`;
    } else {
      tbody.innerHTML = projects.data
        .map((p) => {
          const rejected = p.status === 'rejected';
          const assignStatus = p.assignment_status || 'unassigned';
          const canReassign =
            !['pending_approval', 'rejected'].includes(p.status) &&
            ['rejected', 'unassigned'].includes(assignStatus);
          const actions = [];
          if (rejected) {
            actions.push(
              `<button type="button" class="btn btn-ghost btn-sm" data-resubmit="${esc(p.id)}" style="padding:6px 10px;font-size:0.8rem;">Edit &amp; resubmit</button>`
            );
          }
          if (canReassign) {
            actions.push(
              `<button type="button" class="btn btn-primary btn-sm" data-reassign="${esc(p.id)}" style="padding:6px 10px;font-size:0.8rem;">Reassign</button>`
            );
          }
          if (canCrmMutate(CresAPI.getUser()?.role)) {
            actions.push(
              `<button type="button" class="btn btn-ghost btn-sm" data-delete-project="${esc(p.id)}" data-name="${esc(p.name)}" style="padding:6px 10px;font-size:0.8rem;color:#ffb4b4;">Delete</button>`
            );
          }
          const pct = p.progress_percent != null ? `${Number(p.progress_percent)}%` : '—';
          return `<tr class="clickable-row" data-id="${esc(p.id)}">
            <td>${esc(p.name)}
              ${rejected && p.rejection_reason
                ? `<div class="rejection-banner" style="margin-top:6px;">Rejection reason: ${esc(p.rejection_reason)}</div>`
                : rejected
                  ? `<div class="meta" style="margin-top:4px;color:#ffb4b4;">Rejected — open Edit &amp; resubmit for details</div>`
                  : ''}
            </td>
            <td>${esc(p.client_name || clientMap[p.client_id] || '-')}</td>
            <td>${statusPill(p.status)}</td>
            <td>${p.value_amount != null ? fmtMoney(p.value_amount) : '—'}</td>
            <td>${fmtDate(p.due_date)}</td>
            <td>${esc(pct)}</td>
            <td>${esc(devMap[p.assigned_developer_id] || '-')}</td>
            <td>${actions.length ? actions.join(' ') : '-'}</td>
          </tr>`;
        })
        .join('');
      tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('[data-resubmit],[data-reassign],[data-delete-project]')) return;
          if (typeof CresProjectDetail !== 'undefined') {
            CresProjectDetail.open(tr.dataset.id, { onSaved: () => mountProjects() }).catch(console.error);
          }
        });
      });
      tbody.querySelectorAll('[data-resubmit]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openResubmitModal(btn.dataset.resubmit).catch((err) => alert(err.message));
        });
      });
      tbody.querySelectorAll('[data-reassign]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          reassignProject(btn.dataset.reassign).catch((err) => alert(err.message));
        });
      });
      tbody.querySelectorAll('[data-delete-project]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteProject(btn.dataset.deleteProject, btn.dataset.name).catch((err) => alert(err.message));
        });
      });
    }

    const clientSelect = document.getElementById('proj-client');
    clientSelect.innerHTML =
      `<option value="">- Manual / none -</option>` +
      clients.data.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    const devSelect = document.getElementById('proj-developer');
    devSelect.innerHTML =
      `<option value="">- Unassigned -</option>` +
      developers.data
        .map((d) => {
          const n = loadMap[d.id];
          const load = n != null ? ` (${n} active)` : '';
          return `<option value="${d.id}">${esc(d.name)}${load}</option>`;
        })
        .join('');

    const reportProj = document.getElementById('report-project');
    if (reportProj) {
      reportProj.innerHTML =
        `<option value="">- No project -</option>` +
        projects.data.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    }
  }

  async function openResubmitModal(id) {
    resubmitProjectId = id;
    const [projRes, developers] = await Promise.all([
      CresAPI.request(`/api/projects/${id}`),
      CresAPI.request('/api/users/developers'),
    ]);
    const p = projRes.data;
    const milestones = Array.isArray(p.milestones) ? p.milestones : [];

    document.getElementById('resubmit-project-title').textContent = `Edit & resubmit — ${p.name}`;
    document.getElementById('resubmit-reason').textContent = p.rejection_reason
      ? `Rejection reason: ${p.rejection_reason}`
      : 'This project was rejected. Update and resubmit for Director approval.';
    document.getElementById('resubmit-name').value = p.name || '';
    document.getElementById('resubmit-description').value = p.description || p.summary || '';
    document.getElementById('resubmit-value').value = p.value_amount != null ? p.value_amount : '';

    const msList = document.getElementById('resubmit-milestone-list');
    msList.innerHTML = (milestones.length ? milestones : [{ title: '' }])
      .map(
        (m) => `<div class="milestone-row">
          <input placeholder="Milestone title" value="${esc(m.title || m.name || '')}" />
          <button type="button" class="btn btn-ghost" data-remove-ms style="padding:6px 10px;">✕</button>
        </div>`
      )
      .join('');

    const devSelect = document.getElementById('resubmit-developer');
    devSelect.innerHTML =
      `<option value="">- Unassigned -</option>` +
      developers.data
        .map(
          (d) =>
            `<option value="${d.id}" ${d.id === p.assigned_developer_id ? 'selected' : ''}>${esc(d.name)}</option>`
        )
        .join('');

    document.getElementById('resubmit-project-modal').classList.add('open');
  }

  async function submitResubmit(e) {
    e.preventDefault();
    const milestones = [...document.querySelectorAll('#resubmit-milestone-list input')]
      .map((i) => i.value.trim())
      .filter(Boolean)
      .map((title) => ({ title, status: 'not_started', tasks: [] }));

    const overview = document.getElementById('resubmit-description').value.trim();
    await CresAPI.request(`/api/projects/${resubmitProjectId}/resubmit`, {
      method: 'PATCH',
      body: {
        name: document.getElementById('resubmit-name').value.trim(),
        description: overview,
        summary: overview,
        milestones,
        assigned_developer_id: document.getElementById('resubmit-developer').value || null,
        value_amount: document.getElementById('resubmit-value').value
          ? Number(document.getElementById('resubmit-value').value)
          : null,
      },
      idempotencyKey: `resubmit-${resubmitProjectId}-${Date.now()}`,
    });
    document.getElementById('resubmit-project-modal').classList.remove('open');
    flash(document.getElementById('projects-flash'), 'Project resubmitted for Director approval');
    await mountProjects();
  }

  async function createProject(e) {
    e.preventDefault();
    const milestones = [...document.querySelectorAll('#milestone-list input')]
      .map((i) => i.value.trim())
      .filter(Boolean)
      .map((title) => ({ title, status: 'not_started', tasks: [] }));

    let client_id = document.getElementById('proj-client').value || null;
    const manualName = document.getElementById('proj-manual-client').value.trim();

    if (!client_id && manualName) {
      const created = await CresAPI.request('/api/clients', {
        method: 'POST',
        body: {
          name: manualName,
          business_name: document.getElementById('proj-manual-business').value.trim() || null,
          email: document.getElementById('proj-manual-email').value.trim() || null,
          phone: document.getElementById('proj-manual-phone').value.trim() || null,
        },
        idempotencyKey: `manual-client-${manualName}-${Date.now()}`,
      });
      client_id = created.data.id;
    }

    const overview = document.getElementById('proj-description').value.trim();
    await CresAPI.request('/api/projects', {
      method: 'POST',
      body: {
        name: document.getElementById('proj-name').value.trim(),
        description: overview,
        summary: overview,
        milestones,
        client_id,
        assigned_developer_id: document.getElementById('proj-developer').value || null,
        value_amount: document.getElementById('proj-value').value
          ? Number(document.getElementById('proj-value').value)
          : null,
        due_date: document.getElementById('proj-due')?.value || null,
      },
      idempotencyKey: `proj-${Date.now()}`,
    });

    document.getElementById('new-project-modal').classList.remove('open');
    e.target.reset();
    document.getElementById('milestone-list').innerHTML =
      `<div class="milestone-row"><input placeholder="Milestone title" /><button type="button" class="btn btn-ghost" data-remove-ms style="padding:6px 10px;">✕</button></div>`;
    flash(document.getElementById('projects-flash'), 'Project submitted for Director approval');
    await refreshProjectsView();
  }

  async function deleteProject(id, name) {
    if (!confirm(`Delete project ${name || ''}? It leaves the board. Invoices and receipts stay.`)) {
      return;
    }
    await CresAPI.request(`/api/projects/${id}`, { method: 'DELETE' });
    document.getElementById('project-detail-modal')?.classList.remove('open');
    const flashEl =
      document.getElementById('projects-flash') || document.getElementById('admin-projects-flash');
    flash(flashEl, 'Project deleted');
    await refreshProjectsView();
  }

  function bindModals() {
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.closest('.modal-backdrop')?.classList.remove('open');
      });
    });
    document.querySelectorAll('.modal-backdrop').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.remove('open');
      });
    });

    document.getElementById('btn-new-lead')?.addEventListener('click', () => {
      document.getElementById('new-lead-modal').classList.add('open');
    });
    document.getElementById('btn-new-client')?.addEventListener('click', () => {
      document.getElementById('new-client-modal').classList.add('open');
    });
    document.getElementById('btn-new-project')?.addEventListener('click', () => {
      fillProjectCreateOptions().catch(console.error);
      document.getElementById('new-project-modal').classList.add('open');
    });
    document.getElementById('btn-new-admin-project')?.addEventListener('click', () => {
      fillProjectCreateOptions().catch(console.error);
      document.getElementById('new-project-modal').classList.add('open');
    });
    document.getElementById('btn-delete-lead')?.addEventListener('click', () => {
      if (!leadModalId) return;
      deleteLead(leadModalId).catch((err) => alert(err.message));
    });
    document.getElementById('new-client-form')?.addEventListener('submit', (e) =>
      createClient(e).catch((err) => alert(err.message))
    );
    document.getElementById('add-milestone')?.addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'milestone-row';
      row.innerHTML = `<input placeholder="Milestone title" /><button type="button" class="btn btn-ghost" data-remove-ms style="padding:6px 10px;">✕</button>`;
      document.getElementById('milestone-list').appendChild(row);
      row.querySelector('[data-remove-ms]').addEventListener('click', () => row.remove());
    });
    document.getElementById('milestone-list')?.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-ms]')) e.target.closest('.milestone-row')?.remove();
    });

    document.getElementById('add-resubmit-milestone')?.addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'milestone-row';
      row.innerHTML = `<input placeholder="Milestone title" /><button type="button" class="btn btn-ghost" data-remove-ms style="padding:6px 10px;">✕</button>`;
      document.getElementById('resubmit-milestone-list').appendChild(row);
    });
    document.getElementById('resubmit-milestone-list')?.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-ms]')) e.target.closest('.milestone-row')?.remove();
    });

    document.getElementById('leads-search')?.addEventListener('input', () => {
      clearTimeout(mountLeads._t);
      mountLeads._t = setTimeout(() => mountLeads().catch(console.error), 250);
    });
    document.getElementById('leads-status')?.addEventListener('change', () => mountLeads());

    document.getElementById('new-lead-form')?.addEventListener('submit', (e) =>
      createLead(e).catch((err) => alert(err.message))
    );
    document.getElementById('lead-edit-form')?.addEventListener('submit', (e) =>
      saveLeadEdit(e).catch((err) => alert(err.message))
    );
    document.getElementById('engagement-form')?.addEventListener('submit', (e) =>
      addEngagement(e).catch((err) => alert(err.message))
    );

    async function submitLeadMessage({ sendNow }) {
      if (!leadModalId) return;
      const subject = document.getElementById('lead-msg-subject').value.trim();
      const body = document.getElementById('lead-msg-body').value.trim();
      const when = document.getElementById('lead-msg-when').value;
      const payload = {
        subject,
        body,
        send_now: !!sendNow,
        scheduled_for: when || undefined,
      };
      if (!sendNow && !when) {
        throw new Error('Pick a send time, or use Send now');
      }
      await CresAPI.request(`/api/leads/${leadModalId}/messages`, {
        method: 'POST',
        body: payload,
        idempotencyKey: `lead-msg-${leadModalId}-${Date.now()}`,
      });
      document.getElementById('lead-message-form')?.reset();
      flash(
        document.getElementById('lead-detail-flash'),
        sendNow ? 'Email queued to lead' : 'Email scheduled'
      );
      await openLeadDetail(leadModalId);
    }

    document.getElementById('lead-message-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      submitLeadMessage({ sendNow: false }).catch((err) =>
        flash(document.getElementById('lead-detail-flash'), err.message, false)
      );
    });
    document.getElementById('lead-msg-send-now')?.addEventListener('click', () => {
      submitLeadMessage({ sendNow: true }).catch((err) =>
        flash(document.getElementById('lead-detail-flash'), err.message, false)
      );
    });

    // Daily report submit is bound by CresMyWork on #/work.
    document.getElementById('email-form')?.addEventListener('submit', (e) => {
      if (CresAPI.getUser()?.role === 'finance') return;
      sendEmail(e).catch((err) => alert(err.message));
    });
    document.getElementById('new-project-form')?.addEventListener('submit', (e) =>
      createProject(e).catch((err) => alert(err.message))
    );
    document.getElementById('resubmit-project-form')?.addEventListener('submit', (e) =>
      submitResubmit(e).catch((err) => alert(err.message))
    );

    document.getElementById('btn-export-projects')?.addEventListener('click', () => {
      CresAPI.download('/api/export/projects.csv', 'projects.csv').catch((err) => alert(err.message));
    });

    document.getElementById('email-client')?.addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt?.dataset.email) document.getElementById('email-to').value = opt.dataset.email;
    });

    document.getElementById('lead-win-form')?.addEventListener('submit', (e) =>
      submitWin(e).catch((err) => flash(document.getElementById('lead-detail-flash'), err.message, false))
    );

    document.querySelectorAll('#pipeline-tabs [data-stage]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#pipeline-tabs [data-stage]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        mountLeads().catch(console.error);
      });
    });
    document.getElementById('leads-search')?.addEventListener('input', () => {
      clearTimeout(mountLeads._t);
      mountLeads._t = setTimeout(() => mountLeads().catch(console.error), 250);
    });

    initVoiceCapture();
    CresVoiceForms?.initVoiceForms();
  }

  async function submitWin(e) {
    e.preventDefault();
    if (!leadModalId) return;
    const res = await CresAPI.request(`/api/leads/${leadModalId}/win`, {
      method: 'POST',
      body: {
        project_name: document.getElementById('win-project-name').value.trim(),
        value_amount: document.getElementById('win-value').value
          ? Number(document.getElementById('win-value').value)
          : undefined,
        deposit_amount: document.getElementById('win-deposit').value
          ? Number(document.getElementById('win-deposit').value)
          : 0,
        due_date: document.getElementById('win-due').value || undefined,
      },
      idempotencyKey: `win-${leadModalId}-${Date.now()}`,
    });
    flash(
      document.getElementById('lead-detail-flash'),
      res.data?.invoice
        ? 'Won — client, project, and deposit invoice created'
        : 'Won — client and project created (awaiting Director approval)'
    );
    e.target.reset();
    await openLeadDetail(leadModalId);
    await mountLeads();
  }

  async function mount(faceId, user) {
    if (!['sales', 'director', 'pm', 'admin'].includes(user.role)) return;

    if (faceId === 'home' && user.role === 'sales') {
      await mountHome();
    } else if (faceId === 'pipeline' || faceId === 'leads') {
      await mountLeads();
    } else if (faceId === 'clients') {
      await mountClients();
    } else if (faceId === 'work' && user.role === 'sales') {
      await mountProjects();
    } else if (faceId === 'followups') {
      await mountFollowups();
    } else if (faceId === 'email') {
      await mountEmail();
    } else if (faceId === 'projects') {
      await mountProjects();
    }
  }

  // ---------- Voice capture ----------
  let voiceMediaRecorder = null;
  let voiceStream = null;
  let voiceTimerInterval = null;
  let voiceStartTime = null;
  let voicePauseStartedAt = null;
  let voicePauseElapsed = 0;
  let voiceParsedLeads = [];
  // true when the recording is being thrown away (Close / Re-record), so the
  // recorder's onstop must not upload it.
  let voiceDiscard = false;

  function voiceFlash(msg, ok = true) {
    const el = document.getElementById('voice-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 5000);
  }

  function resetVoiceUI() {
    stopVoiceRecorder(true);
    resetRecorderBtn();
    document.getElementById('voice-recorder-ui').style.display = '';
    document.getElementById('voice-transcript-section').style.display = 'none';
    document.getElementById('voice-leads-section').style.display = 'none';
    document.getElementById('voice-working-indicator').style.display = 'none';
    document.getElementById('voice-leads-table').innerHTML = '';
    document.getElementById('voice-leads-count').textContent = '0';
    document.getElementById('voice-timer').textContent = '00:00';
    voiceParsedLeads = [];
  }

  /**
   * End recording: stop the timer and turn the microphone off. With discard
   * (Close / Re-record) the audio is thrown away instead of being processed.
   */
  function stopVoiceRecorder(discard = true) {
    voiceDiscard = discard;
    if (voiceMediaRecorder && voiceMediaRecorder.state !== 'inactive') {
      try { voiceMediaRecorder.stop(); } catch {}
    }
    if (voiceStream) {
      voiceStream.getTracks().forEach((t) => t.stop());
      voiceStream = null;
    }
    if (voiceTimerInterval) {
      clearInterval(voiceTimerInterval);
      voiceTimerInterval = null;
    }
    voicePauseStartedAt = null;
    voicePauseElapsed = 0;
    const pbtn = document.getElementById('btn-voice-pause');
    if (pbtn) {
      pbtn.style.display = 'none';
      pbtn.textContent = 'Pause';
    }
  }

  function toggleVoicePause() {
    const pbtn = document.getElementById('btn-voice-pause');
    if (!voiceMediaRecorder || !pbtn) return;
    if (voiceMediaRecorder.state === 'recording') {
      voicePauseStartedAt = Date.now();
      voiceMediaRecorder.pause();
      clearInterval(voiceTimerInterval);
      voiceTimerInterval = null;
      pbtn.textContent = 'Resume';
    } else if (voiceMediaRecorder.state === 'paused') {
      voicePauseElapsed += Date.now() - voicePauseStartedAt;
      voicePauseStartedAt = null;
      voiceMediaRecorder.resume();
      pbtn.textContent = 'Pause';
      voiceTimerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - voiceStartTime - voicePauseElapsed) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        document.getElementById('voice-timer').textContent = `${mm}:${ss}`;
      }, 300);
    }
  }

  function preferredMime() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/ogg;codecs=opus',
      'audio/m4a',
      'audio/wav',
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  async function startVoiceRecording() {
    const btn = document.getElementById('btn-voice-record');
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      voiceFlash('Microphone permission denied. Check browser settings.', false);
      return;
    }
    const mime = preferredMime();
    voiceMediaRecorder = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : {});
    const chunks = [];
    voiceMediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    voiceMediaRecorder.onstop = async () => {
      // The mic goes off as soon as recording ends, whichever way it ended.
      voiceStream?.getTracks().forEach((t) => t.stop());
      voiceStream = null;
      if (voiceDiscard) return;
      const blob = new Blob(chunks, { type: voiceMediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1024) {
        voiceFlash('Recording too short. Try again and narrate more contacts.', false);
        resetVoiceUI();
        return;
      }
      await sendVoiceAudio(blob);
    };

    voiceStartTime = Date.now();
    voiceDiscard = false;
    btn.textContent = 'Stop recording';
    btn.style.background = '#c53030';
    btn.classList.remove('btn-primary');
    btn.disabled = false;
    // Stop = finish: timer stops, mic goes off, then the audio is processed.
    btn.onclick = () => {
      stopVoiceRecorder(false);
      btn.textContent = 'Processing…';
      btn.disabled = true;
    };

    const pbtn = document.getElementById('btn-voice-pause');
    if (pbtn) {
      pbtn.style.display = '';
      pbtn.textContent = 'Pause';
      pbtn.onclick = toggleVoicePause;
    }

    document.getElementById('voice-timer').textContent = '00:00';
    voiceTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - voiceStartTime - voicePauseElapsed) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      document.getElementById('voice-timer').textContent = `${mm}:${ss}`;
    }, 300);

    voiceMediaRecorder.start(500); // 500ms timeslice for progress
  }

  async function sendVoiceAudio(blob) {
    const indicator = document.getElementById('voice-working-indicator');
    indicator.style.display = '';
    document.getElementById('voice-recorder-ui').style.display = 'none';
    document.getElementById('voice-transcript-section').style.display = 'none';
    document.getElementById('voice-leads-section').style.display = 'none';

    try {
      const ext = (voiceMediaRecorder?.mimeType || 'audio/webm').includes('ogg')
        ? 'ogg'
        : voiceMediaRecorder?.mimeType?.includes('mp4')
          ? 'm4a'
          : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `leads-capture.${ext}`);

      const res = await CresAPI.request('/api/leads/voice-capture', {
        method: 'POST',
        body: fd,
        idempotencyKey: `voice-capture-${Date.now()}`,
      });

      indicator.style.display = 'none';
      document.getElementById('voice-transcript-section').style.display = '';
      document.getElementById('voice-transcript').textContent =
        res.data.transcript || '(no speech detected)';
      document.getElementById('voice-recorder-ui').style.display = '';
      resetRecorderBtn();

      if (res.data.parse_error) {
        voiceFlash(`Transcript received but parsing failed: ${res.data.parse_error}`, false);
      }
      if (res.data.leads_count) {
        voiceParsedLeads = res.data.leads;
        renderVoiceParsedLeads(res.data.leads);
        voiceFlash(`Parsed ${res.data.leads_count} lead(s) from transcript`);
      } else if (!res.data.parse_error) {
        voiceFlash('No leads detected in audio. Narrate business names and phone numbers.', false);
      }
    } catch (err) {
      indicator.style.display = 'none';
      document.getElementById('voice-recorder-ui').style.display = '';
      resetRecorderBtn();
      voiceFlash(err.message, false);
    }
  }

  function resetRecorderBtn() {
    const btn = document.getElementById('btn-voice-record');
    if (!btn) return;
    btn.textContent = 'Start recording';
    btn.style.background = '';
    btn.classList.add('btn-primary');
    btn.disabled = false;
    btn.onclick = startVoiceRecording;
    const pbtn = document.getElementById('btn-voice-pause');
    if (pbtn) { pbtn.style.display = 'none'; pbtn.textContent = 'Pause'; }
  }

  function renderVoiceParsedLeads(leads) {
    const section = document.getElementById('voice-leads-section');
    section.style.display = '';
    document.getElementById('voice-leads-count').textContent = leads.length;

    const tbl = document.getElementById('voice-leads-table');
    const rows = leads
      .map((l, i) => {
        const bn = esc(String(l.business_name || ''));
        const nm = esc(String(l.name || ''));
        const ph = esc(String(l.phone || ''));
        const bt = esc(String(l.business_type || ''));
        return `<tr style="border-bottom:1px solid var(--border,#d8e0e8);font-size:0.82rem;" data-vidx="${i}">
          <td style="width:28px;text-align:center;padding:6px 4px;"><input type="checkbox" data-voice-idx="${i}" checked /></td>
          <td style="padding:5px 4px;"><input value="${nm}" data-vf="name" style="width:100%;font-size:0.82rem;padding:4px 6px;" /></td>
          <td style="padding:5px 4px;"><input value="${ph}" data-vf="phone" style="width:100%;font-size:0.82rem;padding:4px 6px;" /></td>
          <td style="padding:5px 4px;"><input value="${bn}" data-vf="business_name" style="width:100%;font-size:0.82rem;padding:4px 6px;" /></td>
          <td style="padding:5px 4px;"><input value="${bt}" data-vf="business_type" style="width:100%;font-size:0.82rem;padding:4px 6px;" /></td>
        </tr>`;
      })
      .join('');
    tbl.innerHTML = `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:var(--bg-secondary,#eef2f5);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted,#6b7b8d);">
        <th style="width:28px;"></th><th style="padding:6px 4px;text-align:left;">Contact</th>
        <th style="padding:6px 4px;text-align:left;">Phone</th><th style="padding:6px 4px;text-align:left;">Business</th>
        <th style="padding:6px 4px;text-align:left;">Type</th>
      </tr></thead>
      <tbody>${rows}</tbody></table>`;

    // Sync edits back to voiceParsedLeads
    tbl.querySelectorAll('input[data-vf]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const tr = inp.closest('tr');
        const idx = Number(tr.dataset.vidx);
        const field = inp.dataset.vf;
        if (voiceParsedLeads[idx]) voiceParsedLeads[idx][field] = inp.value.trim();
      });
    });
  }

  async function importVoiceLeads() {
    const selected = [];
    document
      .querySelectorAll('input[data-voice-idx]:checked')
      .forEach((cb) => {
        const idx = Number(cb.dataset.voiceIdx);
        if (voiceParsedLeads[idx]) selected.push(voiceParsedLeads[idx]);
      });
    if (!selected.length) {
      voiceFlash('Select at least one lead to import', false);
      return;
    }
    const btn = document.getElementById('btn-voice-import');
    btn.disabled = true;
    btn.textContent = `Importing ${selected.length}...`;
    try {
      const res = await CresAPI.request('/api/leads/bulk', {
        method: 'POST',
        body: { leads: selected },
        idempotencyKey: `voice-import-${Date.now()}`,
      });
      const d = res.data;
      voiceFlash(
        `Imported ${d.created} lead(s)${d.duplicates ? ` (${d.duplicates} duplicate${d.duplicates === 1 ? '' : 's'} skipped)` : ''}${d.failed ? ` (${d.failed} failed)` : ''}`,
        true
      );
      document.getElementById('leads-tbody') && (await mountLeads());
      setTimeout(() => {
        document.getElementById('voice-capture-modal')?.classList.remove('open');
      }, 1800);
    } catch (err) {
      voiceFlash(err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  }

  function initVoiceCapture() {
    const recordBtn = document.getElementById('btn-voice-record');
    if (recordBtn) recordBtn.onclick = startVoiceRecording;

    document.getElementById('btn-voice-retry')?.addEventListener('click', () => {
      resetVoiceUI();
    });
    document.getElementById('btn-voice-import')?.addEventListener('click', importVoiceLeads);

    document.getElementById('btn-voice-capture')?.addEventListener('click', () => {
      resetVoiceUI();
      document.getElementById('voice-capture-modal').classList.add('open');
    });

    document.querySelector('#voice-capture-modal [data-close-modal]')?.addEventListener('click', () => {
      stopVoiceRecorder(true);
      resetRecorderBtn();
      document.getElementById('voice-capture-modal').classList.remove('open');
    });
  }

  return { bindModals, mount, fillProjectCreateOptions, deleteProject, deleteClient, refreshProjectsView };
})();
