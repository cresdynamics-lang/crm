/**
 * Same-day operations briefing for Admin Reports.
 * Gathers Finance / Director / Admin facts, then asks OpenRouter (Claude Sonnet)
 * for a structured brief. Falls back to a facts-only brief if the key is missing.
 */
const { query } = require('../config/database');
const config = require('../config');
const { expenseClass } = require('../lib/expenseClasses');
const { openRouterJson } = require('./openRouter');

const TZ = 'Africa/Nairobi';
// Fresh for 30 minutes; after that the old copy is served instantly while a
// new one is written in the background (nobody waits for the AI).
const CACHE_TTL_MS = 30 * 60 * 1000;
const inFlight = new Map();
const cache = new Map();

function eatToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseDay(raw) {
  const day = String(raw || '').trim() || eatToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('Date must be YYYY-MM-DD');
  }
  const today = eatToday();
  if (day > today) throw new Error('Date cannot be in the future');
  const oldest = new Date(`${today}T00:00:00+03:00`);
  oldest.setDate(oldest.getDate() - 90);
  const oldestStr = oldest.toISOString().slice(0, 10);
  if (day < oldestStr) throw new Error('Date cannot be older than 90 days');
  return day;
}

function money(n) {
  const v = Number(n) || 0;
  return `KES ${v.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}

function num(v) {
  return Number(v) || 0;
}

function dayClause(alias, col = 'created_at') {
  return `(${alias}.${col} AT TIME ZONE '${TZ}')::date = $1::date`;
}

async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[daily-digest] ${label}: ${err.message}`);
    return fallback;
  }
}

function clip(text, n = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

async function gatherFacts(day) {
  const payments = await safe(
    'payments',
    async () => {
      const { rows } = await query(
        `SELECT p.amount, p.paid_at,
                i.invoice_number, i.status AS invoice_status,
                c.name AS client_name, c.business_name,
                pr.name AS project_name, u.name AS recorded_by
           FROM payments p
           LEFT JOIN invoices i ON i.id = p.invoice_id
           LEFT JOIN clients c ON c.id = i.client_id
           LEFT JOIN projects pr ON pr.id = i.project_id
           LEFT JOIN users u ON u.id = p.recorded_by
          WHERE ${dayClause('p', 'paid_at')}
          ORDER BY p.paid_at DESC
          LIMIT 40`,
        [day]
      );
      return rows.map((r) => ({
        amount: num(r.amount),
        invoice: r.invoice_number,
        client: r.client_name || r.business_name,
        project: r.project_name,
        recorded_by: r.recorded_by,
      }));
    },
    []
  );

  const invoices = await safe(
    'invoices',
    async () => {
      const { rows } = await query(
        `SELECT i.amount, i.status, i.invoice_number,
                c.name AS client_name, pr.name AS project_name
           FROM invoices i
           LEFT JOIN clients c ON c.id = i.client_id
           LEFT JOIN projects pr ON pr.id = i.project_id
          WHERE ${dayClause('i')}
          ORDER BY i.created_at DESC
          LIMIT 40`,
        [day]
      );
      return rows.map((r) => ({
        amount: num(r.amount),
        status: r.status,
        invoice: r.invoice_number,
        client: r.client_name,
        project: r.project_name,
      }));
    },
    []
  );

  const expenses = await safe(
    'expenses',
    async () => {
      const { rows } = await query(
        `SELECT e.category, e.amount, e.description, e.approval_status,
                u.name AS created_by
           FROM expenses e
           LEFT JOIN users u ON u.id = e.created_by
          WHERE ${dayClause('e')}
          ORDER BY e.created_at DESC
          LIMIT 40`,
        [day]
      );
      return rows.map((r) => ({
        category: r.category,
        class: expenseClass(r.category),
        amount: num(r.amount),
        description: clip(r.description, 160),
        approval_status: r.approval_status,
        created_by: r.created_by,
      }));
    },
    []
  );

  const salaryFunding = await safe(
    'salary-funding',
    async () => {
      const { rows } = await query(
        `SELECT month, amount_requested, amount_funded, status, note
           FROM salary_funding_requests
          WHERE ${dayClause('salary_funding_requests')}
             OR (finance_approved_at AT TIME ZONE '${TZ}')::date = $1::date
             OR (admin_approved_at AT TIME ZONE '${TZ}')::date = $1::date
          ORDER BY updated_at DESC
          LIMIT 20`,
        [day]
      );
      return rows.map((r) => ({
        month: r.month,
        requested: num(r.amount_requested),
        funded: r.amount_funded != null ? num(r.amount_funded) : null,
        status: r.status,
        note: clip(r.note, 160),
      }));
    },
    []
  );

  const salariesSettled = await safe(
    'salaries',
    async () => {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_paid),0)::float AS total
           FROM salary_payments
          WHERE (settled_at AT TIME ZONE '${TZ}')::date = $1::date`,
        [day]
      );
      return { count: num(rows[0]?.count), total: num(rows[0]?.total) };
    },
    { count: 0, total: 0 }
  );

  const projects = await safe(
    'projects',
    async () => {
      const { rows } = await query(
        `SELECT p.name, p.status, p.value_amount, c.name AS client_name
           FROM projects p
           LEFT JOIN clients c ON c.id = p.client_id
          WHERE ${dayClause('p')}
             OR (p.approved_at AT TIME ZONE '${TZ}')::date = $1::date
          ORDER BY p.updated_at DESC
          LIMIT 30`,
        [day]
      );
      return rows.map((r) => ({
        name: r.name,
        status: r.status,
        value: r.value_amount != null ? num(r.value_amount) : null,
        client: r.client_name,
      }));
    },
    []
  );

  const leads = await safe(
    'leads',
    async () => {
      const { rows } = await query(
        `SELECT name, business_name, status
           FROM leads
          WHERE ${dayClause('leads')}
          ORDER BY created_at DESC
          LIMIT 30`
        ,
        [day]
      );
      return rows.map((r) => ({
        name: r.name,
        business: r.business_name,
        status: r.status,
      }));
    },
    []
  );

  const dailyReports = await safe(
    'daily-reports',
    async () => {
      const { rows } = await query(
        `SELECT u.name, r.name AS role, p.name AS project_name,
                dr.work_done, dr.blockers_text, dr.needs_attention, dr.content,
                dr.forwarded_at, dr.reviewed_at
           FROM daily_reports dr
           JOIN users u ON u.id = dr.user_id
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN projects p ON p.id = dr.project_id
          WHERE ${dayClause('dr')}
          ORDER BY dr.created_at DESC
          LIMIT 50`,
        [day]
      );
      return rows.map((r) => ({
        author: r.name,
        role: r.role,
        project: r.project_name,
        work: clip(r.work_done || r.content, 220),
        blockers: clip(r.blockers_text, 160),
        needs_attention: clip(r.needs_attention, 160),
        forwarded: Boolean(r.forwarded_at),
        reviewed: Boolean(r.reviewed_at),
      }));
    },
    []
  );

  const audit = await safe(
    'audit',
    async () => {
      const { rows } = await query(
        `SELECT a.action, a.resource_type, a.summary, a.actor_role, a.created_at,
                u.name AS actor_name
           FROM action_audit_log a
           LEFT JOIN users u ON u.id = a.actor_id
          WHERE ${dayClause('a')}
          ORDER BY a.created_at DESC
          LIMIT 80`,
        [day]
      );
      return rows.map((r) => ({
        action: r.action,
        resource: r.resource_type,
        summary: clip(r.summary, 180),
        role: r.actor_role,
        actor: r.actor_name,
      }));
    },
    []
  );

  const pending = await safe(
    'pending',
    async () => {
      const [proj, exp, fund, overdue] = await Promise.all([
        query(`SELECT COUNT(*)::int AS count FROM projects WHERE status = 'pending_approval'`),
        query(
          `SELECT COUNT(*)::int AS count FROM expenses
            WHERE approval_status IN ('pending', 'pending_finance', 'pending_admin')`
        ),
        query(
          `SELECT COUNT(*)::int AS count FROM salary_funding_requests
            WHERE status IN ('pending_finance', 'finance_approved')`
        ),
        query(
          `SELECT COUNT(*)::int AS count FROM invoices WHERE status = 'overdue'`
        ),
      ]);
      return {
        projects: num(proj.rows[0]?.count),
        expenses: num(exp.rows[0]?.count),
        salary_funding: num(fund.rows[0]?.count),
        overdue_invoices: num(overdue.rows[0]?.count),
      };
    },
    { projects: 0, expenses: 0, salary_funding: 0, overdue_invoices: 0 }
  );

  const revenueToday = payments.reduce((s, p) => s + p.amount, 0);
  const expensesToday = expenses.reduce((s, e) => s + e.amount, 0);
  const invoicedToday = invoices.reduce((s, i) => s + i.amount, 0);
  const internalExp = expenses.filter((e) => e.class === 'internal').reduce((s, e) => s + e.amount, 0);
  const externalExp = expensesToday - internalExp;

  const reportsByRole = dailyReports.reduce((acc, r) => {
    acc[r.role] = (acc[r.role] || 0) + 1;
    return acc;
  }, {});

  const auditByRole = audit.reduce((acc, a) => {
    const role = a.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});

  return {
    day,
    timezone: TZ,
    totals: {
      revenue: revenueToday,
      expenses: expensesToday,
      expenses_internal: internalExp,
      expenses_external: externalExp,
      invoiced: invoicedToday,
      payments_count: payments.length,
      invoices_count: invoices.length,
      expenses_count: expenses.length,
      reports_count: dailyReports.length,
      actions_count: audit.length,
    },
    payments,
    invoices,
    expenses,
    salary_funding: salaryFunding,
    salaries_settled: salariesSettled,
    projects,
    leads,
    daily_reports: dailyReports,
    reports_by_role: reportsByRole,
    audit: audit.filter((a) => ['finance', 'director', 'admin'].includes(a.role)),
    audit_other: audit.filter((a) => !['finance', 'director', 'admin'].includes(a.role)).slice(0, 25),
    audit_by_role: auditByRole,
    pending,
  };
}

function emptySection(label) {
  return {
    summary: `No ${label} activity recorded for this day.`,
    highlights: [],
  };
}

function heuristicBriefing(facts) {
  const t = facts.totals;
  const financeBits = [];
  if (t.payments_count) financeBits.push(`${t.payments_count} payment(s) totalling ${money(t.revenue)}`);
  if (t.invoices_count) financeBits.push(`${t.invoices_count} invoice(s) issued for ${money(t.invoiced)}`);
  if (t.expenses_count) {
    financeBits.push(
      `${t.expenses_count} expense(s) ${money(t.expenses)} (internal ${money(t.expenses_internal)}, external ${money(t.expenses_external)})`
    );
  }
  if (facts.salary_funding.length) {
    financeBits.push(`${facts.salary_funding.length} salary funding action(s)`);
  }
  if (facts.salaries_settled.count) {
    financeBits.push(`${facts.salaries_settled.count} salary settlement(s) ${money(facts.salaries_settled.total)}`);
  }

  const directorBits = [];
  const dirReports = facts.daily_reports.filter((r) => r.role === 'director');
  const dirAudit = facts.audit.filter((a) => a.role === 'director');
  const approved = facts.projects.filter((p) => p.status === 'approved');
  if (dirReports.length) directorBits.push(`${dirReports.length} director report(s) filed`);
  if (approved.length) directorBits.push(`${approved.length} project(s) approved or touched`);
  if (dirAudit.length) directorBits.push(`${dirAudit.length} director action(s) in the audit log`);
  facts.daily_reports
    .filter((r) => r.forwarded)
    .slice(0, 3)
    .forEach((r) => directorBits.push(`Forwarded report from ${r.author}`));

  const adminBits = [];
  const adminReports = facts.daily_reports.filter((r) => r.role === 'admin');
  const adminAudit = facts.audit.filter((a) => a.role === 'admin');
  if (adminReports.length) adminBits.push(`${adminReports.length} admin report(s) filed`);
  if (adminAudit.length) adminBits.push(`${adminAudit.length} admin action(s) in the audit log`);
  if (facts.pending.projects) adminBits.push(`${facts.pending.projects} project(s) still pending approval`);
  if (facts.pending.salary_funding) adminBits.push(`${facts.pending.salary_funding} salary funding request(s) open`);

  const opsBits = [];
  if (facts.leads.length) opsBits.push(`${facts.leads.length} new lead(s)`);
  if (facts.projects.length) opsBits.push(`${facts.projects.length} project(s) created or approved`);
  if (facts.daily_reports.length) opsBits.push(`${facts.daily_reports.length} daily report(s) across the team`);

  const watch = [];
  if (facts.pending.overdue_invoices) watch.push(`${facts.pending.overdue_invoices} overdue invoice(s) still open`);
  if (facts.pending.projects) watch.push(`${facts.pending.projects} project(s) waiting for approval`);
  if (facts.pending.expenses) watch.push(`${facts.pending.expenses} expense(s) waiting for approval`);
  if (facts.pending.salary_funding) watch.push(`${facts.pending.salary_funding} salary funding request(s) still open`);
  facts.daily_reports
    .filter((r) => r.needs_attention || r.blockers)
    .slice(0, 4)
    .forEach((r) => watch.push(`${r.author}: ${r.needs_attention || r.blockers}`));

  const headline = financeBits.length || directorBits.length || adminBits.length || opsBits.length
    ? `Today: ${money(t.revenue)} in, ${money(t.expenses)} out, ${t.reports_count} report(s), ${t.actions_count} action(s).`
    : watch.length
      ? `A quiet day on the books — ${watch.length} item(s) still need attention.`
      : 'A quiet day — no Finance, Director, or Admin activity was recorded.';

  return {
    headline,
    finance: financeBits.length
      ? { summary: financeBits.join('. ') + '.', highlights: financeBits.slice(0, 6) }
      : emptySection('finance'),
    director: directorBits.length
      ? { summary: directorBits.join('. ') + '.', highlights: directorBits.slice(0, 6) }
      : emptySection('director'),
    admin: adminBits.length
      ? { summary: adminBits.join('. ') + '.', highlights: adminBits.slice(0, 6) }
      : emptySection('admin'),
    operations: opsBits.length
      ? { summary: opsBits.join('. ') + '.', highlights: opsBits.slice(0, 6) }
      : emptySection('operations'),
    watch,
  };
}

function normalizeBriefing(raw, facts) {
  const fallback = heuristicBriefing(facts);
  const pick = (key) => {
    const src = raw && typeof raw === 'object' ? raw[key] : null;
    if (!src || typeof src !== 'object') return fallback[key];
    return {
      summary: clip(src.summary || fallback[key].summary, 600),
      highlights: Array.isArray(src.highlights)
        ? src.highlights.map((h) => clip(h, 220)).filter(Boolean).slice(0, 8)
        : fallback[key].highlights,
    };
  };
  return {
    headline: clip(raw?.headline || fallback.headline, 280),
    finance: pick('finance'),
    director: pick('director'),
    admin: pick('admin'),
    operations: pick('operations'),
    watch: Array.isArray(raw?.watch)
      ? raw.watch.map((h) => clip(h, 220)).filter(Boolean).slice(0, 8)
      : fallback.watch,
  };
}

async function askModel(facts) {
  const system = `You are the CRES Dynamics operations brief writer for Admin.
Write a same-day briefing from the FACTS JSON only.
Never invent amounts, names, invoices, or events that are not in the facts.
If a section has no activity, say so in one short sentence.
Use Kenyan Shillings as KES and dates like 23 Oct 2026.
Tone: crisp, executive, no fluff.
Return ONLY JSON with this shape:
{
  "headline": "one sentence",
  "finance": { "summary": "2-3 sentences", "highlights": ["…"] },
  "director": { "summary": "2-3 sentences", "highlights": ["…"] },
  "admin": { "summary": "2-3 sentences", "highlights": ["…"] },
  "operations": { "summary": "2-3 sentences", "highlights": ["…"] },
  "watch": ["items that need attention"]
}`;

  const { json, model } = await openRouterJson({
    temperature: 0.2,
    maxTokens: 1600,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `FACTS for ${facts.day} (${facts.timezone}):\n${JSON.stringify(facts)}` },
    ],
  });
  return { briefing: normalizeBriefing(json, facts), model };
}

async function buildDailyDigest({ date, refresh = false } = {}) {
  const day = parseDay(date);
  const cacheKey = day;
  if (!refresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.payload, cached: true };
    if (hit) {
      // Stale: answer now, refresh behind the scenes (once at a time).
      if (!inFlight.has(cacheKey)) {
        inFlight.set(cacheKey, writeDigest(day).catch(() => {}).finally(() => inFlight.delete(cacheKey)));
      }
      return { ...hit.payload, cached: true, stale: true };
    }
  }
  if (inFlight.has(cacheKey) && !refresh) {
    await inFlight.get(cacheKey);
    const fresh = cache.get(cacheKey);
    if (fresh) return { ...fresh.payload, cached: true };
  }
  return writeDigest(day);
}

/** Gather facts, ask the model, cache. */
async function writeDigest(day) {
  const cacheKey = day;

  const facts = await gatherFacts(day);
  const configured = Boolean(config.openRouter.apiKey);
  let briefing = heuristicBriefing(facts);
  let source = 'facts';
  let model = null;
  let error = null;

  if (configured) {
    try {
      const ai = await askModel(facts);
      briefing = ai.briefing;
      model = ai.model;
      source = 'ai';
    } catch (err) {
      error = err.message;
      source = 'facts-fallback';
      console.warn(`[daily-digest] OpenRouter failed: ${err.message}`);
    }
  }

  const payload = {
    day,
    timezone: TZ,
    configured,
    source,
    model,
    error,
    generated_at: new Date().toISOString(),
    totals: facts.totals,
    pending: facts.pending,
    briefing,
  };
  cache.set(cacheKey, { at: Date.now(), payload });
  return { ...payload, cached: false };
}

/**
 * Scheduler: keep today's digest ready during working hours (06:00-20:00
 * Nairobi), so opening it is instant. About 28 AI calls a day.
 */
function prewarmDigest() {
  if (!config.openRouter.apiKey) return Promise.resolve(null);
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }));
  if (hour < 6 || hour >= 20) return Promise.resolve(null);
  const day = parseDay();
  const hit = cache.get(day);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS - 60 * 1000) return Promise.resolve(null);
  return writeDigest(day).catch((e) => console.warn(`[daily-digest] prewarm failed: ${e.message}`));
}

module.exports = { buildDailyDigest, prewarmDigest, eatToday, parseDay };
