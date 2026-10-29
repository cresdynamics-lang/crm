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

  if (typeof Chart !== 'undefined') {
    Chart.defaults.animation = false;
    Chart.defaults.responsive = true;
    Chart.defaults.resizeDelay = 160;
  }

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

  function faceQuery() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const qi = raw.indexOf('?');
    return new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  }

  function insertTabs(face, items, activeId, extraClass = '') {
    if (!face || !items.length) return;
    const tabs = document.createElement('div');
    tabs.className = `page-tabs grouped-page-tabs ${extraClass}`.trim();
    tabs.innerHTML = items
      .map((t) => `<a href="${t.href}" class="${t.id === activeId ? 'active' : ''}">${t.label}</a>`)
      .join('');
    const existing = face.querySelector('.grouped-page-tabs:last-of-type');
    const hero = [...face.children].find((el) => el.classList?.contains('face-hero'));
    if (existing) existing.insertAdjacentElement('afterend', tabs);
    else if (hero) hero.insertAdjacentElement('afterend', tabs);
    else face.insertBefore(tabs, face.firstChild);
  }

  function paintPageTabs(faceId) {
    document.querySelectorAll('.grouped-page-tabs, .billing-tabs').forEach((el) => el.remove());
    const q = faceQuery();
    const mine = q.get('mine') === '1';
    const tab = q.get('tab') || '';

    if (['projects', 'timeline'].includes(faceId) && ['admin', 'director', 'pm'].includes(user.role)) {
      const active = tab === 'timeline' || faceId === 'timeline' ? 'timeline' : 'list';
      insertTabs(
        document.getElementById('face-projects'),
        [
          { href: '#/projects', id: 'list', label: 'List' },
          { href: '#/projects?tab=timeline', id: 'timeline', label: 'Timeline' },
        ],
        active
      );
    }

    if (
      ['admin', 'director'].includes(user.role) &&
      ['finance', 'invoices', 'payments', 'flag', 'expenses', 'billing'].includes(faceId)
    ) {
      const moneyItems =
        user.role === 'admin'
          ? [
              { href: '#/finance', id: 'finance', label: 'Overview' },
              { href: '#/invoices', id: 'billing', label: 'Billing' },
              { href: '#/expenses', id: 'expenses', label: 'Expenses' },
            ]
          : [
              { href: '#/invoices', id: 'invoices', label: 'Invoices' },
              { href: '#/expenses', id: 'expenses', label: 'Expenses' },
            ];
      const moneyActive =
        faceId === 'expenses' ? 'expenses' : faceId === 'finance' ? 'finance' : user.role === 'admin' ? 'billing' : 'invoices';
      insertTabs(document.getElementById(`face-${faceId}`), moneyItems, moneyActive);
    }

    const onBilling =
      ['invoices', 'payments', 'flag'].includes(faceId) ||
      (faceId === 'projects' && user.role === 'finance');
    if (['finance', 'admin'].includes(user.role) && onBilling) {
      const face = document.querySelector('.face.active');
      const items =
        user.role === 'finance'
          ? [
              { href: '#/invoices', id: 'invoices', label: 'Invoices' },
              { href: '#/payments', id: 'payments', label: 'Record payment' },
              { href: '#/projects', id: 'projects', label: 'Project balances' },
              { href: '#/flag', id: 'flag', label: 'Collections' },
            ]
          : [
              { href: '#/invoices', id: 'invoices', label: 'Invoices' },
              { href: '#/payments', id: 'payments', label: 'Record payment' },
              { href: '#/flag', id: 'flag', label: 'Collections' },
            ];
      insertTabs(face, items, faceId, 'billing-tabs');
    }

    if (
      ['hr', 'admin'].includes(user.role) &&
      !mine &&
      ['employees', 'leave', 'applicants', 'onboarding'].includes(faceId)
    ) {
      const peopleItems = [
        { href: '#/employees', id: 'employees', label: 'Employees' },
        { href: '#/leave', id: 'leave', label: 'Leave' },
      ];
      if (user.role === 'admin') {
        peopleItems.push({ href: '#/salaries', id: 'salaries', label: 'Payroll' });
      }
      peopleItems.push(
        { href: '#/applicants', id: 'applicants', label: 'Applicants' },
        { href: '#/onboarding', id: 'onboarding', label: 'Onboarding' }
      );
      insertTabs(document.getElementById(`face-${faceId}`), peopleItems, faceId);
    }

    if (user.role === 'admin' && !mine && faceId === 'salaries') {
      insertTabs(document.getElementById('face-salaries'), [
        { href: '#/employees', id: 'employees', label: 'Employees' },
        { href: '#/leave', id: 'leave', label: 'Leave' },
        { href: '#/salaries', id: 'salaries', label: 'Payroll' },
        { href: '#/applicants', id: 'applicants', label: 'Applicants' },
        { href: '#/onboarding', id: 'onboarding', label: 'Onboarding' },
      ], 'salaries');
    }

    if (user.role === 'hr' && !mine && ['salaries', 'salary-funding'].includes(faceId)) {
      insertTabs(document.getElementById(`face-${faceId}`), [
        { href: '#/salaries', id: 'salaries', label: 'Payroll' },
        { href: '#/salary-funding', id: 'salary-funding', label: 'Salary funding' },
      ], faceId);
    }

    if (user.role === 'admin' && ['traffic', 'website-payments'].includes(faceId)) {
      insertTabs(document.getElementById(`face-${faceId}`), [
        { href: '#/traffic', id: 'traffic', label: 'Website traffic' },
        { href: '#/website-payments', id: 'website-payments', label: 'Event registrations' },
      ], faceId);
    }

    if (user.role === 'admin' && ['users', 'login-audit', 'health', 'organization', 'email'].includes(faceId)) {
      insertTabs(document.getElementById(`face-${faceId}`), [
        { href: '#/users', id: 'users', label: 'Staff' },
        { href: '#/login-audit', id: 'login-audit', label: 'Login audit' },
        { href: '#/health', id: 'health', label: 'Health' },
        { href: '#/organization', id: 'organization', label: 'Company' },
        { href: '#/email', id: 'email', label: 'Email' },
      ], faceId);
    }

    if (['admin', 'director'].includes(user.role) && faceId === 'reports') {
      const defaultTab = user.role === 'admin' ? 'today' : 'analytics';
      const active = tab || defaultTab;
      insertTabs(
        document.getElementById('face-reports'),
        user.role === 'admin'
          ? [
              { href: '#/reports?tab=today', id: 'today', label: 'Today' },
              { href: '#/reports?tab=analytics', id: 'analytics', label: 'Analytics' },
              { href: '#/reports?tab=daily', id: 'daily', label: 'Daily reports' },
              { href: '#/reports?tab=audit', id: 'audit', label: 'Audit' },
            ]
          : [
              { href: '#/reports?tab=analytics', id: 'analytics', label: 'Analytics' },
              { href: '#/reports?tab=daily', id: 'daily', label: 'Daily reports' },
              { href: '#/reports?tab=audit', id: 'audit', label: 'Audit' },
            ],
        active
      );
    }
  }

  // Router
  const titles = {
    '/': 'Home',
    '/pipeline': 'Pipeline',
    '/leads': 'Pipeline',
    '/clients': 'Pipeline',
    '/billing': 'Billing',
    '/projects': 'Projects',
    '/timeline': 'Projects',
    '/finance': 'Finance',
    '/invoices': 'Invoices',
    '/followups': 'My Follow-ups',
    '/approvals': 'Approvals',
    '/work': 'My work',
    '/tasks': 'My work',
    '/email': 'Email client',
    '/flag': 'Flag follow-up',
    '/payments': 'Payments',
    '/expenses': 'Expenses',
    '/employees': 'People',
    '/leave': 'People',
    '/salaries': 'Payroll',
    '/salary-funding': 'Payroll',
    '/applicants': 'People',
    '/onboarding': 'People',
    '/reports': 'Reports',
    '/traffic': 'Website traffic',
    '/website-payments': 'Event registrations',
    '/health': 'Organization',
    '/users': 'Organization',
    '/login-audit': 'Organization',
    '/organization': 'Organization',
    '/email': 'Email',
    '/changes': 'Change requests',
    '/settings': 'Settings',
    '/community': 'Community',
    '/ops': 'Help',
    '/jarvis': 'Jarvis',
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

    if (faceId === 'community' && user.role === 'client') {
      location.hash = '#/';
      return;
    }

    if (faceId === 'ops' && user.role === 'client') {
      location.hash = '#/';
      return;
    }

    if (faceId === 'tasks') {
      location.hash = '#/work';
      return;
    }

    if (faceId === 'reports' && ['sales', 'developer', 'hr'].includes(user.role)) {
      location.hash = user.role === 'hr' ? '#/' : '#/work';
      return;
    }

    if (faceId === 'finance' && user.role !== 'admin') {
      location.hash = user.role === 'director' ? '#/invoices' : '#/';
      return;
    }

    if (['pipeline', 'leads', 'clients'].includes(faceId) && !['director', 'sales', 'pm', 'admin'].includes(user.role)) {
      location.hash = '#/';
      return;
    }

    if (faceId === 'leads' || faceId === 'clients') {
      if (faceId === 'clients') sessionStorage.setItem('cres_pipeline_stage', 'clients');
      location.hash = '#/pipeline';
      return;
    }

    if (faceId === 'changes') {
      location.hash = '#/projects';
      return;
    }

    if (faceId === 'billing') {
      location.hash = '#/invoices';
      return;
    }

    if (faceId === 'timeline') {
      location.hash = '#/projects?tab=timeline';
      return;
    }

    document.querySelectorAll('.face').forEach((el) => el.classList.remove('active'));
    if (face) {
      face.classList.add('active');
      const q = faceQuery();
      let title = titles[path] || face.dataset.title || 'Cres Dynamics';
      if (q.get('mine') === '1' && faceId === 'leave') title = 'My leave';
      if (q.get('mine') === '1' && faceId === 'salaries') title = 'My pay';
      if (user.role === 'admin' && ['users', 'login-audit', 'health', 'organization', 'email'].includes(faceId)) {
        title = 'Organization';
      }
      if (user.role === 'admin' && ['finance', 'invoices', 'payments', 'flag', 'expenses'].includes(faceId)) {
        title = 'Finance';
      }
      if (user.role === 'director' && ['invoices', 'expenses'].includes(faceId)) title = 'Money';
      if (q.get('tab') === 'timeline' && faceId === 'projects') title = 'Projects';
      document.getElementById('page-title').textContent = title;
    } else {
      document.getElementById('face-home').classList.add('active');
      document.getElementById('page-title').textContent = 'Home';
    }

    paintNav(`#${pathFull.startsWith('/') ? pathFull : `/${pathFull}`}`);

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
        if (isFinance || user.role === 'admin') {
        const heading = document.querySelector('#finance-invoices-panel .face-hero h2');
        if (heading) heading.textContent = 'Billing';
      }
      const heading = document.querySelector('#face-invoices .face-hero h2');
        // client panel has its own hero
      }
    }

    const directorReports = document.getElementById('director-reports-panel');
    const pmReports = document.getElementById('pm-reports-panel');
    const adminReports = document.getElementById('admin-reports-panel');
    const financeReports = document.getElementById('finance-reports-panel');
    if (faceId === 'reports') {
      const isDirectorHub = user.role === 'director';
      const isPmHub = user.role === 'pm';
      const isAdminHub = user.role === 'admin';
      const isFinance = user.role === 'finance';
      if (directorReports) directorReports.hidden = !isDirectorHub;
      if (pmReports) pmReports.hidden = !isPmHub;
      if (adminReports) adminReports.hidden = !isAdminHub;
      if (financeReports) financeReports.hidden = !isFinance;
      const heading = document.getElementById('reports-heading');
      const blurb = document.getElementById('reports-blurb');
      if (isAdminHub) {
        if (heading) heading.textContent = 'Reports';
        if (blurb) {
          blurb.textContent =
            'See who shared a report, who did not, and the work they logged. Open a report to view it.';
        }
      } else if (isPmHub) {
        if (heading) heading.textContent = 'Reports hub';
        if (blurb) blurb.textContent = 'Review today’s reports, then approve or forward to the Director.';
      } else if (isDirectorHub) {
        if (heading) heading.textContent = 'Reports';
        if (blurb) blurb.textContent = 'Analytics, daily reports, and the action log.';
      } else if (isFinance) {
        if (heading) heading.textContent = 'Financial reports';
        if (blurb) {
          blurb.textContent =
            'Cash flow in and out — projects, clients, accounts, expenses, and salaries. Download as CSV or PDF.';
        }
      }
      if (isAdminHub || isDirectorHub) {
        const reportsTab = faceQuery().get('tab') || (user.role === 'admin' ? 'today' : 'analytics');
        const ids =
          user.role === 'admin'
            ? {
                today: 'admin-today-digest',
                analytics: 'admin-analytics',
                daily: 'admin-reports-daily',
                audit: 'admin-action-audit',
              }
            : {
                analytics: 'director-analytics',
                daily: 'director-reports-daily',
                audit: 'director-action-audit',
              };
        Object.entries(ids).forEach(([key, id]) => {
          const el = document.getElementById(id);
          if (el) el.hidden = key !== reportsTab;
        });
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
            hero.textContent = 'Approve or reject expenses and salary funding waiting on you.';
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
    if (adminSystem) adminSystem.hidden = true;
    const orgCompany = document.getElementById('org-company-settings');
    if (faceId === 'organization' && orgCompany) orgCompany.hidden = false;

    const adminEmailExtra = document.getElementById('admin-email-automations');
    if (adminEmailExtra) adminEmailExtra.hidden = !(faceId === 'email' && user.role === 'admin');

    // Projects: sales chrome vs PM company list vs client portal vs finance money view
    const salesProjects = document.getElementById('sales-projects-chrome');
    const pmProjects = document.getElementById('pm-projects-panel');
    const pmDetail = document.getElementById('pm-project-detail');
    const clientProjects = document.getElementById('client-projects-panel');
    const clientDetail = document.getElementById('client-project-detail');
    const financeProjects = document.getElementById('finance-projects-panel');
    const adminProjects = document.getElementById('admin-projects-panel');
    if (faceId === 'projects') {
      const isPm = user.role === 'pm';
      const isClient = user.role === 'client';
      const isFinance = user.role === 'finance';
      const isDirector = user.role === 'director';
      const isAdmin = user.role === 'admin';
      const timelineOn =
        faceQuery().get('tab') === 'timeline' && ['admin', 'director', 'pm'].includes(user.role);
      const timelinePanel = document.getElementById('projects-timeline-panel');
      if (timelinePanel) timelinePanel.hidden = !timelineOn;
      if (timelineOn) {
        if (salesProjects) salesProjects.hidden = true;
        if (pmProjects) pmProjects.hidden = true;
        if (pmDetail) pmDetail.hidden = true;
        if (clientProjects) clientProjects.hidden = true;
        if (clientDetail) clientDetail.hidden = true;
        if (financeProjects) financeProjects.hidden = true;
        if (adminProjects) adminProjects.hidden = true;
      } else {
        if (salesProjects) salesProjects.hidden = isPm || isClient || isFinance || isAdmin;
        if (pmProjects) pmProjects.hidden = isPm ? !!faceParam : true;
        if (pmDetail) pmDetail.hidden = !(isPm && faceParam);
        if (clientProjects) clientProjects.hidden = isClient ? !!faceParam : true;
        if (clientDetail) clientDetail.hidden = !(isClient && faceParam);
        if (financeProjects) financeProjects.hidden = !isFinance;
        if (adminProjects) adminProjects.hidden = !isAdmin;
      }
      const newProjBtn = document.getElementById('btn-new-project');
      if (newProjBtn) {
        newProjBtn.hidden =
          timelineOn || isFinance || isClient || isPm || isAdmin || user.role === 'developer';
      }
      const hero = salesProjects?.querySelector('.face-hero');
      if (hero) {
        const h2 = hero.querySelector('h2');
        const p = hero.querySelector('p');
        if (isDirector) {
          if (h2) h2.textContent = 'Projects';
          if (p) {
            p.textContent = 'Create, edit, or delete a project, and review progress.';
          }
        } else if (user.role === 'sales') {
          if (h2) h2.textContent = 'Projects';
          if (p) {
            p.textContent = 'Create a project or check progress for a client.';
          }
        } else if (user.role === 'developer') {
          if (h2) h2.textContent = 'My projects';
          if (p) {
            p.textContent = 'Update milestones and hours on your assigned work.';
          }
        }
      }
    }

    if (faceId === 'settings') {
      await CresSettings.load();
    }
    if (faceId === 'email' && user.role === 'admin') {
      const heading = document.getElementById('email-heading');
      const blurb = document.getElementById('email-blurb');
      if (heading) heading.textContent = 'Client email';
      if (blurb) {
        blurb.textContent = 'Write to a client, turn automations on or off, and see mail going out and coming back.';
      }
    }
    if (faceId === 'approvals' && typeof CresApprovals !== 'undefined') {
      await CresApprovals.mount();
    }
    if (faceId === 'work') {
      if (typeof CresMyWork !== 'undefined') await CresMyWork.mount();
      else if (typeof CresTasks !== 'undefined') await CresTasks.mount();
    }

    paintPageTabs(faceId);
    if (faceId === 'ops' && typeof CresOps !== 'undefined') {
      await CresOps.mount();
    }
    if (faceId === 'community') {
      await CresCommunity.mount();
    }
    if (faceId === 'jarvis' && typeof CresJarvis !== 'undefined') {
      await CresJarvis.show();
    }

    const timelineOn =
      faceId === 'projects' &&
      faceQuery().get('tab') === 'timeline' &&
      ['admin', 'director', 'pm'].includes(user.role);
    const jobs = [];

    if (typeof CresSales !== 'undefined') {
      if (user.role === 'sales') {
        jobs.push(CresSales.mount(faceId, user));
      } else if (user.role === 'admin' && ['followups', 'email', 'pipeline', 'leads', 'clients'].includes(faceId)) {
        jobs.push(CresSales.mount(faceId, user));
      } else if (['director', 'pm'].includes(user.role) && ['pipeline', 'leads', 'clients'].includes(faceId)) {
        jobs.push(CresSales.mount(faceId, user));
      }
    }

    if (typeof CresDirector !== 'undefined' && ['director', 'admin'].includes(user.role)) {
      jobs.push(CresDirector.mount(faceId, user));
    }

    if (typeof CresDeveloper !== 'undefined' && user.role === 'developer') {
      jobs.push(CresDeveloper.mount(faceId, user));
    }

    if (typeof CresFinance !== 'undefined' && ['finance', 'admin', 'director'].includes(user.role)) {
      jobs.push(CresFinance.mount(faceId, user));
    }

    if (typeof CresHR !== 'undefined' && ['hr', 'admin'].includes(user.role)) {
      jobs.push(CresHR.mount(faceId, user, faceParam));
    }

    if (typeof CresPM !== 'undefined' && ['pm', 'director', 'admin'].includes(user.role)) {
      jobs.push(CresPM.mount(faceId, user, faceParam));
    }

    if (typeof CresAdmin !== 'undefined' && ['admin', 'director', 'hr'].includes(user.role)) {
      jobs.push(CresAdmin.mount(faceId, user));
    }

    if (typeof CresTraffic !== 'undefined') {
      jobs.push(CresTraffic.mount(faceId, user));
    }

    if (typeof CresWebsitePayments !== 'undefined') {
      jobs.push(CresWebsitePayments.mount(faceId, user));
    }

    if (typeof CresAdminHealth !== 'undefined') {
      jobs.push(CresAdminHealth.mount(faceId, user));
    }

    if (typeof CresClient !== 'undefined' && user.role === 'client') {
      jobs.push(CresClient.mount(faceId, user, faceParam));
    }

    if (jobs.length) await Promise.all(jobs);
  }

  function roleBlurb(role) {
    const map = {
      sales: 'Work your pipeline, follow up today, and keep deals moving.',
      director: 'Approve work, review the team, and watch this month’s revenue.',
      developer: 'Update your projects and log what you did today.',
      finance: 'Bill, collect, and record spending.',
      pm: 'Keep projects on track and review today’s reports.',
      admin: 'See what needs you today across sales, projects, and money.',
      hr: 'Manage people, leave, and payroll.',
      client: 'See your project progress and invoices.',
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

  function syncModalLock() {
    const open = document.querySelector(
      '.modal-backdrop.open, .new-chat-modal.open, .modal-overlay:not([hidden])'
    );
    document.body.classList.toggle('modal-open', !!open);
  }
  const modalLockObserver = new MutationObserver(syncModalLock);
  document.querySelectorAll('.modal-backdrop, .new-chat-modal, .modal-overlay').forEach((el) => {
    modalLockObserver.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
  });
  syncModalLock();

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
          } else if (btn.dataset.type === 'client' && btn.dataset.id && typeof CresClientCard !== 'undefined') {
            CresClientCard.open(btn.dataset.id).catch(console.error);
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
    if (meta.taskId || type.includes('task')) return '#/work';
    if (meta.leaveId || type.includes('leave')) return '#/leave?mine=1';
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
    if (type.includes('report')) {
      return ['admin', 'director', 'pm', 'finance'].includes(user.role) ? '#/reports' : '#/work';
    }
    if (type.includes('assign')) return '#/projects';
    return null;
  }

  function actionHintForNotification(n) {
    const meta = parseNotifMeta(n);
    if (meta.action) return meta.action;
    const type = String(n.type || '').toLowerCase();
    if (type.includes('expense_pending_finance')) return 'Open Expenses and approve as Finance. Admin only reviews amounts above the threshold.';
    if (type.includes('expense_pending_admin')) return 'Open Expenses and give Admin approval (this amount is above the threshold).';
    if (type.includes('expense')) return 'Review this expense on the Expenses page.';
    if (type.includes('task')) return 'Open My work to view or update this assignment.';
    if (type.includes('leave')) return 'Open My leave to review or track this request.';
    if (type.includes('funding') || type.includes('salary')) return 'Open Salary funding for the approval chain.';
    if (type.includes('approval')) return 'Open Approvals to decide on the project.';
    if (type.includes('message')) return 'Open Community to read the conversation.';
    if (type.includes('report')) {
      return ['admin', 'director', 'pm', 'finance'].includes(user.role)
        ? 'Open Reports to review or respond.'
        : 'Open My work to review or respond.';
    }
    if (type.includes('followup')) return 'Open My Follow-ups to contact the client.';
    return 'Review the details below. Use Open related page when a destination is available.';
  }

  function openNotificationDetail(n) {
    const modal = document.getElementById('notif-detail-modal');
    if (!modal) return;
    const href = hrefForNotification(n);
    document.getElementById('notif-detail-title').textContent = (n.type || 'notification')
      .replace(/_/g, ' ');
    document.getElementById('notif-detail-type').textContent = CresFormat.datetime(n.created_at);
    document.getElementById('notif-detail-body').textContent = n.content || '';
    document.getElementById('notif-detail-action').textContent = actionHintForNotification(n);
    const go = document.getElementById('notif-detail-go');
    if (href) {
      go.hidden = false;
      go.onclick = () => {
        modal.classList.remove('open');
        if (href.startsWith('/')) location.href = href;
        else location.hash = href;
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
        const when = CresFormat.datetime(n.created_at);
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
          // Full page links (e.g. /meeting/<id>) leave the dashboard; the rest are in-app routes.
          if (href.startsWith('/')) location.href = href;
          else location.hash = href;
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
    if (!liveEl) return;
    liveEl.classList.remove('online', 'degraded');
    const label = liveEl.querySelector('.label');
    if (!label) return;
    if (status === 'online') {
      liveEl.classList.add('online');
      label.textContent = 'Live';
    } else if (status === 'degraded' || status === 'connecting') {
      liveEl.classList.add('degraded');
      label.textContent = status === 'connecting' ? 'Connecting' : 'Reconnecting';
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

  CresNav.renderProfile(profileDd, user, permissions);
  profileDd.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => profileDd.classList.remove('open'));
  });

  CresSettings.bind();
  if (typeof CresTasks !== 'undefined') CresTasks.bind();
  if (typeof CresMyWork !== 'undefined') CresMyWork.bind();
  if (typeof CresOps !== 'undefined') CresOps.bind();
  CresCommunity.bind();
  if (typeof CresCalls !== 'undefined') CresCalls.bind();
  if (typeof CresProjectDetail !== 'undefined') CresProjectDetail.bind();
  if (typeof CresClientCard !== 'undefined') CresClientCard.bind();
  CresSales.bindModals();
  CresDirector.bind();
  CresDeveloper.bind();
  CresFinance.bind();
  if (typeof CresHR !== 'undefined') CresHR.bind();
  if (typeof CresPM !== 'undefined') CresPM.bind();
  if (typeof CresAdmin !== 'undefined') CresAdmin.bind();
  if (typeof CresClient !== 'undefined') CresClient.bind();
  window.addEventListener('hashchange', () => {
    route().catch(console.error);
  });
  await route();
  loadNotifications().catch(() => {});
  setTimeout(() => {
    CresRealtime.connect();
    paintLive(CresRealtime.getStatus());
  }, 50);
})();
