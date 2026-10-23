/**
 * Step 7 - Project Management (PM) module
 */
const CresPM = (() => {
  let healthChart = null;
  let devPerfChart = null;
  let salesPerfChart = null;
  let notifUnsub = null;

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

  function statusPill(s) {
    return `<span class="status-pill ${esc(s || '')}">${esc((s || '').replace(/_/g, ' '))}</span>`;
  }

  function healthPill(h) {
    const map = { on_track: 'On track', due_soon: 'Due soon', overdue: 'Overdue' };
    return `<span class="status-pill ${esc(h || '')}">${esc(map[h] || h || '-')}</span>`;
  }

  function flash(el, msg, ok = true) {
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  function rowClass(health) {
    if (health === 'overdue') return 'row-overdue';
    if (health === 'due_soon') return 'row-due-soon';
    return '';
  }

  async function mountHome() {
    const host = document.getElementById('pm-dashboard');
    if (!host) return;
    try {
      const [res, workload] = await Promise.all([
        CresAPI.request('/api/pm/dashboard'),
        CresAPI.request('/api/projects/meta/developer-workload').catch(() => ({ data: [] })),
      ]);
      const d = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Active projects</div><div class="kpi-value">${d.kpis.activeProjects}</div></div>
          <div class="kpi-card"><div class="kpi-label">Due soon</div><div class="kpi-value">${d.kpis.dueSoon}</div></div>
          <div class="kpi-card"><div class="kpi-label">Overdue</div><div class="kpi-value">${d.kpis.overdue}</div></div>
          <div class="kpi-card"><div class="kpi-label">Pending hours</div><div class="kpi-value">${d.kpis.pendingHours || 0}<span style="font-size:0.75rem;color:var(--text-muted);">h</span></div></div>
          <div class="kpi-card"><div class="kpi-label">Pending tasks</div><div class="kpi-value">${d.kpis.pendingTasks || 0}</div></div>
          <div class="kpi-card"><div class="kpi-label">Team load (avg)</div><div class="kpi-value">${d.kpis.teamLoad}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:14px;margin-top:16px;">
          <div class="chart-panel">
            <h3>Health flags</h3>
            <div class="chart-wrap"><canvas id="pm-health-chart"></canvas></div>
          </div>
          <div class="settings-section" style="margin:0;">
            <h3>Developer workload</h3>
            <ul class="engagement-list" id="pm-team-load"></ul>
            <p style="margin:10px 0 0;color:var(--text-muted);font-size:0.8rem;">
              Pending reports in your inbox: ${d.kpis.pendingReports}
            </p>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px;">
          <div class="chart-panel">
            <h3>Developer performance (avg completion %)</h3>
            <div class="chart-wrap"><canvas id="pm-dev-perf-chart"></canvas></div>
          </div>
          <div class="chart-panel">
            <h3>Sales performance (projects created)</h3>
            <div class="chart-wrap"><canvas id="pm-sales-perf-chart"></canvas></div>
          </div>
        </div>
        <div class="settings-section" style="margin-top:16px;max-width:none;">
          <h3>Flagged due work</h3>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>Project</th><th>Developer</th><th>Due</th><th>Health</th></tr></thead>
              <tbody id="pm-flagged-tbody"></tbody>
            </table>
          </div>
        </div>`;

      const loadEl = document.getElementById('pm-team-load');
      const wl = workload.data?.length ? workload.data : d.teamLoad || [];
      loadEl.innerHTML = wl.length
        ? wl
            .map((t) => {
              const name = t.name || t.developerName;
              const active = t.active_count ?? t.activeCount ?? 0;
              const completed = t.completed_count;
              const overdue = t.overdueCount;
              return `<li>
                <div class="meta">${esc(name)}</div>
                <div>${active} active${completed != null ? ` · ${completed} completed` : ''}${
                  overdue ? ` · ${overdue} overdue` : ''
                }</div>
              </li>`;
            })
            .join('')
        : `<li class="empty-state">No assigned developers on active projects.</li>`;

      const flagged = document.getElementById('pm-flagged-tbody');
      flagged.innerHTML = d.flagged.length
        ? d.flagged
            .map(
              (p) => `<tr class="${rowClass(p.health)} clickable-row" data-id="${esc(p.id)}">
                <td>${esc(p.name)}</td>
                <td>${esc(p.developer_name || '-')}</td>
                <td>${fmtDate(p.due_date)}</td>
                <td>${healthPill(p.health)}</td>
              </tr>`
            )
            .join('')
        : `<tr><td colspan="4" class="empty-state">No due-soon or overdue projects.</td></tr>`;

      flagged.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.addEventListener('click', () => {
          location.hash = `#/projects/${tr.dataset.id}`;
        });
      });

      const barOpts = {
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
      };

      if (healthChart) healthChart.destroy();
      healthChart = new Chart(document.getElementById('pm-health-chart'), {
        type: 'doughnut',
        data: {
          labels: d.healthChart.labels,
          datasets: [{
            data: d.healthChart.values.some((v) => v > 0) ? d.healthChart.values : [1],
            backgroundColor: ['#00a8c5', '#f5a623', '#e05a5a'],
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8b9aab' } } },
        },
      });

      const dp = d.developerPerformance || { labels: [], values: [] };
      if (devPerfChart) devPerfChart.destroy();
      devPerfChart = new Chart(document.getElementById('pm-dev-perf-chart'), {
        type: 'bar',
        data: {
          labels: dp.labels.length ? dp.labels : ['No developers'],
          datasets: [{
            label: 'Avg completion %',
            data: dp.labels.length ? dp.values : [0],
            backgroundColor: 'rgba(0, 168, 197, 0.65)',
            borderRadius: 6,
          }],
        },
        options: {
          ...barOpts,
          scales: {
            ...barOpts.scales,
            y: { ...barOpts.scales.y, max: 100 },
          },
        },
      });

      const sp = d.salesPerformance || { labels: [], values: [] };
      if (salesPerfChart) salesPerfChart.destroy();
      salesPerfChart = new Chart(document.getElementById('pm-sales-perf-chart'), {
        type: 'bar',
        data: {
          labels: sp.labels.length ? sp.labels : ['No sales'],
          datasets: [{
            label: 'Projects',
            data: sp.labels.length ? sp.values : [0],
            backgroundColor: 'rgba(90, 150, 220, 0.65)',
            borderRadius: 6,
          }],
        },
        options: barOpts,
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountTimeline() {
    const host = document.getElementById('timeline-body');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/projects/meta/timeline');
      const items = res.data || [];
      if (!items.length) {
        host.innerHTML = `<div class="empty-state">No milestone due dates to chart yet.</div>`;
        return;
      }
      const dates = items.map((i) => new Date(i.due_date).getTime()).filter((n) => !Number.isNaN(n));
      const min = Math.min(...dates);
      const max = Math.max(...dates, min + 86400000);
      const span = Math.max(max - min, 86400000 * 7);
      const today = Date.now();

      host.innerHTML = `
        <div class="gantt-legend" style="margin-bottom:12px;color:var(--text-muted);font-size:0.8rem;">
          Bars align to milestone due dates · Today marked
        </div>
        <div class="gantt-list">
          ${items
            .map((i) => {
              const due = new Date(i.due_date).getTime();
              const left = ((due - min) / span) * 100;
              const width = Math.max(4, 100 / Math.max(items.length, 8));
              const todayLeft = ((today - min) / span) * 100;
              return `<div class="gantt-row" data-id="${esc(i.projectId)}">
                <div class="gantt-label">
                  <strong>${esc(i.projectName)}</strong>
                  <span class="meta">${esc(i.milestone)} · ${esc(i.developer_name || 'Unassigned')} · ${statusPill(i.status)}</span>
                </div>
                <div class="gantt-track">
                  <div class="gantt-today" style="left:${Math.min(100, Math.max(0, todayLeft))}%"></div>
                  <div class="gantt-bar status-${esc(i.status)}" style="left:${Math.min(96, Math.max(0, left))}%;width:${width}%;" title="${esc(i.due_date)}"></div>
                </div>
                <div class="gantt-due">${fmtDate(i.due_date)}</div>
              </div>`;
            })
            .join('')}
        </div>`;

      host.querySelectorAll('.gantt-row[data-id]').forEach((row) => {
        row.addEventListener('click', () => {
          location.hash = `#/projects/${row.dataset.id}`;
        });
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function fillFilters() {
    const [devs, clients] = await Promise.all([
      CresAPI.request('/api/users/developers'),
      CresAPI.request('/api/clients'),
    ]);
    const devSel = document.getElementById('pm-filter-developer');
    const clientSel = document.getElementById('pm-filter-client');
    if (devSel && devSel.options.length <= 1) {
      devSel.innerHTML =
        `<option value="">All developers</option>` +
        (devs.data || []).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    }
    if (clientSel && clientSel.options.length <= 1) {
      clientSel.innerHTML =
        `<option value="">All clients</option>` +
        (clients.data || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    }
  }

  async function mountProjects(projectId) {
    const listPanel = document.getElementById('pm-projects-panel');
    const detailPanel = document.getElementById('pm-project-detail');
    const salesPanel = document.getElementById('sales-projects-chrome');
    if (!listPanel) return;

    // Hide sales create chrome for PM
    if (salesPanel) salesPanel.hidden = true;
    const btn = document.getElementById('btn-new-project');
    if (btn) btn.hidden = true;

    if (projectId) {
      listPanel.hidden = true;
      if (detailPanel) detailPanel.hidden = false;
      await mountProjectDetail(projectId);
      return;
    }

    listPanel.hidden = false;
    if (detailPanel) detailPanel.hidden = true;

    await fillFilters();
    const params = new URLSearchParams();
    const status = document.getElementById('pm-filter-status')?.value;
    const developer = document.getElementById('pm-filter-developer')?.value;
    const client = document.getElementById('pm-filter-client')?.value;
    const from = document.getElementById('pm-filter-from')?.value;
    const to = document.getElementById('pm-filter-to')?.value;
    const health = document.getElementById('pm-filter-health')?.value;
    if (status) params.set('status', status);
    if (developer) params.set('developer_id', developer);
    if (client) params.set('client_id', client);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);
    if (health) params.set('health', health);

    const exportBtn = document.getElementById('btn-export-pm-projects');
    if (exportBtn) exportBtn.hidden = false;

    const res = await CresAPI.request(`/api/pm/projects?${params}`);
    const tbody = document.getElementById('pm-projects-tbody');
    if (!tbody) return;
    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No projects match these filters.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.data
      .map(
        (p) => `<tr class="${rowClass(p.health)} clickable-row" data-id="${esc(p.id)}">
          <td>${esc(p.name)}</td>
          <td>${esc(p.client_name || '-')}</td>
          <td>${esc(p.developer_name || '-')}</td>
          <td>${statusPill(p.status)}</td>
          <td>${p.progress_pct}%</td>
          <td>${fmtDate(p.due_date)} ${healthPill(p.health)}</td>
        </tr>`
      )
      .join('');

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        location.hash = `#/projects/${tr.dataset.id}`;
      });
    });
  }

  async function mountProjectDetail(id) {
    const panel = document.getElementById('pm-project-detail');
    if (!panel) return;
    try {
      const [pmRes, projRes, updatesRes] = await Promise.all([
        CresAPI.request(`/api/pm/projects/${id}`),
        CresAPI.request(`/api/projects/${id}`),
        CresAPI.request(`/api/projects/${id}/updates`),
      ]);
      const { project: p } = pmRes.data;
      const meta = projRes.meta || {};
      const canUpdate = !!meta.canUpdateProgress;
      const milestones = (Array.isArray(p.milestones) ? p.milestones : []).map((m) => ({
        ...m,
        status: (m.status === 'pending' ? 'not_started' : m.status) || 'not_started',
      }));

      panel.innerHTML = `
        <button type="button" class="btn btn-ghost" id="pm-project-back" style="margin-bottom:12px;">Back to projects</button>
        <div class="face-hero" style="margin-bottom:12px;">
          <h2 style="margin:0;">${esc(p.name)}</h2>
          <p style="margin:6px 0 0;">${esc(p.client_name || 'No client')} · ${esc(p.developer_name || 'Unassigned')} · ${statusPill(p.status)} · ${healthPill(p.health)}</p>
          ${
            p.preview_url
              ? `<p style="margin:10px 0 0;"><a href="${esc(p.preview_url)}" target="_blank" rel="noopener">Preview link</a></p>`
              : ''
          }
        </div>
        <div id="pm-project-contact"></div>
        <div class="kpi-grid" style="margin-bottom:16px;">
          <div class="kpi-card"><div class="kpi-label">Progress</div><div class="kpi-value" style="font-size:1.2rem;">${p.progress_pct}%</div></div>
          <div class="kpi-card"><div class="kpi-label">Due date</div><div class="kpi-value" style="font-size:1.2rem;">${fmtDate(p.due_date)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Sales owner</div><div class="kpi-value" style="font-size:1.1rem;">${esc(p.sales_name || '-')}</div></div>
          <div class="kpi-card"><div class="kpi-label">Pending work</div><div class="kpi-value" style="font-size:1.1rem;">${p.pending_tasks || 0} tasks · ${p.pending_hours || 0}h</div></div>
        </div>
        <div class="settings-section" style="max-width:720px;">
          <h3>Sales summary</h3>
          <p style="white-space:pre-wrap;margin:0;">${esc(p.summary || p.description || 'No summary provided.')}</p>
        </div>
        <div class="settings-section" style="max-width:none;">
          <h3>Milestones</h3>
          <div id="pm-ms-editor"></div>
        </div>
        ${
          canUpdate
            ? `<div class="settings-section" style="max-width:640px;">
                <h3>Log progress</h3>
                <div class="form-grid">
                  <div><label>Project status</label>
                    <select id="pm-proj-status">
                      <option value="in_progress">In progress</option>
                      <option value="blocked">Blocked</option>
                      <option value="completed">Completed</option>
                      <option value="approved">Approved</option>
                    </select>
                  </div>
                  <div><label>Note</label>
                    <textarea id="pm-proj-note" rows="3" style="width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);"></textarea>
                  </div>
                  <div class="form-actions"><button type="button" class="btn btn-primary" id="pm-save-progress">Save progress</button></div>
                </div>
                <div id="pm-progress-flash" class="flash"></div>
              </div>`
            : ''
        }
        <div id="pm-project-extras"></div>
        <div class="settings-section" style="max-width:720px;">
          <h3>Audit log</h3>
          <p style="margin:0 0 8px;color:var(--text-muted);font-size:0.8rem;">Append-only. Who changed what and when.</p>
          ${typeof CresProjectDetail !== 'undefined' ? CresProjectDetail.auditHtml(updatesRes.data) : ''}
        </div>`;

      const msBox = document.getElementById('pm-ms-editor');
      if (canUpdate) {
        msBox.innerHTML = milestones
          .map((m, i) => {
            const tasks = (m.tasks || [])
              .map((t) => {
                const flag = t.status !== 'done'
                  ? `<span class="pending-flag">${esc(String(t.hours || 0))}h · ${esc(t.status || 'pending')}</span>`
                  : `<span class="meta">done</span>`;
                return `<div class="meta" style="margin:4px 0 0 8px;">• ${esc(t.title || 'Task')} ${flag}</div>`;
              })
              .join('');
            return `<div class="ms-block">
              <div style="display:grid;grid-template-columns:1fr 160px;gap:8px;margin-bottom:8px;">
                <div>
                  <strong>${esc(m.title || m.name || '-')}</strong>
                  ${(m.pending_tasks || (m.tasks || []).filter((t) => t.status !== 'done').length)
                    ? `<span class="pending-flag">work pending</span>`
                    : ''}
                </div>
                <select data-ms="${i}">
                  <option value="not_started">Not started</option>
                  <option value="in_progress">In progress</option>
                  <option value="blocked">Blocked</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              ${tasks || '<div class="meta">No developer tasks yet.</div>'}
            </div>`;
          })
          .join('') || '<div class="empty-state">No milestones</div>';
        msBox.querySelectorAll('select[data-ms]').forEach((sel) => {
          const idx = Number(sel.dataset.ms);
          sel.value = milestones[idx].status;
          sel.addEventListener('change', () => {
            milestones[idx].status = sel.value;
          });
        });
        const st = document.getElementById('pm-proj-status');
        if (st) {
          st.value = ['in_progress', 'blocked', 'completed', 'approved'].includes(p.status)
            ? p.status
            : 'in_progress';
        }
        document.getElementById('pm-save-progress')?.addEventListener('click', async () => {
          try {
            await CresAPI.request(`/api/projects/${id}/progress`, {
              method: 'PATCH',
              body: {
                status: document.getElementById('pm-proj-status').value,
                milestones,
                note: document.getElementById('pm-proj-note').value.trim() || undefined,
              },
              idempotencyKey: `pm-prog-${id}-${Date.now()}`,
            });
            flash(document.getElementById('pm-progress-flash'), 'Progress saved');
            await mountProjectDetail(id);
          } catch (err) {
            flash(document.getElementById('pm-progress-flash'), err.message, false);
          }
        });
      } else {
        msBox.innerHTML = `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Milestone</th><th>Status</th><th>Due</th></tr></thead><tbody>${
          milestones.length
            ? milestones
                .map(
                  (m) => `<tr><td>${esc(m.title || m.name)}</td><td>${statusPill(m.status)}</td><td>${fmtDate(m.due_date)}</td></tr>`
                )
                .join('')
            : '<tr><td colspan="3">No milestones</td></tr>'
        }</tbody></table></div>`;
      }

      const contactHost = document.getElementById('pm-project-contact');
      const extrasHost = document.getElementById('pm-project-extras');
      const contactSrc = { ...p, ...projRes.data };
      if (contactHost && typeof CresProjectDetail !== 'undefined') {
        contactHost.innerHTML = CresProjectDetail.contactHtml(contactSrc);
        contactHost.querySelectorAll('[data-open-client-card]').forEach((btn) => {
          btn.addEventListener('click', () => {
            if (typeof CresClientCard !== 'undefined') {
              CresClientCard.open(btn.dataset.openClientCard).catch(console.error);
            }
          });
        });
      }
      if (extrasHost && typeof CresProjectDetail !== 'undefined') {
        await CresProjectDetail.mountExtras(extrasHost, {
          id,
          project: contactSrc,
          meta,
          user: CresAPI.getUser(),
          onRefresh: () => mountProjectDetail(id),
          showContact: false,
          showMoney: false,
          allowMessages: true,
          allowDecide: true,
          allowBlocked: true,
          allowChangeForm: false,
        });
      }

      document.getElementById('pm-project-back')?.addEventListener('click', () => {
        location.hash = '#/projects';
      });
    } catch (err) {
      panel.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  async function mountTasks() {
    if (typeof CresTasks !== 'undefined') return CresTasks.mount();
  }

  async function createTask() {
    /* CresTasks */
  }

  async function mountReports() {
    const params = new URLSearchParams();
    const role = document.getElementById('pm-reports-role')?.value;
    const routing = document.getElementById('pm-reports-routing')?.value;
    const from = document.getElementById('pm-reports-from')?.value;
    const to = document.getElementById('pm-reports-to')?.value;
    if (role) params.set('role', role);
    if (routing) params.set('routing_status', routing);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const res = await CresAPI.request(`/api/reports?${params}`);
    const list = document.getElementById('pm-reports-list');
    if (!list) return;

    list.innerHTML = res.data.length
      ? res.data
          .map((r) => {
            const canRoute = r.routing_status !== 'forwarded_director';
            return `<li data-id="${esc(r.id)}">
              <div class="meta report-author">
                ${typeof CresSettings !== 'undefined' ? CresSettings.avatarHtml({ name: r.author_name, avatar_url: r.author_avatar_url }, 'avatar avatar-sm') : ''}
                <span>${esc(r.author_name)} · ${esc(r.author_role)} · ${CresFormat.datetime(r.created_at)}
                ${r.project_name ? ` · ${esc(r.project_name)}` : ''}
                · ${statusPill(r.routing_status)}</span>
              </div>
              <div>${esc(r.content)}</div>
              ${
                r.pm_note
                  ? `<div class="meta" style="margin-top:6px;">PM note: ${esc(r.pm_note)}</div>`
                  : ''
              }
              ${
                canRoute
                  ? `<div class="toolbar" style="margin-top:8px;">
                      <button type="button" class="btn btn-ghost btn-sm" data-review="${esc(r.id)}">Mark reviewed</button>
                      <button type="button" class="btn btn-primary btn-sm" data-forward="${esc(r.id)}">Forward to Director</button>
                    </div>`
                  : `<div class="meta" style="margin-top:6px;">Forwarded ${
                      r.forwarded_at ? CresFormat.datetime(r.forwarded_at) : ''
                    }</div>`
              }
            </li>`;
          })
          .join('')
      : `<li class="empty-state">No reports match these filters.</li>`;

    list.querySelectorAll('[data-review]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/reports/${btn.dataset.review}/review`, {
            method: 'POST',
            body: {},
          });
          flash(document.getElementById('pm-reports-flash'), 'Marked reviewed');
          await mountReports();
        } catch (err) {
          flash(document.getElementById('pm-reports-flash'), err.message, false);
        }
      });
    });
    list.querySelectorAll('[data-forward]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/reports/${btn.dataset.forward}/forward`, {
            method: 'POST',
            body: {},
          });
          flash(document.getElementById('pm-reports-flash'), 'Forwarded to Director hub');
          await mountReports();
        } catch (err) {
          flash(document.getElementById('pm-reports-flash'), err.message, false);
        }
      });
    });
  }

  function bindRealtime() {
    if (notifUnsub || typeof CresRealtime === 'undefined') return;
    notifUnsub = CresRealtime.on('notification', (payload) => {
      if (!payload) return;
      const type = payload.type;
      if (['project_update', 'project_approved', 'daily_report', 'report_forwarded'].includes(type)) {
        const hash = location.hash.replace(/^#/, '') || '/';
        if (hash === '/' || hash === '') mountHome().catch(console.error);
        if (hash.startsWith('/projects')) {
          const parts = hash.split('/').filter(Boolean);
          mountProjects(parts[1] || null).catch(console.error);
        }
      }
    });
  }

  function bind() {
    ['pm-filter-status', 'pm-filter-developer', 'pm-filter-client', 'pm-filter-from', 'pm-filter-to', 'pm-filter-health'].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener('change', () => mountProjects().catch(console.error));
      }
    );
    ['pm-reports-role', 'pm-reports-routing', 'pm-reports-from', 'pm-reports-to'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => mountReports().catch(console.error));
    });
    document.getElementById('btn-export-pm-projects')?.addEventListener('click', () => {
      CresAPI.download('/api/export/projects.csv', 'projects.csv').catch((err) => alert(err.message));
    });
  }

  async function mount(faceId, user, faceParam) {
    const tab = new URLSearchParams((location.hash.split('?')[1] || '')).get('tab') || '';
    const timelineOn = faceId === 'timeline' || (faceId === 'projects' && tab === 'timeline');
    if (user.role === 'pm') {
      bindRealtime();
      if (faceId === 'home') await mountHome();
      else if (timelineOn) await mountTimeline();
      else if (faceId === 'projects') await mountProjects(faceParam || null);
      else if (faceId === 'tasks') await mountTasks();
      else if (faceId === 'reports') await mountReports();
      return;
    }
    if (['director', 'admin'].includes(user.role) && timelineOn) {
      await mountTimeline();
    }
  }

  return { bind, mount, mountTimeline };
})();
