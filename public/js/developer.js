/**
 * Step 5 - Developer module faces
 */
const CresDeveloper = (() => {
  let chart;
  let activeProjectId = null;
  let activeMilestones = [];

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

  function flash(el, msg, ok = true) {
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  function normalizeMsStatus(s) {
    if (!s || s === 'pending') return 'not_started';
    return s;
  }

  function newTaskId() {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function pendingHoursSummary(milestones) {
    let hours = 0;
    let tasks = 0;
    for (const m of milestones || []) {
      for (const t of m.tasks || []) {
        if (t.status !== 'done') {
          hours += Number(t.hours) || 0;
          tasks += 1;
        }
      }
    }
    return { hours, tasks };
  }

  function ensureMilestoneShape(m, i) {
    return {
      id: m.id || `m-${i}-${Date.now()}`,
      title: m.title || m.name || `Milestone ${i + 1}`,
      status: normalizeMsStatus(m.status),
      due_date: m.due_date || null,
      tasks: Array.isArray(m.tasks)
        ? m.tasks.map((t) => ({
            id: t.id || newTaskId(),
            title: t.title || 'Task',
            hours: Number(t.hours) || 0,
            status: t.status === 'done' || t.status === 'in_progress' ? t.status : 'pending',
          }))
        : [],
    };
  }

  async function mountHome() {
    const host = document.getElementById('developer-dashboard');
    if (!host) return;
    try {
      const res = await CresAPI.request('/api/developer/dashboard');
      const { kpis, chart: c, pendingInvitations = [] } = res.data;
      host.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Assigned projects</div><div class="kpi-value">${kpis.assignedProjects}</div></div>
          <div class="kpi-card"><div class="kpi-label">Active projects</div><div class="kpi-value">${kpis.activeProjects}</div></div>
          <div class="kpi-card"><div class="kpi-label">Tasks due today</div><div class="kpi-value">${kpis.tasksDueToday}</div></div>
          <div class="kpi-card"><div class="kpi-label">Tasks completed today</div><div class="kpi-value">${kpis.tasksCompletedToday}</div></div>
          <div class="kpi-card"><div class="kpi-label">Pending invitations</div><div class="kpi-value">${kpis.pendingInvitations}</div></div>
        </div>
        <div class="settings-section" style="margin-top:16px;max-width:none;">
          <h3>Pending invitations</h3>
          <div id="dev-invitations">${renderInvitations(pendingInvitations)}</div>
        </div>
        <div class="chart-panel" style="margin-top:16px;">
          <h3>Project completion progress</h3>
          <div class="chart-wrap"><canvas id="dev-progress-chart"></canvas></div>
        </div>`;

      bindInvitationActions(host);

      const ctx = document.getElementById('dev-progress-chart');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: c.labels.length ? c.labels : ['No active projects'],
          datasets: [{
            label: 'Completion %',
            data: c.values.length ? c.values : [0],
            backgroundColor: 'rgba(0, 168, 197, 0.65)',
            borderRadius: 6,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              min: 0,
              max: 100,
              ticks: { color: '#8b9aab' },
              grid: { color: 'rgba(42,52,65,0.5)' },
            },
            y: {
              ticks: { color: '#8b9aab' },
              grid: { color: 'rgba(42,52,65,0.5)' },
            },
          },
        },
      });
    } catch (err) {
      host.innerHTML = `<div class="placeholder-card">${esc(err.message)}</div>`;
    }
  }

  function renderInvitations(list) {
    if (!list.length) {
      return `<div class="empty-state">No pending project invitations.</div>`;
    }
    return list
      .map(
        (inv) => `<div class="invitation-card" data-assignment="${esc(inv.id)}">
          <div>
            <strong>${esc(inv.project_name)}</strong>
            <div class="meta">${esc(inv.assigned_by_name || 'Assigned')} · ${statusPill(inv.project_status)}${
              inv.original_developer_name
                ? ` · swap from ${esc(inv.original_developer_name)}`
                : ''
            }</div>
            ${inv.summary ? `<div style="margin-top:6px;color:var(--text-muted);font-size:0.85rem;">${esc(inv.summary)}</div>` : ''}
          </div>
          <div class="invitation-actions">
            <button type="button" class="btn btn-primary btn-sm" data-invite-accept="${esc(inv.id)}">Accept</button>
            <button type="button" class="btn btn-ghost btn-sm" data-invite-swap="${esc(inv.id)}">Swap</button>
            <button type="button" class="btn btn-ghost btn-sm" data-invite-reject="${esc(inv.id)}">Reject</button>
          </div>
        </div>`
      )
      .join('');
  }

  async function pickDeveloper(title, excludeId) {
    const res = await CresAPI.request('/api/users/developers');
    const list = (res.data || []).filter((d) => d.id !== excludeId);
    if (!list.length) {
      alert('No other developers available');
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

  function bindInvitationActions(host) {
    host.querySelectorAll('[data-invite-accept]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/assignments/${btn.dataset.inviteAccept}/accept`, {
            method: 'POST',
            idempotencyKey: `accept-${btn.dataset.inviteAccept}-${Date.now()}`,
          });
          await mountHome();
          await mountProjects();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    host.querySelectorAll('[data-invite-reject]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reject this project invitation?')) return;
        try {
          await CresAPI.request(`/api/assignments/${btn.dataset.inviteReject}/reject`, {
            method: 'POST',
            body: {},
            idempotencyKey: `reject-${btn.dataset.inviteReject}-${Date.now()}`,
          });
          await mountHome();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    host.querySelectorAll('[data-invite-swap]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const user = CresAPI.getUser();
          const developerId = await pickDeveloper('Swap to another developer', user?.id);
          if (!developerId) return;
          await CresAPI.request(`/api/assignments/${btn.dataset.inviteSwap}/swap`, {
            method: 'POST',
            body: { developer_id: developerId },
            idempotencyKey: `swap-${btn.dataset.inviteSwap}-${Date.now()}`,
          });
          await mountHome();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  async function mountProjects() {
    const [res, inviteRes] = await Promise.all([
      CresAPI.request('/api/developer/projects'),
      CresAPI.request('/api/assignments/pending').catch(() => ({ data: [] })),
    ]);
    const tbody = document.getElementById('projects-tbody');
    const btn = document.getElementById('btn-new-project');
    if (btn) btn.hidden = true;
    const thead = document.querySelector('#sales-projects-chrome thead tr');
    if (thead) thead.innerHTML = '<th>Name</th><th>Status</th><th>Progress</th>';
    const hero = document.querySelector('#face-projects .face-hero p');
    if (hero) {
      hero.textContent = 'Update milestones and hours on your assigned work.';
    }

    const wrap = tbody?.closest('.data-table-wrap');
    let banner = document.getElementById('dev-invite-banner');
    if (!banner && wrap) {
      banner = document.createElement('div');
      banner.id = 'dev-invite-banner';
      banner.style.margin = '0 0 14px';
      wrap.before(banner);
    }
    if (banner) {
      const pending = inviteRes.data || [];
      banner.innerHTML = pending.length
        ? `<div class="settings-section" style="margin:0;max-width:none;"><h3>Pending invitations</h3>${renderInvitations(pending)}</div>`
        : '';
      if (pending.length) bindInvitationActions(banner);
    }

    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No assigned projects yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = res.data
      .map(
        (p) => `<tr data-id="${p.id}" class="clickable-row">
          <td>${esc(p.name)}</td>
          <td>${statusPill(p.status)}</td>
          <td>${p.progress_pct}%</td>
        </tr>`
      )
      .join('');

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        if (typeof CresProjectDetail !== 'undefined') {
          CresProjectDetail.open(tr.dataset.id, { onSaved: () => mountProjects() }).catch(console.error);
        } else {
          openProject(tr.dataset.id);
        }
      });
    });
  }

  function progressPct(list) {
    if (!list?.length) return 0;
    const done = list.filter((m) => normalizeMsStatus(m.status) === 'completed').length;
    return Math.round((done / list.length) * 100);
  }

  async function openProject(id) {
    activeProjectId = id;
    const [projRes, updatesRes] = await Promise.all([
      CresAPI.request(`/api/projects/${id}`),
      CresAPI.request(`/api/projects/${id}/updates`),
    ]);
    const p = projRes.data;
    activeMilestones = (Array.isArray(p.milestones) ? p.milestones : []).map(ensureMilestoneShape);
    const pending = pendingHoursSummary(activeMilestones);
    const pct = progressPct(activeMilestones);

    document.getElementById('dev-project-title').textContent = p.name;
    document.getElementById('dev-project-body').innerHTML = `
      <div class="form-grid" style="margin-bottom:14px;">
        <div><strong>Status</strong><div>${statusPill(p.status)}</div></div>
        <div><strong>Progress</strong><div>${pct}% <span class="meta">(${activeMilestones.filter((m) => normalizeMsStatus(m.status) === 'completed').length}/${activeMilestones.length || 0} milestones)</span></div></div>
        <div><strong>Pending work</strong><div>${pending.tasks} task(s) · ${pending.hours}h</div></div>
        <div style="grid-column:1/-1;"><strong>Description / overview</strong>
          <div style="white-space:pre-wrap;margin-top:4px;">${esc(p.description || p.summary || '-')}</div>
        </div>
        <div style="grid-column:1/-1;">
          <label for="dev-preview-url">Project preview link</label>
          <input id="dev-preview-url" type="url" placeholder="https://…" value="${esc(p.preview_url || '')}" />
          <p class="meta" style="margin:6px 0 0;">Visible to Sales, Client, PM, and Director after you save.</p>
        </div>
      </div>
      <h4 style="margin:0 0 8px;font-size:0.9rem;">Milestones &amp; tasks</h4>
      <p class="meta" style="margin:0 0 10px;">Add milestones and tasks with hours. Adding a milestone lowers % until new work is completed.</p>
      <div id="dev-milestones"></div>
      <button type="button" class="btn btn-ghost" id="dev-add-milestone" style="margin:4px 0 14px;padding:6px 10px;font-size:0.8rem;">+ Add milestone</button>
      <div style="margin-top:14px;">
        <label for="dev-project-status">Project status</label>
        <select id="dev-project-status">
          <option value="in_progress">In progress</option>
          <option value="blocked">Blocked</option>
          <option value="completed">Completed</option>
          <option value="approved">Approved</option>
        </select>
      </div>
      <div style="margin-top:12px;">
        <label for="dev-update-note">Progress note</label>
        <textarea id="dev-update-note" rows="3" placeholder="What's blocking it, what shipped, etc."></textarea>
      </div>
      <div id="dev-project-flash" class="flash" style="margin-top:10px;"></div>
      <div class="form-actions" style="margin-top:10px;">
        <button type="button" class="btn btn-primary" id="dev-save-progress">Save progress</button>
      </div>
      <h4 style="margin:20px 0 8px;font-size:0.9rem;">Update history</h4>
      <ul class="engagement-list" id="dev-updates-list"></ul>`;

    document.getElementById('dev-project-status').value =
      ['in_progress', 'blocked', 'completed', 'approved'].includes(p.status) ? p.status : 'in_progress';

    renderMilestones();
    document.getElementById('dev-add-milestone')?.addEventListener('click', () => {
      activeMilestones.push(
        ensureMilestoneShape(
          { title: `Milestone ${activeMilestones.length + 1}`, status: 'not_started', tasks: [] },
          activeMilestones.length
        )
      );
      renderMilestones();
    });

    const list = document.getElementById('dev-updates-list');
    list.innerHTML = updatesRes.data.length
      ? updatesRes.data
          .map(
            (u) => `<li>
              <div class="meta">${esc(u.author_name)} · ${CresFormat.datetime(u.created_at)}${
                u.milestone_status ? ` · ${esc(u.milestone_status)}` : ''
              }</div>
              <div>${esc(u.note || u.change_summary || '')}</div>
            </li>`
          )
          .join('')
      : `<li class="empty-state">No updates yet.</li>`;

    document.getElementById('dev-project-modal').classList.add('open');
    document.getElementById('dev-save-progress').onclick = () =>
      saveProgress().catch((err) =>
        flash(document.getElementById('dev-project-flash'), err.message, false)
      );
  }

  function renderMilestones() {
    const box = document.getElementById('dev-milestones');
    if (!activeMilestones.length) {
      box.innerHTML = `<div class="empty-state">No milestones on this project.</div>`;
      return;
    }
    box.innerHTML = activeMilestones
      .map((m, i) => {
        const tasksHtml = (m.tasks || [])
          .map(
            (t, ti) => `<div class="ms-task-row" data-ms="${i}" data-task="${ti}">
              <input data-task-title value="${esc(t.title)}" placeholder="Task" />
              <input data-task-hours type="number" min="0" step="0.5" value="${esc(t.hours)}" title="Hours" />
              <select data-task-status>
                <option value="pending"${t.status === 'pending' ? ' selected' : ''}>Pending</option>
                <option value="in_progress"${t.status === 'in_progress' ? ' selected' : ''}>In progress</option>
                <option value="done"${t.status === 'done' ? ' selected' : ''}>Done</option>
              </select>
              <button type="button" class="btn btn-ghost" data-remove-task style="padding:6px 8px;">✕</button>
            </div>`
          )
          .join('');
        return `<div class="ms-block" data-ms-block="${i}">
          <div class="milestone-row" style="grid-template-columns:1fr 160px;align-items:center;margin-bottom:8px;">
            <input data-ms-title value="${esc(m.title)}" placeholder="Milestone title" />
            <select data-ms="${i}">
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="completed">Completed</option>
            </select>
          </div>
          ${m.due_date ? `<div class="meta" style="margin:-4px 0 8px;">Due ${fmtDate(m.due_date)}</div>` : ''}
          <div class="ms-tasks">${tasksHtml || '<div class="meta">No tasks yet — add hours to plan work.</div>'}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-add-task="${i}" style="margin:6px 0 14px;padding:6px 10px;font-size:0.8rem;">+ Add task / hours</button>
        </div>`;
      })
      .join('');

    box.querySelectorAll('select[data-ms]').forEach((sel) => {
      const idx = Number(sel.dataset.ms);
      sel.value = normalizeMsStatus(activeMilestones[idx].status);
    });

    box.onchange = (e) => {
      const t = e.target;
      const block = t.closest('[data-ms-block]');
      if (!block) return;
      const mi = Number(block.dataset.msBlock);
      if (t.matches('select[data-ms]')) {
        activeMilestones[mi].status = t.value;
      }
      if (t.matches('[data-task-status]')) {
        const ti = Number(t.closest('.ms-task-row').dataset.task);
        activeMilestones[mi].tasks[ti].status = t.value;
      }
    };

    box.oninput = (e) => {
      const t = e.target;
      const block = t.closest('[data-ms-block]');
      if (!block) return;
      const mi = Number(block.dataset.msBlock);
      if (t.matches('[data-ms-title]')) {
        activeMilestones[mi].title = t.value;
      }
      const row = t.closest('.ms-task-row');
      if (!row) return;
      const ti = Number(row.dataset.task);
      if (t.matches('[data-task-title]')) activeMilestones[mi].tasks[ti].title = t.value;
      if (t.matches('[data-task-hours]')) activeMilestones[mi].tasks[ti].hours = Number(t.value) || 0;
    };

    box.onclick = (e) => {
      const addBtn = e.target.closest('[data-add-task]');
      if (addBtn) {
        const mi = Number(addBtn.dataset.addTask);
        activeMilestones[mi].tasks = activeMilestones[mi].tasks || [];
        activeMilestones[mi].tasks.push({
          id: newTaskId(),
          title: '',
          hours: 1,
          status: 'pending',
        });
        renderMilestones();
        return;
      }
      const rm = e.target.closest('[data-remove-task]');
      if (rm) {
        const row = rm.closest('.ms-task-row');
        const mi = Number(row.dataset.ms);
        const ti = Number(row.dataset.task);
        activeMilestones[mi].tasks.splice(ti, 1);
        renderMilestones();
      }
    };
  }

  async function saveProgress() {
    const note = document.getElementById('dev-update-note').value.trim();
    const status = document.getElementById('dev-project-status').value;
    const payloadMs = activeMilestones.map((m, i) => ensureMilestoneShape(m, i));
    const previewEl = document.getElementById('dev-preview-url');
    const res = await CresAPI.request(`/api/projects/${activeProjectId}/progress`, {
      method: 'PATCH',
      body: {
        status,
        milestones: payloadMs,
        preview_url: previewEl ? previewEl.value.trim() : undefined,
        note: note || undefined,
        milestone_status: payloadMs.map((m) => m.status).join(','),
      },
    });
    const done = res.data?.completed_milestones || [];
    const msg = done.length
      ? `Progress saved. Notified sales/client: ${done.join(', ')}`
      : 'Progress saved. PM will see pending hours automatically.';
    flash(document.getElementById('dev-project-flash'), msg);
    document.getElementById('dev-update-note').value = '';
    await mountProjects();
    await openProject(activeProjectId);
    return res;
  }

  async function mountTasks() {
    if (typeof CresTasks !== 'undefined') return CresTasks.mount();
  }

  async function mountReports() {
    const list = document.getElementById('reports-list');
    const reportProj = document.getElementById('report-project');
    try {
      const projects = await CresAPI.request('/api/developer/projects');
      if (reportProj) {
        reportProj.innerHTML =
          `<option value="">- No project -</option>` +
          projects.data.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      }
      const res = await CresAPI.request('/api/reports');
      if (list) {
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
    } catch (err) {
      if (list) list.innerHTML = `<tr><td colspan="5" class="empty-state">${esc(err.message)}</td></tr>`;
    }

    // Bind submit once via sales form if present
    const form = document.getElementById('report-form');
    if (form && !form.dataset.devBound) {
      form.dataset.devBound = '1';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
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
        try {
          await CresAPI.request('/api/reports', { method: 'POST', body: fd });
          form.reset();
          flash(document.getElementById('reports-flash'), 'Report submitted');
          await mountReports();
        } catch (err) {
          flash(document.getElementById('reports-flash'), err.message, false);
        }
      });
    }
    CresVoiceReport?.initVoiceReport();
    CresVoiceForms?.initVoiceForms();

    // New report toggle
    const btnNewReport = document.getElementById('btn-new-report');
    const reportFormEl = document.getElementById('report-form');
    if (btnNewReport && reportFormEl && !btnNewReport.dataset.reportBound) {
      btnNewReport.dataset.reportBound = '1';
      btnNewReport.addEventListener('click', () => {
        const isHidden = reportFormEl.style.display === 'none';
        reportFormEl.style.display = isHidden ? '' : 'none';
        btnNewReport.textContent = isHidden ? 'Close form' : 'New report';
      });
    }
  }

  function bind() {
    document.querySelectorAll('#dev-project-modal [data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('dev-project-modal')?.classList.remove('open');
      });
    });
  }

  async function mount(faceId, user) {
    if (!['developer', 'admin'].includes(user.role)) return;
    // Admin already has director; only run developer faces for developer role
    if (user.role === 'admin' && faceId === 'home') return;

    if (faceId === 'home' && user.role === 'developer') await mountHome();
    else if (faceId === 'projects' && user.role === 'developer') await mountProjects();
    else if (faceId === 'work' && user.role === 'developer') await mountTasks();
  }

  return { bind, mount, openProject };
})();
