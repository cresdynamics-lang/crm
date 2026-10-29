/**
 * Step 4 - Director module faces
 */
const CresDirector = (() => {
  let chart;
  let analyticsChart = null;
  let approvalId = null;

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

  async function mountHome() {
    const host = document.getElementById('director-dashboard');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/director/dashboard');
      const { kpis, teamPerformance, invoiceProjection, chart: c } = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Active projects</div><div class="kpi-value">${kpis.activeProjects}</div></div>
          <div class="kpi-card"><div class="kpi-label">Pending approvals</div><div class="kpi-value">${kpis.pendingApprovals}</div></div>
          <div class="kpi-card"><div class="kpi-label">Reports this week</div><div class="kpi-value">${kpis.reportsThisWeek}</div></div>
          <div class="kpi-card"><div class="kpi-label">Open tasks</div><div class="kpi-value">${kpis.openTasks}</div></div>
        </div>
        <div class="toolbar" style="margin-bottom:16px;">
          <div class="kpi-card" style="flex:1;min-width:160px;">
            <div class="kpi-label">Expected in (issued/overdue)</div>
            <div class="kpi-value" style="font-size:1.35rem;">${fmtMoney(invoiceProjection.expectedIn)}</div>
          </div>
          <div class="kpi-card" style="flex:1;min-width:160px;">
            <div class="kpi-label">Collected (paid invoices)</div>
            <div class="kpi-value" style="font-size:1.35rem;">${fmtMoney(invoiceProjection.collected)}</div>
          </div>
        </div>
        <p style="color:var(--text-muted);font-size:0.8rem;margin:-8px 0 16px;">
          Issued vs collected this period.
        </p>
        <div class="chart-panel" style="margin-bottom:18px;">
          <h3>Invoices in / out projection</h3>
          <div class="chart-wrap"><canvas id="director-invoice-chart"></canvas></div>
        </div>
        <div class="settings-section" style="max-width:640px;">
          <h3>Team performance (reports this week)</h3>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>Role</th><th>Reports</th></tr></thead>
              <tbody>
                ${(teamPerformance || [])
                  .map((t) => `<tr><td class="status-pill ${esc(t.role)}" style="text-transform:capitalize;">${esc(t.role)}</td><td>${t.reports}</td></tr>`)
                  .join('') || '<tr><td colspan="2" class="empty-state">No data</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

      const ctx = document.getElementById('director-invoice-chart');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: c.labels,
          datasets: [
            {
              label: 'Expected (issued/overdue)',
              data: c.expected,
              backgroundColor: 'rgba(0, 168, 197, 0.65)',
              borderRadius: 6,
            },
            {
              label: 'Collected (paid)',
              data: c.collected,
              backgroundColor: 'rgba(90, 150, 220, 0.55)',
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8b9aab' } } },
          scales: {
            x: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(42,52,65,0.5)' } },
            y: {
              beginAtZero: true,
              ticks: { color: '#8b9aab' },
              grid: { color: 'rgba(42,52,65,0.5)' },
            },
          },
        },
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
      return;
    }
    await mountHomeKpisOnly(host);
  }

  async function mountHomeKpisOnly(host) {
    // pending expenses for director are tracked on Expenses face (Finance→Admin pipeline)
    try {
      const res = await CresAPI.request('/api/expenses?mine=1');
      const pending = (res.data || []).filter((x) =>
        ['pending_finance', 'pending_admin', 'pending'].includes(x.approval_status)
      );
      if (!host || !pending.length) return;
      let wrap = host.querySelector('#director-expense-status');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'director-expense-status';
        wrap.className = 'settings-section';
        wrap.style.marginTop = '24px';
        wrap.style.maxWidth = '720px';
        host.appendChild(wrap);
      }
      wrap.innerHTML = `
        <h3>Your expenses in approval</h3>
        <p class="meta" style="margin:0 0 10px;">Finance must approve, then Admin. Open Expenses to submit more.</p>
        <ul class="engagement-list">
          ${pending
            .map(
              (x) =>
                `<li><strong>${fmtMoney(x.amount)}</strong> — ${esc(x.description || x.category)}
                 <span class="role-tag">${esc((x.approval_status || '').replace(/_/g, ' '))}</span></li>`
            )
            .join('')}
        </ul>
        <button type="button" class="btn btn-ghost" id="dir-goto-expenses" style="margin-top:10px;">Go to Expenses</button>`;
      wrap.querySelector('#dir-goto-expenses')?.addEventListener('click', () => {
        location.hash = '#/expenses';
      });
    } catch {
      /* ignore */
    }
  }

  async function mountPendingExpenses() {
    /* legacy no-op — pipeline is Finance → Admin */
  }

  async function mountApprovals() {
    const res = await CresAPI.request('/api/director/approvals');
    const tbody = document.getElementById('approvals-tbody');
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No projects awaiting approval.</td></tr>`;
    } else {
      tbody.innerHTML = res.data
        .map(
          (p) => `<tr data-id="${p.id}">
            <td>${esc(p.name)}</td>
            <td>${esc(p.client_name || p.client_business || '-')}</td>
            <td>${esc(p.submitted_by_name)}</td>
            <td>${fmtDate(p.created_at)}</td>
            <td>${esc(p.developer_name || '-')}</td>
          </tr>`
        )
        .join('');
      tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', () => openApproval(tr.dataset.id));
      });
    }
    await mountPendingExpenses(null);
  }

  async function openApproval(id) {
    approvalId = id;
    const res = await CresAPI.request(`/api/director/approvals/${id}`);
    const p = res.data;
    const milestones = Array.isArray(p.milestones) ? p.milestones : [];
    document.getElementById('approval-title').textContent = p.name;
    document.getElementById('approval-body').innerHTML = `
      <div class="form-grid" style="margin-bottom:16px;">
        <div><strong>Client</strong><div>${esc(p.client_name || '-')} ${p.client_business ? `(${esc(p.client_business)})` : ''}</div></div>
        <div><strong>Submitted by</strong><div>${esc(p.submitted_by_name)}</div></div>
        <div><strong>Developer</strong><div>${esc(p.developer_name || 'Unassigned')}</div></div>
        <div><strong>Value</strong><div>${fmtMoney(p.value_amount)}</div></div>
        <div><strong>Status</strong><div>${statusPill(p.status)}</div></div>
        <div><strong>Summary</strong><div>${esc(p.summary || '-')}</div></div>
        <div style="grid-column:1/-1;"><strong>Description</strong><div style="white-space:pre-wrap;margin-top:4px;">${esc(p.description || '-')}</div></div>
        <div style="grid-column:1/-1;">
          <strong>Milestones</strong>
          <ul style="margin:8px 0 0;padding-left:18px;">
            ${
              milestones.length
                ? milestones.map((m) => `<li>${esc(m.title || m.name || JSON.stringify(m))} ${m.status ? `(${esc(m.status)})` : ''}</li>`).join('')
                : '<li>None listed</li>'
            }
          </ul>
        </div>
      </div>
      <div id="approval-flash" class="flash"></div>
      <div class="form-actions" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="btn-approve-project">Approve</button>
        <button type="button" class="btn btn-ghost" id="btn-show-reject">Reject…</button>
      </div>
      <form id="reject-form" class="form-grid" hidden style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;">
        <div>
          <label for="reject-reason">Rejection reason (sent back to Sales)</label>
          <textarea id="reject-reason" rows="3" required style="width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);"></textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" style="background:var(--danger);color:#fff;">Confirm reject</button>
        </div>
      </form>`;

    document.getElementById('approval-modal').classList.add('open');

    document.getElementById('btn-approve-project').onclick = async () => {
      try {
        await CresAPI.request(`/api/projects/${approvalId}/approve`, {
          method: 'POST',
          idempotencyKey: `approve-${approvalId}`,
        });
        flash(document.getElementById('approval-flash'), 'Approved. Downstream invoice/email/notifications are queued.');
        setTimeout(() => {
          document.getElementById('approval-modal').classList.remove('open');
          mountApprovals();
          mountHome().catch(() => {});
        }, 700);
      } catch (err) {
        flash(document.getElementById('approval-flash'), err.message, false);
      }
    };

    document.getElementById('btn-show-reject').onclick = () => {
      document.getElementById('reject-form').hidden = false;
    };

    document.getElementById('reject-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await CresAPI.request(`/api/projects/${approvalId}/reject`, {
          method: 'POST',
          body: { reason: document.getElementById('reject-reason').value.trim() },
        });
        document.getElementById('approval-modal').classList.remove('open');
        await mountApprovals();
      } catch (err) {
        flash(document.getElementById('approval-flash'), err.message, false);
      }
    };
  }

  async function mountTasks() {
    if (typeof CresTasks !== 'undefined') return CresTasks.mount();
  }

  async function createTask(e) {
    // handled by CresTasks.bind()
  }

  async function mountReportsHub() {
    const role = document.getElementById('reports-role')?.value;
    const from = document.getElementById('reports-from')?.value;
    const to = document.getElementById('reports-to')?.value;
    const routing = document.getElementById('reports-routing')?.value;
    const personSelect = document.getElementById('reports-person');

    const users = await CresAPI.request('/api/users?status=active');
    const reportRoles = ['sales', 'developer', 'pm'];
    const people = (users.data || []).filter((u) => {
      if (!reportRoles.includes(u.role)) return false;
      if (role && u.role !== role) return false;
      return true;
    });

    let person = personSelect?.value || '';
    if (person && !people.some((u) => u.id === person)) {
      person = '';
    }
    if (personSelect) {
      personSelect.innerHTML =
        `<option value="">All people</option>` +
        people
          .map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`)
          .join('');
      personSelect.value = person;
    }

    const params = new URLSearchParams();
    if (role) params.set('role', role);
    if (person) params.set('user_id', person);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);
    if (routing) params.set('routing_status', routing);

    const reports = await CresAPI.request(`/api/reports?${params}`);

    const list = document.getElementById('director-reports-list');
    list.innerHTML = reports.data.length
      ? reports.data
          .map((r) => {
            const remarkBox = r.can_remark
              ? `<div class="toolbar" style="margin-top:6px;gap:6px;align-items:flex-start;">
                   <textarea data-remark-input="${esc(r.id)}" rows="2" placeholder="Ask for clarity…" style="flex:1;min-width:160px;"></textarea>
                   <button type="button" class="btn btn-primary btn-sm" data-remark="${esc(r.id)}">Save remarks</button>
                 </div>`
              : '';
            const aiReviewBtn = r.can_remark
              ? `<button type="button" class="btn btn-ghost btn-sm" data-ai-review="${esc(r.id)}" data-author="${esc(r.author_name)}" style="font-size:0.78rem;margin-top:4px;">AI Review</button>`
              : '';
            return `<tr>
              <td>${CresFormat.datetime(r.created_at)}</td>
              <td><div class="report-author">${typeof CresSettings !== 'undefined' ? CresSettings.avatarHtml({ name: r.author_name, avatar_url: r.author_avatar_url }, 'avatar avatar-sm') : ''}<span>${esc(r.author_name)} · ${esc(r.author_role)}</span></div></td>
              <td>${statusPill(r.routing_status || 'pending_pm')}</td>
              <td>${esc(r.content)}${r.project_name ? `<div class="meta">${esc(r.project_name)}</div>` : ''}${r.pm_note ? `<div class="meta">PM: ${esc(r.pm_note)}</div>` : ''}</td>
              <td>
                ${r.remarks ? `<div class="rejection-banner" style="margin:0 0 6px;">${esc(r.remarks)}</div>` : '<span class="meta">No remarks yet</span>'}
                ${
                  r.admin_director_note
                    ? `<div style="margin-top:8px;padding:8px;border-left:3px solid var(--accent);background:rgba(0,168,197,0.06);border-radius:0 6px 6px 0;">
                         <div class="meta" style="margin-bottom:2px;">Admin note (private · Director only)</div>
                         <div>${esc(r.admin_director_note)}</div>
                         <div class="meta">${esc(r.admin_director_note_by_name || 'Admin')}${
                           r.admin_director_note_at ? ` · ${CresFormat.datetime(r.admin_director_note_at)}` : ''
                         }</div>
                       </div>`
                    : ''
                }
                ${remarkBox}
              </td>
              <td>${aiReviewBtn}</td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="6" class="empty-state">No reports match these filters.</td></tr>`;

    // Save remarks
    list.querySelectorAll('[data-remark]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.remark;
        const input = list.querySelector(`[data-remark-input="${id}"]`);
        const remarks = input?.value?.trim();
        if (!remarks) return;
        try {
          await CresAPI.request(`/api/reports/${id}/remarks`, {
            method: 'POST',
            body: { remarks },
          });
          await mountReportsHub();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    // AI Review buttons
    list.querySelectorAll('[data-ai-review]').forEach((btn) => {
      btn.addEventListener('click', () => openAiReview(btn.dataset.aiReview, btn.dataset.author));
    });

    // Add voice remark mic to each remarks textarea
    list.querySelectorAll('[data-remark-input]').forEach((ta) => {
      CresVoiceReport?.initRemarkMic(null, null);
      // Re-init using the actual element
      if (window.CresVoiceReport && !ta.dataset.micBound) {
        ta.dataset.micBound = '1';
        const micBtn = document.createElement('button');
        micBtn.type = 'button';
        micBtn.className = 'btn btn-ghost btn-sm';
        micBtn.style.cssText = 'padding:3px 10px;font-size:0.78rem;vertical-align:middle;margin-left:6px;';
        micBtn.textContent = '\uD83C\uDF99 Speak';
        ta.parentNode.insertBefore(micBtn, ta.nextSibling);

        let rStream = null, rRec = null, rChunks = [];
        micBtn.addEventListener('click', async () => {
          if (rRec && rRec.state === 'recording') {
            micBtn.textContent = '\uD83C\uDF99 Speak';
            micBtn.classList.remove('btn-danger');
            const blob = await new Promise((res) => {
              rRec.onstop = () => { rStream?.getTracks().forEach((t) => t.stop()); res(new Blob(rChunks, { type: 'audio/webm' })); };
              rRec.stop();
            });
            rChunks = [];
            if (!blob || blob.size < 500) return;
            micBtn.disabled = true; micBtn.textContent = '...';
            try {
              const fd = new FormData(); fd.append('audio', blob, `remark-${Date.now()}.webm`);
              const r = await CresAPI.request('/api/reports/voice-capture', { method: 'POST', body: fd });
              if (r.ok && r.data?.content) ta.value = (ta.value ? ta.value + '\n' : '') + r.data.content;
            } catch { /* ignore */ }
            micBtn.disabled = false; micBtn.textContent = '\uD83C\uDF99 Speak';
            return;
          }
          try {
            rStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            rChunks = [];
            rRec = new MediaRecorder(rStream, { mimeType: 'audio/webm;codecs=opus' });
            rRec.ondataavailable = (e) => { if (e.data.size > 0) rChunks.push(e.data); };
            rRec.start();
            micBtn.textContent = '\u23F9 Stop'; micBtn.classList.add('btn-danger');
          } catch { /* mic denied */ }
        });
      }
    });
  }

  // AI Review state
  let aiReviewState = { reportId: null, analysis: null };

  async function openAiReview(reportId, authorName) {
    const modal = document.getElementById('ai-review-modal');
    const body = document.getElementById('ai-review-body');
    const flash = document.getElementById('ai-review-flash');
    if (!modal || !body) return;

    modal.hidden = false;
    body.innerHTML = '<p class="meta">Analyzing report with full context…</p>';
    flash.innerHTML = '';

    aiReviewState = { reportId, analysis: null };

    try {
      const res = await CresAPI.request(`/api/reports/${reportId}/ai-review`, { method: 'POST' });
      aiReviewState.analysis = res.data;

      const questions = res.data.questions || [];
      const raw = res.data.raw || '';
      const summary = res.data.context_summary || {};

      body.innerHTML = `
        <div style="margin-bottom:12px;">
          <strong>AI Analysis for ${esc(authorName)}'s report</strong>
          ${res.cached ? '<span class="meta" style="margin-left:6px;">(cached)</span>' : ''}
        </div>
        ${summary.open_tasks != null ? `<div style="margin-bottom:10px;font-size:0.85rem;">
          <span class="meta">Open tasks: ${summary.open_tasks}</span>
          ${summary.overdue_tasks > 0 ? `<span style="color:var(--danger);margin-left:8px;">Overdue: ${summary.overdue_tasks}</span>` : ''}
          ${summary.recurring_blockers ? '<span style="color:var(--warning,#e6a817);margin-left:8px;">Recurring blockers</span>' : ''}
        </div>` : ''}
        <div style="margin-bottom:10px;">
          <label style="font-size:0.85rem;font-weight:600;">Questions to ask (editable):</label>
          <textarea id="ai-review-text" rows="10" style="width:100%;margin-top:6px;font-size:0.9rem;white-space:pre-wrap;">${esc(raw)}</textarea>
        </div>
        <div style="font-size:0.8rem;color:var(--text-muted);">
          These questions will be sent as your remarks. The reporter will see them as coming from you.
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p style="color:var(--danger);">Analysis failed: ${esc(err.message)}</p>`;
    }

    // Send button
    document.getElementById('btn-ai-review-send')?.addEventListener('click', async () => {
      const text = document.getElementById('ai-review-text')?.value?.trim();
      if (!text) return;
      try {
        await CresAPI.request(`/api/reports/${reportId}/remarks-ai`, {
          method: 'POST',
          body: { remarks: text, ai_analysis: aiReviewState.analysis },
        });
        modal.hidden = true;
        await mountReportsHub();
      } catch (err) {
        flash.innerHTML = `<span style="color:var(--danger);">${esc(err.message)}</span>`;
      }
    });

    // Close modal buttons
    modal.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => { modal.hidden = true; });
    });
  }

  async function mountAnalytics(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/audit/analytics');
      const d = res.data;
      host.innerHTML = `
        <div class="reports-panel-block">
          <h3 style="margin:0 0 12px;">Reports panel — Analytics</h3>
          <div class="kpi-grid" style="margin-bottom:14px;">
            <div class="kpi-card"><div class="kpi-label">Lead conversion rate</div><div class="kpi-value">${d.conversionRate}%</div></div>
            <div class="kpi-card"><div class="kpi-label">Leads converted</div><div class="kpi-value">${d.leadsConverted}</div></div>
            <div class="kpi-card"><div class="kpi-label">Leads total</div><div class="kpi-value">${d.leadsTotal}</div></div>
          </div>
          <div class="chart-panel" style="margin-bottom:14px;">
            <h3>Projects created (6 months)</h3>
            <div class="chart-wrap"><canvas id="${esc(hostId)}-projects-chart"></canvas></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div class="data-table-wrap">
              <table class="data-table">
                <thead><tr><th>Developer</th><th>Projects</th><th>Avg completion</th></tr></thead>
                <tbody>
                  ${(d.developerDelivery || [])
                    .map(
                      (r) => `<tr>
                        <td>${esc(r.developer)}</td>
                        <td>${r.projects}</td>
                        <td>${Math.round(r.avg_completion)}%</td>
                      </tr>`
                    )
                    .join('') || '<tr><td colspan="3" class="empty-state">No data</td></tr>'}
                </tbody>
              </table>
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead><tr><th>Sales</th><th>Created</th><th>Completed</th></tr></thead>
                <tbody>
                  ${(d.salesVolume || [])
                    .map(
                      (r) => `<tr>
                        <td>${esc(r.sales_rep)}</td>
                        <td>${r.projects_created}</td>
                        <td>${r.completed}</td>
                      </tr>`
                    )
                    .join('') || '<tr><td colspan="3" class="empty-state">No data</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;

      const canvas = document.getElementById(`${hostId}-projects-chart`);
      if (analyticsChart) analyticsChart.destroy();
      analyticsChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: d.projectsByMonth?.labels?.length ? d.projectsByMonth.labels : ['No data'],
          datasets: [{
            label: 'Projects',
            data: d.projectsByMonth?.labels?.length ? d.projectsByMonth.values : [0],
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

  async function mountInvoices() {
    const res = await CresAPI.request('/api/invoices');
    const tbody = document.getElementById('director-invoices-tbody');
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No invoices yet.</td></tr>`;
      return;
    }

    // Enrich with client/project names via query layer if needed
    let clients = {};
    let projects = {};
    try {
      const [c, p] = await Promise.all([
        CresAPI.request('/api/clients'),
        CresAPI.request('/api/projects'),
      ]);
      clients = Object.fromEntries(c.data.map((x) => [x.id, x.name]));
      projects = Object.fromEntries(p.data.map((x) => [x.id, x.name]));
    } catch {
      // ignore
    }

    tbody.innerHTML = res.data
      .map((i) => {
        const paid = Number(i.amount_paid || 0);
        const amount = Number(i.amount || 0);
        const balance = Math.max(0, amount - paid);
        return `<tr>
          <td>${esc(i.client_name || clients[i.client_id] || '-')}</td>
          <td>${fmtMoney(amount)}</td>
          <td>${fmtMoney(paid)}</td>
          <td>${fmtMoney(balance)}</td>
          <td>${statusPill(i.status)}</td>
          <td>${esc(i.project_name || projects[i.project_id] || '-')}</td>
        </tr>`;
      })
      .join('');
  }

  function bind() {
    ['reports-role', 'reports-person', 'reports-from', 'reports-to', 'reports-routing'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () =>
        mountReportsHub().catch(console.error)
      );
    });
  }

  async function mountProjects() {
    const res = await CresAPI.request('/api/projects');
    const tbody = document.getElementById('projects-tbody');
    const btn = document.getElementById('btn-new-project');
    const exportBtn = document.getElementById('btn-export-projects');
    if (btn) btn.hidden = false;
    if (exportBtn) exportBtn.hidden = false;
    if (typeof CresSales !== 'undefined' && CresSales.fillProjectCreateOptions) {
      CresSales.fillProjectCreateOptions().catch(console.error);
    }
    if (!tbody) return;

    const thead = document.querySelector('#sales-projects-chrome thead tr');
    if (thead) {
      thead.innerHTML =
        '<th>Project</th><th>Client</th><th>Status</th><th>Due</th><th>Progress</th><th>Developer</th><th></th>';
    }

    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No projects yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.data
      .map((p) => {
        const pct = p.progress_percent != null ? `${Number(p.progress_percent)}%` : '—';
        const canEdit = !['pending_approval', 'rejected'].includes(p.status);
        return `<tr class="clickable-row" data-id="${esc(p.id)}" title="Open project">
          <td><a href="#/projects/${esc(p.id)}" class="project-link" data-open-project="${esc(p.id)}">${esc(p.name)}</a></td>
          <td>${esc(p.client_name || '-')}</td>
          <td>${statusPill(p.status)}</td>
          <td>${fmtDate(p.due_date)}</td>
          <td>${esc(pct)}</td>
          <td>${esc(p.developer_name || '-')}</td>
          <td>
            ${
              canEdit
                ? `<button type="button" class="btn btn-ghost btn-sm" data-edit-project="${esc(p.id)}" style="padding:6px 10px;font-size:0.8rem;">Edit</button>`
                : ''
            }
            <button type="button" class="btn btn-ghost btn-sm" data-delete-project="${esc(p.id)}" data-name="${esc(p.name)}" style="padding:6px 10px;font-size:0.8rem;color:#ffb4b4;">Delete</button>
          </td>
        </tr>`;
      })
      .join('');

    const openProject = (id, e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (typeof CresProjectDetail !== 'undefined') {
        CresProjectDetail.open(id, { onSaved: () => mountProjects() }).catch(console.error);
      }
    };

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-edit-project], [data-open-project], [data-delete-project]')) return;
        openProject(tr.dataset.id, e);
      });
    });
    tbody.querySelectorAll('[data-open-project], [data-edit-project]').forEach((el) => {
      el.addEventListener('click', (e) => {
        openProject(el.dataset.openProject || el.dataset.editProject, e);
      });
    });
    tbody.querySelectorAll('[data-delete-project]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof CresSales !== 'undefined' && CresSales.deleteProject) {
          CresSales.deleteProject(btn.dataset.deleteProject, btn.dataset.name).catch((err) =>
            alert(err.message)
          );
        }
      });
    });
  }

  async function mountAudit(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/audit/actions');
      const rows = res.data || [];
      host.innerHTML = `
        <div class="reports-panel-block">
          <h3 style="margin:0 0 12px;">Action audit log</h3>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th></tr></thead>
              <tbody>
                ${
                  rows.length
                    ? rows
                        .map(
                          (a) => `<tr>
                            <td>${CresFormat.datetime(a.created_at)}</td>
                            <td>${esc(a.actor_name || a.actor_role || '-')}</td>
                            <td>${esc(a.action)}</td>
                            <td>${esc(a.summary)}</td>
                          </tr>`
                        )
                        .join('')
                    : `<tr><td colspan="4" class="empty-state">No action audit entries.</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>`;
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mount(faceId, user) {
    if (!['director', 'admin'].includes(user.role)) return;
    const tab = new URLSearchParams((location.hash.split('?')[1] || '')).get('tab') || '';
    if (faceId === 'home' && user.role === 'director') await mountHome();
    else if (faceId === 'approvals') await mountApprovals();
    else if (faceId === 'tasks') await mountTasks();
    else if (faceId === 'reports' && user.role === 'director') {
      const reportsTab = tab || 'analytics';
      if (reportsTab === 'daily') await mountReportsHub();
      else if (reportsTab === 'audit') await mountAudit('director-action-audit');
      else await mountAnalytics('director-analytics');
    } else if (faceId === 'invoices' && user.role === 'director') await mountInvoices();
    else if (faceId === 'projects' && user.role === 'director' && tab !== 'timeline') await mountProjects();
    else if (faceId === 'expenses' && user.role === 'director') {
      if (typeof CresFinance !== 'undefined' && CresFinance.mountExpenses) {
        await CresFinance.mountExpenses();
      }
    }
  }

  return { bind, mount, openApproval, refreshProjects: mountProjects };
})();
