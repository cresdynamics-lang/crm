const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { INTERNAL_CATEGORIES, expenseClass } = require('../lib/expenseClasses');

const router = express.Router();
router.use(authenticate);

/** One row per id — live copies without PKs used to double every total. */
const uniq = (table) => `(SELECT DISTINCT ON (id) * FROM ${table} ORDER BY id)`;

function requireFinanceAdmin(req) {
  if (!['finance', 'admin'].includes(req.user.role)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

/**
 * Admin Finance overview: project figures, health, this-month revenue/expenses.
 */
router.get(
  '/overview',
  requireAnyPermission([['cash_flow', 'view'], ['account_balance', 'view'], ['invoices', 'view']]),
  asyncHandler(async (req, res) => {
    requireFinanceAdmin(req);

    const { rows: balances } = await query(
      `SELECT id, label, balance, updated_at FROM ${uniq('account_balances')} account_balances ORDER BY label`
    );
    const accountBalance = balances.reduce((s, b) => s + Number(b.balance), 0);

    const { rows: monthRev } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total
       FROM ${uniq('payments')} payments
       WHERE paid_at >= date_trunc('month', CURRENT_DATE)`
    );
    const { rows: monthExpRows } = await query(
      `SELECT category, COALESCE(SUM(amount),0)::float AS total
       FROM ${uniq('expenses')} expenses
       WHERE approval_status = 'approved'
         AND COALESCE(approved_at, created_at) >= date_trunc('month', CURRENT_DATE)
       GROUP BY category`
    );
    const { rows: allExpRows } = await query(
      `SELECT category, COALESCE(SUM(amount),0)::float AS total
       FROM ${uniq('expenses')} expenses
       WHERE approval_status = 'approved'
       GROUP BY category`
    );

    function splitExpenses(rows) {
      const internal = { total: 0, byCategory: [] };
      const external = { total: 0, byCategory: [] };
      for (const r of rows) {
        const bucket = expenseClass(r.category) === 'internal' ? internal : external;
        bucket.total += Number(r.total || 0);
        bucket.byCategory.push({ category: r.category, total: Number(r.total || 0) });
      }
      internal.byCategory.sort((a, b) => b.total - a.total);
      external.byCategory.sort((a, b) => b.total - a.total);
      return { internal, external, total: internal.total + external.total };
    }

    const expensesThisMonth = splitExpenses(monthExpRows);
    const expensesAllTime = splitExpenses(allExpRows);
    const revenueThisMonth = Number(monthRev[0].total || 0);

    const { rows: outstanding } = await query(
      `SELECT COALESCE(SUM(GREATEST(amount - COALESCE(amount_paid,0), 0)),0)::float AS total
       FROM ${uniq('invoices')} invoices WHERE status IN ('issued','overdue','partially_paid')`
    );
    const { rows: billed } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS invoiced,
              COALESCE(SUM(COALESCE(amount_paid,0)),0)::float AS paid
       FROM ${uniq('invoices')} invoices`
    );
    const { rows: overdueCount } = await query(
      `SELECT COUNT(*)::int AS count FROM ${uniq('invoices')} invoices WHERE status = 'overdue'`
    );
    const invoiced = Number(billed[0].invoiced || 0);
    const paid = Number(billed[0].paid || 0);
    const outstandingTotal = Number(outstanding[0].total || 0);
    const collectionRate = invoiced > 0 ? paid / invoiced : 1;
    const netThisMonth = revenueThisMonth - expensesThisMonth.total;

    let health = 'healthy';
    if (overdueCount[0].count >= 3 || netThisMonth < 0 || collectionRate < 0.45) health = 'tight';
    else if (overdueCount[0].count > 0 || collectionRate < 0.7 || outstandingTotal > revenueThisMonth) {
      health = 'watch';
    }

    const { rows: projects } = await query(
      `SELECT p.id, p.name, p.status, p.value_amount,
              c.name AS client_name, c.business_name AS client_business,
              COALESCE(SUM(i.amount), 0)::float AS invoiced,
              COALESCE(SUM(COALESCE(i.amount_paid, 0)), 0)::float AS paid,
              COALESCE(SUM(GREATEST(i.amount - COALESCE(i.amount_paid, 0), 0)), 0)::float AS balance
       FROM ${uniq('projects')} p
       LEFT JOIN ${uniq('clients')} c ON c.id = p.client_id
       LEFT JOIN ${uniq('invoices')} i ON i.project_id = p.id
       WHERE p.status NOT IN ('pending_approval', 'rejected')
         AND p.deleted_at IS NULL
       GROUP BY p.id, p.name, p.status, p.value_amount, c.name, c.business_name
       ORDER BY p.name ASC`
    );

    res.json({
      ok: true,
      data: {
        monthLabel: new Date().toLocaleString('en-KE', { month: 'long', year: 'numeric' }),
        kpis: {
          accountBalance,
          revenueThisMonth,
          expensesThisMonth: expensesThisMonth.total,
          internalThisMonth: expensesThisMonth.internal.total,
          externalThisMonth: expensesThisMonth.external.total,
          netThisMonth,
          outstanding: outstandingTotal,
          invoiced,
          paid,
          collectionRate,
          overdueCount: overdueCount[0].count,
          projectCount: projects.length,
        },
        health,
        expensesThisMonth,
        expensesAllTime,
        internalCategories: INTERNAL_CATEGORIES,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          client_name: p.client_name,
          client_business: p.client_business,
          value_amount: p.value_amount != null ? Number(p.value_amount) : null,
          invoiced: Number(p.invoiced || 0),
          paid: Number(p.paid || 0),
          balance: Number(p.balance || 0),
        })),
        balances,
      },
    });
  })
);

/**
 * Full money-health dashboard - Finance + Admin ONLY.
 * Director cannot hit this (no cash_flow / account_balance).
 */
router.get(
  '/dashboard',
  requireAnyPermission([['cash_flow', 'view'], ['account_balance', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows: balances } = await query(
      `SELECT id, label, balance, updated_at FROM ${uniq('account_balances')} account_balances ORDER BY label`
    );
    const totalBalance = balances.reduce((s, b) => s + Number(b.balance), 0);

    const { rows: paid } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM ${uniq('payments')} payments`
    );
    const { rows: exp } = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM ${uniq('expenses')} expenses WHERE approval_status = 'approved'`
    );
    const { rows: outstanding } = await query(
      `SELECT COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS total
       FROM ${uniq('invoices')} invoices WHERE status IN ('issued','overdue','partially_paid')`
    );
    const { rows: issuedCount } = await query(
      `SELECT COUNT(*)::int AS count FROM ${uniq('invoices')} invoices WHERE status = 'issued'`
    );
    const { rows: overdueCount } = await query(
      `SELECT COUNT(*)::int AS count FROM ${uniq('invoices')} invoices WHERE status = 'overdue'`
    );
    const { rows: pendingFinanceExp } = await query(
      `SELECT COUNT(*)::int AS count FROM ${uniq('expenses')} expenses
       WHERE approval_status IN ('pending_finance', 'pending')`
    );
    const { rows: pendingFinanceFund } = await query(
      `SELECT COUNT(*)::int AS count FROM ${uniq('salary_funding_requests')} salary_funding_requests
       WHERE status = 'pending_finance'`
    );

    // Cash flow by month (last 6): payments in vs expenses out
    const { rows: monthly } = await query(
      `SELECT m.month,
              COALESCE(p.in_amount, 0)::float AS money_in,
              COALESCE(e.out_amount, 0)::float AS money_out
       FROM (
         SELECT to_char(d, 'YYYY-MM') AS month
         FROM generate_series(
           date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
           date_trunc('month', CURRENT_DATE),
           INTERVAL '1 month'
         ) d
       ) m
       LEFT JOIN (
         SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
                SUM(amount) AS in_amount
         FROM ${uniq('payments')} payments
         GROUP BY 1
       ) p ON p.month = m.month
       LEFT JOIN (
         SELECT to_char(date_trunc('month', COALESCE(approved_at, created_at)), 'YYYY-MM') AS month,
                SUM(amount) AS out_amount
         FROM ${uniq('expenses')} expenses
         WHERE approval_status = 'approved'
         GROUP BY 1
       ) e ON e.month = m.month
       ORDER BY m.month`
    );

    const cashLabels = [];
    const cashIn = [];
    const cashOut = [];
    for (const row of monthly) {
      const [y, mo] = row.month.split('-');
      const d = new Date(Number(y), Number(mo) - 1, 1);
      cashLabels.push(d.toLocaleString(undefined, { month: 'short' }));
      cashIn.push(row.money_in);
      cashOut.push(row.money_out);
    }

    // Revenue by project (paid + issued amounts on invoices)
    const { rows: byProject } = await query(
      `SELECT COALESCE(p.name, 'Unlinked') AS label,
              COALESCE(SUM(i.amount),0)::float AS total
       FROM ${uniq('invoices')} i
       LEFT JOIN ${uniq('projects')} p ON p.id = i.project_id
       GROUP BY COALESCE(p.name, 'Unlinked')
       ORDER BY total DESC
       LIMIT 8`
    );

    // Expense breakdown by category
    const { rows: byCategory } = await query(
      `SELECT category AS label, COALESCE(SUM(amount),0)::float AS total
       FROM ${uniq('expenses')} expenses
       WHERE approval_status = 'approved'
       GROUP BY category
       ORDER BY total DESC`
    );

    const { rows: notifications } = await query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.id]
    );

    res.json({
      ok: true,
      data: {
        kpis: {
          accountBalance: totalBalance,
          revenue: paid[0].total,
          expenses: exp[0].total,
          netCash: paid[0].total - exp[0].total,
          outstanding: outstanding[0].total,
          issuedCount: issuedCount[0].count,
          overdueCount: overdueCount[0].count,
          pendingApprovals:
            (pendingFinanceExp[0]?.count || 0) + (pendingFinanceFund[0]?.count || 0),
          pendingExpenses: pendingFinanceExp[0]?.count || 0,
          pendingSalaryFunding: pendingFinanceFund[0]?.count || 0,
        },
        balances,
        cashFlowChart: { labels: cashLabels, moneyIn: cashIn, moneyOut: cashOut },
        revenueByProject: {
          labels: byProject.map((r) => r.label),
          values: byProject.map((r) => r.total),
        },
        expenseBreakdown: {
          labels: byCategory.map((r) => r.label),
          values: byCategory.map((r) => r.total),
        },
        notifications,
      },
    });
  })
);

/**
 * Finance-wise project list: value, invoice, paid, balance — no create/edit workflow.
 */
router.get(
  '/projects',
  requirePermission('projects', 'view'),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `SELECT p.id, p.name, p.status, p.value_amount, p.client_id, p.created_at, p.updated_at,
              p.assigned_developer_id,
              c.name AS client_name, c.business_name AS client_business,
              c.email AS client_email, c.phone AS client_phone,
              u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone,
              d.name AS developer_name,
              i.id AS invoice_id, i.amount AS invoice_amount, i.amount_paid,
              i.status AS invoice_status, i.due_date, i.penalty_count,
              (COALESCE(i.amount, 0) - COALESCE(i.amount_paid, 0))::float AS balance_due,
              p.suspended_at, p.suspend_reason
       FROM ${uniq('projects')} p
       LEFT JOIN ${uniq('clients')} c ON c.id = p.client_id
       LEFT JOIN ${uniq('users')} u ON u.id = p.created_by
       LEFT JOIN ${uniq('users')} d ON d.id = p.assigned_developer_id
       LEFT JOIN LATERAL (
         SELECT inv.*
         FROM ${uniq('invoices')} inv
         WHERE inv.project_id = p.id
         ORDER BY inv.created_at DESC
         LIMIT 1
       ) i ON TRUE
       WHERE p.status NOT IN ('pending_approval', 'rejected')
         AND p.deleted_at IS NULL
       ORDER BY
         CASE WHEN i.status = 'overdue' THEN 0
              WHEN i.status IN ('issued', 'partially_paid') THEN 1
              WHEN i.status = 'paid' THEN 2
              ELSE 3 END,
         p.updated_at DESC`
    );

    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        client_id: r.client_id,
        value_amount: r.value_amount != null ? Number(r.value_amount) : null,
        client_name: r.client_name,
        client_business: r.client_business,
        client_email: r.client_email,
        client_phone: r.client_phone,
        owner_name: r.owner_name,
        owner_email: r.owner_email,
        owner_phone: r.owner_phone,
        developer_name: r.developer_name,
        invoice_id: r.invoice_id,
        invoice_amount: r.invoice_amount != null ? Number(r.invoice_amount) : null,
        amount_paid: r.amount_paid != null ? Number(r.amount_paid) : 0,
        invoice_status: r.invoice_status,
        due_date: r.due_date,
        penalty_count: Number(r.penalty_count || 0),
        balance_due: Number(r.balance_due || 0),
        suspended_at: r.suspended_at,
        suspend_reason: r.suspend_reason,
        updated_at: r.updated_at,
      })),
    });
  })
);

/**
 * Full financial cash-flow report: money in/out across projects, clients, accounts.
 */
router.get(
  '/cash-flow-report',
  requireAnyPermission([['cash_flow', 'view'], ['account_balance', 'view']]),
  asyncHandler(async (req, res) => {
    if (!['finance', 'admin'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const { buildCashFlowReport } = require('../services/cashFlowReport');
    const data = await buildCashFlowReport({
      date_from: req.query.date_from,
      date_to: req.query.date_to,
    });
    res.json({ ok: true, data });
  })
);

// ─── Website event payments (live from website DB, read-only) ───
const { wQuery, wQueryRows, respondIfDisconnected } = require('../config/websiteDb');
const { enqueue } = require('../queues');

const EAT = 'Africa/Nairobi';

async function ensureFinanceFor(req) {
  if (!['finance', 'admin'].includes(req.user.role)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

router.get(
  '/website-payments',
  requireAnyPermission([['cash_flow', 'view'], ['payments', 'view']]),
  asyncHandler(async (req, res) => {
    await ensureFinanceFor(req);
    if (
      await respondIfDisconnected(res, {
        payments: [],
        summary: { paidCount: 0, paidPeople: 0, latestPayment: null },
        currency: 'KES',
      })
    ) {
      return;
    }
    const { status, event, from, to } = req.query;
    const conds = ["booking_status = 'paid'"];
    const params = [];
    if (event) { params.push(event); conds.push(`event_title = $${params.length}`); }
    if (from) { params.push(from); conds.push(`paid_at >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`paid_at <= $${params.length}`); }

    const rows = await wQueryRows(
      `SELECT id, event_title, event_date, first_name, last_name, email, phone, company,
              ticket_type, attendance_type, lanyard_category, paid_at, paid_by, paid_source,
              ticket_number, created_at,
              to_char(paid_at AT TIME ZONE '${EAT}', 'YYYY-MM-DD HH24:MI') AS paid_at_eat
       FROM event_reservations
       WHERE ${conds.join(' AND ')}
       ORDER BY paid_at DESC, id DESC
       LIMIT 500`,
      params
    );

    const { rows: totals } = await wQuery(
      `SELECT COUNT(*)::bigint AS paid_count,
              COUNT(DISTINCT email)::bigint AS paid_people,
              MAX(paid_at) AS latest_payment
       FROM event_reservations WHERE booking_status = 'paid'`
    );

    // Emailed markers (CRM-side log, never written to website DB)
    const { rows: emailedRows } = await query(
      `SELECT DISTINCT ON (reservation_id) reservation_id, status, sent_at
       FROM website_payer_emails ORDER BY reservation_id, id DESC`
    );
    const emailedBy = Object.fromEntries(emailedRows.map((e) => [String(e.reservation_id), e]));

    res.json({
      ok: true,
      data: {
        asOf: new Date().toISOString(),
        timezone: EAT,
        currency: 'KES',
        summary: {
          paidCount: Number(totals[0].paid_count),
          paidPeople: Number(totals[0].paid_people),
          latestPayment: totals[0].latest_payment,
        },
        payments: rows.map((r) => ({
          id: r.id,
          eventTitle: r.event_title,
          eventDate: r.event_date,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '-',
          email: r.email,
          phone: r.phone || '',
          company: r.company || '',
          ticketType: r.ticket_type || '-',
          attendanceType: r.attendance_type || '',
          lanyardCategory: r.lanyard_category || '',
          paidAtEat: r.paid_at_eat,
          paidAt: r.paid_at,
          paidBy: r.paid_by || '',
          paidSource: r.paid_source || 'manual',
          ticketNumber: r.ticket_number || '',
          currency: 'KES',
          emailed: Boolean(emailedBy[r.id]?.status === 'sent'),
          emailedAt: emailedBy[r.id]?.sent_at || null,
        })),
      },
    });
  })
);

router.post(
  '/website-payments/:id/email',
  requireAnyPermission([['cash_flow', 'view'], ['payments', 'view']]),
  asyncHandler(async (req, res) => {
    await ensureFinanceFor(req);
    const { websiteDbAvailable } = require('../config/websiteDb');
    const dbStatus = await websiteDbAvailable();
    if (dbStatus.status !== 'up') {
      throw new AppError('Not connected yet — website database is not available.', 503, 'NOT_CONNECTED');
    }
    const { subject, message } = req.body;
    if (!message?.trim()) {
      throw new AppError('message is required', 400, 'VALIDATION');
    }

    const payers = await wQueryRows(
      `SELECT id, first_name, last_name, email, phone, event_title, ticket_type, ticket_number
       FROM event_reservations WHERE id = $1 AND booking_status = 'paid'`,
      [req.params.id]
    );
    const payer = payers[0];
    if (!payer) throw new AppError('Paid registration not found', 404, 'NOT_FOUND');
    if (!payer.email) throw new AppError('Payer has no email address', 400, 'VALIDATION');

    await enqueue('email', 'site.payer-contact', {
      reservationId: payer.id,
      to: payer.email,
      name: [payer.first_name, payer.last_name].filter(Boolean).join(' ') || 'there',
      subject: subject?.trim() || `Your reservation — ${payer.event_title}`,
      message: message.trim(),
      context: {
        event_title: payer.event_title,
        ticket_type: payer.ticket_type,
        ticket_number: payer.ticket_number,
      },
      sentBy: { id: req.user.id, name: req.user.name, role: req.user.role },
    });

    res.status(202).json({ ok: true, queued: true, to: payer.email });
  })
);

/**
 * Finance suspends a project (non-payment / collections). Delivery pauses.
 */
router.post(
  '/projects/:id/suspend',
  requirePermission('invoices', 'edit'),
  asyncHandler(async (req, res) => {
    requireFinanceAdmin(req);
    const { suspendProject } = require('../services/projectSuspend');
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');
    if (rows[0].status === 'suspended') {
      return res.json({ ok: true, data: rows[0], already: true });
    }
    const updated = await suspendProject({
      projectId: req.params.id,
      actorUserId: req.user.id,
      actorRole: req.user.role,
      reason: req.body?.reason || 'Suspended by Finance',
      source: 'finance',
    });
    if (!updated) {
      throw new AppError(
        'This project cannot be suspended (completed, rejected, or not yet approved)',
        409,
        'INVALID_STATE'
      );
    }
    res.json({ ok: true, data: updated });
  })
);

/**
 * Finance resumes a suspended project after payment or agreement.
 */
router.post(
  '/projects/:id/unsuspend',
  requirePermission('invoices', 'edit'),
  asyncHandler(async (req, res) => {
    requireFinanceAdmin(req);
    const { unsuspendProject } = require('../services/projectSuspend');
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new AppError('Project not found', 404, 'NOT_FOUND');
    if (rows[0].status !== 'suspended') {
      throw new AppError('Project is not suspended', 409, 'INVALID_STATE');
    }
    const updated = await unsuspendProject({
      projectId: req.params.id,
      actorUserId: req.user.id,
      actorRole: req.user.role,
      note: req.body?.note || 'Resumed by Finance',
    });
    res.json({ ok: true, data: updated });
  })
);

module.exports = router;
