/**
 * Step 8 - Admin module (dashboard, users, full reports, system settings).
 * Department faces are reused via existing Cres* modules + RBAC.
 */
const CresAdmin = (() => {
  let cashChart = null;
  let healthChart = null;
  let salaryChart = null;
  let analyticsChart = null;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
    setTimeout(() => el.classList.remove('visible'), 4000);
  }

  function chartOpts() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { labels: { color: '#8b9aab' } } },
      scales: {
        x: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#8b9aab' }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    };
  }

  async function mountHome() {
    const host = document.getElementById('admin-dashboard');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/admin/dashboard');
      const d = res.data;
      const k = d.kpis;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Leads today</div><div class="kpi-value">${k.sales.leadsToday}</div></div>
          <div class="kpi-card"><div class="kpi-label">Open pipeline</div><div class="kpi-value">${k.sales.openPipeline}</div></div>
          <div class="kpi-card"><div class="kpi-label">Active projects</div><div class="kpi-value">${k.projects.active}</div></div>
          <div class="kpi-card"><div class="kpi-label">Pending approval</div><div class="kpi-value">${k.projects.pendingApproval}</div></div>
          <div class="kpi-card"><div class="kpi-label">Account balance</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(k.finance.accountBalance)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Net cash</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(k.finance.netCash)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Salary owed</div><div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(k.hr.owedThisMonth)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Failed jobs</div><div class="kpi-value">${k.ops.failedJobs}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:14px;margin-top:16px;">
          <div class="chart-panel">
            <h3>Cash flow (in vs out)</h3>
            <div class="chart-wrap"><canvas id="admin-cash-chart"></canvas></div>
          </div>
          <div class="chart-panel">
            <h3>Project health</h3>
            <div class="chart-wrap"><canvas id="admin-health-chart"></canvas></div>
          </div>
        </div>
        <div class="chart-panel" style="margin-top:14px;max-width:720px;">
          <h3>HR salaries (settled vs owed)</h3>
          <div class="chart-wrap"><canvas id="admin-salary-chart"></canvas></div>
        </div>
        <p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">
          Open Approvals for anything waiting on you, or pick a department from the sidebar.
        </p>`;

      if (cashChart) cashChart.destroy();
      cashChart = new Chart(document.getElementById('admin-cash-chart'), {
        type: 'bar',
        data: {
          labels: d.charts.cashFlow.labels,
          datasets: [
            { label: 'Money in', data: d.charts.cashFlow.moneyIn, backgroundColor: 'rgba(0,168,197,0.65)', borderRadius: 6 },
            { label: 'Money out', data: d.charts.cashFlow.moneyOut, backgroundColor: 'rgba(224,90,90,0.55)', borderRadius: 6 },
          ],
        },
        options: chartOpts(),
      });

      if (healthChart) healthChart.destroy();
      healthChart = new Chart(document.getElementById('admin-health-chart'), {
        type: 'doughnut',
        data: {
          labels: d.charts.projectHealth.labels,
          datasets: [{
            data: d.charts.projectHealth.values.some((v) => v > 0) ? d.charts.projectHealth.values : [1],
            backgroundColor: ['#00a8c5', '#f5a623', '#e05a5a'],
          }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#8b9aab' } } } },
      });

      if (salaryChart) salaryChart.destroy();
      salaryChart = new Chart(document.getElementById('admin-salary-chart'), {
        type: 'bar',
        data: {
          labels: d.charts.salaries.labels,
          datasets: [
            { label: 'Settled', data: d.charts.salaries.settled, backgroundColor: 'rgba(0,168,197,0.65)', borderRadius: 6 },
            { label: 'Owed', data: d.charts.salaries.owed, backgroundColor: 'rgba(224,90,90,0.55)', borderRadius: 6 },
          ],
        },
        options: chartOpts(),
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    const role = document.getElementById('users-filter-role')?.value || '';
    const status = document.getElementById('users-filter-status')?.value || 'all';
    const params = new URLSearchParams({ status });
    if (role) params.set('role', role);

    const [users, roles] = await Promise.all([
      CresAPI.request(`/api/users?${params}`),
      CresAPI.request('/api/users/roles'),
    ]);

    const roleSel = document.getElementById('user-form-role');
    if (roleSel && roleSel.options.length <= 1) {
      roleSel.innerHTML = roles.data.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    }
    const filterRole = document.getElementById('users-filter-role');
    if (filterRole && filterRole.options.length <= 1) {
      filterRole.innerHTML =
        `<option value="">All roles</option>` +
        roles.data.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    }

    tbody.innerHTML = users.data.length
      ? users.data
          .map(
            (u) => `<tr data-id="${esc(u.id)}">
              <td>${esc(u.name)}</td>
              <td>${esc(u.email)}</td>
              <td>${esc(u.role)}</td>
              <td>${statusPill(u.status)}</td>
              <td>
                <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(u.id)}">Edit</button>
              </td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="empty-state">No users match.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openUserForm(btn.dataset.edit, users.data));
    });
  }

  function openUserForm(id, list) {
    const modal = document.getElementById('user-modal');
    const form = document.getElementById('user-form');
    const title = document.getElementById('user-modal-title');
    form.reset();
    form.dataset.id = id || '';
    document.getElementById('user-password-wrap').hidden = !!id;
    document.getElementById('user-password').required = !id;
    title.textContent = id ? 'Edit user' : 'Add user (with password)';

    if (id) {
      const u = list.find((x) => x.id === id);
      if (!u) return;
      form.name.value = u.name;
      form.email.value = u.email;
      form.phone.value = u.phone || '';
      form.role.value = u.role;
      form.status.value = u.status;
      form.email.readOnly = true;
    } else {
      form.email.readOnly = false;
      form.status.value = 'active';
    }
    modal.classList.add('open');
  }

  async function openInviteForm() {
    const roles = await CresAPI.request('/api/users/roles');
    const roleSel = document.getElementById('invite-role');
    if (roleSel) {
      roleSel.innerHTML = roles.data.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    }
    document.getElementById('invite-form')?.reset();
    document.getElementById('invite-modal')?.classList.add('open');
  }

  async function mountLoginAudit() {
    const res = await CresAPI.request('/api/invites/login-audit');
    const tbody = document.getElementById('login-audit-tbody');
    if (!tbody) return;
    tbody.innerHTML = res.data.length
      ? res.data
          .map(
            (r) => `<tr>
              <td>${CresFormat.datetime(r.created_at)}</td>
              <td>${esc(r.email || '-')}</td>
              <td>${esc(r.user_name || '-')}</td>
              <td>${r.success ? statusPill('approved') : statusPill('rejected')}</td>
              <td>${esc(r.ip || '-')}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="empty-state">No login attempts logged.</td></tr>`;
  }

  async function mountReports() {
    const tab = new URLSearchParams((location.hash.split('?')[1] || '')).get('tab') || 'today';
    if (tab === 'daily') return mountDailyReports();
    if (tab === 'audit') return mountActionAudit();
    if (tab === 'analytics') return mountAnalytics();
    return mountTodayDigest();
  }

  function digestSourceLabel(d) {
    if (d.source === 'ai') return d.model || 'Claude Sonnet';
    if (d.source === 'facts-fallback') return 'Facts only — AI unavailable';
    if (!d.configured) return 'Facts only — add OPENROUTER_API_KEY';
    return 'Facts only';
  }

  function digestList(items) {
    if (!items?.length) return '';
    return `<ul class="digest-list">${items.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`;
  }

  function digestCard(title, section) {
    return `
      <article class="digest-card">
        <h3>${esc(title)}</h3>
        <p>${esc(section?.summary || 'No activity.')}</p>
        ${digestList(section?.highlights)}
      </article>`;
  }

  async function mountTodayDigest(opts = {}) {
    const host = document.getElementById('admin-today-digest');
    if (!host) return;
    const dateEl = document.getElementById('admin-digest-date');
    const day = opts.date || dateEl?.value || '';
    host.innerHTML = `<div class="placeholder-card">Building today’s briefing…</div>`;
    try {
      const qs = new URLSearchParams();
      if (day) qs.set('date', day);
      if (opts.refresh) qs.set('refresh', '1');
      const res = await CresAPI.request(`/api/admin/daily-digest?${qs}`);
      const d = res.data || {};
      const t = d.totals || {};
      const b = d.briefing || {};
      const watch = b.watch || [];
      host.innerHTML = `
        <div class="reports-panel-block digest-wrap">
          <div class="toolbar" style="margin-bottom:14px;flex-wrap:wrap;gap:8px;">
            <label class="meta" for="admin-digest-date">Day</label>
            <input id="admin-digest-date" type="date" value="${esc(d.day || '')}" />
            <button type="button" class="btn btn-ghost" id="btn-admin-digest-refresh">Refresh briefing</button>
            <span class="meta" style="margin-left:auto;">${esc(digestSourceLabel(d))}${d.cached ? ' · cached' : ''}</span>
          </div>
          <p class="digest-headline">${esc(b.headline || 'No briefing yet.')}</p>
          <div class="kpi-grid" style="margin-bottom:16px;">
            <div class="kpi-card"><div class="kpi-label">In today</div><div class="kpi-value">${fmtMoney(t.revenue)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Out today</div><div class="kpi-value">${fmtMoney(t.expenses)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Invoices issued</div><div class="kpi-value">${esc(t.invoices_count || 0)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Reports filed</div><div class="kpi-value">${esc(t.reports_count || 0)}</div></div>
          </div>
          <div class="digest-grid">
            ${digestCard('Finance', b.finance)}
            ${digestCard('Director', b.director)}
            ${digestCard('Admin', b.admin)}
          </div>
          <div class="digest-grid digest-grid-2" style="margin-top:12px;">
            ${digestCard('Operations', b.operations)}
            <article class="digest-card digest-watch">
              <h3>Needs attention</h3>
              ${watch.length ? digestList(watch) : '<p class="meta">Nothing flagged.</p>'}
            </article>
          </div>
          ${
            d.error
              ? `<p class="meta" style="margin-top:12px;">AI note: ${esc(d.error)}. Showing the facts briefing instead.</p>`
              : ''
          }
        </div>`;
      document.getElementById('admin-digest-date')?.addEventListener('change', (e) => {
        mountTodayDigest({ date: e.target.value }).catch(console.error);
      });
      document.getElementById('btn-admin-digest-refresh')?.addEventListener('click', () => {
        const picked = document.getElementById('admin-digest-date')?.value;
        mountTodayDigest({ date: picked, refresh: true }).catch(console.error);
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountDailyReports() {
    const role = document.getElementById('admin-reports-role')?.value;
    const from = document.getElementById('admin-reports-from')?.value;
    const to = document.getElementById('admin-reports-to')?.value;
    const personSel = document.getElementById('admin-reports-person');

    const users = await CresAPI.request('/api/users?status=all');
    const people = (users.data || []).filter((u) => {
      if (u.role === 'client') return false;
      if (role && u.role !== role) return false;
      return true;
    });

    let person = personSel?.value || '';
    if (person && !people.some((u) => u.id === person)) person = '';
    if (personSel) {
      personSel.innerHTML =
        `<option value="">All people</option>` +
        people.map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join('');
      personSel.value = person;
    }

    const params = new URLSearchParams({ routing_status: 'all' });
    if (role) params.set('role', role);
    if (person) params.set('user_id', person);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const reports = await CresAPI.request(`/api/reports?${params}`);

    const list = document.getElementById('admin-reports-list');
    if (!list) return;
    list.innerHTML = reports.data.length
      ? reports.data
          .map((r) => {
            const reactions = (r.reactions || [])
              .map(
                (rx) => `<div class="meta" style="margin-top:4px;">↳ ${esc(rx.author_name)}: ${esc(rx.content)}</div>`
              )
              .join('');
            const reactBox = r.can_react
              ? `<div class="toolbar" style="margin-top:8px;gap:8px;align-items:flex-start;">
                   <input data-react-input="${esc(r.id)}" placeholder="Respond…" style="flex:1;min-width:160px;" />
                   <button type="button" class="btn btn-primary btn-sm" data-react="${esc(r.id)}">Send</button>
                 </div>`
              : ['sales', 'developer'].includes(r.author_role)
                ? `<div class="meta" style="margin-top:6px;">Read-only (Sales/Developer reports)</div>`
                : '';
            return `<li>
              <div class="meta report-author">${typeof CresSettings !== 'undefined' ? CresSettings.avatarHtml({ name: r.author_name, avatar_url: r.author_avatar_url }, 'avatar avatar-sm') : ''}<span>${esc(r.author_name)} · ${esc(r.author_role)} · ${CresFormat.datetime(r.created_at)}
                ${r.project_name ? ` · ${esc(r.project_name)}` : ''} · ${statusPill(r.routing_status || '')}</span>
              </div>
              <div>${esc(r.content)}</div>
              ${reactions}
              ${reactBox}
            </li>`;
          })
          .join('')
      : `<li class="empty-state">No reports match.</li>`;

    list.querySelectorAll('[data-react]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.react;
        const input = list.querySelector(`[data-react-input="${id}"]`);
        const content = input?.value?.trim();
        if (!content) return;
        try {
          await CresAPI.request(`/api/reports/${id}/react`, { method: 'POST', body: { content } });
          flash(document.getElementById('admin-reports-flash'), 'Response sent');
          await mountDailyReports();
        } catch (err) {
          flash(document.getElementById('admin-reports-flash'), err.message, false);
        }
      });
    });
  }

  async function mountAnalytics() {
    const host = document.getElementById('admin-analytics');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/audit/analytics');
      const d = res.data;
      host.innerHTML = `
        <div class="reports-panel-block">
          <div class="toolbar" style="margin-bottom:12px;">
            <h3 style="margin:0;">Reports panel — Analytics</h3>
            <div class="spacer"></div>
            <a href="#/login-audit" class="btn btn-ghost btn-sm">Login audit</a>
          </div>
          <div class="kpi-grid" style="margin-bottom:14px;">
            <div class="kpi-card"><div class="kpi-label">Lead conversion rate</div><div class="kpi-value">${d.conversionRate}%</div></div>
            <div class="kpi-card"><div class="kpi-label">Leads converted</div><div class="kpi-value">${d.leadsConverted}</div></div>
            <div class="kpi-card"><div class="kpi-label">Leads total</div><div class="kpi-value">${d.leadsTotal}</div></div>
          </div>
          <div class="chart-panel" style="margin-bottom:14px;">
            <h3>Projects created (6 months)</h3>
            <div class="chart-wrap"><canvas id="admin-analytics-projects-chart"></canvas></div>
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

      const canvas = document.getElementById('admin-analytics-projects-chart');
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

  async function mountActionAudit() {
    const host = document.getElementById('admin-action-audit');
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

  const RULE_LABELS = {
    notifyPmOnDailyReport: 'Notify PM when a daily report is filed',
    notifyDirectorOnForward: 'Notify Director when a report is forwarded',
    notifyFinanceOnSalarySettle: 'Notify Finance when a salary is settled',
    notifyDevOnProjectApprove: 'Notify the developer when a project is approved',
  };

  const AUTO_FLAGS = [
    { key: 'invoiceIssued', label: 'Invoice issued — email the client the tax invoice' },
    { key: 'paymentReceipt', label: 'Payment received — email the client a receipt' },
    { key: 'overdueReminder', label: 'Overdue reminder — warn the client before a penalty' },
    { key: 'overduePenalty', label: 'Overdue penalty — tell the client a 2% fee was added' },
    { key: 'overdueFollowup', label: 'Overdue follow-up — chase an unpaid invoice' },
    { key: 'userInvite', label: 'User invite — email new staff their set-password link' },
    { key: 'leadMessage', label: 'Lead email — send scheduled messages to leads' },
  ];

  function orgFlash(msg, ok = true) {
    flash(document.getElementById('org-settings-flash') || document.getElementById('email-flash') || document.getElementById('settings-flash'), msg, ok);
  }

  async function saveOrgKey(key, value, okMsg) {
    await CresAPI.request(`/api/admin/system/${key}`, { method: 'PATCH', body: { value } });
    orgFlash(okMsg);
  }

  async function mountSystemSettings() {
    const host = document.getElementById('org-company-settings');
    if (!host) return;
    try {
      const [sys, dlq] = await Promise.all([
        CresAPI.request('/api/admin/system'),
        CresAPI.request('/api/admin/failed-jobs'),
      ]);
      const s = sys.data;
      host.innerHTML = `
        <div class="settings-section">
          <h3>Notification rules</h3>
          <form id="admin-notif-rules" class="form-grid">
            ${Object.entries(s.notification_rules || {})
              .map(
                ([k, v]) => `<label style="display:flex;gap:8px;align-items:center;">
                  <input type="checkbox" name="${esc(k)}" ${v ? 'checked' : ''} /> ${esc(RULE_LABELS[k] || k)}
                </label>`
              )
              .join('')}
            <div class="form-actions"><button type="submit" class="btn btn-primary">Save rules</button></div>
          </form>
        </div>
        <div class="settings-section">
          <h3>Email templates</h3>
          <form id="admin-email-templates" class="form-grid">
            <div><label>Invoice subject</label>
              <input name="invoice_subject" value="${esc(s.email_templates?.invoice_issued?.subject || '')}" /></div>
            <div><label>Invoice body</label>
              <textarea name="invoice_body" rows="4" style="width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);">${esc(s.email_templates?.invoice_issued?.body || '')}</textarea></div>
            <div><label>Password reset subject</label>
              <input name="reset_subject" value="${esc(s.email_templates?.password_reset?.subject || '')}" /></div>
            <div><label>Password reset body</label>
              <textarea name="reset_body" rows="3" style="width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);">${esc(s.email_templates?.password_reset?.body || '')}</textarea></div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">Save templates</button></div>
          </form>
        </div>
        <div class="settings-section">
          <h3>Integrations</h3>
          <form id="admin-integrations" class="form-grid">
            <div><label>Email from</label>
              <input name="email_from" value="${esc(s.integrations?.email?.from || '')}" /></div>
            <div><label>Primary provider</label>
              <input name="email_primary" value="${esc(s.integrations?.email?.primaryProvider || '')}" /></div>
            <div><label>Fallback provider</label>
              <input name="email_fallback" value="${esc(s.integrations?.email?.fallbackProvider || '')}" /></div>
            <div><label>M-Pesa enabled</label>
              <select name="mpesa_enabled">
                <option value="false" ${!s.integrations?.mpesa?.enabled ? 'selected' : ''}>No</option>
                <option value="true" ${s.integrations?.mpesa?.enabled ? 'selected' : ''}>Yes</option>
              </select></div>
            <div><label>M-Pesa shortcode</label>
              <input name="mpesa_shortcode" value="${esc(s.integrations?.mpesa?.shortcode || '')}" /></div>
            <div><label>M-Pesa environment</label>
              <select name="mpesa_env">
                <option value="sandbox" ${s.integrations?.mpesa?.environment === 'sandbox' ? 'selected' : ''}>Sandbox</option>
                <option value="production" ${s.integrations?.mpesa?.environment === 'production' ? 'selected' : ''}>Production</option>
              </select></div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">Save integrations</button></div>
          </form>
        </div>
        <div class="settings-section">
          <h3>Expense approval</h3>
          <form id="admin-expense-approval" class="form-grid">
            <div><label>Threshold (Ksh)</label>
              <input name="threshold" type="number" min="0" step="1"
                value="${esc(s.expense_approval?.threshold ?? 500)}" /></div>
            <div><label>Require approval above threshold</label>
              <select name="requireAboveThreshold">
                <option value="true" ${s.expense_approval?.requireAboveThreshold !== false ? 'selected' : ''}>Yes</option>
                <option value="false" ${s.expense_approval?.requireAboveThreshold === false ? 'selected' : ''}>No</option>
              </select></div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">Save threshold</button></div>
          </form>
        </div>
        <div class="settings-section" style="max-width:none;">
          <h3>Queue / dead-letter monitoring</h3>
          <p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 10px;">
            Counts: ${esc(JSON.stringify(dlq.meta?.queueCounts || {}))}
          </p>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>When</th><th>Queue</th><th>Job</th><th>Error</th><th>Attempts</th><th></th></tr></thead>
              <tbody id="admin-dlq-tbody">
                ${(dlq.data || []).length
                  ? dlq.data
                      .map(
                        (j) => `<tr>
                          <td>${CresFormat.datetime(j.created_at)}</td>
                          <td>${esc(j.queue)}</td>
                          <td>${esc(j.job_name)}</td>
                          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;">${esc(j.error)}</td>
                          <td>${esc(j.attempts)}</td>
                          <td>
                            <button type="button" class="btn btn-ghost btn-sm" data-retry="${esc(j.id)}">Retry</button>
                            <button type="button" class="btn btn-ghost btn-sm" data-dismiss="${esc(j.id)}">Dismiss</button>
                          </td>
                        </tr>`
                      )
                      .join('')
                  : '<tr><td colspan="6" class="empty-state">No failed jobs.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

      document.getElementById('admin-notif-rules')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = {};
        [...e.target.elements].forEach((el) => {
          if (el.name && el.type === 'checkbox') value[el.name] = el.checked;
        });
        try {
          await saveOrgKey('notification_rules', value, 'Notification rules saved');
        } catch (err) {
          orgFlash(err.message, false);
        }
      });

      document.getElementById('admin-email-templates')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const value = {
          invoice_issued: { subject: f.invoice_subject.value, body: f.invoice_body.value },
          password_reset: { subject: f.reset_subject.value, body: f.reset_body.value },
        };
        try {
          await saveOrgKey('email_templates', value, 'Email templates saved');
        } catch (err) {
          orgFlash(err.message, false);
        }
      });

      document.getElementById('admin-integrations')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const value = {
          email: {
            from: f.email_from.value,
            primaryProvider: f.email_primary.value,
            fallbackProvider: f.email_fallback.value,
          },
          mpesa: {
            enabled: f.mpesa_enabled.value === 'true',
            shortcode: f.mpesa_shortcode.value,
            environment: f.mpesa_env.value,
            note: 'Configure when M-Pesa credentials are available',
          },
        };
        try {
          await saveOrgKey('integrations', value, 'Integrations saved');
        } catch (err) {
          orgFlash(err.message, false);
        }
      });

      document.getElementById('admin-expense-approval')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await saveOrgKey(
            'expense_approval',
            {
              threshold: Number(f.threshold.value) || 0,
              requireAboveThreshold: f.requireAboveThreshold.value === 'true',
            },
            'Expense approval threshold saved'
          );
        } catch (err) {
          orgFlash(err.message, false);
        }
      });

      host.querySelectorAll('[data-retry]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await CresAPI.request(`/api/admin/failed-jobs/${btn.dataset.retry}/retry`, { method: 'POST', body: {} });
            orgFlash('Job re-queued');
            await mountSystemSettings();
          } catch (err) {
            orgFlash(err.message, false);
          }
        });
      });
      host.querySelectorAll('[data-dismiss]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await CresAPI.request(`/api/admin/failed-jobs/${btn.dataset.dismiss}`, { method: 'DELETE' });
            orgFlash('Job dismissed');
            await mountSystemSettings();
          } catch (err) {
            orgFlash(err.message, false);
          }
        });
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  function activityList(rows) {
    if (!rows?.length) return `<li class="empty-state">Nothing yet.</li>`;
    return rows
      .map(
        (r) => `<li>
          <div class="meta">${CresFormat.datetime(r.at)} · ${esc(r.kind || '')} · ${esc(r.who || '')} · ${esc(r.status || '')}</div>
          <strong>${esc(r.title || '-')}</strong>
          <div style="margin-top:4px;color:var(--text-muted);font-size:0.85rem;">${esc((r.summary || '').slice(0, 180))}</div>
        </li>`
      )
      .join('');
  }

  async function mountEmailOrg() {
    const host = document.getElementById('admin-email-automations');
    if (!host) return;
    host.hidden = false;
    try {
      const [sys, act] = await Promise.all([
        CresAPI.request('/api/admin/system'),
        CresAPI.request('/api/admin/email-activity'),
      ]);
      const flags = sys.data?.email_automations || {};
      const to = act.data?.to || [];
      const from = act.data?.from || [];
      host.innerHTML = `
        <div class="settings-section" style="max-width:none;margin-top:24px;">
          <h3>Email automations</h3>
          <p class="meta" style="margin:0 0 12px;">Turn automatic mail to clients and staff on or off. Manual “Send email” above always works.</p>
          <form id="admin-email-autos" class="form-grid">
            ${AUTO_FLAGS.map(
              (f) => `<label style="display:flex;gap:8px;align-items:center;grid-column:1/-1;">
                <input type="checkbox" name="${esc(f.key)}" ${flags[f.key] !== false ? 'checked' : ''} /> ${esc(f.label)}
              </label>`
            ).join('')}
            <div class="form-actions"><button type="submit" class="btn btn-primary">Save automations</button></div>
          </form>
        </div>
        <div class="digest-grid digest-grid-2" style="margin-top:16px;">
          <div class="settings-section" style="max-width:none;margin:0;">
            <h3>To clients</h3>
            <p class="meta" style="margin:0 0 10px;">Invoices, receipts, reminders, and mail you send from here.</p>
            <ul class="engagement-list">${activityList(to)}</ul>
          </div>
          <div class="settings-section" style="max-width:none;margin:0;">
            <h3>From clients</h3>
            <p class="meta" style="margin:0 0 10px;">Project messages and change requests they send in.</p>
            <ul class="engagement-list">${activityList(from)}</ul>
          </div>
        </div>`;
      document.getElementById('admin-email-autos')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = {};
        AUTO_FLAGS.forEach((f) => {
          value[f.key] = Boolean(e.target.elements[f.key]?.checked);
        });
        try {
          await saveOrgKey('email_automations', value, 'Email automations saved');
        } catch (err) {
          orgFlash(err.message, false);
        }
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  function bind() {
    if (typeof CresAdminInbox !== 'undefined') CresAdminInbox.bind();
    document.getElementById('btn-add-user')?.addEventListener('click', () => openUserForm(null, []));
    document.getElementById('btn-invite-user')?.addEventListener('click', () =>
      openInviteForm().catch((err) => alert(err.message))
    );
    document.querySelectorAll('#user-modal [data-close-modal], #invite-modal [data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.modal-backdrop')?.classList.remove('open'));
    });

    document.getElementById('invite-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        await CresAPI.request('/api/invites/invite', {
          method: 'POST',
          body: {
            name: form.name.value.trim(),
            email: form.email.value.trim(),
            phone: form.phone.value.trim() || null,
            role: form.role.value,
          },
          idempotencyKey: `invite-${form.email.value.trim()}-${Date.now()}`,
        });
        document.getElementById('invite-modal').classList.remove('open');
        flash(document.getElementById('users-flash'), 'Invite emailed — user will set their own password');
        await mountUsers();
      } catch (err) {
        flash(document.getElementById('invite-form-flash'), err.message, false);
      }
    });

    document.getElementById('user-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const id = form.dataset.id;
      const payload = {
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        phone: form.phone.value.trim() || null,
        role: form.role.value,
        status: form.status.value,
      };
      try {
        if (id) {
          if (form.password?.value) payload.password = form.password.value;
          await CresAPI.request(`/api/users/${id}`, { method: 'PATCH', body: payload });
          flash(document.getElementById('users-flash'), 'User updated - role changes apply on next request');
        } else {
          payload.password = form.password.value;
          await CresAPI.request('/api/users', {
            method: 'POST',
            body: payload,
            idempotencyKey: `user-${payload.email}-${Date.now()}`,
          });
          flash(document.getElementById('users-flash'), 'User created');
        }
        document.getElementById('user-modal').classList.remove('open');
        await mountUsers();
      } catch (err) {
        flash(document.getElementById('user-form-flash'), err.message, false);
      }
    });

    document.getElementById('btn-export-login-audit')?.addEventListener('click', () => {
      CresAPI.download('/api/export/login-audit.csv', 'login-audit.csv').catch((err) => alert(err.message));
    });

    ['users-filter-role', 'users-filter-status'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => mountUsers().catch(console.error));
    });
    ['admin-reports-role', 'admin-reports-person', 'admin-reports-from', 'admin-reports-to'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => mountDailyReports().catch(console.error));
    });
  }

  function healthPill(h) {
    const map = {
      healthy: ['on_track', 'Healthy'],
      watch: ['due_soon', 'Watch'],
      tight: ['overdue', 'Tight'],
    };
    const [cls, label] = map[h] || ['pending', h || '-'];
    return `<span class="status-pill ${esc(cls)}">${esc(label)}</span>`;
  }

  async function mountFinance() {
    const host = document.getElementById('admin-finance-overview');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/finance/overview');
      const d = res.data;
      const k = d.kpis;
      const cats = (bucket) =>
        (bucket.byCategory || [])
          .map((c) => `<li><strong>${esc(c.category)}</strong> · ${fmtMoney(c.total)}</li>`)
          .join('') || '<li class="meta">None this month</li>';
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Financial health</div>
            <div class="kpi-value" style="font-size:1.15rem;">${healthPill(d.health)}</div>
            <div class="meta">Collected ${(k.collectionRate * 100).toFixed(0)}% · ${k.overdueCount} overdue</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Revenue this month</div>
            <div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(k.revenueThisMonth)}</div>
            <div class="meta">${esc(d.monthLabel)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Expenses this month</div>
            <div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(k.expensesThisMonth)}</div>
            <div class="meta">Internal ${fmtMoney(k.internalThisMonth)} · External ${fmtMoney(k.externalThisMonth)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Net this month</div>
            <div class="kpi-value" style="font-size:1.25rem;">${fmtMoney(k.netThisMonth)}</div>
            <div class="meta">Account ${fmtMoney(k.accountBalance)} · Outstanding ${fmtMoney(k.outstanding)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px;">
          <div class="settings-section" style="margin:0;">
            <h3>Internal expenses this month</h3>
            <p class="meta" style="margin:0 0 8px;">Salaries and hosting</p>
            <ul class="engagement-list">${cats(d.expensesThisMonth.internal)}</ul>
          </div>
          <div class="settings-section" style="margin:0;">
            <h3>External expenses this month</h3>
            <p class="meta" style="margin:0 0 8px;">Ads, transport, domains, drawings, and other</p>
            <ul class="engagement-list">${cats(d.expensesThisMonth.external)}</ul>
          </div>
        </div>
        <div class="settings-section" style="margin-top:16px;">
          <h3>All projects</h3>
          <p class="meta" style="margin:0 0 10px;">Value, invoiced, paid, and outstanding balance for every project.</p>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr><th>Project</th><th>Client</th><th>Value</th><th>Invoiced</th><th>Paid</th><th>Balance</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${
                  d.projects.length
                    ? d.projects
                        .map(
                          (p) => `<tr>
                            <td>${esc(p.name)}</td>
                            <td>${esc(p.client_name || p.client_business || '-')}</td>
                            <td>${p.value_amount != null ? fmtMoney(p.value_amount) : '—'}</td>
                            <td>${fmtMoney(p.invoiced)}</td>
                            <td>${fmtMoney(p.paid)}</td>
                            <td>${fmtMoney(p.balance)}</td>
                            <td>${statusPill(p.status)}</td>
                          </tr>`
                        )
                        .join('')
                    : `<tr><td colspan="7" class="empty-state">No projects yet.</td></tr>`
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
    if (user.role !== 'admin') return;
    if (faceId === 'home') await mountHome();
    else if (faceId === 'finance') await mountFinance();
    else if (faceId === 'users') await mountUsers();
    else if (faceId === 'reports') await mountReports();
    else if (faceId === 'organization') await mountSystemSettings();
    else if (faceId === 'email') await mountEmailOrg();
    else if (faceId === 'login-audit') await mountLoginAudit();
  }

  return { bind, mount };
})();
