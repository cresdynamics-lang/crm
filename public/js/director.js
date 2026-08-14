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
    if (!v) return '-';
    return new Date(v).toLocaleDateString();
  }

  function fmtMoney(n) {
    const num = Number(n);
    if (Number.isNaN(num)) return '-';
    return num.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
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
          Invoice projection only. No account balances or cash-health data on this view.
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
              backgroundColor: 'rgba(31, 167, 160, 0.65)',
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

    await mountAnalytics('director-analytics');

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
            return `<tr>
              <td>${new Date(r.created_at).toLocaleString()}</td>
              <td><div class="report-author">${typeof CresSettings !== 'undefined' ? CresSettings.avatarHtml({ name: r.author_name, avatar_url: r.author_avatar_url }, 'avatar avatar-sm') : ''}<span>${esc(r.author_name)} · ${esc(r.author_role)}</span></div></td>
              <td>${statusPill(r.routing_status || 'pending_pm')}</td>
              <td>${esc(r.content)}${r.project_name ? `<div class="meta">${esc(r.project_name)}</div>` : ''}${r.pm_note ? `<div class="meta">PM: ${esc(r.pm_note)}</div>` : ''}</td>
              <td>
                ${r.remarks ? `<div class="rejection-banner" style="margin:0 0 6px;">${esc(r.remarks)}</div>` : '<span class="meta">No remarks yet</span>'}
                ${remarkBox}
              </td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="5" class="empty-state">No reports match these filters.</td></tr>`;

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
            backgroundColor: 'rgba(31, 167, 160, 0.65)',
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
      .map(
        (i) => `<tr>
          <td>${esc(clients[i.client_id] || i.client_id || '-')}</td>
          <td>${fmtMoney(i.amount)}</td>
          <td>${statusPill(i.status)}</td>
          <td>${esc(projects[i.project_id] || i.project_id || '-')}</td>
        </tr>`
      )
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
    if (btn) btn.hidden = true;
    if (exportBtn) exportBtn.hidden = true;
    if (!tbody) return;

    const thead = document.querySelector('#sales-projects-chrome thead tr');
    if (thead) {
      thead.innerHTML =
        '<th>Project</th><th>Client</th><th>Status</th><th>Progress</th><th>Developer</th><th></th>';
    }

    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No projects yet.</td></tr>`;
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
          <td>${esc(pct)}</td>
          <td>${esc(p.developer_name || '-')}</td>
          <td>${
            canEdit
              ? `<button type="button" class="btn btn-ghost btn-sm" data-edit-project="${esc(p.id)}" style="padding:6px 10px;font-size:0.8rem;">Edit</button>`
              : ''
          }</td>
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
        if (e.target.closest('[data-edit-project], [data-open-project]')) return;
        openProject(tr.dataset.id, e);
      });
    });
    tbody.querySelectorAll('[data-open-project], [data-edit-project]').forEach((el) => {
      el.addEventListener('click', (e) => {
        openProject(el.dataset.openProject || el.dataset.editProject, e);
      });
    });
  }

  async function mount(faceId, user) {
    if (!['director', 'admin'].includes(user.role)) return;
    // Admin reuses Approvals + Tasks; home/reports/projects/invoices handled by Admin/Sales/Finance faces
    if (faceId === 'home' && user.role === 'director') await mountHome();
    else if (faceId === 'approvals') await mountApprovals();
    else if (faceId === 'tasks') await mountTasks();
    else if (faceId === 'reports' && user.role === 'director') await mountReportsHub();
    else if (faceId === 'invoices' && user.role === 'director') await mountInvoices();
    else if (faceId === 'projects' && user.role === 'director') await mountProjects();
    else if (faceId === 'expenses' && user.role === 'director') {
      if (typeof CresFinance !== 'undefined' && CresFinance.mountExpenses) {
        await CresFinance.mountExpenses();
      }
    }
  }

  return { bind, mount, openApproval };
})();
