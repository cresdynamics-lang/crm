/**
 * AI-readable fetch & filter layer.
 * Structured JSON only. Same RBAC as domain APIs - never a permission bypass.
 */
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');
const { hasPermission } = require('../middleware/rbac');

const RESOURCES = {
  leads: {
    permission: ['leads', 'view'],
    table: 'leads',
    filters: {
      status: 'status',
      created_by: 'created_by',
      date_from: { sql: 'created_at >= $%::date', param: true },
      date_to: { sql: "created_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: 'id, name, phone, email, business_name, status, created_by, created_at',
    scope(user, params, clauses) {
      if (user.role === 'sales') {
        params.push(user.id);
        clauses.push(`created_by = $${params.length}`);
      }
    },
  },

  clients: {
    permission: ['clients', 'view'],
    table: 'clients',
    filters: {
      date_from: { sql: 'converted_at >= $%::date', param: true },
      date_to: { sql: "converted_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: 'id, lead_id, name, business_name, email, phone, converted_at',
  },

  projects: {
    permission: ['projects', 'view'],
    table: 'projects',
    filters: {
      status: 'status',
      assigned_developer: 'assigned_developer_id',
      client_id: 'client_id',
      created_by: 'created_by',
      date_from: { sql: 'created_at >= $%::date', param: true },
      date_to: { sql: "created_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: `id, name, client_id, description, milestones, summary,
              assigned_developer_id, created_by, status, rejection_reason,
              approved_by, approved_at, assignment_status, created_at, updated_at`,
    // value_amount intentionally omitted unless caller has invoices:view
    scope(user, params, clauses) {
      if (user.role === 'developer') {
        params.push(user.id);
        clauses.push(`assigned_developer_id = $${params.length}`);
        clauses.push(`status NOT IN ('pending_approval', 'rejected')`);
      } else if (user.role === 'sales') {
        params.push(user.id);
        clauses.push(`created_by = $${params.length}`);
      }
    },
    mapRow(row, user) {
      if (hasPermission(user, 'invoices', 'view') || hasPermission(user, 'account_balance', 'view')) {
        return row; // value added separately below when permitted
      }
      return row;
    },
  },

  invoices: {
    permission: ['invoices', 'view'],
    table: 'invoices',
    filters: {
      status: 'status',
      client_id: 'client_id',
      project_id: 'project_id',
      amount_min: { sql: 'amount >= $%', param: true },
      amount_max: { sql: 'amount <= $%', param: true },
      date_from: { sql: 'created_at >= $%::date', param: true },
      date_to: { sql: "created_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: 'id, project_id, client_id, amount, status, auto_sent_at, created_at',
    // Sales cannot use this resource even via query - they use invoice_followups
    denyRoles: ['sales', 'developer', 'pm', 'hr'],
  },

  invoice_followups: {
    permission: ['invoice_followups', 'view'],
    table: 'invoice_followups',
    filters: {
      status: 'status',
      assigned_sales_user_id: 'assigned_sales_user_id',
      invoice_id: 'invoice_id',
    },
    columns: 'id, invoice_id, assigned_sales_user_id, flagged_by, status, created_at',
    scope(user, params, clauses) {
      if (user.role === 'sales') {
        params.push(user.id);
        clauses.push(`assigned_sales_user_id = $${params.length}`);
      }
    },
  },

  payments: {
    permission: ['payments', 'view'],
    table: 'payments',
    filters: {
      invoice_id: 'invoice_id',
      date_from: { sql: 'paid_at >= $%::date', param: true },
      date_to: { sql: "paid_at < ($%::date + INTERVAL '1 day')", param: true },
      amount_min: { sql: 'amount >= $%', param: true },
      amount_max: { sql: 'amount <= $%', param: true },
    },
    columns: 'id, invoice_id, amount, paid_at, recorded_by, created_at',
  },

  expenses: {
    permission: ['expenses', 'view'],
    table: 'expenses',
    filters: {
      category: 'category',
      date_from: { sql: 'created_at >= $%::date', param: true },
      date_to: { sql: "created_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: 'id, category, amount, description, linked_salary_id, created_at',
  },

  salaries: {
    permission: ['salaries', 'view'],
    table: 'salary_payments',
    filters: {
      status: 'status',
      month: 'month',
      employee_id: 'employee_id',
    },
    columns: 'id, employee_id, month, amount_expected, amount_paid, status, settled_at, created_at',
  },

  employees: {
    permission: ['employees', 'view'],
    table: 'employees',
    filters: {
      pay_cycle: 'pay_cycle',
    },
    columns: 'id, user_id, position, salary_amount, pay_cycle, created_at',
  },

  reports: {
    permission: ['reports', 'view'],
    table: 'daily_reports',
    filters: {
      user_id: 'user_id',
      project_id: 'project_id',
      date_from: { sql: 'created_at >= $%::date', param: true },
      date_to: { sql: "created_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: 'id, user_id, project_id, content, attachments, created_at',
    scope(user, params, clauses) {
      if (['sales', 'developer'].includes(user.role)) {
        params.push(user.id);
        clauses.push(`user_id = $${params.length}`);
      }
    },
  },

  notifications: {
    permission: ['notifications', 'view'],
    table: 'notifications',
    filters: {
      type: 'type',
      date_from: { sql: 'created_at >= $%::date', param: true },
      date_to: { sql: "created_at < ($%::date + INTERVAL '1 day')", param: true },
    },
    columns: 'id, user_id, type, content, meta, created_at, read_at',
    scope(user, params, clauses) {
      params.push(user.id);
      clauses.push(`user_id = $${params.length}`);
    },
  },
};

function buildFilterQuery(resourceKey, user, filterParams) {
  const def = RESOURCES[resourceKey];
  if (!def) throw new AppError(`Unknown query resource: ${resourceKey}`, 404, 'NOT_FOUND');

  if (def.denyRoles?.includes(user.role)) {
    throw new AppError(`Forbidden: role ${user.role} cannot query ${resourceKey}`, 403, 'FORBIDDEN');
  }

  const [resName, action] = def.permission;
  if (!hasPermission(user, resName, action)) {
    throw new AppError(`Forbidden: missing ${resName}:${action}`, 403, 'FORBIDDEN');
  }

  const params = [];
  const clauses = [];

  if (typeof def.scope === 'function') {
    def.scope(user, params, clauses);
  }

  for (const [key, spec] of Object.entries(def.filters || {})) {
    const value = filterParams[key];
    if (value === undefined || value === null || value === '') continue;

    if (typeof spec === 'string') {
      params.push(value);
      clauses.push(`${spec} = $${params.length}`);
    } else if (spec.param) {
      params.push(value);
      clauses.push(spec.sql.replace('$%', `$${params.length}`));
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let columns = def.columns;

  // Projects: include value_amount only if money-visible
  if (resourceKey === 'projects' && (
    hasPermission(user, 'invoices', 'view') || hasPermission(user, 'account_balance', 'view')
  )) {
    columns += ', value_amount';
  }

  // Hard block account_balance / cash_flow as query resources unless permitted
  const limit = Math.min(Number(filterParams.limit) || 100, 500);
  const offset = Math.max(Number(filterParams.offset) || 0, 0);
  params.push(limit);
  params.push(offset);

  const sql = `SELECT ${columns} FROM ${def.table} ${where}
               ORDER BY created_at DESC NULLS LAST
               LIMIT $${params.length - 1} OFFSET $${params.length}`;

  return { sql, params };
}

async function runQuery(resourceKey, user, filterParams = {}) {
  // Explicit money-health resources - separate from invoices
  if (resourceKey === 'account_balances') {
    if (!hasPermission(user, 'account_balance', 'view')) {
      throw new AppError('Forbidden: missing account_balance:view', 403, 'FORBIDDEN');
    }
    const { rows } = await query(`SELECT id, label, balance, updated_at FROM account_balances`);
    return { resource: resourceKey, count: rows.length, data: rows };
  }

  if (resourceKey === 'cash_flow') {
    if (!hasPermission(user, 'cash_flow', 'view')) {
      throw new AppError('Forbidden: missing cash_flow:view', 403, 'FORBIDDEN');
    }
    const { rows: paid } = await query(`SELECT COALESCE(SUM(amount),0)::float AS total FROM payments`);
    const { rows: exp } = await query(`SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses`);
    const data = {
      paymentsIn: paid[0].total,
      expensesOut: exp[0].total,
      net: paid[0].total - exp[0].total,
    };
    return { resource: resourceKey, count: 1, data: [data] };
  }

  const { sql, params } = buildFilterQuery(resourceKey, user, filterParams);
  const { rows } = await query(sql, params);
  return {
    resource: resourceKey,
    count: rows.length,
    filters: filterParams,
    data: rows,
  };
}

function listResources(user) {
  const available = Object.keys(RESOURCES).filter((key) => {
    const def = RESOURCES[key];
    if (def.denyRoles?.includes(user.role)) return false;
    const [r, a] = def.permission;
    return hasPermission(user, r, a);
  });

  if (hasPermission(user, 'account_balance', 'view')) available.push('account_balances');
  if (hasPermission(user, 'cash_flow', 'view')) available.push('cash_flow');

  return available;
}

module.exports = { runQuery, listResources, RESOURCES };
