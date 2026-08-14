/**
 * Full money-flow report for Finance: in (payments) / out (expenses + salaries).
 */
const { query } = require('../config/database');

function num(v) {
  return Number(v || 0);
}

function parseRange(queryParams = {}) {
  const to = queryParams.date_to || new Date().toISOString().slice(0, 10);
  let from = queryParams.date_from;
  if (!from) {
    const d = new Date(to);
    d.setMonth(d.getMonth() - 5);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}

async function buildCashFlowReport({ date_from, date_to } = {}) {
  const { from, to } = parseRange({ date_from, date_to });

  const { rows: balances } = await query(
    `SELECT id, label, balance, updated_at FROM account_balances ORDER BY label`
  );

  const { rows: moneyIn } = await query(
    `SELECT pay.id,
            pay.paid_at AS occurred_at,
            pay.amount,
            pay.bank_reference,
            'payment' AS kind,
            'in' AS direction,
            c.name AS client_name,
            c.business_name AS client_business,
            p.name AS project_name,
            i.id AS invoice_id,
            u.name AS recorded_by_name
     FROM payments pay
     JOIN invoices i ON i.id = pay.invoice_id
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN projects p ON p.id = i.project_id
     LEFT JOIN users u ON u.id = pay.recorded_by
     WHERE pay.paid_at::date >= $1::date
       AND pay.paid_at::date <= $2::date
     ORDER BY pay.paid_at DESC`,
    [from, to]
  );

  const { rows: moneyOut } = await query(
    `SELECT e.id,
            COALESCE(e.approved_at, e.created_at) AS occurred_at,
            e.amount,
            e.category,
            e.description,
            e.approval_status,
            'expense' AS kind,
            'out' AS direction,
            CASE
              WHEN e.category = 'salary' THEN 'salary'
              WHEN e.category = 'operational' THEN 'expense'
              ELSE 'expense'
            END AS out_type,
            u.name AS created_by_name,
            a.name AS approved_by_name
     FROM expenses e
     LEFT JOIN users u ON u.id = e.created_by
     LEFT JOIN users a ON a.id = e.approved_by
     WHERE e.approval_status = 'approved'
       AND COALESCE(e.approved_at, e.created_at)::date >= $1::date
       AND COALESCE(e.approved_at, e.created_at)::date <= $2::date
     ORDER BY COALESCE(e.approved_at, e.created_at) DESC`,
    [from, to]
  );

  const { rows: salaries } = await query(
    `SELECT sp.id,
            COALESCE(sp.settled_at, sp.created_at) AS occurred_at,
            sp.amount_paid AS amount,
            sp.month,
            sp.status,
            'salary_settlement' AS kind,
            'out' AS direction,
            emp_u.name AS employee_name
     FROM salary_payments sp
     JOIN employees e ON e.id = sp.employee_id
     JOIN users emp_u ON emp_u.id = e.user_id
     WHERE sp.status = 'settled'
       AND sp.amount_paid > 0
       AND COALESCE(sp.settled_at, sp.created_at)::date >= $1::date
       AND COALESCE(sp.settled_at, sp.created_at)::date <= $2::date
     ORDER BY COALESCE(sp.settled_at, sp.created_at) DESC`,
    [from, to]
  );

  // Prefer expense rows for salary outflows when synced; still list settlements for audit
  const expenseSalaryTotal = moneyOut
    .filter((r) => r.category === 'salary')
    .reduce((s, r) => s + num(r.amount), 0);
  const settlementTotal = salaries.reduce((s, r) => s + num(r.amount), 0);
  // Avoid double-counting in totals: money out = all approved expenses.
  // Settlements shown separately; if no salary expenses exist, add settlements into out total.
  const paymentsInTotal = moneyIn.reduce((s, r) => s + num(r.amount), 0);
  const expensesOutTotal = moneyOut.reduce((s, r) => s + num(r.amount), 0);
  const salaryGap = Math.max(0, settlementTotal - expenseSalaryTotal);
  const moneyOutTotal = expensesOutTotal + salaryGap;

  const byProjectMap = new Map();
  for (const row of moneyIn) {
    const key = row.project_name || 'Unlinked project';
    const cur = byProjectMap.get(key) || { project: key, money_in: 0, money_out: 0 };
    cur.money_in += num(row.amount);
    byProjectMap.set(key, cur);
  }

  const byClientMap = new Map();
  for (const row of moneyIn) {
    const key = row.client_business || row.client_name || 'Unknown client';
    const cur = byClientMap.get(key) || { client: key, money_in: 0, payments: 0 };
    cur.money_in += num(row.amount);
    cur.payments += 1;
    byClientMap.set(key, cur);
  }

  const byCategoryMap = new Map();
  for (const row of moneyOut) {
    const key = row.category || 'other';
    const cur = byCategoryMap.get(key) || { category: key, money_out: 0, count: 0 };
    cur.money_out += num(row.amount);
    cur.count += 1;
    byCategoryMap.set(key, cur);
  }
  if (salaryGap > 0) {
    const cur = byCategoryMap.get('salary') || { category: 'salary', money_out: 0, count: 0 };
    cur.money_out += salaryGap;
    cur.count += salaries.length;
    byCategoryMap.set('salary', cur);
  }

  const ledger = [
    ...moneyIn.map((r) => ({
      occurred_at: r.occurred_at,
      direction: 'in',
      kind: 'payment',
      amount: num(r.amount),
      label: `Payment — ${r.client_name || r.client_business || 'Client'}`,
      detail: [r.project_name, r.bank_reference ? `Ref ${r.bank_reference}` : null, r.recorded_by_name]
        .filter(Boolean)
        .join(' · '),
      client: r.client_business || r.client_name || null,
      project: r.project_name || null,
      bank_reference: r.bank_reference || null,
      category: null,
      id: r.id,
    })),
    ...moneyOut.map((r) => ({
      occurred_at: r.occurred_at,
      direction: 'out',
      kind: r.category === 'salary' ? 'salary' : 'expense',
      amount: num(r.amount),
      label: `Expense — ${r.category}`,
      detail: [r.description, r.created_by_name, r.approved_by_name ? `approved by ${r.approved_by_name}` : null]
        .filter(Boolean)
        .join(' · '),
      client: null,
      project: null,
      bank_reference: null,
      category: r.category,
      id: r.id,
    })),
  ];

  // Add settlement rows only when not already covered by salary expenses (gap path)
  if (salaryGap > 0) {
    for (const r of salaries) {
      ledger.push({
        occurred_at: r.occurred_at,
        direction: 'out',
        kind: 'salary',
        amount: num(r.amount),
        label: `Salary settlement — ${r.employee_name}`,
        detail: `Month ${r.month}`,
        client: null,
        project: null,
        bank_reference: null,
        category: 'salary',
        id: r.id,
      });
    }
  }

  ledger.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

  const { rows: outstanding } = await query(
    `SELECT COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS total
     FROM invoices WHERE status IN ('issued','overdue','partially_paid')`
  );

  return {
    period: { from, to },
    generated_at: new Date().toISOString(),
    company: 'Cres Dynamics',
    summary: {
      money_in: paymentsInTotal,
      money_out: moneyOutTotal,
      net: paymentsInTotal - moneyOutTotal,
      outstanding_invoices: num(outstanding[0]?.total),
      account_balance: balances.reduce((s, b) => s + num(b.balance), 0),
      payment_count: moneyIn.length,
      expense_count: moneyOut.length,
      salary_settlement_count: salaries.length,
    },
    accounts: balances.map((b) => ({
      id: b.id,
      label: b.label,
      balance: num(b.balance),
      updated_at: b.updated_at,
    })),
    by_project: [...byProjectMap.values()]
      .map((r) => ({ ...r, net: r.money_in - r.money_out }))
      .sort((a, b) => b.money_in - a.money_in),
    by_client: [...byClientMap.values()].sort((a, b) => b.money_in - a.money_in),
    by_category: [...byCategoryMap.values()].sort((a, b) => b.money_out - a.money_out),
    salaries: salaries.map((r) => ({
      id: r.id,
      employee: r.employee_name,
      month: r.month,
      amount: num(r.amount),
      settled_at: r.occurred_at,
    })),
    ledger,
  };
}

function cashFlowToCsv(report) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [];
  lines.push('Cres Dynamics — Financial cash flow report');
  lines.push(`Period,${report.period.from},${report.period.to}`);
  lines.push(`Generated,${report.generated_at}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push('Metric,Amount');
  lines.push(`Money in,${report.summary.money_in}`);
  lines.push(`Money out,${report.summary.money_out}`);
  lines.push(`Net cash,${report.summary.net}`);
  lines.push(`Account balance,${report.summary.account_balance}`);
  lines.push(`Outstanding invoices,${report.summary.outstanding_invoices}`);
  lines.push('');
  lines.push('ACCOUNTS');
  lines.push('Account,Balance,Updated');
  for (const a of report.accounts) {
    lines.push([a.label, a.balance, a.updated_at].map(esc).join(','));
  }
  lines.push('');
  lines.push('BY PROJECT');
  lines.push('Project,Money in,Money out,Net');
  for (const r of report.by_project) {
    lines.push([r.project, r.money_in, r.money_out, r.net].map(esc).join(','));
  }
  lines.push('');
  lines.push('BY CLIENT');
  lines.push('Client,Money in,Payments');
  for (const r of report.by_client) {
    lines.push([r.client, r.money_in, r.payments].map(esc).join(','));
  }
  lines.push('');
  lines.push('OUTFLOWS BY CATEGORY');
  lines.push('Category,Money out,Count');
  for (const r of report.by_category) {
    lines.push([r.category, r.money_out, r.count].map(esc).join(','));
  }
  lines.push('');
  lines.push('LEDGER');
  lines.push('Date,Direction,Kind,Amount,Label,Detail,Client,Project,Category,Bank reference');
  for (const r of report.ledger) {
    lines.push(
      [
        r.occurred_at,
        r.direction,
        r.kind,
        r.amount,
        r.label,
        r.detail,
        r.client,
        r.project,
        r.category,
        r.bank_reference,
      ]
        .map(esc)
        .join(',')
    );
  }
  return lines.join('\n');
}

module.exports = { buildCashFlowReport, cashFlowToCsv, parseRange };
