/**
 * Nav items driven by role_permissions - not hardcoded per role.
 * Same component/data for every department.
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
      id: 'inbox-ai',
      label: 'Inbox AI',
      href: '#/inbox-ai',
      icon: '✉',
      rolesOnly: ['admin'],
      anyOf: ['users:view'],
    },
    {
      id: 'approvals',
      label: 'Approvals',
      href: '#/approvals',
      icon: '✓',
      // Director: projects · Finance/Admin: money (expenses + salary funding)
      anyOf: ['projects:approve', 'expenses:edit', 'salaries:view'],
      rolesOnly: ['director', 'admin', 'finance'],
      labelByRole: { finance: 'Money approvals', admin: 'Approvals' },
    },
    {
      id: 'leads',
      label: 'Leads',
      href: '#/leads',
      icon: '◎',
      anyOf: ['leads:view'],
    },
    {
      id: 'clients',
      label: 'Clients',
      href: '#/clients',
      icon: '◉',
      anyOf: ['clients:view'],
      hideRoles: ['client'],
    },
    {
      id: 'projects',
      label: 'Projects',
      href: '#/projects',
      icon: '▣',
      anyOf: ['projects:view'],
      hideRoles: ['hr'],
      labelByRole: { finance: 'Project finances', client: 'Your projects' },
    },
    {
      id: 'timeline',
      label: 'Timeline',
      href: '#/timeline',
      icon: '▦',
      anyOf: ['projects:view'],
      rolesOnly: ['pm', 'director', 'admin'],
    },
    {
      id: 'invoices',
      label: 'Invoices',
      href: '#/invoices',
      icon: '▤',
      anyOf: ['invoices:view'],
      hideRoles: ['sales'], // sales uses follow-ups
      labelByRole: { client: 'Invoices & docs' },
    },
    {
      id: 'followups',
      label: 'My Follow-ups',
      href: '#/followups',
      icon: '⚑',
      anyOf: ['invoice_followups:view'],
      rolesOnly: ['sales', 'admin'],
    },
    {
      id: 'payments',
      label: 'Payments',
      href: '#/payments',
      icon: '₫',
      anyOf: ['payments:view'],
    },
    {
      id: 'expenses',
      label: 'Expenses',
      href: '#/expenses',
      icon: '◌',
      anyOf: ['expenses:view'],
    },
    {
      id: 'flag',
      label: 'Flag follow-up',
      href: '#/flag',
      icon: '⚑',
      anyOf: ['invoice_followups:create'],
      rolesOnly: ['finance', 'admin'],
    },
    {
      id: 'employees',
      label: 'Employees',
      href: '#/employees',
      icon: '☺',
      anyOf: ['employees:view'],
    },
    {
      id: 'leave',
      label: 'Leave',
      href: '#/leave',
      icon: '◷',
      anyOf: ['leave:view', 'employees:view'],
      hideRoles: ['client'],
    },
    {
      id: 'salaries',
      label: 'Payroll',
      href: '#/salaries',
      icon: '₪',
      anyOf: ['salaries:view'],
      hideRoles: ['client'],
      labelByRole: {
        sales: 'My payroll',
        director: 'My payroll',
        developer: 'My payroll',
        finance: 'My payroll',
        pm: 'My payroll',
      },
    },
    {
      id: 'salary-funding',
      label: 'Salary funding',
      href: '#/salary-funding',
      icon: '⇄',
      anyOf: ['salaries:create'],
      rolesOnly: ['hr'],
    },
    {
      id: 'changes',
      label: 'Change requests',
      href: '#/changes',
      icon: '↻',
      anyOf: ['projects:view'],
      rolesOnly: ['client', 'sales', 'admin', 'director'],
    },
    {
      id: 'email',
      label: 'Email client',
      href: '#/email',
      icon: '✉',
      anyOf: ['clients:view'],
      rolesOnly: ['sales', 'finance'],
      labelByRole: { finance: 'Finance email' },
    },
    {
      id: 'tasks',
      label: 'Tasks',
      href: '#/tasks',
      icon: '☑',
      anyOf: ['tasks:view'],
    },
    {
      id: 'reports',
      label: 'Reports',
      href: '#/reports',
      icon: '☰',
      anyOf: ['reports:view', 'cash_flow:view'],
      labelByRole: { finance: 'Financial reports' },
    },
    {
      id: 'users',
      label: 'Users',
      href: '#/users',
      icon: '⚙',
      anyOf: ['users:create'],
      rolesOnly: ['admin'],
    },
    {
      id: 'login-audit',
      label: 'Login audit',
      href: '#/login-audit',
      icon: '☰',
      anyOf: ['users:view'],
      rolesOnly: ['admin'],
    },
    {
      id: 'community',
      label: 'Community',
      href: '#/community',
      icon: '💬',
      anyOf: ['messages:view'],
      hideRoles: ['finance', 'client'],
    },
    {
      id: 'settings',
      label: 'Settings',
      href: '#/settings',
      icon: '◦',
      anyOf: ['settings:view'],
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

  function render(container, user, permissions, activeHref) {
    const items = visibleItems(user, permissions);
    container.innerHTML = items
      .map((item) => {
        const active = activeHref === item.href || (item.href === '#/' && (activeHref === '' || activeHref === '#/'));
        const label = item.labelByRole?.[user.role] || item.label;
        return `<li>
          <a href="${item.href}" class="${active ? 'active' : ''}" data-nav="${item.id}">
            <span class="nav-icon">${item.icon}</span>
            <span>${label}</span>
          </a>
        </li>`;
      })
      .join('');
    return items;
  }

  return { ITEMS, visibleItems, render };
})();
