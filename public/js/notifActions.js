/**
 * What each notification does when you act on it: every one has a button that takes you inside the system
 * (the project, the invoice, the chat, the client, the user...), plus the Notifications section that keeps
 * the full history (the bell in the top bar only holds what you have not read yet).
 */
const CresNotifActions = (() => {
  function meta(n) {
    let m = n?.meta;
    if (typeof m === 'string') {
      try { m = JSON.parse(m); } catch { m = {}; }
    }
    return m || {};
  }

  /** { href, label } for a notification. Never empty: the last fallback opens the dashboard. */
  function action(n, user) {
    const m = meta(n);
    const type = String(n?.type || '').toLowerCase();
    const role = user?.role || '';
    const is = (...parts) => parts.some((p) => type.includes(p));
    const withHref = (label, fallback) => ({ href: m.href || fallback, label });

    if (is('project_needs_invoice')) return withHref('Create invoice', '#/invoices');
    if (is('invoice_followup', 'follow_up_due')) return withHref('Follow up', '#/followups');
    if (is('payment')) return withHref('View payment', '#/payments');
    if (is('invoice')) return withHref('Open invoice', '#/invoices');
    if (is('salary_settled')) return withHref('View my pay', '#/salaries?mine=1');
    if (is('salary_funding_request')) return withHref('Review funding', '#/approvals');
    if (is('salary')) return withHref('Open salary funding', '#/salary-funding');
    if (is('expense')) return withHref('Open expense', '#/expenses');
    if (is('leave')) return withHref('Open leave', '#/leave?mine=1');
    if (is('task')) return withHref('Open my work', '#/work');
    if (is('report')) {
      return withHref('Open report', ['admin', 'director', 'pm', 'finance'].includes(role) ? '#/reports' : '#/work');
    }
    if (is('pending_approval', 'approval')) return withHref('Review project', ['director', 'admin'].includes(role) ? '#/approvals' : '#/projects');
    if (m.projectId && is('project', 'milestone', 'assign', 'change_request')) return withHref('Open project', `#/projects/${m.projectId}`);
    if (is('change_request')) return withHref('Review request', '#/projects');
    if (is('project', 'milestone', 'assign')) return withHref('Open projects', '#/projects');
    if (is('lead', 'follow_up')) return withHref('Open lead', '#/pipeline');
    if (is('client')) return withHref('Open client', '#/pipeline');
    if (is('meeting')) return withHref('Open meeting', '/meetings');
    if (is('mail_followup')) return withHref('Open follow-ups', '/mail?box=followups');
    if (is('team_mail')) return withHref('Open Team mail', '/mail');
    if (is('inbox')) return withHref('Open inbox', role === 'admin' ? '/inbox' : '/mail');
    if (is('message', 'conversation') || m.conversationId) return withHref('Open chat', '#/community');
    if (is('credentials', 'user_', 'staff')) return withHref('Open users', role === 'hr' ? '#/employees' : '#/users');
    if (is('password')) return withHref('Open settings', '#/settings');
    if (is('digest')) return withHref('Open notifications', '#/notifications');
    return withHref('Open dashboard', '#/');
  }

  function go(href) {
    if (!href) return;
    if (href.startsWith('/')) location.href = href;
    else location.hash = href;
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- The Notifications section ----------
  const page = { filter: 'unread', items: [], user: null };

  async function load() {
    const res = await CresAPI.request(`/api/notifications?filter=${page.filter}&limit=200`, { noCache: true });
    page.items = res.data || [];
    render();
  }

  function render() {
    const host = document.getElementById('notif-page-list');
    if (!host) return;
    document.querySelectorAll('#notif-page-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.filter === page.filter));
    if (!page.items.length) {
      host.innerHTML = `<div class="notif-empty">${page.filter === 'unread' ? "You're all caught up. Nothing unread." : 'No notifications yet.'}</div>`;
      return;
    }
    host.innerHTML = page.items.map((n) => {
      const a = action(n, page.user);
      return `<div class="notif-row ${n.read_at ? '' : 'unread'}" data-id="${esc(n.id)}">
        <div class="notif-row-main">
          <div class="notif-row-text">${esc(n.content)}</div>
          <div class="ntime">${esc(String(n.type || '').replace(/_/g, ' '))} · ${esc(CresFormat.datetime(n.created_at))}</div>
        </div>
        <div class="notif-row-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="go">${esc(a.label)} →</button>
          ${n.read_at ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="read">Mark read</button>'}
        </div></div>`;
    }).join('');
  }

  async function markRead(id) {
    await CresAPI.request(`/api/notifications/${id}/read`, { method: 'POST', toast: false }).catch(() => {});
    window.dispatchEvent(new Event('cres:notifs-changed'));
  }

  function bindPage() {
    const host = document.getElementById('notif-page-list');
    if (!host || host.dataset.bound) return;
    host.dataset.bound = '1';
    host.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('.notif-row');
      if (!btn || !row) return;
      const n = page.items.find((x) => x.id === row.dataset.id);
      if (!n) return;
      if (btn.dataset.act === 'read') {
        await markRead(n.id);
        await load();
        return;
      }
      if (!n.read_at) await markRead(n.id);
      go(action(n, page.user).href);
    });
    document.getElementById('notif-page-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-filter]');
      if (!b) return;
      page.filter = b.dataset.filter;
      load().catch(() => {});
    });
    document.getElementById('notif-page-readall')?.addEventListener('click', async () => {
      await CresAPI.request('/api/notifications/read-all', { method: 'POST', toastSuccess: 'All notifications marked read' });
      window.dispatchEvent(new Event('cres:notifs-changed'));
      await load();
    });
    window.addEventListener('cres:notifs-changed', () => {
      if (document.getElementById('face-notifications')?.classList.contains('active')) load().catch(() => {});
    });
    if (typeof CresRealtime !== 'undefined') {
      CresRealtime.on('notification', () => {
        if (document.getElementById('face-notifications')?.classList.contains('active')) load().catch(() => {});
      });
    }
  }

  function mount(user) {
    page.user = user;
    bindPage();
    return load();
  }

  return { meta, action, go, mount };
})();
