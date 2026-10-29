/**
 * Nav items driven by role_permissions - not hardcoded per role.
 * Same component/data for every department.
 * Personal items (leave, pay, settings, help) live in the profile menu.
 */
const CresNav = (() => {
  const ITEMS = [
    {
      id: 'home',
      label: 'Home',
      href: '#/',
      icon: '⌂',
    },
    {
      id: 'jarvis',
      label: 'Jarvis',
      href: '#/jarvis',
      icon: '✦',
    },
    {
      id: 'community',
      label: 'Community',
      href: '#/community',
      icon: '💬',
      hideRoles: ['client'],
    },
    {
      id: 'inbox',
      label: 'Inbox',
      href: '/inbox',
      icon: '✉',
      rolesOnly: ['admin'],
    },
    {
      id: 'meetings',
      label: 'Meetings',
      href: '/meetings',
      icon: '◉',
    },
    {
      id: 'approvals',
      label: 'Approvals',
      href: '#/approvals',
      icon: '✓',
      anyOf: ['projects:approve', 'expenses:edit', 'salaries:view'],
      rolesOnly: ['director', 'admin', 'finance'],
    },
    {
      id: 'pipeline',
      label: 'Pipeline',
      href: '#/pipeline',
      icon: '◎',
      anyOf: ['leads:view'],
      rolesOnly: ['director', 'sales', 'pm', 'admin'],
    },
    {
      id: 'projects',
      label: 'Projects',
      href: '#/projects',
      icon: '▣',
      anyOf: ['projects:view'],
      hideRoles: ['hr', 'finance'],
      labelByRole: { client: 'Your projects' },
    },
    {
      id: 'finance',
      label: 'Finance',
      href: '#/finance',
      icon: '▤',
      anyOf: ['invoices:view', 'expenses:view'],
      rolesOnly: ['admin'],
    },
    {
      id: 'money',
      label: 'Money',
      href: '#/invoices',
      icon: '▤',
      anyOf: ['invoices:view', 'expenses:view'],
      rolesOnly: ['director'],
    },
    {
      id: 'billing',
      label: 'Billing',
      href: '#/billing',
      icon: '▤',
      anyOf: ['invoices:view', 'payments:view'],
      rolesOnly: ['finance'],
    },
    {
      id: 'invoices',
      label: 'Invoices',
      href: '#/invoices',
      icon: '▤',
      anyOf: ['invoices:view'],
      hideRoles: ['sales', 'finance', 'admin', 'director'],
      labelByRole: { client: 'Invoices & docs' },
    },
    {
      id: 'followups',
      label: 'Collections',
      href: '#/followups',
      icon: '⚑',
      anyOf: ['invoice_followups:view'],
      rolesOnly: ['sales'],
    },
    {
      id: 'payments',
      label: 'Payments',
      href: '#/payments',
      icon: '₫',
      anyOf: ['payments:view'],
      hideRoles: ['finance', 'admin', 'director'],
    },
    {
      id: 'expenses',
      label: 'Expenses',
      href: '#/expenses',
      icon: '◌',
      anyOf: ['expenses:view'],
      hideRoles: ['admin', 'director'],
    },
    {
      id: 'flag',
      label: 'Flag follow-up',
      href: '#/flag',
      icon: '⚑',
      anyOf: ['invoice_followups:create'],
      rolesOnly: [],
    },
    {
      id: 'people',
      label: 'People',
      href: '#/employees',
      icon: '☺',
      anyOf: ['employees:view'],
      rolesOnly: ['hr', 'admin'],
    },
    {
      id: 'salaries',
      label: 'Payroll',
      href: '#/salaries',
      icon: '₪',
      anyOf: ['salaries:view'],
      rolesOnly: ['hr'],
    },
    {
      id: 'email',
      label: 'Email client',
      href: '#/email',
      icon: '✉',
      anyOf: ['clients:view'],
      rolesOnly: ['finance'],
      labelByRole: { finance: 'Finance email' },
    },
    {
      id: 'work',
      label: 'My work',
      href: '#/work',
      icon: '☑',
      anyOf: ['tasks:view', 'reports:create'],
      hideRoles: ['client', 'hr', 'admin'],
    },
    {
      id: 'reports',
      label: 'Reports',
      href: '#/reports',
      icon: '☰',
      anyOf: ['reports:view', 'cash_flow:view'],
      rolesOnly: ['admin', 'director', 'pm', 'finance'],
      labelByRole: { finance: 'Financial reports' },
    },
    {
      id: 'websites',
      label: 'Websites',
      href: '#/traffic',
      icon: '◔',
      anyOf: ['reports:view'],
      rolesOnly: ['admin'],
    },
    {
      id: 'traffic',
      label: 'Website traffic',
      href: '#/traffic',
      icon: '◔',
      anyOf: ['reports:view'],
      rolesOnly: ['director'],
    },
    {
      id: 'website-payments',
      label: 'Event registrations',
      href: '#/website-payments',
      icon: '₡',
      anyOf: ['payments:view', 'cash_flow:view'],
      rolesOnly: ['finance'],
    },
    {
      id: 'system',
      label: 'Organization',
      href: '#/users',
      icon: '⚙',
      anyOf: ['users:create', 'users:view'],
      rolesOnly: ['admin'],
    },
  ];

  function visibleItems(user, permissions) {
    const perms = permissions || [];
    return ITEMS.filter((item) => {
      if (item.hideRoles?.includes(user.role)) return false;
      if (item.rolesOnly && !item.rolesOnly.includes(user.role)) return false;
      if (!item.anyOf) return true;
      return item.anyOf.some((p) => perms.includes(p));
    });
  }

  function profileItems(user, permissions) {
    const perms = permissions || [];
    const staff = user.role !== 'client';
    const items = [];
    if (staff && (perms.includes('leave:view') || perms.includes('leave:create') || perms.includes('employees:view'))) {
      items.push({ id: 'my-leave', label: 'My leave', href: '#/leave?mine=1' });
    }
    if (staff && perms.includes('salaries:view')) {
      items.push({ id: 'my-pay', label: 'My pay', href: '#/salaries?mine=1' });
    }
    if (perms.includes('settings:view') || staff) {
      items.push({ id: 'settings', label: 'Settings', href: '#/settings' });
    }
    if (staff) {
      items.push({ id: 'help', label: 'Help', href: '#/ops' });
    }
    return items;
  }

  function pathOf(href) {
    return String(href || '').split('?')[0];
  }

  function render(container, user, permissions, activeHref) {
    const items = visibleItems(user, permissions);
    const hrefPath = pathOf(activeHref || '#/');
    const mine = /(?:\?|&)mine=1\b/.test(activeHref || '');
    const moneyPaths = ['#/finance', '#/invoices', '#/payments', '#/flag', '#/expenses', '#/billing'];
    const peoplePaths = ['#/employees', '#/leave', '#/salaries', '#/applicants', '#/onboarding'];
    const websitePaths = ['#/traffic', '#/website-payments'];
    const systemPaths = ['#/users', '#/login-audit', '#/health', '#/organization', '#/email'];
    const payrollPaths = ['#/salaries', '#/salary-funding'];
    const billingPaths = ['#/invoices', '#/payments', '#/flag', '#/billing'];
    container.innerHTML = items
      .map((item) => {
        const active =
          hrefPath === item.href ||
          (item.href === '#/' && (hrefPath === '' || hrefPath === '#/')) ||
          (item.href === '#/work' && (hrefPath === '#/tasks' || hrefPath === '#/work')) ||
          (item.id === 'billing' &&
            (billingPaths.includes(hrefPath) ||
              (hrefPath === '#/projects' && user.role === 'finance'))) ||
          ((item.id === 'money' || item.id === 'finance') && moneyPaths.includes(hrefPath)) ||
          (item.id === 'people' && peoplePaths.includes(hrefPath) && !mine) ||
          (item.id === 'salaries' && payrollPaths.includes(hrefPath) && !mine) ||
          (item.id === 'websites' && websitePaths.includes(hrefPath)) ||
          (item.id === 'system' && systemPaths.includes(hrefPath)) ||
          (item.id === 'projects' && (hrefPath === '#/projects' || hrefPath === '#/timeline')) ||
          (item.id === 'pipeline' && (hrefPath === '#/leads' || hrefPath === '#/clients'));
        const label = item.labelByRole?.[user.role] || item.label;
        const liClass = item.id === 'community' ? ' class="nav-core-end"' : '';
        return `<li${liClass}>
          <a href="${item.href}" class="${active ? 'active' : ''}" data-nav="${item.id}">
            <span class="nav-icon">${item.icon}</span>
            <span>${label}</span>
          </a>
        </li>`;
      })
      .join('');
    return items;
  }

  function renderProfile(container, user, permissions) {
    if (!container) return [];
    const items = profileItems(user, permissions);
    const links = items
      .map((item) => `<a href="${item.href}" data-profile-nav="${item.id}">${item.label}</a>`)
      .join('');
    const logout = container.querySelector('#logout-btn');
    container.querySelectorAll('[data-profile-nav]').forEach((el) => el.remove());
    if (logout) {
      logout.insertAdjacentHTML('beforebegin', links);
    } else {
      container.insertAdjacentHTML('afterbegin', links);
    }
    return items;
  }

  return { ITEMS, visibleItems, profileItems, render, renderProfile };
})();
