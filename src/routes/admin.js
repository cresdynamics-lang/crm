const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { enqueue, getQueues } = require('../queues');
const config = require('../config');
const { buildDailyDigest } = require('../services/dailyOpsDigest');

const router = express.Router();
router.use(authenticate);

function assertAdmin(req) {
  if (req.user.role !== 'admin') {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

const DEFAULT_SETTINGS = {
  notification_rules: {
    notifyPmOnDailyReport: true,
    notifyDirectorOnForward: true,
    notifyFinanceOnSalarySettle: true,
    notifyDevOnProjectApprove: true,
  },
  email_templates: {
    invoice_issued: {
      subject: 'Your invoice from Cres Dynamics',
      body: 'Hello,\n\nYour invoice {{invoiceId}} for {{amount}} has been issued.\n\nThank you,\nCres Dynamics',
    },
    password_reset: {
      subject: 'Cres Dynamics password reset code',
      body: 'Hi {{name}},\n\nYour password reset code is: {{code}}\n\nIt expires in 10 minutes.',
    },
  },
  email_automations: {
    invoiceIssued: true,
    paymentReceipt: true,
    overdueReminder: true,
    overduePenalty: true,
    overdueFollowup: true,
    userInvite: true,
    leadMessage: true,
  },
  integrations: {
    email: {
      primaryProvider: config.email.primary,
      fallbackProvider: config.email.fallback,
      from: config.email.from,
    },
    mpesa: {
      enabled: false,
      shortcode: '',
      environment: 'sandbox',
      note: 'Configure when M-Pesa credentials are available',
    },
  },
};

async function ensureSystemDefaults() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(
      `INSERT INTO system_settings (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
}

/**
 * Cross-department overview - every KPI surface Admin is entitled to see.
 */
router.get(
  '/dashboard',
  requirePermission('query', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);

    const [
      leadsToday,
      openLeads,
      activeProjects,
      pendingApproval,
      overdueProjects,
      dueSoon,
      accountBal,
      revenue,
      expenses,
      outstanding,
      salaryExpected,
      salaryOwed,
      salarySettled,
      pendingReports,
      failedJobs,
      cashFlow,
      health,
    ] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count FROM leads WHERE created_at::date = CURRENT_DATE`),
      query(`SELECT COUNT(*)::int AS count FROM leads WHERE status IN ('new','contacting','follow_up')`),
      query(`SELECT COUNT(*)::int AS count FROM projects WHERE status IN ('approved','in_progress','blocked')`),
      query(`SELECT COUNT(*)::int AS count FROM projects WHERE status = 'pending_approval'`),
      query(
        `SELECT COUNT(*)::int AS count FROM projects p
         WHERE p.status IN ('approved','in_progress','blocked')
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(p.milestones) m
             WHERE COALESCE(m->>'status','') <> 'completed'
               AND NULLIF(m->>'due_date','') IS NOT NULL
               AND (m->>'due_date')::date < CURRENT_DATE
           )`
      ),
      query(
        `SELECT COUNT(*)::int AS count FROM projects p
         WHERE p.status IN ('approved','in_progress','blocked')
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(p.milestones) m
             WHERE COALESCE(m->>'status','') <> 'completed'
               AND NULLIF(m->>'due_date','') IS NOT NULL
               AND (m->>'due_date')::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
           )`
      ),
      query(`SELECT COALESCE(SUM(balance),0)::float AS total FROM account_balances`),
      query(`SELECT COALESCE(SUM(amount),0)::float AS total FROM payments`),
      query(`SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses`),
      query(`SELECT COALESCE(SUM(amount),0)::float AS total FROM invoices WHERE status IN ('issued','overdue')`),
      query(
        `SELECT COALESCE(SUM(amount_expected),0)::float AS total
         FROM salary_payments WHERE month = to_char(CURRENT_DATE, 'YYYY-MM')`
      ),
      query(
        `SELECT COALESCE(SUM(amount_expected - amount_paid),0)::float AS total
         FROM salary_payments
         WHERE month = to_char(CURRENT_DATE, 'YYYY-MM') AND status = 'owed'`
      ),
      query(
        `SELECT COALESCE(SUM(amount_paid),0)::float AS total
         FROM salary_payments
         WHERE month = to_char(CURRENT_DATE, 'YYYY-MM') AND status = 'settled'`
      ),
      query(`SELECT COUNT(*)::int AS count FROM daily_reports WHERE routing_status = 'pending_pm'`),
      query(`SELECT COUNT(*)::int AS count FROM failed_jobs`),
      query(
        `SELECT to_char(d, 'YYYY-MM') AS month
         FROM generate_series(
           date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
           date_trunc('month', CURRENT_DATE),
           INTERVAL '1 month'
         ) d`
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('approved','in_progress','blocked')
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(milestones) m
               WHERE COALESCE(m->>'status','') <> 'completed'
                 AND NULLIF(m->>'due_date','') IS NOT NULL
                 AND (m->>'due_date')::date < CURRENT_DATE
             )
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(milestones) m
               WHERE COALESCE(m->>'status','') <> 'completed'
                 AND NULLIF(m->>'due_date','') IS NOT NULL
                 AND (m->>'due_date')::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
             )
           )::int AS on_track,
           COUNT(*) FILTER (WHERE status IN ('approved','in_progress','blocked')
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(milestones) m
               WHERE COALESCE(m->>'status','') <> 'completed'
                 AND NULLIF(m->>'due_date','') IS NOT NULL
                 AND (m->>'due_date')::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
             )
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(milestones) m
               WHERE COALESCE(m->>'status','') <> 'completed'
                 AND NULLIF(m->>'due_date','') IS NOT NULL
                 AND (m->>'due_date')::date < CURRENT_DATE
             )
           )::int AS due_soon,
           COUNT(*) FILTER (WHERE status IN ('approved','in_progress','blocked')
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(milestones) m
               WHERE COALESCE(m->>'status','') <> 'completed'
                 AND NULLIF(m->>'due_date','') IS NOT NULL
                 AND (m->>'due_date')::date < CURRENT_DATE
             )
           )::int AS overdue
         FROM projects`
      ),
    ]);

    const months = cashFlow.rows.map((r) => r.month);
    const moneyIn = [];
    const moneyOut = [];
    const settledSal = [];
    const owedSal = [];
    for (const month of months) {
      const [pay, exp, salS, salO] = await Promise.all([
        query(
          `SELECT COALESCE(SUM(amount),0)::float AS total FROM payments
           WHERE to_char(paid_at, 'YYYY-MM') = $1`,
          [month]
        ),
        query(
          `SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses
           WHERE to_char(created_at, 'YYYY-MM') = $1`,
          [month]
        ),
        query(
          `SELECT COALESCE(SUM(amount_paid),0)::float AS total FROM salary_payments
           WHERE month = $1 AND status = 'settled'`,
          [month]
        ),
        query(
          `SELECT COALESCE(SUM(amount_expected - amount_paid),0)::float AS total FROM salary_payments
           WHERE month = $1 AND status = 'owed'`,
          [month]
        ),
      ]);
      moneyIn.push(pay.rows[0].total);
      moneyOut.push(exp.rows[0].total);
      settledSal.push(salS.rows[0].total);
      owedSal.push(salO.rows[0].total);
    }

    const labels = months.map((m) => {
      const [y, mo] = m.split('-');
      return new Date(Number(y), Number(mo) - 1, 1).toLocaleString(undefined, { month: 'short' });
    });

    res.json({
      ok: true,
      data: {
        kpis: {
          sales: {
            leadsToday: leadsToday.rows[0].count,
            openPipeline: openLeads.rows[0].count,
          },
          projects: {
            active: activeProjects.rows[0].count,
            pendingApproval: pendingApproval.rows[0].count,
            dueSoon: dueSoon.rows[0].count,
            overdue: overdueProjects.rows[0].count,
          },
          finance: {
            accountBalance: accountBal.rows[0].total,
            revenue: revenue.rows[0].total,
            expenses: expenses.rows[0].total,
            netCash: revenue.rows[0].total - expenses.rows[0].total,
            outstanding: outstanding.rows[0].total,
          },
          hr: {
            expectedThisMonth: salaryExpected.rows[0].total,
            owedThisMonth: salaryOwed.rows[0].total,
            settledThisMonth: salarySettled.rows[0].total,
          },
          ops: {
            pendingReports: pendingReports.rows[0].count,
            failedJobs: failedJobs.rows[0].count,
          },
        },
        charts: {
          cashFlow: { labels, moneyIn, moneyOut },
          projectHealth: {
            labels: ['On track', 'Due soon', 'Overdue'],
            values: [
              health.rows[0].on_track,
              health.rows[0].due_soon,
              health.rows[0].overdue,
            ],
          },
          salaries: { labels, settled: settledSal, owed: owedSal },
        },
      },
    });
  })
);

/** Company-wide system settings */
router.get(
  '/system',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    await ensureSystemDefaults();
    const { rows } = await query(`SELECT key, value, updated_at FROM system_settings ORDER BY key`);
    const data = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ ok: true, data });
  })
);

router.patch(
  '/system/:key',
  requirePermission('settings', 'edit'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const key = req.params.key;
    if (
      !DEFAULT_SETTINGS[key]
      && !['notification_rules', 'email_templates', 'integrations', 'expense_approval', 'email_automations'].includes(key)
    ) {
      throw new AppError('Unknown settings key', 400, 'VALIDATION');
    }
    if (req.body?.value == null || typeof req.body.value !== 'object') {
      throw new AppError('value object required', 400, 'VALIDATION');
    }
    await ensureSystemDefaults();
    const { rows } = await query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(req.body.value), req.user.id]
    );
    res.json({ ok: true, data: rows[0] });
  })
);

/** Dead-letter / failed jobs - Admin review */
router.get(
  '/failed-jobs',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(
      `SELECT * FROM failed_jobs ORDER BY created_at DESC LIMIT 200`
    );
    let queueCounts = null;
    try {
      const q = getQueues();
      queueCounts = {
        sideEffects: await q.sideEffects.getJobCounts('waiting', 'active', 'failed', 'delayed'),
        email: await q.email.getJobCounts('waiting', 'active', 'failed', 'delayed'),
        notifications: await q.notifications.getJobCounts('waiting', 'active', 'failed', 'delayed'),
      };
    } catch {
      queueCounts = { error: 'queue unavailable' };
    }
    res.json({ ok: true, data: rows, meta: { queueCounts } });
  })
);

router.post(
  '/failed-jobs/:id/retry',
  requirePermission('settings', 'edit'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(`SELECT * FROM failed_jobs WHERE id = $1`, [req.params.id]);
    const job = rows[0];
    if (!job) throw new AppError('Failed job not found', 404, 'NOT_FOUND');

    const queueKey =
      job.queue.includes('email') ? 'email'
        : job.queue.includes('notification') ? 'notifications'
          : 'sideEffects';

    await enqueue(queueKey, job.job_name, job.payload || {}, {
      jobId: `retry-${job.id}-${Date.now()}`,
    });
    await query(`DELETE FROM failed_jobs WHERE id = $1`, [job.id]);
    res.json({ ok: true, data: { retried: true, queue: queueKey, jobName: job.job_name } });
  })
);

router.delete(
  '/failed-jobs/:id',
  requirePermission('settings', 'edit'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const { rows } = await query(
      `DELETE FROM failed_jobs WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError('Failed job not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: { dismissed: true } });
  })
);

router.get(
  '/email-activity',
  requirePermission('settings', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    const toInvoice = await query(
      `SELECT l.created_at, l.channel, l.status, l.detail,
              i.invoice_number, c.name AS client_name, c.email AS client_email
         FROM invoice_email_log l
         LEFT JOIN invoices i ON i.id = l.invoice_id
         LEFT JOIN clients c ON c.id = i.client_id
        ORDER BY l.created_at DESC
        LIMIT 40`
    ).catch(() => ({ rows: [] }));

    const toManual = await query(
      `SELECT oe.created_at, oe.to_email, oe.subject, oe.status, oe.body,
              u.name AS sender_name, c.name AS client_name
         FROM outbound_emails oe
         LEFT JOIN users u ON u.id = oe.sent_by
         LEFT JOIN clients c ON c.id = oe.client_id
        ORDER BY oe.created_at DESC
        LIMIT 40`
    ).catch(() => ({ rows: [] }));

    const toLeads = await query(
      `SELECT m.created_at, m.subject, m.status, m.error, l.name AS lead_name, l.email AS lead_email
         FROM lead_messages m
         JOIN leads l ON l.id = m.lead_id
        ORDER BY m.created_at DESC
        LIMIT 30`
    ).catch(() => ({ rows: [] }));

    const fromMessages = await query(
      `SELECT m.created_at, m.body, u.name AS sender_name, p.name AS project_name
         FROM project_messages m
         JOIN users u ON u.id = m.sender_id
         JOIN roles r ON r.id = u.role_id
         JOIN projects p ON p.id = m.project_id
        WHERE r.name = 'client'
        ORDER BY m.created_at DESC
        LIMIT 40`
    ).catch(() => ({ rows: [] }));

    const fromChanges = await query(
      `SELECT cr.created_at, cr.subject, cr.details, cr.status,
              u.name AS sender_name, p.name AS project_name
         FROM client_change_requests cr
         LEFT JOIN users u ON u.id = cr.client_user_id
         LEFT JOIN projects p ON p.id = cr.project_id
        ORDER BY cr.created_at DESC
        LIMIT 30`
    ).catch(() => ({ rows: [] }));

    const to = [
      ...toInvoice.rows.map((r) => ({
        direction: 'to_client',
        kind: 'invoice',
        at: r.created_at,
        title: r.invoice_number || r.channel || 'Invoice email',
        summary: r.detail || r.status,
        who: r.client_name || r.client_email || 'Client',
        status: r.status,
      })),
      ...toManual.rows.map((r) => ({
        direction: 'to_client',
        kind: 'manual',
        at: r.created_at,
        title: r.subject,
        summary: `${r.status} · ${r.to_email}`,
        who: r.client_name || r.to_email,
        status: r.status,
      })),
      ...toLeads.rows.map((r) => ({
        direction: 'to_client',
        kind: 'lead',
        at: r.created_at,
        title: r.subject,
        summary: r.error || r.status,
        who: r.lead_name || r.lead_email,
        status: r.status,
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 50);

    const from = [
      ...fromMessages.rows.map((r) => ({
        direction: 'from_client',
        kind: 'project_message',
        at: r.created_at,
        title: r.project_name || 'Project message',
        summary: r.body,
        who: r.sender_name,
        status: 'received',
      })),
      ...fromChanges.rows.map((r) => ({
        direction: 'from_client',
        kind: 'change_request',
        at: r.created_at,
        title: r.subject,
        summary: r.details,
        who: r.sender_name,
        status: r.status,
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 50);

    res.json({ ok: true, data: { to, from } });
  })
);

router.get(
  '/daily-digest',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    assertAdmin(req);
    try {
      const data = await buildDailyDigest({
        date: req.query.date,
        refresh: req.query.refresh === '1' || req.query.refresh === 'true',
      });
      res.json({ ok: true, data });
    } catch (err) {
      if (err.message && /date/i.test(err.message)) {
        throw new AppError(err.message, 400, 'BAD_DATE');
      }
      throw err;
    }
  })
);

module.exports = router;
