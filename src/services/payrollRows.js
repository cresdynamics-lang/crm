/**
 * Payroll rows (salary_payments): one row per employee per month, from the
 * month they joined to now. Created by the background scheduler and at
 * start-up, so reading payroll pages never writes to the database.
 */
const { query, withTransaction } = require('../config/database');

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthAdd(yyyyMm, delta) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthsFromTo(fromMonth, toMonth) {
  const out = [];
  let cur = fromMonth;
  while (cur <= toMonth) {
    out.push(cur);
    cur = monthAdd(cur, 1);
    if (out.length > 120) break; // safety
  }
  return out;
}

async function ensureMonthRow(tx, employeeId, salaryAmount, month) {
  const existing = await tx.query(
    `SELECT * FROM salary_payments WHERE employee_id = $1 AND month = $2`,
    [employeeId, month]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await tx.query(
    `INSERT INTO salary_payments (employee_id, month, amount_expected, status)
     VALUES ($1, $2, $3, 'owed')
     RETURNING *`,
    [employeeId, month, salaryAmount || 0]
  );
  return rows[0];
}

/** Backfill salary_payments from onboarding month through current month */
async function ensurePayrollHistory(txOrQuery, employeeId, salaryAmount, hireAt) {
  const to = currentMonth();
  const from = (hireAt ? new Date(hireAt) : new Date()).toISOString().slice(0, 7);
  const months = monthsFromTo(from, to);
  const run = txOrQuery.query ? txOrQuery : { query: txOrQuery };
  for (const month of months) {
    await ensureMonthRow(run, employeeId, salaryAmount, month);
  }
}


/** Make sure every active employee has a row for `month`. */
async function ensureMonthRows(month) {
  await withTransaction(async (tx) => {
    const { rows: missing } = await tx.query(
      `SELECT e.id, e.salary_amount
       FROM employees e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN salary_payments sp ON sp.employee_id = e.id AND sp.month = $1
       WHERE sp.id IS NULL AND u.status = 'active'`,
      [month]
    );
    for (const m of missing) {
      await tx.query(
        `INSERT INTO salary_payments (employee_id, month, amount_expected, amount_paid, status)
         VALUES ($1, $2, $3, 0, 'owed')
         ON CONFLICT (employee_id, month) DO NOTHING`,
        [m.id, month, Number(m.salary_amount || 0)]
      );
    }
  });
}

/** Scheduler job: fill in any missing months for everyone, up to now. */
async function backfillPayroll() {
  const month = currentMonth();
  const { rows } = await query(
    `SELECT e.id, e.salary_amount, e.created_at
     FROM employees e
     LEFT JOIN salary_payments sp ON sp.employee_id = e.id AND sp.month = $1
     WHERE sp.id IS NULL`,
    [month]
  );
  for (const m of rows) {
    await withTransaction((tx) => ensurePayrollHistory(tx, m.id, m.salary_amount, m.created_at));
  }
  await ensureMonthRows(month);
  return { employeesFilled: rows.length, month };
}

module.exports = { currentMonth, ensurePayrollHistory, ensureMonthRows, backfillPayroll };
