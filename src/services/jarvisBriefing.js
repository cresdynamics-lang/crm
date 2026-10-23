/**
 * Role-scoped company snapshot for Jarvis.
 * Admin: full operations + full finance.
 * Director: operations (logins, work, HR, sales, PM, dev updates) plus
 * pending invoices and stamped/cleared payment receipts only — never
 * balances, cash flow, expense books, or payroll totals.
 */
const { query } = require('../config/database');

function money(n) {
  const num = Number(n) || 0;
  return Math.round(num * 100) / 100;
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[jarvisBriefing] ${label}:`, err.message);
    return { error: `${label} unavailable` };
  }
}

async function gatherCompanyBrief(user) {
  const role = user?.role;
  if (!['admin', 'director'].includes(role)) {
    return { error: 'Not allowed for this role.' };
  }
  const fullFinance = role === 'admin';

  const [
    logins,
    actions,
    sales,
    projects,
    developers,
    hr,
    reports,
    pendingInvoices,
    receipts,
    finance,
  ] = await Promise.all([
    safe('logins', recentLogins),
    safe('actions', recentActions),
    safe('sales', salesSnapshot),
    safe('projects', projectSnapshot),
    safe('developers', developerUpdates),
    safe('hr', () => hrSnapshot(fullFinance)),
    safe('reports', recentReports),
    safe('pendingInvoices', pendingInvoiceSnapshot),
    safe('receipts', clearedReceipts),
    fullFinance ? safe('finance', fullFinanceSnapshot) : Promise.resolve(null),
  ]);

  const brief = {
    audience: role,
    financeScope:
      role === 'admin'
        ? 'full'
        : 'pending_invoices_and_cleared_receipts_only',
    logins,
    recentActions: actions,
    sales,
    projects,
    developerUpdates: developers,
    hr,
    dailyReports: reports,
    pendingInvoices,
    clearedReceipts: receipts,
  };

  if (fullFinance) {
    brief.finance = finance;
  } else {
    brief.financeNote =
      'Director may only be told about pending/overdue invoices and stamped receipts for payments that have been recorded and cleared. Do not mention account balances, cash flow, expense totals, or payroll figures.';
  }

  return brief;
}

async function recentLogins() {
  const { rows } = await query(
    `SELECT la.created_at, la.email, la.success, la.ip,
            u.name AS user_name, r.name AS role
     FROM login_audit la
     LEFT JOIN users u ON u.id = la.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY la.created_at DESC
     LIMIT 30`
  );
  return rows;
}

async function recentActions() {
  const { rows } = await query(
    `SELECT a.created_at, a.action, a.resource_type, a.summary,
            u.name AS actor_name, a.actor_role
     FROM action_audit_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC
     LIMIT 40`
  );
  return rows;
}

async function salesSnapshot() {
  const { rows: pipeline } = await query(
    `SELECT status, COUNT(DISTINCT id)::int AS count
     FROM leads
     GROUP BY status
     ORDER BY count DESC`
  );
  const { rows: today } = await query(
    `SELECT COUNT(DISTINCT id)::int AS new_today
     FROM leads
     WHERE created_at::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::date`
  );
  const { rows: recent } = await query(
    `SELECT DISTINCT ON (l.id) l.name, l.business_name, l.status, l.updated_at, u.name AS owner
     FROM leads l
     LEFT JOIN users u ON u.id = l.created_by
     ORDER BY l.id, l.updated_at DESC`
  );
  recent.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return {
    byStatus: pipeline,
    newToday: today[0]?.new_today || 0,
    recent: recent.slice(0, 12),
  };
}

async function projectSnapshot() {
  const { rows: byStatus } = await query(
    `SELECT status, COUNT(DISTINCT id)::int AS count
     FROM projects
     GROUP BY status
     ORDER BY count DESC`
  );
  const { rows: recent } = await query(
    `SELECT DISTINCT ON (p.id)
            p.name, p.status, p.updated_at,
            c.name AS client_name,
            d.name AS developer_name,
            pm.name AS created_by_name
     FROM projects p
     LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN users d ON d.id = p.assigned_developer_id
     LEFT JOIN users pm ON pm.id = p.created_by
     ORDER BY p.id, p.updated_at DESC`
  );
  recent.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return { byStatus, recent: recent.slice(0, 15) };
}

async function developerUpdates() {
  const { rows } = await query(
    `SELECT pu.created_at,
            COALESCE(pu.change_summary, pu.note, pu.milestone_status) AS summary,
            pu.milestone_status,
            us.name AS developer_name,
            COALESCE(pu.actor_role, r.name) AS role,
            pr.name AS project_name
     FROM project_updates pu
     JOIN users us ON us.id = pu.updated_by
     LEFT JOIN roles r ON r.id = us.role_id
     JOIN projects pr ON pr.id = pu.project_id
     ORDER BY pu.created_at DESC
     LIMIT 25`
  );
  return rows;
}

async function hrSnapshot(includePayroll) {
  const { rows: headcount } = await query(
    `SELECT r.name AS role, COUNT(DISTINCT u.id)::int AS count
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active'
     GROUP BY r.name
     ORDER BY r.name`
  );
  const { rows: leave } = await query(
    `SELECT lr.status, lr.start_date, lr.end_date, lr.leave_type,
            u.name AS employee_name
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id
     JOIN users u ON u.id = e.user_id
     WHERE lr.status IN ('pending', 'approved')
       AND lr.end_date >= CURRENT_DATE
     ORDER BY lr.start_date
     LIMIT 20`
  );
  const { rows: applicants } = await query(
    `SELECT name, role_applied, stage, interview_date, created_at
     FROM applicants
     WHERE stage NOT IN ('rejected', 'hired')
     ORDER BY created_at DESC
     LIMIT 15`
  ).catch(() => ({ rows: [] }));

  const { rows: attendance } = await query(
    `SELECT u.name, r.name AS role, ra.submitted, ra.report_date
     FROM report_attendance ra
     JOIN users u ON u.id = ra.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE ra.report_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::date
     ORDER BY u.name`
  ).catch(() => ({ rows: [] }));

  const out = {
    headcount,
    leaveOpen: leave,
    applicantsOpen: applicants,
    attendanceToday: attendance,
  };

  if (includePayroll) {
    const month = new Date().toISOString().slice(0, 7);
    const { rows: pay } = await query(
      `SELECT COUNT(DISTINCT id)::int AS rows,
              COALESCE(SUM(amount_expected),0)::float AS expected,
              COALESCE(SUM(amount_paid),0)::float AS paid
       FROM salary_payments
       WHERE month = $1`,
      [month]
    );
    out.payrollThisMonth = {
      month,
      expected: money(pay[0]?.expected),
      paid: money(pay[0]?.paid),
    };
  }

  return out;
}

async function recentReports() {
  const { rows } = await query(
    `SELECT dr.created_at, u.name AS author, r.name AS role,
            LEFT(COALESCE(dr.work_done, dr.content, dr.remarks, ''), 280) AS excerpt,
            p.name AS project_name
     FROM daily_reports dr
     JOIN users u ON u.id = dr.user_id
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN projects p ON p.id = dr.project_id
     WHERE dr.created_at >= NOW() - INTERVAL '3 days'
     ORDER BY dr.created_at DESC
     LIMIT 20`
  );
  return rows;
}

async function pendingInvoiceSnapshot() {
  const { rows } = await query(
    `SELECT DISTINCT ON (i.id)
            i.id, i.invoice_number, i.status, i.due_date,
            i.amount::float AS amount,
            COALESCE(i.amount_paid, 0)::float AS amount_paid,
            (COALESCE(i.amount,0) - COALESCE(i.amount_paid,0))::float AS outstanding,
            c.name AS client_name, p.name AS project_name
     FROM invoices i
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.status IN ('issued', 'overdue', 'partially_paid')
     ORDER BY i.id, i.created_at DESC`
  );
  rows.sort((a, b) => Number(b.outstanding) - Number(a.outstanding));
  return rows.slice(0, 25).map((r) => ({
    ...r,
    amount: money(r.amount),
    amount_paid: money(r.amount_paid),
    outstanding: money(r.outstanding),
  }));
}

async function clearedReceipts() {
  const { rows } = await query(
    `SELECT DISTINCT ON (pay.id)
            pay.id,
            pay.amount::float AS amount,
            pay.paid_at,
            pay.bank_reference,
            pay.method,
            i.invoice_number,
            i.status AS invoice_status,
            c.name AS client_name,
            pr.name AS project_name,
            rec.name AS recorded_by
     FROM payments pay
     JOIN invoices i ON i.id = pay.invoice_id
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN projects pr ON pr.id = i.project_id
     LEFT JOIN users rec ON rec.id = pay.recorded_by
     ORDER BY pay.id, pay.paid_at DESC`
  );
  rows.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));
  return rows.slice(0, 25).map((r) => ({
    receiptStamp: r.bank_reference || r.invoice_number || r.id,
    amount: money(r.amount),
    paid_at: r.paid_at,
    method: r.method || null,
    invoice_number: r.invoice_number,
    invoice_status: r.invoice_status,
    client_name: r.client_name,
    project_name: r.project_name,
    recorded_by: r.recorded_by,
  }));
}

async function fullFinanceSnapshot() {
  const { rows: balances } = await query(
    `SELECT label, balance::float AS balance FROM account_balances ORDER BY label`
  ).catch(() => ({ rows: [] }));
  const { rows: monthRev } = await query(
    `SELECT COALESCE(SUM(amount),0)::float AS total
     FROM payments
     WHERE paid_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')`
  );
  const { rows: monthExp } = await query(
    `SELECT COALESCE(SUM(amount),0)::float AS total
     FROM expenses
     WHERE approval_status = 'approved'
       AND COALESCE(approved_at, created_at) >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')`
  );
  const { rows: pendingExp } = await query(
    `SELECT COUNT(DISTINCT id)::int AS count, COALESCE(SUM(amount),0)::float AS total
     FROM expenses
     WHERE approval_status IN ('pending', 'pending_finance', 'pending_admin')`
  );
  return {
    accountBalances: balances.map((b) => ({ label: b.label, balance: money(b.balance) })),
    thisMonthRevenue: money(monthRev[0]?.total),
    thisMonthExpenses: money(monthExp[0]?.total),
    pendingExpenses: { count: pendingExp[0]?.count || 0, total: money(pendingExp[0]?.total) },
  };
}

module.exports = { gatherCompanyBrief };
