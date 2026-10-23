/**
 * My work — today's tasks plus the daily report for every staff role.
 * Daily: Done today · Blocked by · Tomorrow's top 3.
 * Friday: weekly check-in (feelings questions).
 */
const CresMyWork = (() => {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isFriday(d = new Date()) {
    return d.getDay() === 5;
  }

  function flash(msg, ok = true) {
    const el = document.getElementById('reports-flash') || document.getElementById('tasks-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3200);
  }

  function statusPill(s) {
    return `<span class="status-pill ${esc(s || '')}">${esc((s || '').replace(/_/g, ' '))}</span>`;
  }

  function showWeeklyFields() {
    const wrap = document.getElementById('report-weekly-fields');
    if (wrap) wrap.hidden = !isFriday();
  }

  async function fillProjects(me) {
    const sel = document.getElementById('report-project');
    if (!sel) return;
    try {
      let rows = [];
      if (me.role === 'developer') {
        const res = await CresAPI.request('/api/developer/projects');
        rows = res.data || [];
      } else if (me.role !== 'hr' && me.role !== 'client') {
        const res = await CresAPI.request('/api/projects').catch(() => ({ data: [] }));
        rows = res.data || [];
      }
      sel.innerHTML =
        `<option value="">No project</option>` +
        rows.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    } catch {
      sel.innerHTML = `<option value="">No project</option>`;
    }
  }

  async function mountReports(me) {
    const list = document.getElementById('reports-list');
    const section = document.getElementById('work-report-section');
    const allowed = !['client', 'hr'].includes(me.role);

    if (section) section.hidden = !allowed;
    if (!allowed) return;

    showWeeklyFields();
    await fillProjects(me);

    if (!list) return;
    try {
      const qs = ['sales', 'developer'].includes(me.role) ? '' : '?mine=1';
      const res = await CresAPI.request(`/api/reports${qs}`);
      const rows = res.data || [];
      list.innerHTML = rows.length
        ? rows
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
                   ${
                     r.remarks_reply
                       ? `<div style="margin-top:6px;padding:8px;border-left:3px solid var(--accent);background:rgba(0,168,197,0.06);border-radius:0 6px 6px 0;">
                            <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:2px;">Your reply</div>
                            <div>${esc(r.remarks_reply)}</div>
                          </div>`
                       : `<div style="margin-top:6px;">
                            <textarea data-reply-input="${esc(r.id)}" rows="2" placeholder="Reply to remarks…" style="width:100%;font-size:0.85rem;"></textarea>
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

      list.querySelectorAll('[data-reply]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.reply;
          const input = list.querySelector(`[data-reply-input="${id}"]`);
          const reply = input?.value?.trim();
          if (!reply) return;
          try {
            await CresAPI.request(`/api/reports/${id}/reply`, { method: 'POST', body: { reply } });
            await mountReports(me);
          } catch (err) {
            flash(err.message, false);
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<tr><td colspan="5" class="empty-state">${esc(err.message)}</td></tr>`;
    }
  }

  async function submitReport(e) {
    e.preventDefault();
    const fd = new FormData();
    fd.append('content', document.getElementById('report-content').value.trim());
    const blockers = document.getElementById('report-blockers')?.value.trim();
    const attention = document.getElementById('report-attention')?.value.trim();
    if (blockers) fd.append('blockers_text', blockers);
    if (attention) fd.append('needs_attention', attention);
    if (isFriday()) {
      const hard = document.getElementById('report-hard')?.value.trim();
      const easy = document.getElementById('report-easy')?.value.trim();
      const happy = document.getElementById('report-happiness')?.value.trim();
      const concerns = document.getElementById('report-concerns')?.value.trim();
      if (hard) fd.append('hard_today', hard);
      if (easy) fd.append('easy_today', easy);
      if (happy) fd.append('happiness', happy);
      if (concerns) fd.append('concerns', concerns);
    }
    const projectId = document.getElementById('report-project')?.value;
    if (projectId) fd.append('project_id', projectId);
    const files = document.getElementById('report-files')?.files || [];
    for (const f of files) fd.append('attachments', f);

    await CresAPI.request('/api/reports', { method: 'POST', body: fd });
    e.target.reset();
    showWeeklyFields();
    flash('Report submitted');
    const me = CresAPI.getUser();
    await mountReports(me);
  }

  async function mount() {
    const me = CresAPI.getUser();
    if (!me || me.role === 'client') return;

    const hero = document.querySelector('#face-work .face-hero');
    if (hero) {
      const h2 = hero.querySelector('h2');
      const p = hero.querySelector('p');
      if (h2) h2.textContent = 'My work';
      if (p) p.textContent = "Today's tasks, then log what you did.";
    }

    if (typeof CresTasks !== 'undefined') {
      await CresTasks.mount();
    }
    await mountReports(me);
    CresVoiceReport?.initVoiceReport();
    CresVoiceForms?.initVoiceForms();
  }

  function bind() {
    const form = document.getElementById('report-form');
    if (form && !form.dataset.workBound) {
      form.dataset.workBound = '1';
      form.addEventListener('submit', (e) => submitReport(e).catch((err) => flash(err.message, false)));
    }
    const btnNewReport = document.getElementById('btn-new-report');
    const reportForm = document.getElementById('report-form');
    if (reportForm) reportForm.style.display = '';
    if (btnNewReport) btnNewReport.hidden = true;
  }

  return { mount, bind, mountReports };
})();
