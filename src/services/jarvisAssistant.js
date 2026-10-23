/**
 * Read-only Jarvis assistant for the CRM side panel.
 * Looks up data only via allowlisted GETs using the signed-in user's token.
 */
const config = require('../config');
const { hasPermission } = require('../middleware/rbac');
const { searchKnowledge } = require('./knowledgeService');
const { gatherCompanyBrief } = require('./jarvisBriefing');
const { AppError } = require('../lib/errors');

const STAFF = ['admin', 'director', 'sales', 'developer', 'finance', 'pm', 'hr'];
const LEADERS = ['admin', 'director'];
const BOOKS = ['admin', 'finance'];
const PENDING_INVOICE_STATUSES = ['issued', 'overdue', 'partially_paid'];
const DIRECTOR_BLOCKED_ENDPOINTS = new Set([
  'finance_overview',
  'finance_dashboard',
  'finance_projects',
  'cash_flow_report',
  'website_payments',
  'balances',
  'expenses',
  'payments',
  'salary_funding',
  'admin_dashboard',
  'daily_digest',
]);

const ID_RE = /^[\w-]{1,64}$/;
const QUERY_KEY_RE = /^[\w.-]{1,40}$/;
const SECRET_KEY_RE = /(password|passwd|secret|token|hash|api_?key|otp)/i;

const MAX_ARRAY = 60;
const MAX_STRING = 1500;
const MAX_RESULT = 14000;
const MAX_TOOL_ROUNDS = 6;
const MAX_MESSAGE = 4000;
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 2000;
const QUERY_VALUE_MAX = 200;

const MODEL = process.env.JARVIS_CRM_MODEL || 'anthropic/claude-sonnet-5.5';

const CATALOG = [
  { id: 'me', path: '/api/auth/me', any: null, roles: [...STAFF, 'client'], desc: 'Your signed-in profile' },
  { id: 'notifications', path: '/api/notifications', any: [['notifications', 'view']], roles: null, desc: 'Your notifications' },
  { id: 'approvals', path: '/api/approvals', any: null, roles: STAFF, desc: 'Items waiting on you' },
  { id: 'admin_dashboard', path: '/api/admin/dashboard', any: [['query', 'view']], roles: ['admin'], desc: 'Admin dashboard KPIs' },
  { id: 'daily_digest', path: '/api/admin/daily-digest', any: [['reports', 'view']], roles: ['admin'], desc: "Today's operations digest" },
  { id: 'director_dashboard', path: '/api/director/dashboard', any: [['projects', 'approve'], ['invoices', 'view']], roles: LEADERS, desc: 'Director dashboard (projects, team, pending invoices — no books)' },
  { id: 'director_approvals', path: '/api/director/approvals', any: [['projects', 'approve']], roles: LEADERS, desc: 'Projects waiting for director approval' },
  { id: 'sales_dashboard', path: '/api/sales/dashboard', any: [['leads', 'view'], ['projects', 'view']], roles: ['sales', ...LEADERS], desc: 'Sales dashboard' },
  { id: 'developer_dashboard', path: '/api/developer/dashboard', any: [['projects', 'view']], roles: ['developer', 'admin'], desc: 'Developer dashboard' },
  { id: 'developer_projects', path: '/api/developer/projects', any: [['projects', 'view']], roles: ['developer', 'admin'], desc: 'Projects assigned to the developer' },
  { id: 'pm_dashboard', path: '/api/pm/dashboard', any: [['projects', 'view']], roles: ['pm', ...LEADERS], desc: 'PM dashboard' },
  { id: 'pm_projects', path: '/api/pm/projects', any: [['projects', 'view']], roles: ['pm', ...LEADERS], desc: 'PM project list' },
  { id: 'pm_project', path: '/api/pm/projects/:id', any: [['projects', 'view']], roles: ['pm', ...LEADERS], desc: 'One PM project by id' },
  { id: 'finance_overview', path: '/api/finance/overview', any: [['cash_flow', 'view'], ['account_balance', 'view'], ['invoices', 'view']], roles: BOOKS, desc: 'Full finance overview (balances, revenue, expenses)' },
  { id: 'finance_dashboard', path: '/api/finance/dashboard', any: [['cash_flow', 'view'], ['account_balance', 'view']], roles: BOOKS, desc: 'Finance dashboard' },
  { id: 'finance_projects', path: '/api/finance/projects', any: [['projects', 'view']], roles: BOOKS, desc: 'Finance project balances' },
  { id: 'cash_flow_report', path: '/api/finance/cash-flow-report', any: [['cash_flow', 'view'], ['account_balance', 'view']], roles: BOOKS, desc: 'Cash flow report' },
  { id: 'website_payments', path: '/api/finance/website-payments', any: [['cash_flow', 'view'], ['payments', 'view']], roles: BOOKS, desc: 'Website payment records' },
  { id: 'hr_dashboard', path: '/api/hr/dashboard', any: [['salaries', 'view']], roles: ['hr', 'admin'], desc: 'HR dashboard including payroll figures' },
  { id: 'hr_applicants', path: '/api/hr/applicants', any: [['employees', 'view']], roles: ['hr', 'admin'], desc: 'Job applicants' },
  { id: 'hr_onboarding', path: '/api/hr/onboarding', any: [['employees', 'view']], roles: ['hr', 'admin'], desc: 'Onboarding list' },
  { id: 'site_analytics', path: '/api/analytics/summary', any: null, roles: LEADERS, desc: 'Website analytics summary' },
  { id: 'system_health', path: '/api/admin/health/overview', any: null, roles: ['admin'], desc: 'System health overview' },
  { id: 'failed_jobs', path: '/api/admin/failed-jobs', any: [['settings', 'view']], roles: ['admin'], desc: 'Failed background jobs' },
  { id: 'email_activity', path: '/api/admin/email-activity', any: [['settings', 'view']], roles: ['admin'], desc: 'Outbound email activity' },
  { id: 'login_audit', path: '/api/invites/login-audit', any: [['users', 'view']], roles: ['admin'], desc: 'Who signed in (admin Organization log)' },
  { id: 'admin_inbox', path: '/api/admin/inbox', any: [['users', 'view']], roles: ['admin'], desc: 'Admin inbox threads' },
  { id: 'admin_inbox_item', path: '/api/admin/inbox/:id', any: [['users', 'view']], roles: ['admin'], desc: 'One admin inbox thread by id' },
  { id: 'search', path: '/api/search', any: [['query', 'view']], roles: STAFF, desc: 'Global search (pass query.q)' },
  { id: 'clients', path: '/api/clients', any: [['clients', 'view']], roles: STAFF, desc: 'Client list' },
  { id: 'client', path: '/api/clients/:id', any: [['clients', 'view']], roles: STAFF, desc: 'One client by id' },
  { id: 'client_projects', path: '/api/clients/:id/projects', any: [['clients', 'view']], roles: STAFF, desc: 'Projects for a client' },
  { id: 'emails', path: '/api/emails', any: [['clients', 'view']], roles: STAFF, desc: 'Client emails' },
  { id: 'leads', path: '/api/leads', any: [['leads', 'view']], roles: STAFF, desc: 'Lead list' },
  { id: 'lead', path: '/api/leads/:id', any: [['leads', 'view']], roles: STAFF, desc: 'One lead by id' },
  { id: 'lead_engagements', path: '/api/leads/:id/engagements', any: [['leads', 'view']], roles: STAFF, desc: 'Engagements for a lead' },
  { id: 'projects', path: '/api/projects', any: [['projects', 'view']], roles: STAFF, desc: 'Project list' },
  { id: 'project', path: '/api/projects/:id', any: [['projects', 'view']], roles: STAFF, desc: 'One project by id' },
  { id: 'project_updates', path: '/api/projects/:id/updates', any: [['projects', 'view']], roles: STAFF, desc: 'Updates for a project' },
  { id: 'project_change_requests', path: '/api/projects/:id/change-requests', any: [['projects', 'view']], roles: STAFF, desc: 'Change requests for a project' },
  { id: 'project_timeline', path: '/api/projects/meta/timeline', any: [['projects', 'view']], roles: STAFF, desc: 'Project timeline' },
  { id: 'developer_workload', path: '/api/projects/meta/developer-workload', any: [['projects', 'view']], roles: STAFF, desc: 'Developer workload' },
  { id: 'assignments_pending', path: '/api/assignments/pending', any: [['projects', 'view']], roles: STAFF, desc: 'Pending assignments' },
  { id: 'tasks', path: '/api/tasks', any: [['tasks', 'view']], roles: STAFF, desc: 'Task list' },
  { id: 'reports', path: '/api/reports', any: [['reports', 'view']], roles: STAFF, desc: 'Daily reports' },
  { id: 'attendance_team', path: '/api/attendance/team', any: [['reports', 'view']], roles: STAFF, desc: 'Team attendance' },
  { id: 'report_compliance', path: '/api/attendance/report-compliance', any: [['reports', 'view']], roles: STAFF, desc: 'Report compliance' },
  { id: 'audit', path: '/api/audit', any: [['reports', 'view']], roles: LEADERS, desc: 'What people did (action audit)' },
  { id: 'audit_actions', path: '/api/audit/actions', any: [['reports', 'view']], roles: LEADERS, desc: 'Action audit trail' },
  { id: 'invoices', path: '/api/invoices', any: [['invoices', 'view']], roles: STAFF, desc: 'Invoice list (director: pending/overdue only)' },
  { id: 'invoice', path: '/api/invoices/:id', any: [['invoices', 'view']], roles: STAFF, desc: 'One invoice by id (director: pending/overdue only)' },
  { id: 'invoice_followups', path: '/api/invoices/followups', any: [['invoice_followups', 'view']], roles: STAFF, desc: 'Invoice follow-ups' },
  { id: 'balances', path: '/api/invoices/meta/balances', any: [['account_balance', 'view']], roles: BOOKS, desc: 'Account balances' },
  { id: 'payments', path: '/api/payments', any: [['payments', 'view']], roles: BOOKS, desc: 'All payments (full books)' },
  { id: 'expenses', path: '/api/expenses', any: [['expenses', 'view']], roles: BOOKS, desc: 'Expense list' },
  { id: 'salaries', path: '/api/salaries', any: [['salaries', 'view']], roles: ['hr', 'admin', 'finance'], desc: 'Salary list' },
  { id: 'my_salary', path: '/api/salaries/me', any: [['salaries', 'view']], roles: STAFF, desc: 'Your salary' },
  { id: 'salary_funding', path: '/api/salaries/funding/summary', any: [['salaries', 'view']], roles: ['finance', 'hr', 'admin'], desc: 'Salary funding summary' },
  { id: 'employees', path: '/api/salaries/employees', any: [['employees', 'view']], roles: STAFF, desc: 'Employee list' },
  { id: 'my_leave', path: '/api/leave/mine', any: [['leave', 'view']], roles: STAFF, desc: 'Your leave' },
  { id: 'leave', path: '/api/leave', any: [['leave', 'view'], ['employees', 'view']], roles: STAFF, desc: 'Leave requests' },
  { id: 'conversations', path: '/api/messages/conversations', any: [['messages', 'view']], roles: STAFF, desc: 'Message conversations' },
  { id: 'users', path: '/api/users', any: [['users', 'view']], roles: STAFF, desc: 'User list' },
  { id: 'portal_dashboard', path: '/api/client/dashboard', any: null, roles: ['client'], desc: 'Client portal dashboard' },
  { id: 'portal_projects', path: '/api/client/projects', any: null, roles: ['client'], desc: 'Your projects (client portal)' },
  { id: 'portal_project', path: '/api/client/projects/:id', any: null, roles: ['client'], desc: 'One of your projects by id' },
  { id: 'portal_invoices', path: '/api/client/invoices', any: null, roles: ['client'], desc: 'Your invoices (client portal)' },
  { id: 'portal_change_requests', path: '/api/client/change-requests', any: null, roles: ['client'], desc: 'Your change requests (client portal)' },
];

function isAllowed(user, entry) {
  const role = user?.role;
  const portal = entry.id.startsWith('portal_');
  if (role === 'client') {
    if (entry.id !== 'me' && !portal) return false;
  } else if (portal) {
    return false;
  }
  if (role === 'director' && DIRECTOR_BLOCKED_ENDPOINTS.has(entry.id)) return false;
  if (entry.roles && entry.roles.length && !entry.roles.includes(role)) return false;
  if (entry.any && entry.any.length) {
    return entry.any.some(([resource, action]) => hasPermission(user, resource, action));
  }
  return true;
}

function allowedEndpoints(user) {
  return CATALOG.filter((entry) => isAllowed(user, entry));
}

function scrubValue(value, depth = 0) {
  if (depth > 8) return null;
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => scrubValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue;
      out[key] = scrubValue(nested, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

function scrubResult(data) {
  const cleaned = scrubValue(data);
  const text = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned);
  if (text.length > MAX_RESULT) return `${text.slice(0, MAX_RESULT)}…`;
  return text;
}

function nairobiNow() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

function roleRules(role) {
  if (role === 'admin') {
    return [
      'This is Admin: they get the full company picture. Use company_brief first for overviews.',
      'You may report logins, what people did, sales, HR (including payroll), project management, developer updates, invoices, receipts, expenses, cash flow, and account balances.',
    ].join(' ');
  }
  if (role === 'director') {
    return [
      'This is Director. Use company_brief first for overviews.',
      'You MAY report: who logged in, what people did, sales, project management, developer updates, HR operations (headcount, leave, attendance, applicants), pending/overdue invoices, and stamped receipts for payments that have been recorded and cleared.',
      'You must NOT report account balances, cash-flow totals, expense lists or expense totals, salary funding, payroll figures, or general financial health.',
      'If asked for the books, say Admin and Finance hold those numbers, then offer pending invoices or recent receipt stamps instead.',
    ].join(' ');
  }
  return 'Stay inside this role\'s allowed endpoints. Do not volunteer another department\'s numbers.';
}

function buildSystemPrompt(user, allowed) {
  const name = user?.name || 'there';
  const role = user?.role || 'user';
  const list = allowed.map((e) => `- ${e.id}: ${e.desc}`).join('\n');
  const leaderTool = LEADERS.includes(role)
    ? 'You also have company_brief for a live snapshot of operations (and, for Admin, full finance). Call it before answering company-wide questions.'
    : '';
  return [
    `You are JARVIS, the assistant inside the Cres Dynamics CRM, talking to ${name} (${role}).`,
    `Today is ${nairobiNow()} (Africa/Nairobi).`,
    roleRules(role),
    leaderTool,
    'Answer only from tool results; look things up before answering; never invent names, figures, dates or statuses.',
    'Read-only: if asked to change something, say which CRM page to use.',
    'If data is outside the role or a tool says "Not allowed", say their role doesn\'t have access — no guessing, no workarounds.',
    'Never reveal another person\'s salary, personal details or private messages unless the tool returned them for this user.',
    'Brief: direct answer first, then key facts; KES for money. Format for a small chat panel: plain sentences, **bold** for emphasis and "- " bullet lines only — no tables, headings or links in markdown syntax.',
    'Allowed endpoint ids:',
    list,
  ].filter(Boolean).join('\n');
}

function clipHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: String(turn.content).slice(0, MAX_HISTORY_CHARS),
    }));
}

function buildTools(allowedIds, role) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'crm_get',
        description:
          'Read CRM data the signed-in user is allowed to see. Pick an endpoint id from the enum. For paths with :id, pass id. For search, pass query.q.',
        parameters: {
          type: 'object',
          properties: {
            endpoint: { type: 'string', enum: allowedIds, description: 'Allowlisted endpoint id' },
            id: { type: 'string', description: 'Record id substituted for :id' },
            query: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Optional query string parameters',
            },
          },
          required: ['endpoint'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_knowledge',
        description: 'Search the organisation knowledge base for policies, processes, and notes this role can access.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Search text' },
          },
          required: ['text'],
        },
      },
    },
  ];
  if (LEADERS.includes(role)) {
    tools.unshift({
      type: 'function',
      function: {
        name: 'company_brief',
        description:
          role === 'admin'
            ? 'Live company snapshot: logins, what people did, sales, HR, projects, developer updates, pending invoices, cleared receipts, and full finance.'
            : 'Live company snapshot: logins, what people did, sales, HR operations, projects, developer updates, pending invoices, and stamped receipts for cleared payments. No balances, expenses, or payroll.',
        parameters: { type: 'object', properties: {} },
      },
    });
  }
  return tools;
}

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function openRouterComplete({ messages, tools, toolChoice }) {
  const key = config.openRouter.apiKey;
  if (!key) {
    throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
  }

  const body = {
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 1500,
  };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  let res;
  try {
    res = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.openRouter.siteUrl,
          'X-Title': config.openRouter.appName,
        },
        body: JSON.stringify(body),
      },
      75000
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
    }
    throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
  }

  if (res.status === 402) {
    throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[jarvis] OpenRouter HTTP', res.status);
    throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
  }

  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
  }
  return message;
}

function sanitizeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {};
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_KEY_RE.test(key)) continue;
    out[key] = String(value ?? '').slice(0, QUERY_VALUE_MAX);
  }
  return out;
}

function filterDirectorPayload(endpointId, data) {
  if (endpointId !== 'invoices' && endpointId !== 'invoice') return data;
  const keep = (row) => PENDING_INVOICE_STATUSES.includes(String(row?.status || ''));
  if (Array.isArray(data)) return data.filter(keep);
  if (data && typeof data === 'object' && Array.isArray(data.items)) {
    return { ...data, items: data.items.filter(keep) };
  }
  if (data && typeof data === 'object' && data.status && !keep(data)) {
    return {
      notice:
        'This invoice is not pending. Director may only see pending/overdue invoices or stamped receipts for cleared payments.',
      status: data.status,
      invoice_number: data.invoice_number || null,
    };
  }
  return data;
}

async function executeCrmGet({ user, authHeader, endpointId, id, query }) {
  if (user?.role === 'director' && DIRECTOR_BLOCKED_ENDPOINTS.has(endpointId)) {
    return 'ERROR: Not allowed for this user\'s role.';
  }
  const entry = allowedEndpoints(user).find((e) => e.id === endpointId);
  if (!entry) return 'ERROR: Not allowed for this user\'s role.';

  let path = entry.path;
  if (path.includes(':id')) {
    const raw = id == null ? '' : String(id);
    if (!ID_RE.test(raw)) return 'ERROR: This endpoint requires a valid id.';
    path = path.replace(':id', encodeURIComponent(raw));
  }

  const url = new URL(path, `http://127.0.0.1:${config.port}`);
  const params = sanitizeQuery(query);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let res;
  try {
    res = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      },
      20000
    );
  } catch {
    return 'ERROR: Lookup failed.';
  }

  if (res.status === 403) return 'ERROR: Not allowed for this user\'s role.';
  if (res.status === 404) return 'ERROR: Not found.';
  if (!res.ok) return 'ERROR: Lookup failed.';

  const body = await res.json().catch(() => ({}));
  let payload = body.data ?? body;
  if (user?.role === 'director') payload = filterDirectorPayload(endpointId, payload);
  return scrubResult(payload);
}

async function executeSearchKnowledge(user, text) {
  const searchText = String(text || '').trim();
  if (!searchText) return 'ERROR: text is required.';
  try {
    const rows = await searchKnowledge({
      searchText,
      role: user.role,
      limit: 6,
    });
    return scrubResult(rows);
  } catch {
    return 'ERROR: Knowledge search failed.';
  }
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function runTool({ user, authHeader, name, args, used }) {
  if (name === 'company_brief') {
    used.push('company_brief');
    if (!LEADERS.includes(user?.role)) return 'ERROR: Not allowed for this user\'s role.';
    const brief = await gatherCompanyBrief(user);
    return scrubResult(brief);
  }
  if (name === 'crm_get') {
    const endpoint = String(args.endpoint || '');
    if (endpoint) used.push(endpoint);
    return executeCrmGet({
      user,
      authHeader,
      endpointId: endpoint,
      id: args.id,
      query: args.query,
    });
  }
  if (name === 'search_knowledge') {
    return executeSearchKnowledge(user, args.text);
  }
  return 'ERROR: Unknown tool.';
}

async function askJarvis({ user, authHeader, message, history }) {
  if (!config.openRouter.apiKey) {
    throw new AppError('Jarvis is temporarily unavailable', 503, 'JARVIS_UNAVAILABLE');
  }

  const allowed = allowedEndpoints(user);
  const allowedIds = allowed.map((e) => e.id);
  const tools = allowedIds.length || LEADERS.includes(user?.role)
    ? buildTools(allowedIds, user?.role)
    : undefined;
  const used = [];

  const question = String(message || '').slice(0, MAX_MESSAGE);
  const messages = [
    { role: 'system', content: buildSystemPrompt(user, allowed) },
    ...clipHistory(history),
    { role: 'user', content: question },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const reply = await openRouterComplete({ messages, tools });
    const calls = reply.tool_calls || [];
    if (!calls.length) {
      return { answer: String(reply.content || '').trim(), used: [...new Set(used)] };
    }

    messages.push({
      role: 'assistant',
      content: reply.content || '',
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function?.name || call.name;
      const args = parseToolArgs(call.function?.arguments ?? call.arguments);
      const content = await runTool({ user, authHeader, name, args, used });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      });
    }
  }

  // Out of lookup rounds: the history holds tool calls, so the tools must still be
  // declared, but forbid another call and make the model answer with what it has.
  const final = await openRouterComplete({ messages, tools, toolChoice: tools ? 'none' : undefined });
  return {
    answer: String(final.content || '').trim() || 'I could not finish looking that up.',
    used: [...new Set(used)],
  };
}

module.exports = {
  askJarvis,
  allowedEndpoints,
  CATALOG,
};
