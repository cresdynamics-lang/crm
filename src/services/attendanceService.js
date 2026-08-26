/**
 * Attendance tracking service.
 * Calculates rolling 30-day report compliance from employee onboard date.
 * Mon–Sat are expected work days; Sunday is off.
 * Real-time: each report submission marks that day as attended.
 */
const { query } = require('../config/database');

/**
 * Get all expected work dates (Mon-Sat) between two dates, inclusive.
 */
function getExpectedWorkDays(fromDate, toDate) {
  const days = [];
  const d = new Date(fromDate);
  const end = new Date(toDate);
  while (d <= end) {
    const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon ... 6=Sat
    if (dayOfWeek !== 0) {
      days.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/**
 * Calculate the rolling 30-day window from an employee's onboard date.
 * Returns { from, to, expectedDays }.
 */
function calculateWindow(onboardDate, referenceDate = new Date()) {
  const from = new Date(onboardDate);
  const to = new Date(referenceDate);
  // Cap to 30 days back from reference date
  const thirtyDaysAgo = new Date(to);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  const effectiveFrom = from > thirtyDaysAgo ? from : thirtyDaysAgo;
  const expectedDays = getExpectedWorkDays(effectiveFrom, to);
  return { from: effectiveFrom, to, expectedDays };
}

/**
 * Mark attendance on report submission.
 */
async function markAttendance(userId, reportDate, reportId) {
  const dateStr = typeof reportDate === 'string'
    ? reportDate.slice(0, 10)
    : new Date(reportDate).toISOString().slice(0, 10);

  const { rows } = await query(
    `INSERT INTO report_attendance (user_id, report_date, submitted, report_id)
     VALUES ($1, $2::date, TRUE, $3)
     ON CONFLICT (user_id, report_date)
     DO UPDATE SET submitted = TRUE,
                   report_id = COALESCE(EXCLUDED.report_id, report_attendance.report_id),
                   updated_at = NOW()
     RETURNING *`,
    [userId, dateStr, reportId]
  );
  return rows[0];
}

/**
 * Get attendance compliance for a user within a date range.
 */
async function getCompliance(userId, fromDate, toDate) {
  const { from, to, expectedDays } = calculateWindow(fromDate, toDate);

  const { rows: attended } = await query(
    `SELECT report_date, report_id
     FROM report_attendance
     WHERE user_id = $1
       AND report_date >= $2::date
       AND report_date <= $3::date
       AND submitted = TRUE
     ORDER BY report_date`,
    [userId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]
  );

  const attendedDates = new Set(attended.map((r) => r.report_date.toISOString().slice(0, 10)));
  const expectedDateStrs = expectedDays.map((d) => d.toISOString().slice(0, 10));

  const missing = expectedDateStrs.filter((d) => !attendedDates.has(d));
  const totalExpected = expectedDateStrs.length;
  const totalAttended = attendedDates.size;
  const score = totalExpected > 0 ? totalAttended / totalExpected : 1;

  return {
    user_id: userId,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    total_expected: totalExpected,
    total_attended: totalAttended,
    missing_days: missing.length,
    missing_dates: missing,
    attendance_score: Math.round(score * 100) / 100,
  };
}

/**
 * Calculate salary deduction based on missing reports.
 * Formula: (missing_days / total_expected_work_days) * salary_amount
 * Pro-rated for the 30-day window.
 */
async function calculateSalaryImpact(employeeId, month) {
  // Get employee details
  const { rows: employees } = await query(
    `SELECT e.id, e.user_id, e.salary_amount, e.created_at
     FROM employees e WHERE e.id = $1`,
    [employeeId]
  );
  if (!employees[0]) return null;
  const emp = employees[0];

  // Calculate month window (first to last day of month)
  const [year, mo] = month.split('-').map(Number);
  const monthStart = new Date(year, mo - 1, 1);
  const monthEnd = new Date(year, mo, 0); // last day of month

  // Use employee onboard date or month start, whichever is later
  const effectiveStart = emp.created_at > monthStart ? emp.created_at : monthStart;

  const compliance = await getCompliance(emp.user_id, effectiveStart, monthEnd);

  const dailyRate = emp.salary_amount / compliance.total_expected;
  const totalDeduction = dailyRate * compliance.missing_days;

  return {
    employee_id: emp.id,
    user_id: emp.user_id,
    month,
    salary_amount: Number(emp.salary_amount),
    total_expected: compliance.total_expected,
    total_attended: compliance.total_attended,
    missing_days: compliance.missing_days,
    missing_dates: compliance.missing_dates,
    attendance_score: compliance.attendance_score,
    daily_rate: Math.round(dailyRate * 100) / 100,
    total_deduction: Math.round(totalDeduction * 100) / 100,
    net_salary: Math.round((emp.salary_amount - totalDeduction) * 100) / 100,
  };
}

/**
 * Get team attendance summary for a director/admin view.
 */
async function getTeamCompliance(fromDate, toDate) {
  const { rows: employees } = await query(
    `SELECT e.id, e.user_id, e.salary_amount, e.position, e.created_at,
            u.name, r.name AS role
     FROM employees e
     JOIN users u ON u.id = e.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active'
       AND r.name IN ('sales', 'developer')
     ORDER BY u.name`
  );

  const results = [];
  for (const emp of employees) {
    const effectiveStart = emp.created_at > new Date(fromDate) ? emp.created_at : new Date(fromDate);
    const compliance = await getCompliance(emp.user_id, effectiveStart, new Date(toDate));
    const dailyRate = emp.salary_amount / compliance.total_expected;
    const deduction = dailyRate * compliance.missing_days;

    results.push({
      user_id: emp.user_id,
      name: emp.name,
      role: emp.role,
      position: emp.position,
      salary_amount: Number(emp.salary_amount),
      ...compliance,
      daily_rate: Math.round(dailyRate * 100) / 100,
      projected_deduction: Math.round(deduction * 100) / 100,
    });
  }

  return results;
}

/**
 * Ensure attendance rows exist for a given month's expected work days.
 * Backfills missing rows for active sales/developer users.
 */
async function ensureAttendanceRows(year, month) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const expectedDays = getExpectedWorkDays(monthStart, monthEnd);

  const { rows: staff } = await query(
    `SELECT u.id, e.created_at
     FROM users u
     JOIN employees e ON e.user_id = u.id
     JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active'
       AND r.name IN ('sales', 'developer')`
  );

  let created = 0;
  for (const person of staff) {
    for (const day of expectedDays) {
      // Skip days before employee was onboarded
      if (person.created_at > day) continue;

      const dateStr = day.toISOString().slice(0, 10);
      const { rows } = await query(
        `INSERT INTO report_attendance (user_id, report_date, submitted)
         VALUES ($1, $2::date, FALSE)
         ON CONFLICT (user_id, report_date) DO NOTHING
         RETURNING id`,
        [person.id, dateStr]
      );
      if (rows.length) created++;
    }
  }
  return created;
}

module.exports = {
  getExpectedWorkDays,
  calculateWindow,
  markAttendance,
  getCompliance,
  calculateSalaryImpact,
  getTeamCompliance,
  ensureAttendanceRows,
};
