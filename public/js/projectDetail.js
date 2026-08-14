/**
 * Shared project detail + progress form + immutable audit log.
 * Used by Sales, Director, PM, Developer, Admin - response shape is role-scoped by API.
 */
const CresProjectDetail = (() => {
  let state = { id: null, milestones: [], meta: {}, project: null, onSaved: null };

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

  function renderAudit(updates) {
    if (!updates?.length) {
      return `<li class="empty-state">No audit entries yet.</li>`;
    }
    return updates
      .map((u) => {
        const role = u.author_role || u.actor_role || '';
        const summary = u.change_summary || u.note || u.milestone_status || 'Update';
        return `<li>
          <div class="meta">${esc(u.author_name || 'Someone')}${
            role ? ` · ${esc(role)}` : ''
          } · ${fmtDate(u.created_at)}</div>
          <div>${esc(summary)}</div>
          ${u.note && u.change_summary && u.note !== u.change_summary
            ? `<div class="meta" style="margin-top:4px;">Note: ${esc(u.note)}</div>`
            : ''}
        </li>`;
      })
      .join('');
  }

  function isVideo(mime) {
    return String(mime || '').startsWith('video/');
  }

  function isImage(mime) {
    return String(mime || '').startsWith('image/');
  }

  function mediaPreviewHtml(doc) {
    if (isImage(doc.mime_type)) {
      return `<a href="${esc(doc.file_path)}" target="_blank" rel="noopener" class="deliverable-media">
        <img src="${esc(doc.file_path)}" alt="${esc(doc.title)}" />
      </a>`;
    }
    if (isVideo(doc.mime_type)) {
      return `<video class="deliverable-media" controls preload="metadata" src="${esc(doc.file_path)}"></video>`;
    }
    return `<a href="${esc(doc.file_path)}" target="_blank" rel="noopener">${esc(doc.original_name || 'File')}</a>`;
  }

  function renderDeliverables(docs) {
    if (!docs?.length) {
      return `<div class="empty-state" style="padding:12px;">No screenshots or videos uploaded yet.</div>`;
    }
    return `<div class="deliverable-grid">${docs
      .map(
        (d) => `<article class="deliverable-card">
          ${mediaPreviewHtml(d)}
          <div class="deliverable-meta">
            <strong>${esc(d.title)}</strong>
            <div class="meta">${esc(d.milestone_title || 'No milestone')} · ${fmtDate(d.created_at)}</div>
            <div class="meta">${esc(d.uploaded_by_name || '')}${d.shared_with_client ? ' · shared with client' : ''}</div>
          </div>
        </article>`
      )
      .join('')}</div>`;
  }

  function renderAssignmentHistory(rows) {
    if (!rows?.length) {
      return `<li class="empty-state">No assignment history yet.</li>`;
    }
    return rows
      .map(
        (a) => `<li>
          <div class="meta">${fmtDate(a.created_at)} · ${statusPill(a.status)}</div>
          <div>${esc(a.developer_name || 'Developer')}${
            a.assigned_by_name ? ` · by ${esc(a.assigned_by_name)}` : ''
          }${
            a.original_developer_name
              ? ` · swapped from ${esc(a.original_developer_name)}`
              : ''
          }</div>
          ${a.note ? `<div class="meta" style="margin-top:4px;">${esc(a.note)}</div>` : ''}
        </li>`
      )
      .join('');
  }

  function renderMilestonesEditor(canEdit) {
    if (!state.milestones.length) {
      return `<div class="empty-state">No milestones on this project.</div>`;
    }
    return state.milestones
      .map((m, i) => {
        const title = esc(m.title || m.name || `Milestone ${i + 1}`);
        const tasks = (m.tasks || [])
          .map((t) => {
            const flag =
              t.status !== 'done'
                ? `<span class="pending-flag">${esc(String(t.hours || 0))}h · ${esc(t.status || 'pending')}</span>`
                : '';
            return `<div class="meta" style="margin:4px 0 0;">• ${esc(t.title || 'Task')} ${flag}</div>`;
          })
          .join('');
        if (!canEdit) {
          return `<div class="ms-block">
            <strong>${title}</strong> ${statusPill(normalizeMsStatus(m.status))}
            ${m.due_date ? `<div style="font-size:0.75rem;color:var(--text-muted);">Due ${new Date(m.due_date).toLocaleDateString()}</div>` : ''}
            ${tasks}
          </div>`;
        }
        return `<div class="ms-block">
          <div class="milestone-row" style="display:grid;grid-template-columns:1fr 160px;gap:8px;align-items:center;margin-bottom:8px;">
            <div>
              <input data-ms-title="${i}" value="${title}" placeholder="Milestone title" />
              ${m.due_date ? `<div style="font-size:0.75rem;color:var(--text-muted);">Due ${new Date(m.due_date).toLocaleDateString()}</div>` : ''}
            </div>
            <select data-ms="${i}">
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="completed">Completed</option>
            </select>
          </div>
          ${tasks || '<div class="meta">No tasks yet (developers add hours under milestones).</div>'}
        </div>`;
      })
      .join('');
  }

  function canResubmit(role, p) {
    return p.status === 'rejected' && ['sales', 'admin'].includes(role);
  }

  function canUploadDeliverable(role, p, meta) {
    const active = !['pending_approval', 'rejected'].includes(p.status);
    if (!active) return false;
    if (role === 'developer') return true;
    return !!meta.canUpdateProgress || ['pm', 'admin', 'sales', 'director'].includes(role);
  }

  async function open(id, { onSaved } = {}) {
    state.id = id;
    state.onSaved = onSaved || null;
    const modal = document.getElementById('project-detail-modal');
    const body = document.getElementById('project-detail-body');
    const title = document.getElementById('project-detail-title');
    if (!modal || !body) return;

    const user = CresAPI.getUser();
    const canLoadAssignments = ['sales', 'pm', 'director', 'admin'].includes(user?.role);
    const [projRes, updatesRes, assignRes, docsRes] = await Promise.all([
      CresAPI.request(`/api/projects/${id}`),
      CresAPI.request(`/api/projects/${id}/updates`),
      canLoadAssignments
        ? CresAPI.request(`/api/assignments/project/${id}`).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
      CresAPI.request(`/api/projects/${id}/documents`).catch(() => ({ data: [] })),
    ]);
    const p = projRes.data;
    const meta = projRes.meta || {};
    state.meta = meta;
    state.project = p;
    state.milestones = (Array.isArray(p.milestones) ? p.milestones : []).map((m) => ({
      ...m,
      status: normalizeMsStatus(m.status),
    }));
    const assignmentHistory = assignRes.data || [];
    const documents = docsRes.data || [];
    const deliverables = documents.filter((d) => d.kind === 'deliverable' || isImage(d.mime_type) || isVideo(d.mime_type));

    let devOptions = [];
    if (canResubmit(user?.role, p)) {
      const d = await CresAPI.request('/api/users/developers').catch(() => ({ data: [] }));
      devOptions = d.data || [];
    }

    title.textContent = p.name;
    const showClient = meta.canSeeClient && (p.client_name || p.client_id);
    const showMoney = meta.canSeeMoney && p.value_amount != null;
    const canUpdate = !!meta.canUpdateProgress;
    const canEdit = !!meta.canEditProject;
    const showResubmit = canResubmit(user?.role, p);
    const showDeliverable = canUploadDeliverable(user?.role, p, meta);
    const progressPct =
      p.progress_percent != null ? Number(p.progress_percent) : null;

    body.innerHTML = `
      <div class="form-grid" style="margin-bottom:14px;">
        <div><strong>Status</strong><div>${statusPill(p.status)}</div></div>
        ${
          progressPct != null
            ? `<div><strong>Progress</strong><div>${progressPct}% <span class="meta">from developer milestones</span></div></div>`
            : ''
        }
        ${
          p.developer_name
            ? `<div><strong>Developer</strong><div>${esc(p.developer_name)}</div></div>`
            : ''
        }
        ${
          showClient
            ? `<div><strong>Client</strong><div>${esc(p.client_name || '-')}${
                p.client_business ? ` · ${esc(p.client_business)}` : ''
              }</div>
              <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">${esc(p.client_email || '')} ${esc(p.client_phone || '')}</div></div>`
            : ''
        }
        ${showMoney ? `<div><strong>Project value (amount)</strong><div>${Number(p.value_amount).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}</div></div>` : ''}
        ${
          p.preview_url
            ? `<div style="grid-column:1/-1;"><strong>Preview link</strong>
                <div><a href="${esc(p.preview_url)}" target="_blank" rel="noopener">${esc(p.preview_url)}</a></div></div>`
            : ''
        }
        ${
          canEdit
            ? `<div style="grid-column:1/-1;"><label for="proj-detail-name">Project name</label>
                <input id="proj-detail-name" value="${esc(p.name || '')}" required style="width:100%;margin-top:6px;" /></div>
               <div style="grid-column:1/-1;"><label for="proj-detail-description">Description / overview</label>
                <textarea id="proj-detail-description" rows="3" style="width:100%;margin-top:6px;">${esc(p.description || p.summary || '')}</textarea></div>`
            : `<div style="grid-column:1/-1;"><strong>Description / overview</strong>
                <div style="white-space:pre-wrap;margin-top:4px;">${esc(p.description || p.summary || '-')}</div>
              </div>`
        }
      </div>

      ${
        showResubmit
          ? `<div class="settings-section" style="margin-bottom:16px;border:1px solid rgba(224,90,90,0.35);border-radius:10px;padding:14px;">
              <h4 style="margin:0 0 8px;color:#ffb4b4;">Rejected — address this reason</h4>
              <p class="rejection-banner">${esc(p.rejection_reason || 'No reason provided.')}</p>
              <form id="proj-resubmit-form" class="form-grid">
                <div><label>Name</label><input id="pd-resubmit-name" value="${esc(p.name || '')}" required /></div>
                <div style="grid-column:1/-1;"><label>Description / overview</label>
                  <textarea id="pd-resubmit-description" rows="3">${esc(p.description || p.summary || '')}</textarea>
                </div>
                ${
                  meta.canSeeMoney
                    ? `<div><label>Project value (amount)</label><input id="pd-resubmit-value" type="number" min="0" step="0.01" value="${p.value_amount != null ? esc(p.value_amount) : ''}" /></div>`
                    : ''
                }
                <div><label>Developer</label>
                  <select id="pd-resubmit-developer">
                    <option value="">- Unassigned -</option>
                    ${devOptions
                      .map(
                        (d) =>
                          `<option value="${d.id}" ${d.id === p.assigned_developer_id ? 'selected' : ''}>${esc(d.name)}</option>`
                      )
                      .join('')}
                  </select>
                </div>
                <div style="grid-column:1/-1;">
                  <label>Milestones</label>
                  <div id="pd-resubmit-ms">
                    ${(state.milestones.length ? state.milestones : [{ title: '' }])
                      .map(
                        (m) => `<div class="milestone-row">
                          <input placeholder="Milestone title" value="${esc(m.title || m.name || '')}" />
                          <button type="button" class="btn btn-ghost" data-pd-rm-ms style="padding:6px 10px;">✕</button>
                        </div>`
                      )
                      .join('')}
                  </div>
                  <button type="button" class="btn btn-ghost" id="pd-add-ms" style="margin-top:8px;padding:6px 10px;font-size:0.8rem;">+ Add milestone</button>
                </div>
                <div id="pd-resubmit-flash" class="flash"></div>
                <div class="form-actions"><button type="submit" class="btn btn-primary">Resubmit for approval</button></div>
              </form>
            </div>`
          : ''
      }

      <h4 style="margin:0 0 8px;font-size:0.9rem;">Milestones</h4>
      <div id="proj-detail-milestones">${renderMilestonesEditor(canUpdate)}</div>
      ${
        canUpdate
          ? `<button type="button" class="btn btn-ghost" id="pd-add-milestone" style="margin:8px 0 12px;padding:6px 10px;font-size:0.8rem;">+ Add milestone</button>`
          : ''
      }

      ${
        canUpdate || canEdit
          ? `${
              canUpdate
                ? `<div style="margin-top:14px;">
              <label for="proj-detail-preview">Project preview link</label>
              <input id="proj-detail-preview" type="url" placeholder="https://…" value="${esc(p.preview_url || '')}" style="width:100%;margin-top:6px;" />
            </div>
            <div style="margin-top:14px;">
              <label for="proj-detail-status">Project status</label>
              <select id="proj-detail-status">
                <option value="in_progress">In progress</option>
                <option value="blocked">Blocked</option>
                <option value="completed">Completed</option>
                <option value="approved">Approved</option>
              </select>
            </div>
            <div style="margin-top:12px;">
              <label for="proj-detail-note">Progress note</label>
              <textarea id="proj-detail-note" rows="3" placeholder="What changed…"></textarea>
            </div>`
                : ''
            }
            <div id="proj-detail-flash" class="flash" style="margin-top:10px;"></div>
            <div class="form-actions" style="margin-top:10px;">
              <button type="button" class="btn btn-primary" id="proj-detail-save">${
                canEdit && canUpdate ? 'Save project &amp; progress' : canEdit ? 'Save project' : 'Save progress'
              }</button>
            </div>`
          : ''
      }

      ${
        showDeliverable || deliverables.length
          ? `<div class="settings-section" style="margin-top:18px;max-width:none;">
              <h4 style="margin:0 0 10px;font-size:0.9rem;">Deliverables (screenshots &amp; video)</h4>
              <div id="pd-del-gallery">${renderDeliverables(deliverables)}</div>
              ${
                showDeliverable
                  ? `<form id="proj-deliverable-form" class="form-grid" style="margin-top:14px;">
                <div><label>Milestone</label>
                  <select id="pd-del-milestone" required>
                    <option value="">Select milestone…</option>
                    ${state.milestones
                      .map((m) => `<option value="${esc(m.title || m.name || '')}">${esc(m.title || m.name || '')}</option>`)
                      .join('')}
                  </select>
                </div>
                <div><label>Title</label><input id="pd-del-title" required placeholder="e.g. Homepage screenshot" /></div>
                <div>
                  <label>Screenshot or short video</label>
                  <input id="pd-del-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime" required />
                  <p class="meta" style="margin:6px 0 0;">Max 20 MB. Prefer screenshots; short MP4/WebM clips also work.</p>
                </div>
                <div id="pd-del-preview" class="deliverable-preview" hidden></div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <input type="checkbox" id="pd-del-shared" checked />
                  <label for="pd-del-shared" style="margin:0;">Shared with client</label>
                </div>
                <div id="pd-del-flash" class="flash"></div>
                <div class="form-actions"><button type="submit" class="btn btn-primary">Upload deliverable</button></div>
              </form>`
                  : ''
              }
            </div>`
          : ''
      }

      <h4 style="margin:20px 0 8px;font-size:0.9rem;">Audit log</h4>
      <p style="margin:0 0 8px;color:var(--text-muted);font-size:0.8rem;">Append-only history. Entries cannot be edited or deleted.</p>
      <ul class="engagement-list" id="proj-detail-audit">${renderAudit(updatesRes.data)}</ul>

      ${
        canLoadAssignments
          ? `<h4 style="margin:20px 0 8px;font-size:0.9rem;">Assignment chain</h4>
             <ul class="engagement-list" id="proj-detail-assignments">${renderAssignmentHistory(assignmentHistory)}</ul>`
          : ''
      }`;

    if (canUpdate || canEdit) {
      if (canUpdate) {
        const statusEl = document.getElementById('proj-detail-status');
        if (statusEl) {
          statusEl.value = ['in_progress', 'blocked', 'completed', 'approved'].includes(p.status)
            ? p.status
            : 'in_progress';
        }
        body.querySelectorAll('select[data-ms]').forEach((sel) => {
          const idx = Number(sel.dataset.ms);
          sel.value = normalizeMsStatus(state.milestones[idx].status);
          sel.addEventListener('change', () => {
            state.milestones[idx].status = sel.value;
          });
        });
        body.querySelectorAll('[data-ms-title]').forEach((input) => {
          input.addEventListener('input', () => {
            const idx = Number(input.dataset.msTitle);
            state.milestones[idx].title = input.value;
          });
        });
        document.getElementById('pd-add-milestone')?.addEventListener('click', () => {
          state.milestones.push({
            title: `Milestone ${state.milestones.length + 1}`,
            status: 'not_started',
            tasks: [],
          });
          document.getElementById('proj-detail-milestones').innerHTML = renderMilestonesEditor(true);
          body.querySelectorAll('select[data-ms]').forEach((sel) => {
            const idx = Number(sel.dataset.ms);
            sel.value = normalizeMsStatus(state.milestones[idx].status);
            sel.addEventListener('change', () => {
              state.milestones[idx].status = sel.value;
            });
          });
          body.querySelectorAll('[data-ms-title]').forEach((input) => {
            input.addEventListener('input', () => {
              const idx = Number(input.dataset.msTitle);
              state.milestones[idx].title = input.value;
            });
          });
        });
      }
      document.getElementById('proj-detail-save').onclick = () =>
        save().catch((err) => flash(document.getElementById('proj-detail-flash'), err.message, false));
    }

    if (showResubmit) {
      document.getElementById('pd-add-ms')?.addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'milestone-row';
        row.innerHTML = `<input placeholder="Milestone title" /><button type="button" class="btn btn-ghost" data-pd-rm-ms style="padding:6px 10px;">✕</button>`;
        document.getElementById('pd-resubmit-ms').appendChild(row);
      });
      document.getElementById('pd-resubmit-ms')?.addEventListener('click', (e) => {
        if (e.target.matches('[data-pd-rm-ms]')) e.target.closest('.milestone-row')?.remove();
      });
      document.getElementById('proj-resubmit-form')?.addEventListener('submit', (e) =>
        submitResubmit(e).catch((err) =>
          flash(document.getElementById('pd-resubmit-flash'), err.message, false)
        )
      );
    }

    if (showDeliverable) {
      const fileInput = document.getElementById('pd-del-file');
      const preview = document.getElementById('pd-del-preview');
      fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file || !preview) {
          if (preview) preview.hidden = true;
          return;
        }
        if (file.size > 20 * 1024 * 1024) {
          flash(document.getElementById('pd-del-flash'), 'File must be 20 MB or less', false);
          fileInput.value = '';
          preview.hidden = true;
          return;
        }
        const url = URL.createObjectURL(file);
        if (file.type.startsWith('video/')) {
          preview.innerHTML = `<video controls src="${url}"></video>`;
        } else {
          preview.innerHTML = `<img src="${url}" alt="Preview" />`;
        }
        preview.hidden = false;
      });
      document.getElementById('proj-deliverable-form')?.addEventListener('submit', (e) =>
        uploadDeliverable(e).catch((err) =>
          flash(document.getElementById('pd-del-flash'), err.message, false)
        )
      );
    }

    modal.classList.add('open');
  }

  async function submitResubmit(e) {
    e.preventDefault();
    const milestones = [...document.querySelectorAll('#pd-resubmit-ms input')]
      .map((i) => i.value.trim())
      .filter(Boolean)
      .map((title) => ({ title, status: 'not_started', tasks: [] }));
    const overview = document.getElementById('pd-resubmit-description').value.trim();
    const body = {
      name: document.getElementById('pd-resubmit-name').value.trim(),
      description: overview,
      summary: overview,
      milestones,
      assigned_developer_id: document.getElementById('pd-resubmit-developer').value || null,
    };
    const valueEl = document.getElementById('pd-resubmit-value');
    if (valueEl) {
      body.value_amount = valueEl.value ? Number(valueEl.value) : null;
    }
    await CresAPI.request(`/api/projects/${state.id}/resubmit`, {
      method: 'PATCH',
      body,
      idempotencyKey: `pd-resubmit-${state.id}-${Date.now()}`,
    });
    flash(document.getElementById('pd-resubmit-flash'), 'Resubmitted for approval');
    if (typeof state.onSaved === 'function') await state.onSaved(state.id);
    await open(state.id, { onSaved: state.onSaved });
  }

  async function uploadDeliverable(e) {
    e.preventDefault();
    const milestone = document.getElementById('pd-del-milestone').value.trim();
    const title = document.getElementById('pd-del-title').value.trim();
    const file = document.getElementById('pd-del-file').files[0];
    if (!milestone) throw new Error('Select a milestone');
    if (!title) throw new Error('Enter a title');
    if (!file) throw new Error('Choose a screenshot or short video');
    if (file.size > 20 * 1024 * 1024) throw new Error('File must be 20 MB or less');
    const okType =
      /^(image\/(jpeg|jpg|png|gif|webp)|video\/(mp4|webm|quicktime))/.test(file.type);
    if (!okType) throw new Error('Use a screenshot (JPG/PNG/WebP) or short video (MP4/WebM)');

    const fd = new FormData();
    fd.append('project_id', state.id);
    fd.append('title', title);
    fd.append('kind', 'deliverable');
    fd.append('milestone_title', milestone);
    fd.append('shared_with_client', document.getElementById('pd-del-shared').checked ? 'true' : 'false');
    fd.append('file', file);
    await CresAPI.request('/api/client/documents', { method: 'POST', body: fd });
    flash(document.getElementById('pd-del-flash'), 'Deliverable uploaded');
    if (typeof state.onSaved === 'function') await state.onSaved(state.id);
    await open(state.id, { onSaved: state.onSaved });
  }

  async function save() {
    const canEdit = !!state.meta?.canEditProject;
    const canUpdate = !!state.meta?.canUpdateProgress;
    const note = document.getElementById('proj-detail-note')?.value?.trim();
    const status = document.getElementById('proj-detail-status')?.value;
    const preview = document.getElementById('proj-detail-preview')?.value?.trim();
    const name = document.getElementById('proj-detail-name')?.value?.trim();
    const description = document.getElementById('proj-detail-description')?.value;
    const body = {};
    if (canEdit && name !== undefined) body.name = name;
    if (canEdit && description !== undefined) body.description = description;
    if (canUpdate) {
      body.status = status;
      body.milestones = state.milestones;
      body.preview_url = preview !== undefined ? preview : undefined;
      body.note = note || undefined;
    }
    await CresAPI.request(`/api/projects/${state.id}/progress`, {
      method: 'PATCH',
      body,
      idempotencyKey: `prog-${state.id}-${Date.now()}`,
    });
    flash(
      document.getElementById('proj-detail-flash'),
      canEdit ? 'Project saved — audit entry appended' : 'Progress saved - audit entry appended'
    );
    if (typeof state.onSaved === 'function') await state.onSaved(state.id);
    await open(state.id, { onSaved: state.onSaved });
  }

  function bind() {
    document.querySelectorAll('#project-detail-modal [data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('project-detail-modal')?.classList.remove('open');
      });
    });
  }

  /** Render audit list HTML into an existing container (e.g. PM panel). */
  function auditHtml(updates) {
    return `<ul class="engagement-list">${renderAudit(updates)}</ul>`;
  }

  return { open, bind, auditHtml, renderAudit };
})();
