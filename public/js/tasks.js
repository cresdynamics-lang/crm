/**
 * Personal / daily tasks — shared by Sales, Developer, Director, PM, Admin, Finance.
 * Visibility: assignee + creator always; Director/PM/Admin see the full board.
 */
const CresTasks = (() => {
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

  function flash(msg, ok = true) {
    const el = document.getElementById('tasks-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3200);
  }

  function heroCopy(me) {
    if (me.role === 'director') {
      return 'Assign tasks to Admin, Sales (one or all), Developers (one or all), Finance, or a Project Manager. Full board visibility.';
    }
    if (me.role === 'pm') {
      return 'Assign tasks to Sales or Developers. They appear on your board, theirs, and the Director board.';
    }
    if (me.role === 'admin') {
      return 'Assign and oversee tasks across the organization.';
    }
    if (me.role === 'finance') {
      return 'Assign tasks to anyone on staff (Sales, Developers, HR, PM, Director, Admin). They see it marked “assigned to you” and get a notification.';
    }
    return 'Your assigned tasks and anything you created. Update status when you work them.';
  }

  function fillAssigneeSelect(select, people, bulkRoles, me) {
    if (!select) return;
    const groups = {};
    for (const u of people) {
      groups[u.role] = groups[u.role] || [];
      groups[u.role].push(u);
    }
    const roleOrder = ['admin', 'pm', 'sales', 'developer', 'finance', 'director', 'hr'];
    const parts = [];

    if (bulkRoles?.length) {
      parts.push('<optgroup label="Assign to everyone in role">');
      if (bulkRoles.includes('sales')) {
        parts.push('<option value="__all:sales">All salespeople</option>');
      }
      if (bulkRoles.includes('developer')) {
        parts.push('<option value="__all:developer">All developers</option>');
      }
      parts.push('</optgroup>');
    }

    for (const role of roleOrder) {
      const list = groups[role];
      if (!list?.length) continue;
      const label =
        role === 'sales'
          ? 'Sales'
          : role === 'developer'
            ? 'Developers'
            : role === 'pm'
              ? 'Project managers'
              : role.charAt(0).toUpperCase() + role.slice(1);
      parts.push(`<optgroup label="${esc(label)}">`);
      for (const u of list) {
        const you = u.id === me.id ? ' — you' : '';
        parts.push(
          `<option value="${esc(u.id)}" ${u.id === me.id && !bulkRoles?.length ? 'selected' : ''}>${esc(u.name)}${you} (${esc(u.role)})</option>`
        );
      }
      parts.push('</optgroup>');
    }

    select.innerHTML = parts.join('') || `<option value="${esc(me.id)}">${esc(me.name)} (you)</option>`;
  }

  async function mount() {
    const me = CresAPI.getUser();
    if (!me) return;
    const formWrap = document.getElementById('task-form')?.closest('.settings-section');
    if (formWrap) formWrap.hidden = false;

    const hero = document.querySelector('#face-work .face-hero');
    if (hero && location.hash.replace(/^#/, '').split('?')[0] === '/tasks') {
      hero.querySelector('h2').textContent = 'Tasks';
      hero.querySelector('p').textContent = heroCopy(me);
    }

    const listTitle = document.getElementById('work-tasks-heading') || document.querySelector('#face-work h3');
    if (listTitle) {
      listTitle.textContent = ['director', 'admin', 'pm'].includes(me.role)
        ? 'Task board'
        : 'Your tasks';
    }

    const [tasks, assignees] = await Promise.all([
      CresAPI.request('/api/tasks'),
      CresAPI.request('/api/tasks/assignees').catch(() => ({ data: [], meta: {} })),
    ]);

    fillAssigneeSelect(
      document.getElementById('task-assignee'),
      assignees.data || [],
      assignees.meta?.bulkRoles || [],
      me
    );

    const tbody = document.getElementById('tasks-tbody');
    if (!tbody) return;
    if (!tasks.data.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No tasks yet. Add one above.</td></tr>`;
      return;
    }

    tbody.innerHTML = tasks.data
      .map((t) => {
        const mine = t.assigned_to === me.id || t.assigned_by === me.id;
        const hub = ['admin', 'director', 'pm'].includes(me.role);
        const canEdit = mine || hub;
        const relation =
          t.assigned_to === me.id
            ? '<span class="role-tag">assigned to you</span>'
            : t.assigned_by === me.id
              ? '<span class="role-tag">you assigned</span>'
              : '';
        return `<tr data-id="${esc(t.id)}">
          <td>${esc(t.title)}<div class="meta">${esc(t.description || '')} ${relation}</div></td>
          <td>${esc(t.assignee_name)} <span class="role-tag">(${esc(t.assignee_role)})</span></td>
          <td>${fmtDate(t.due_date)}</td>
          <td>${statusPill(t.status)}</td>
          <td>${esc(t.assigned_by_name)} <span class="role-tag">(${esc(t.assigned_by_role || '-')})</span></td>
          <td class="toolbar" style="gap:4px;flex-wrap:wrap;">
            ${
              canEdit && t.status !== 'done'
                ? `<button type="button" class="btn btn-ghost btn-sm" data-status="in_progress" data-id="${esc(t.id)}">In progress</button>
                   <button type="button" class="btn btn-primary btn-sm" data-status="done" data-id="${esc(t.id)}">Done</button>`
                : ''
            }
            ${
              canEdit
                ? `<button type="button" class="btn btn-ghost btn-sm" data-delete="${esc(t.id)}" style="color:#ffb4b4;">Delete</button>`
                : '-'
            }
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await CresAPI.request(`/api/tasks/${btn.dataset.id}`, {
            method: 'PATCH',
            body: { status: btn.dataset.status },
          });
          flash('Task updated');
          await mount();
        } catch (err) {
          flash(err.message, false);
        }
      });
    });
    tbody.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this task?')) return;
        try {
          await CresAPI.request(`/api/tasks/${btn.dataset.delete}`, { method: 'DELETE' });
          flash('Task deleted');
          await mount();
        } catch (err) {
          flash(err.message, false);
        }
      });
    });
  }

  async function create(e) {
    e.preventDefault();
    const raw = document.getElementById('task-assignee').value;
    const body = {
      title: document.getElementById('task-title').value.trim(),
      description: document.getElementById('task-description').value.trim(),
      due_date: document.getElementById('task-due').value || null,
    };
    if (raw.startsWith('__all:')) {
      body.assign_to_all_role = raw.slice('__all:'.length);
    } else {
      body.assigned_to = raw;
    }
    try {
      const assigneeLabel =
        document.getElementById('task-assignee')?.selectedOptions?.[0]?.textContent || 'assignee';
      const res = await CresAPI.request('/api/tasks', {
        method: 'POST',
        body,
        idempotencyKey: `task-${Date.now()}`,
      });
      e.target.reset();
      const n = res.meta?.count || 1;
      flash(
        n > 1
          ? `${n} tasks assigned — each person sees “assigned to you” and gets a notification`
          : `Task assigned to ${assigneeLabel} — they see it on Tasks with “assigned to you”`
      );
      await mount();
    } catch (err) {
      flash(err.message, false);
    }
  }

  function bind() {
    const form = document.getElementById('task-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    form.addEventListener('submit', create);
  }

  return { mount, bind };
})();
