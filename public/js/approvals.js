/**
 * One Approvals inbox — project, expense, salary funding, leave — filtered to the signed-in person.
 */
const CresApprovals = (() => {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function flash(msg, ok = true) {
    const el = document.getElementById('approvals-inbox-flash');
    if (!el) return;
    el.textContent = msg;
    el.className = `flash visible ${ok ? 'ok' : 'err'}`;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  async function decide(item, action) {
    const me = CresAPI.getUser();
    try {
      if (item.kind === 'project') {
        if (action === 'approve') {
          await CresAPI.request(`/api/projects/${item.id}/approve`, {
            method: 'POST',
            body: {},
            idempotencyKey: `appr-proj-${item.id}-${Date.now()}`,
          });
        } else {
          const reason = window.prompt('Rejection reason (sent back to Sales)') || '';
          if (!reason.trim()) return;
          await CresAPI.request(`/api/projects/${item.id}/reject`, {
            method: 'POST',
            body: { reason: reason.trim() },
          });
        }
      } else if (item.kind === 'expense') {
        if (action === 'approve') {
          const path = me.role === 'admin' ? 'approve' : 'finance-approve';
          await CresAPI.request(`/api/expenses/${item.id}/${path}`, {
            method: 'POST',
            body: {},
            idempotencyKey: `appr-exp-${item.id}-${Date.now()}`,
          });
        } else {
          const note = window.prompt('Rejection note (optional)') || undefined;
          await CresAPI.request(`/api/expenses/${item.id}/reject`, {
            method: 'POST',
            body: { note },
            idempotencyKey: `appr-exp-rej-${item.id}-${Date.now()}`,
          });
        }
      } else if (item.kind === 'funding') {
        if (action === 'approve') {
          if (me.role === 'admin') {
            await CresAPI.request(`/api/salaries/funding/${item.id}/admin-approve`, {
              method: 'POST',
              body: {},
              idempotencyKey: `appr-fund-${item.id}-${Date.now()}`,
            });
          } else {
            const entered = window.prompt('Funded amount', String(item.amount || ''));
            if (entered == null) return;
            const amount_funded = Number(entered);
            if (!(amount_funded > 0)) {
              flash('Enter a valid funded amount', false);
              return;
            }
            await CresAPI.request(`/api/salaries/funding/${item.id}/finance-approve`, {
              method: 'POST',
              body: { amount_funded },
              idempotencyKey: `appr-fund-${item.id}-${Date.now()}`,
            });
          }
        } else {
          const note = window.prompt('Rejection note (optional)') || undefined;
          await CresAPI.request(`/api/salaries/funding/${item.id}/reject`, {
            method: 'POST',
            body: { note },
            idempotencyKey: `appr-fund-rej-${item.id}-${Date.now()}`,
          });
        }
      } else if (item.kind === 'leave') {
        await CresAPI.request(`/api/leave/${item.id}/decide`, {
          method: 'POST',
          body: { status: action === 'approve' ? 'approved' : 'rejected' },
        });
      }
      flash(action === 'approve' ? 'Approved' : 'Rejected');
      await mount();
    } catch (err) {
      flash(err.message, false);
    }
  }

  async function mount() {
    const tbody = document.getElementById('approvals-inbox-tbody');
    if (!tbody) return;
    const projectPanel = document.getElementById('project-approvals-panel');
    const moneyPanel = document.getElementById('finance-money-approvals-panel');
    if (projectPanel) projectPanel.hidden = true;
    if (moneyPanel) moneyPanel.hidden = true;
    const inbox = document.getElementById('approvals-inbox-panel');
    if (inbox) inbox.hidden = false;

    try {
      const res = await CresAPI.request('/api/approvals');
      const rows = res.data || [];
      tbody.innerHTML = rows.length
        ? rows
            .map(
              (r) => `<tr data-kind="${esc(r.kind)}" data-id="${esc(r.id)}">
                <td>${esc((r.kind || '').replace(/_/g, ' '))}</td>
                <td>${esc(r.title)}<div class="meta">${esc(r.subtitle || '')}</div></td>
                <td>${esc(r.from || '-')}</td>
                <td>${r.amount != null ? CresFormat.money(r.amount) : '—'}</td>
                <td>${CresFormat.date(r.submitted_at)}</td>
                <td class="toolbar" style="gap:6px;">
                  <button type="button" class="btn btn-primary btn-sm" data-ok="1">${esc(r.approve_label || 'Approve')}</button>
                  <button type="button" class="btn btn-ghost btn-sm" data-ok="0">${esc(r.reject_label || 'Reject')}</button>
                </td>
              </tr>`
            )
            .join('')
        : `<tr><td colspan="6" class="empty-state">Nothing waiting on you.</td></tr>`;

      tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
        const item = rows.find((r) => r.id === tr.dataset.id && r.kind === tr.dataset.kind);
        tr.querySelector('[data-ok="1"]')?.addEventListener('click', () => decide(item, 'approve'));
        tr.querySelector('[data-ok="0"]')?.addEventListener('click', () => decide(item, 'reject'));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${esc(err.message)}</td></tr>`;
    }
  }

  return { mount };
})();
