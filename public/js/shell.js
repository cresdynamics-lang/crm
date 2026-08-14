/**
 * Dashboard shell - auth gate, nav, topbar, routing, notifications.
 */
(async function bootShell() {
  if (!CresAPI.getAccess()) {
    location.replace('/login');
    return;
  }

  let session;
  try {
    session = await CresAPI.verify();
  } catch {
    CresAPI.clearSession();
    location.replace('/login');
    return;
  }

  const { user, permissions } = session;
  const state = { user, permissions, notifs: [] };

  // Profile chip
  document.getElementById('profile-name').textContent = user.name;
  document.getElementById('profile-role').textContent = user.role;
  CresSettings.paintShellAvatar(user);
  document.getElementById('home-greeting').textContent = `Welcome, ${user.name.split(' ')[0]}`;
  document.getElementById('home-blurb').textContent =
    roleBlurb(user.role);

  // Nav from permissions
  const navEl = document.getElementById('nav-list');
  function paintNav(hash) {
    CresNav.render(navEl, user, permissions, hash || '#/');
  }

  // Router
  const titles = {
    '/': 'Home',
    '/leads': 'Leads',
    '/clients': 'Clients',
    '/projects': 'Projects',
    '/timeline': 'Timeline',
    '/invoices': 'Invoices',
    '/followups': 'My Follow-ups',
    '/approvals': 'Approvals',
    '/tasks': 'Tasks',
    '/email': 'Email client',
    '/flag': 'Flag follow-up',
    '/payments': 'Payments',
    '/expenses': 'Expenses',
    '/employees': 'Employees',
    '/leave': 'Leave',
    '/salaries': 'Payroll',
    '/salary-funding': 'Salary funding',
    '/inbox-ai': 'Inbox AI',
    '/reports': 'Reports',
    '/users': 'Users',
    '/login-audit': 'Login audit',
    '/changes': 'Change requests',
    '/settings': 'Settings',
    '/community': 'Community',
  };

  const shell = document.getElementById('app-shell');
  document.getElementById('hamburger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    shell.classList.toggle('nav-open');
  });
  document.getElementById('drawer-overlay')?.addEventListener('click', () => {
    shell.classList.remove('nav-open');
  });
  navEl.addEventListener('click', (e) => {
    if (e.target.closest('a')) shell.classList.remove('nav-open');
  });

  async function route() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const pathFull = raw.startsWith('/') ? raw : `/${raw}`;
    const pathOnly = pathFull.split('?')[0];
    const segments = pathOnly.replace(/^\//, '').split('/').filter(Boolean);
    const faceId = segments.length === 0 ? 'home' : segments[0];
    const faceParam = segments[1] || null;
    const path = faceId === 'home' ? '/' : `/${faceId}`;
    const face = document.getElementById(`face-${faceId}`);

    if (faceId === 'community' && (user.role === 'finance' || user.role === 'client' || !permissions.includes('messages:view'))) {
      location.hash = '#/';
      return;
    }

    document.querySelectorAll('.face').forEach((el) => el.classList.remove('active'));
    if (face) {
      face.classList.add('active');
      document.getElementById('page-title').textContent = face.dataset.title || titles[path] || 'Cres Dynamics';
    } else {
      document.getElementById('face-home').classList.add('active');
      document.getElementById('page-title').textContent = 'Home';
    }

    paintNav(`#${path === '/' ? '/' : path}`);

    const salesDash = document.getElementById('sales-dashboard');
    const directorDash = document.getElementById('director-dashboard');
    const developerDash = document.getElementById('developer-dashboard');
    const financeDash = document.getElementById('finance-dashboard');
    const hrDash = document.getElementById('hr-dashboard');
    const pmDash = document.getElementById('pm-dashboard');
    const adminDash = document.getElementById('admin-dashboard');
    const clientDash = document.getElementById('client-dashboard');
    const genericHome = document.getElementById('generic-home');
    if (faceId === 'home') {
      if (salesDash) salesDash.hidden = user.role !== 'sales';
      if (directorDash) directorDash.hidden = user.role !== 'director';
      if (developerDash) developerDash.hidden = user.role !== 'developer';
      if (financeDash) financeDash.hidden = user.role !== 'finance';
      if (hrDash) hrDash.hidden = user.role !== 'hr';
      if (pmDash) pmDash.hidden = user.role !== 'pm';
      if (adminDash) adminDash.hidden = user.role !== 'admin';
      if (clientDash) clientDash.hidden = user.role !== 'client';
      if (genericHome) {
        genericHome.hidden = ['sales', 'director', 'admin', 'developer', 'finance', 'hr', 'pm', 'client'].includes(user.role);
      }
    }

    // Invoices: director overview vs finance management vs client portal
    const dirInv = document.getElementById('director-invoices-panel');
    const finInv = document.getElementById('finance-invoices-panel');
    const clientInv = document.getElementById('client-invoices-panel');
    if (faceId === 'invoices') {
      const isFinance = ['finance', 'admin'].includes(user.role);
      const isDirector = user.role === 'director';
      const isClient = user.role === 'client';
      if (dirInv) dirInv.hidden = !(isDirector && !isFinance);
      if (finInv) finInv.hidden = !isFinance;
      if (clientInv) clientInv.hidden = !isClient;
      if (user.role === 'admin') {
        if (dirInv) dirInv.hidden = true;
        if (finInv) finInv.hidden = false;
        if (clientInv) clientInv.hidden = true;
      }
      if (user.role === 'director') {
        if (dirInv) dirInv.hidden = false;
        if (finInv) finInv.hidden = true;
        if (clientInv) clientInv.hidden = true;
      }
      if (isClient) {
        if (dirInv) dirInv.hidden = true;
        if (finInv) finInv.hidden = true;
        if (clientInv) clientInv.hidden = false;
        const heading = document.querySelector('#face-invoices .face-hero h2');
        // client panel has its own hero
      }
    }

    const salesReports = document.getElementById('sales-reports-panel');
    const directorReports = document.getElementById('director-reports-panel');
    const pmReports = document.getElementById('pm-reports-panel');
    const adminReports = document.getElementById('admin-reports-panel');
    const financeReports = document.getElementById('finance-reports-panel');
    if (faceId === 'reports') {
      const isDirectorHub = user.role === 'director';
      const isPmHub = user.role === 'pm';
      const isAdminHub = user.role === 'admin';
      const isFinance = user.role === 'finance';
      if (salesReports) salesReports.hidden = isDirectorHub || isPmHub || isAdminHub || isFinance;
      if (directorReports) directorReports.hidden = !isDirectorHub;
      if (pmReports) pmReports.hidden = !isPmHub;
      if (adminReports) adminReports.hidden = !isAdminHub;
      if (financeReports) financeReports.hidden = !isFinance;
      const heading = document.getElementById('reports-heading');
      const blurb = document.getElementById('reports-blurb');
      if (isAdminHub) {
        if (heading) heading.textContent = 'All reports';
        if (blurb) blurb.textContent = 'Analytics, action audit, and full company reports. Respond to Director/PM/Finance; Sales/Developer are read-only.';
      } else if (isPmHub) {
        if (heading) heading.textContent = 'Reports hub';
        if (blurb) blurb.textContent = 'Review Sales and Developer reports, then forward to Director.';
      } else if (isDirectorHub) {
        if (heading) heading.textContent = 'Reports hub';
        if (blurb) blurb.textContent = 'Analytics plus reports forwarded by PM. Switch filter to see the full chain.';
      } else if (isFinance) {
        if (heading) heading.textContent = 'Financial reports';
        if (blurb) {
          blurb.textContent =
            'Cash flow in and out — projects, clients, accounts, expenses, and salaries. Download as CSV or PDF.';
        }
      } else {
        if (heading) heading.textContent = 'Daily report';
        if (blurb) blurb.textContent = 'Submit what you did today. Delivered to PM first, then Director.';
      }
    }

    // Approvals: project (Director/Admin) vs money (Finance + Admin salary/expense)
    const projectApprovals = document.getElementById('project-approvals-panel');
    const moneyApprovals = document.getElementById('finance-money-approvals-panel');
    if (faceId === 'approvals') {
      const isFinance = user.role === 'finance';
      const isAdmin = user.role === 'admin';
      const isDirector = user.role === 'director';
      if (projectApprovals) projectApprovals.hidden = isFinance;
      if (moneyApprovals) {
        moneyApprovals.hidden = !(isFinance || isAdmin);
        const expH = document.getElementById('money-exp-heading');
        const fundH = document.getElementById('money-fund-heading');
        if (isAdmin) {
          const hero = moneyApprovals.querySelector('.face-hero p');
          if (hero) {
            hero.textContent =
              'Final Admin unlock for expenses escalated by Finance, and salary funding after Finance.';
          }
          const h2 = moneyApprovals.querySelector('.face-hero h2');
          if (h2) h2.textContent = 'Money approvals';
          if (expH) expH.textContent = 'Expenses awaiting Admin';
          if (fundH) fundH.textContent = 'Salary funding awaiting Admin';
        } else if (isFinance) {
          if (expH) expH.textContent = 'Director expenses awaiting Finance';
          if (fundH) fundH.textContent = 'HR salary funding awaiting Finance';
        }
      }
      if (isDirector && moneyApprovals) moneyApprovals.hidden = true;
    }

    const adminSystem = document.getElementById('admin-system-settings');
    if (faceId === 'settings' && adminSystem) {
      adminSystem.hidden = user.role !== 'admin';
    }

    // Projects: sales chrome vs PM company list vs client portal vs finance money view
    const salesProjects = document.getElementById('sales-projects-chrome');
    const pmProjects = document.getElementById('pm-projects-panel');
    const pmDetail = document.getElementById('pm-project-detail');
    const clientProjects = document.getElementById('client-projects-panel');
    const clientDetail = document.getElementById('client-project-detail');
    const financeProjects = document.getElementById('finance-projects-panel');
    if (faceId === 'projects') {
      const isPm = user.role === 'pm';
      const isClient = user.role === 'client';
      const isFinance = user.role === 'finance';
      const isDirector = user.role === 'director';
      if (salesProjects) salesProjects.hidden = isPm || isClient || isFinance;
      if (pmProjects) pmProjects.hidden = isPm ? !!faceParam : true;
      if (pmDetail) pmDetail.hidden = !(isPm && faceParam);
      if (clientProjects) clientProjects.hidden = isClient ? !!faceParam : true;
      if (clientDetail) clientDetail.hidden = !(isClient && faceParam);
      if (financeProjects) financeProjects.hidden = !isFinance;
      const newProjBtn = document.getElementById('btn-new-project');
      if (newProjBtn) {
        newProjBtn.hidden =
          isFinance || isClient || isPm || isDirector || user.role === 'developer';
      }
      const hero = salesProjects?.querySelector('.face-hero');
      if (hero) {
        const h2 = hero.querySelector('h2');
        const p = hero.querySelector('p');
        if (isDirector) {
          if (h2) h2.textContent = 'Projects';
          if (p) {
            p.textContent =
              'Open a project to review progress from developers, milestones, and edit project details.';
          }
        } else if (user.role === 'sales' || user.role === 'admin') {
          if (h2) h2.textContent = 'Projects';
          if (p) {
            p.textContent =
              'Create projects for Director approval. Assigned developers see them only after approval.';
          }
        } else if (user.role === 'developer') {
          if (h2) h2.textContent = 'My projects';
          if (p) {
            p.textContent =
              'Update milestones and task hours. Progress % updates as you complete work.';
          }
        }
      }
    }

    if (faceId === 'settings') {
      await CresSettings.load();
    }
    if (faceId === 'tasks' && typeof CresTasks !== 'undefined') {
      await CresTasks.mount();
    }
    if (faceId === 'community') {
      await CresCommunity.mount();
    }

    if (typeof CresSales !== 'undefined') {
      if (user.role === 'sales') {
        await CresSales.mount(faceId, user);
      } else if (
        user.role === 'admin' &&
        ['leads', 'clients', 'projects', 'followups', 'email'].includes(faceId)
      ) {
        await CresSales.mount(faceId, user);
      }
    }

    if (typeof CresDirector !== 'undefined') {
      await CresDirector.mount(faceId, user);
    }

    if (typeof CresDeveloper !== 'undefined') {
      await CresDeveloper.mount(faceId, user);
    }

    if (typeof CresFinance !== 'undefined') {
      await CresFinance.mount(faceId, user);
    }

    if (typeof CresHR !== 'undefined') {
      await CresHR.mount(faceId, user, faceParam);
    }

    if (typeof CresPM !== 'undefined') {
      await CresPM.mount(faceId, user, faceParam);
    }

    if (typeof CresAdmin !== 'undefined') {
      await CresAdmin.mount(faceId, user);
    }

    if (typeof CresClient !== 'undefined') {
      await CresClient.mount(faceId, user, faceParam);
    }
  }

  function roleBlurb(role) {
    const map = {
      sales: 'Sales workspace - leads, clients, projects, and flagged invoice follow-ups.',
      director: 'Director workspace - approvals, reports, and projected invoice visibility.',
      developer: 'Developer workspace - assigned projects, tasks, and daily reports.',
      finance: 'Finance workspace - money approvals, invoices, payments, receipts, and cash-flow graphs.',
      pm: 'PM workspace - all projects, due dates, and report routing.',
      admin: 'Admin workspace - full access via the same shared components.',
      hr: 'HR workspace - employees and payroll (no client invoice or cash-flow access).',
      client: 'Client portal - your projects and invoices only. No staff chat.',
    };
    return map[role] || 'Shared Cres Dynamics shell.';
  }

  // Dropdowns
  const profileBtn = document.getElementById('profile-btn');
  const profileDd = document.getElementById('profile-dropdown');
  const notifBtn = document.getElementById('notif-btn');
  const notifDd = document.getElementById('notif-dropdown');

  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    profileDd.classList.toggle('open');
    notifDd.classList.remove('open');
  });
  notifBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    notifDd.classList.toggle('open');
    profileDd.classList.remove('open');
    if (notifDd.classList.contains('open')) renderNotifs();
  });
  document.addEventListener('click', () => {
    profileDd.classList.remove('open');
    notifDd.classList.remove('open');
  });
  profileDd.addEventListener('click', (e) => e.stopPropagation());
  notifDd.addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('logout-btn').addEventListener('click', async () => {
    CresRealtime.disconnect();
    await CresAPI.logout();
    location.href = '/login';
  });

  // Global search
  const searchInput = document.getElementById('global-search');
  const searchDrop = document.getElementById('global-search-dropdown');
  let searchTimer = null;

  function hideSearch() {
    if (searchDrop) searchDrop.classList.remove('open');
  }

  async function runSearch(q) {
    if (!searchDrop) return;
    if (!q || q.length < 2) {
      hideSearch();
      return;
    }
    try {
      const res = await CresAPI.request(`/api/search?q=${encodeURIComponent(q)}`);
      const items = res.data || [];
      if (!items.length) {
        searchDrop.innerHTML = `<div class="notif-empty">No matches</div>`;
        searchDrop.classList.add('open');
        return;
      }
      searchDrop.innerHTML = items
        .map(
          (r) => `<button type="button" class="search-result" data-href="${escapeHtml(r.href || '')}" data-type="${escapeHtml(r.type)}" data-id="${escapeHtml(r.id)}">
            <span class="meta">${escapeHtml(r.type)}</span>
            <strong>${escapeHtml(r.title)}</strong>
            <span class="ntime">${escapeHtml(r.subtitle || '')}</span>
          </button>`
        )
        .join('');
      searchDrop.classList.add('open');
      searchDrop.querySelectorAll('.search-result').forEach((btn) => {
        btn.addEventListener('click', () => {
          hideSearch();
          if (btn.dataset.type === 'project' && btn.dataset.id) {
            if (['client', 'pm'].includes(user.role)) {
              location.hash = `#/projects/${btn.dataset.id}`;
            } else if (typeof CresProjectDetail !== 'undefined') {
              CresProjectDetail.open(btn.dataset.id).catch(console.error);
              if (btn.dataset.href) location.hash = btn.dataset.href.split('?')[0] || '#/projects';
            } else {
              location.hash = btn.dataset.href || `#/projects/${btn.dataset.id}`;
            }
          } else if (btn.dataset.href) {
            location.hash = btn.dataset.href;
          }
        });
      });
    } catch {
      hideSearch();
    }
  }

  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(searchInput.value.trim()), 280);
  });
  searchInput?.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) runSearch(searchInput.value.trim());
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.global-search-wrap')) hideSearch();
  });
  searchDrop?.addEventListener('click', (e) => e.stopPropagation());

  // Notifications
  async function loadNotifications() {
    try {
      const res = await CresAPI.request('/api/notifications');
      state.notifs = res.data || [];
      updateBadge();
    } catch {
      // notifications group may be degraded - don't break shell
    }
  }

  function updateBadge() {
    const unread = state.notifs.filter((n) => !n.read_at).length;
    const badge = document.getElementById('notif-badge');
    if (unread > 0) {
      badge.hidden = false;
      badge.textContent = unread > 99 ? '99+' : String(unread);
    } else {
      badge.hidden = true;
    }
  }

  function parseNotifMeta(n) {
    let meta = n.meta;
    if (typeof meta === 'string') {
      try {
        meta = JSON.parse(meta);
      } catch {
        meta = {};
      }
    }
    return meta || {};
  }

  function hrefForNotification(n) {
    const meta = parseNotifMeta(n);
    if (meta.href) return meta.href;
    const type = String(n.type || '').toLowerCase();
    if (meta.conversationId || type.includes('message')) return '#/community';
    if (meta.taskId || type.includes('task')) return '#/tasks';
    if (meta.leaveId || type.includes('leave')) return '#/leave';
    if (meta.fundingId || type.includes('salary_funding') || type.includes('funding')) {
      return '#/salary-funding';
    }
    if (meta.expenseId || type.includes('expense')) return '#/expenses';
    if (meta.followupId || type.includes('followup')) return '#/followups';
    if (meta.invoiceId || type.includes('invoice') || type.includes('payment')) {
      return '#/invoices';
    }
    if (meta.projectId) return `#/projects/${meta.projectId}`;
    if (type.includes('approval') || type.includes('project') || type.includes('milestone')) {
      return user.role === 'director' || user.role === 'admin' ? '#/approvals' : '#/projects';
    }
    if (type.includes('report')) return '#/reports';
    if (type.includes('assign')) return '#/projects';
    return null;
  }

  function actionHintForNotification(n) {
    const meta = parseNotifMeta(n);
    if (meta.action) return meta.action;
    const type = String(n.type || '').toLowerCase();
    if (type.includes('expense_pending_finance')) return 'Open Expenses and approve as Finance, then Admin will review.';
    if (type.includes('expense_pending_admin')) return 'Open Expenses and give final Admin approval to unlock the transaction.';
    if (type.includes('expense')) return 'Review this expense on the Expenses page.';
    if (type.includes('task')) return 'Open Tasks to view or update this assignment.';
    if (type.includes('leave')) return 'Open Leave to review or track this request.';
    if (type.includes('funding') || type.includes('salary')) return 'Open Salary funding for the approval chain.';
    if (type.includes('approval')) return 'Open Approvals to decide on the project.';
    if (type.includes('message')) return 'Open Community to read the conversation.';
    if (type.includes('report')) return 'Open Reports to review or respond.';
    if (type.includes('followup')) return 'Open My Follow-ups to contact the client.';
    return 'Review the details below. Use Open related page when a destination is available.';
  }

  function openNotificationDetail(n) {
    const modal = document.getElementById('notif-detail-modal');
    if (!modal) return;
    const href = hrefForNotification(n);
    document.getElementById('notif-detail-title').textContent = (n.type || 'notification')
      .replace(/_/g, ' ');
    document.getElementById('notif-detail-type').textContent = new Date(n.created_at).toLocaleString();
    document.getElementById('notif-detail-body').textContent = n.content || '';
    document.getElementById('notif-detail-action').textContent = actionHintForNotification(n);
    const go = document.getElementById('notif-detail-go');
    if (href) {
      go.hidden = false;
      go.onclick = () => {
        modal.classList.remove('open');
        location.hash = href;
      };
    } else {
      go.hidden = true;
      go.onclick = null;
    }
    modal.classList.add('open');
  }

  document.querySelectorAll('[data-close-notif-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('notif-detail-modal')?.classList.remove('open');
    });
  });

  function renderNotifs() {
    const list = document.getElementById('notif-list');
    if (!state.notifs.length) {
      list.innerHTML = `<div class="notif-empty">No notifications yet.${
        user.role === 'finance' ? ' Your system feed will appear here.' : ''
      }</div>`;
      return;
    }
    list.innerHTML = state.notifs
      .slice(0, 40)
      .map((n) => {
        const unread = n.read_at ? '' : 'unread';
        const when = new Date(n.created_at).toLocaleString();
        const href = hrefForNotification(n);
        return `<button type="button" class="notif-item ${unread}" data-id="${escapeHtml(n.id)}" data-has-href="${href ? '1' : '0'}">
          <span>${escapeHtml(n.content)}</span>
          <span class="ntime">${escapeHtml(n.type)} · ${when}${href ? ' · Open →' : ''}</span>
        </button>`;
      })
      .join('');

    list.querySelectorAll('.notif-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const n = state.notifs.find((x) => x.id === el.dataset.id);
        try {
          await CresAPI.request(`/api/notifications/${el.dataset.id}/read`, { method: 'POST' });
          if (n) n.read_at = new Date().toISOString();
          updateBadge();
        } catch {
          // ignore
        }
        document.getElementById('notif-dropdown')?.classList.remove('open');
        if (!n) return;
        const href = hrefForNotification(n);
        if (href) {
          location.hash = href;
        } else {
          openNotificationDetail(n);
        }
      });
    });
  }

  document.getElementById('notif-read-all').addEventListener('click', async () => {
    await CresAPI.request('/api/notifications/read-all', { method: 'POST' });
    state.notifs.forEach((n) => {
      n.read_at = n.read_at || new Date().toISOString();
    });
    updateBadge();
    renderNotifs();
  });

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Live indicator
  const liveEl = document.getElementById('live-indicator');
  function paintLive(status) {
    liveEl.classList.remove('online', 'degraded');
    const label = liveEl.querySelector('.label');
    if (status === 'online') {
      liveEl.classList.add('online');
      label.textContent = 'Live';
    } else if (status === 'degraded') {
      liveEl.classList.add('degraded');
      label.textContent = 'Reconnecting';
    } else {
      label.textContent = 'Offline';
    }
  }

  CresRealtime.on('status', paintLive);
  CresRealtime.on('notification', (payload) => {
    if (payload?.__poll && Array.isArray(payload.items)) {
      // merge unread from poll without wiping read ones carelessly
      const byId = new Map(state.notifs.map((n) => [n.id, n]));
      payload.items.forEach((n) => byId.set(n.id, n));
      state.notifs = Array.from(byId.values()).sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
      updateBadge();
      return;
    }
    if (payload?.id) {
      state.notifs.unshift(payload);
      updateBadge();
    }
  });

  CresSettings.bind();
  if (typeof CresTasks !== 'undefined') CresTasks.bind();
  CresCommunity.bind();
  if (typeof CresProjectDetail !== 'undefined') CresProjectDetail.bind();
  CresSales.bindModals();
  CresDirector.bind();
  CresDeveloper.bind();
  CresFinance.bind();
  if (typeof CresHR !== 'undefined') CresHR.bind();
  if (typeof CresPM !== 'undefined') CresPM.bind();
  if (typeof CresAdmin !== 'undefined') CresAdmin.bind();
  if (typeof CresClient !== 'undefined') CresClient.bind();
  CresRealtime.connect();
  paintLive(CresRealtime.getStatus());

  await loadNotifications();
  window.addEventListener('hashchange', () => {
    route().catch(console.error);
  });
  await route();
})();
