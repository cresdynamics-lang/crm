/**
 * Seed roles, permissions, role_permissions, and demo users.
 * Money-visibility + messaging rules live in role_permissions.
 */
const bcrypt = require('bcryptjs');
const { pool, query } = require('../config/database');

const ROLES = [
  { name: 'sales', description: 'Sales team' },
  { name: 'director', description: 'Director' },
  { name: 'developer', description: 'Developers' },
  { name: 'finance', description: 'Finance' },
  { name: 'pm', description: 'Project Management' },
  { name: 'admin', description: 'Full system access' },
  { name: 'hr', description: 'Human Resources' },
  { name: 'client', description: 'Client portal user' },
];

/** resource:action pairs */
const PERMISSIONS = [
  // Auth / users
  ['users', 'view'],
  ['users', 'create'],
  ['users', 'edit'],
  // Leads / clients
  ['leads', 'view'],
  ['leads', 'create'],
  ['leads', 'edit'],
  ['clients', 'view'],
  ['clients', 'create'],
  ['clients', 'edit'],
  // Projects
  ['projects', 'view'],
  ['projects', 'create'],
  ['projects', 'edit'],
  ['projects', 'approve'],
  // Finance - granular money visibility
  ['invoices', 'view'],
  ['invoices', 'create'],
  ['invoices', 'edit'],
  ['payments', 'view'],
  ['payments', 'create'],
  ['expenses', 'view'],
  ['expenses', 'create'],
  ['expenses', 'edit'],
  ['account_balance', 'view'],
  ['cash_flow', 'view'],
  ['invoice_followups', 'view'],
  ['invoice_followups', 'create'],
  ['invoice_followups', 'edit'],
  // HR
  ['salaries', 'view'],
  ['salaries', 'create'],
  ['salaries', 'edit'],
  ['employees', 'view'],
  ['employees', 'create'],
  ['employees', 'edit'],
  ['leave', 'view'],
  ['leave', 'create'],
  ['leave', 'decide'],
  // Community / notifications / reports
  ['messages', 'view'],
  ['messages', 'create'],
  ['notifications', 'view'],
  ['reports', 'view'],
  ['reports', 'create'],
  // Director tasks
  ['tasks', 'view'],
  ['tasks', 'create'],
  ['tasks', 'edit'],
  // AI query layer (read shape; still gated per resource)
  ['query', 'view'],
  // System
  ['settings', 'view'],
  ['settings', 'edit'],
];

/**
 * Role → list of "resource:action"
 * Money rules:
 *   finance/admin: full finance incl. balances + cash flow
 *   director: invoices view (projected in/out) - NO account_balance, NO cash_flow
 *   sales: invoice_followups only (flagged to them)
 *   hr: salaries/employees only - no invoices/cash
 *   developer/pm: zero finance
 */
const ROLE_PERMS = {
  admin: '*', // all permissions

  sales: [
    'leads:view', 'leads:create', 'leads:edit',
    'clients:view', 'clients:create', 'clients:edit',
    'projects:view', 'projects:create', 'projects:edit',
    'invoice_followups:view', 'invoice_followups:edit',
    'messages:view', 'messages:create',
    'notifications:view',
    'reports:view', 'reports:create',
    'tasks:view', 'tasks:create', 'tasks:edit',
    'leave:view', 'leave:create',
    'salaries:view',
    'query:view',
    'settings:view',
  ],

  director: [
    'leads:view',
    'clients:view',
    'projects:view', 'projects:edit', 'projects:approve',
    'invoices:view', // projected money in/out only
    'expenses:view', 'expenses:create', 'expenses:edit', // Director can submit; Finance→Admin approve
    'messages:view', 'messages:create',
    'notifications:view',
    'reports:view', 'reports:create',
    'tasks:view', 'tasks:create', 'tasks:edit',
    'users:view',
    'leave:view', 'leave:create',
    'salaries:view',
    'query:view',
    'settings:view',
  ],

  developer: [
    'projects:view', 'projects:edit',
    'messages:view', 'messages:create',
    'notifications:view',
    'reports:view', 'reports:create',
    'tasks:view', 'tasks:create', 'tasks:edit',
    'leave:view', 'leave:create',
    'salaries:view',
    'query:view',
    'settings:view',
  ],

  finance: [
    'invoices:view', 'invoices:create', 'invoices:edit',
    'payments:view', 'payments:create',
    'expenses:view', 'expenses:create', 'expenses:edit',
    'salaries:view', // own payroll + salary figures synced as expenses context
    'account_balance:view',
    'cash_flow:view',
    'invoice_followups:view', 'invoice_followups:create', 'invoice_followups:edit',
    'clients:view', 'clients:create', 'clients:edit', // attach / add client when recording payments
    'projects:view',
    'notifications:view',
    'reports:view', 'reports:create',
    'tasks:view', 'tasks:create', 'tasks:edit',
    'leave:view', 'leave:create',
    'query:view',
    'settings:view',
  ],

  pm: [
    'projects:view', 'projects:edit',
    // clients:view / leads:view removed - PM sees project ops only
    'messages:view', 'messages:create',
    'notifications:view',
    'reports:view', 'reports:create',
    'tasks:view', 'tasks:create', 'tasks:edit',
    'leave:view', 'leave:create',
    'salaries:view',
    'query:view',
    'settings:view',
  ],

  hr: [
    'employees:view', 'employees:create', 'employees:edit',
    'salaries:view', 'salaries:create', 'salaries:edit',
    'leave:view', 'leave:create', 'leave:decide',
    'users:view',
    'notifications:view',
    'reports:view',
    'query:view',
    'settings:view',
  ],

  client: [
    'projects:view',
    'invoices:view', // own invoices only - scoped in route handlers
    'notifications:view',
    'query:view',
    'settings:view',
  ],
};

const DEMO_USERS = [
  { name: 'Admin User', email: 'admin@cresdynamics.local', role: 'admin', phone: '+10000000001' },
  { name: 'Sales Rep', email: 'sales@cresdynamics.local', role: 'sales', phone: '+10000000002' },
  { name: 'Director', email: 'director@cresdynamics.local', role: 'director', phone: '+10000000003' },
  { name: 'Dev One', email: 'dev@cresdynamics.local', role: 'developer', phone: '+10000000004' },
  { name: 'Finance Officer', email: 'finance@cresdynamics.local', role: 'finance', phone: '+10000000005' },
  { name: 'Project Manager', email: 'pm@cresdynamics.local', role: 'pm', phone: '+10000000006' },
  { name: 'HR Officer', email: 'hr@cresdynamics.local', role: 'hr', phone: '+10000000007' },
  { name: 'Acme Client', email: 'client@cresdynamics.local', role: 'client', phone: '+10000000008' },
];

const DEFAULT_PASSWORD = 'Password123!';

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Roles
    const roleIds = {};
    for (const role of ROLES) {
      const { rows } = await client.query(
        `INSERT INTO roles (name, description)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
         RETURNING id, name`,
        [role.name, role.description]
      );
      roleIds[rows[0].name] = rows[0].id;
    }

    // Permissions
    const permIds = {};
    for (const [resource, action] of PERMISSIONS) {
      const { rows } = await client.query(
        `INSERT INTO permissions (resource, action)
         VALUES ($1, $2)
         ON CONFLICT (resource, action) DO UPDATE SET resource = EXCLUDED.resource
         RETURNING id, resource, action`,
        [resource, action]
      );
      permIds[`${rows[0].resource}:${rows[0].action}`] = rows[0].id;
    }

    // Role permissions
    for (const [roleName, perms] of Object.entries(ROLE_PERMS)) {
      const roleId = roleIds[roleName];
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);

      const keys = perms === '*' ? Object.keys(permIds) : perms;
      for (const key of keys) {
        const permissionId = permIds[key];
        if (!permissionId) {
          throw new Error(`Unknown permission key: ${key}`);
        }
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, permissionId]
        );
      }
    }

    // Demo users
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    for (const u of DEMO_USERS) {
      await client.query(
        `INSERT INTO users (name, email, phone, password_hash, role_id, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name,
               phone = EXCLUDED.phone,
               password_hash = EXCLUDED.password_hash,
               role_id = EXCLUDED.role_id,
               status = 'active'`,
        [u.name, u.email, u.phone, passwordHash, roleIds[u.role]]
      );
    }

    // Link every staff demo user to an employees row (leave + payroll)
    const STAFF_EMPLOYEE_META = {
      'admin@cresdynamics.local': {
        position: 'Administrator',
        salary: 180000,
        home: 'Nairobi HQ',
        kin: 'Emergency desk',
        kra: 'A000000001X',
        bank: 'KES-ADMIN-001',
      },
      'sales@cresdynamics.local': {
        position: 'Sales Representative',
        salary: 95000,
        home: 'Westlands',
        kin: 'Jane Sales',
        kra: 'A000000002X',
        bank: 'KES-SALES-001',
      },
      'director@cresdynamics.local': {
        position: 'Director',
        salary: 250000,
        home: 'Karen',
        kin: 'Office of the Director',
        kra: 'A000000003X',
        bank: 'KES-DIR-001',
      },
      'dev@cresdynamics.local': {
        position: 'Software Developer',
        salary: 120000,
        home: 'Kilimani',
        kin: 'Dev Next of Kin',
        kra: 'A000000004X',
        bank: 'KES-DEV-001',
      },
      'finance@cresdynamics.local': {
        position: 'Finance Officer',
        salary: 110000,
        home: 'Upper Hill',
        kin: 'Finance Desk',
        kra: 'A000000005X',
        bank: 'KES-FIN-001',
      },
      'pm@cresdynamics.local': {
        position: 'Project Manager',
        salary: 130000,
        home: 'Lavington',
        kin: 'PM Family',
        kra: 'A000000006X',
        bank: 'KES-PM-001',
      },
      'hr@cresdynamics.local': {
        position: 'HR Officer',
        salary: 105000,
        home: 'South B',
        kin: 'HR Desk',
        kra: 'A000000007X',
        bank: 'KES-HR-001',
      },
    };

    const onboardMonth = (() => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - 3);
      return d.toISOString().slice(0, 7);
    })();
    const thisMonth = new Date().toISOString().slice(0, 7);

    for (const [email, meta] of Object.entries(STAFF_EMPLOYEE_META)) {
      const { rows: urows } = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
      if (!urows[0]) continue;
      const { rows: empRows } = await client.query(
        `INSERT INTO employees (
           user_id, position, salary_amount, pay_cycle,
           home_address, next_of_kin, kra_pin, bank_account, created_at
         )
         VALUES ($1, $2, $3, 'monthly', $4, $5, $6, $7, ($8 || '-01')::date)
         ON CONFLICT (user_id) DO UPDATE SET
           position = EXCLUDED.position,
           salary_amount = EXCLUDED.salary_amount,
           home_address = COALESCE(employees.home_address, EXCLUDED.home_address),
           next_of_kin = COALESCE(employees.next_of_kin, EXCLUDED.next_of_kin),
           kra_pin = COALESCE(employees.kra_pin, EXCLUDED.kra_pin),
           bank_account = COALESCE(employees.bank_account, EXCLUDED.bank_account)
         RETURNING id, salary_amount, created_at`,
        [
          urows[0].id,
          meta.position,
          meta.salary,
          meta.home,
          meta.kin,
          meta.kra,
          meta.bank,
          onboardMonth,
        ]
      );
      const emp = empRows[0];
      // Backfill payroll months from onboarding → current
      let cur = onboardMonth;
      while (cur <= thisMonth) {
        await client.query(
          `INSERT INTO salary_payments (employee_id, month, amount_expected, status)
           VALUES ($1, $2, $3, 'owed')
           ON CONFLICT (employee_id, month) DO NOTHING`,
          [emp.id, cur, emp.salary_amount]
        );
        const [y, m] = cur.split('-').map(Number);
        const nd = new Date(Date.UTC(y, m - 1 + 1, 1));
        cur = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}`;
      }
    }

    // Seed a default operating account (Finance/Admin only)
    const { rows: bal } = await client.query('SELECT id FROM account_balances LIMIT 1');
    if (bal.length === 0) {
      await client.query(
        `INSERT INTO account_balances (label, balance) VALUES ('Operating Account', 0)`
      );
    }

    // Link demo client user to a clients row (portal access)
    const { rows: clientUsers } = await client.query(
      `SELECT id, email FROM users WHERE email = 'client@cresdynamics.local'`
    );
    if (clientUsers[0]) {
      let clientId;
      const { rows: existingClient } = await client.query(
        `SELECT id FROM clients WHERE email = $1 OR user_id = $2 LIMIT 1`,
        [clientUsers[0].email, clientUsers[0].id]
      );
      if (existingClient[0]) {
        clientId = existingClient[0].id;
        await client.query(
          `UPDATE clients SET user_id = $1, email = $2 WHERE id = $3`,
          [clientUsers[0].id, clientUsers[0].email, clientId]
        );
      } else {
        // Prefer linking an existing CRM client row if present
        const { rows: anyClient } = await client.query(
          `SELECT id FROM clients ORDER BY created_at ASC LIMIT 1`
        );
        if (anyClient[0]) {
          clientId = anyClient[0].id;
          await client.query(
            `UPDATE clients SET user_id = $1, email = COALESCE(email, $2) WHERE id = $3`,
            [clientUsers[0].id, clientUsers[0].email, clientId]
          );
        } else {
          const { rows: created } = await client.query(
            `INSERT INTO clients (name, email, phone, business_name, user_id)
             VALUES ('Acme Co', $1, '+10000000008', 'Acme Co Ltd', $2)
             RETURNING id`,
            [clientUsers[0].email, clientUsers[0].id]
          );
          clientId = created[0].id;
        }
      }
    }

    await client.query('COMMIT');
    console.log('[seed] roles, permissions, and demo users ready');
    console.log(`[seed] default password for demo users: ${DEFAULT_PASSWORD}`);
    console.log('[seed] client portal: client@cresdynamics.local');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  seed().catch(() => process.exit(1));
}

module.exports = { seed, ROLE_PERMS, MESSAGING_MATRIX: null };
