# Jarvis side panel — implementation spec

A read-only AI assistant ("Jarvis") available in a side panel on **every role's screen**
(admin, director, sales, developer, finance, pm, hr, client). It answers questions about the
organisation using only data the signed-in user is already allowed to see.

This is NOT the laptop Jarvis in `jarvis/`. Do not import from, change, or run anything in
`jarvis/`. This feature lives entirely in the CRM (`src/` and `public/`).

## Rules that must hold

1. **Read-only.** Jarvis can only read. No create/update/delete/approve/send of any kind.
2. **Same access as the user.** Every data lookup is an HTTP `GET` to this same server
   (`http://127.0.0.1:${config.port}`) with the **user's own `Authorization` header**, so the
   existing `authenticate` + `requirePermission` / scoping on each route applies unchanged.
3. **Allowlist only.** The model may only call endpoints from a fixed catalog (below), filtered
   per user by `hasPermission(user, resource, action)` (any-of) and, where given, by role.
   The model picks an endpoint **id** from an enum; it never supplies a raw URL/path.
4. **Clients see only the client portal.** The `client` role gets only `me` + `portal_*` entries.
   Staff roles never get `portal_*` entries.
5. **No secrets in model input.** Before sending any tool result to the model, drop keys matching
   `/(password|passwd|secret|token|hash|api_?key|otp)/i`, cap arrays at 60 items, strings at
   1500 chars, and the whole result at 14 000 chars.
6. **Cost control.** Per-user limit `JARVIS_CRM_RATE_PER_HOUR` (default 40) requests/hour
   (in-memory is fine). Max 6 tool rounds per question. `max_tokens` 1500.
7. Never log the user's token or the OpenRouter key.

## Backend

### `src/services/jarvisAssistant.js` (new)

Exports `askJarvis({ user, authHeader, message, history })`, `allowedEndpoints(user)`, `CATALOG`.

- Model: `process.env.JARVIS_CRM_MODEL || 'anthropic/claude-sonnet-5.5'`, via OpenRouter
  chat completions (`https://openrouter.ai/api/v1/chat/completions`) with OpenAI-style
  `tools`, using `config.openRouter.apiKey`, `siteUrl`, `appName` (see
  `src/services/openRouter.js` for headers). Temperature 0.2.
- Two tools:
  - `crm_get { endpoint: enum<allowed ids>, id?: string, query?: {string:string} }`
    - `id` must match `/^[\w-]{1,64}$/`, substituted for `:id` (URL-encoded).
    - `query` keys must match `/^[\w.-]{1,40}$/`, values capped at 200 chars.
    - 403 → tool result `ERROR: Not allowed for this user's role.`
    - Use `body.data ?? body`, scrubbed per rule 5.
  - `search_knowledge { text }` → `searchKnowledge({ searchText, role: user.role, limit: 6 })`
    from `src/services/knowledgeService.js`, scrubbed.
- Loop: send messages + tools; execute every tool call; repeat until the model answers with
  no tool calls (max 6 rounds). History: last 10 user/assistant turns, each ≤ 2000 chars;
  message ≤ 4000 chars. Returns `{ answer, used: [endpoint ids] }`.
- OpenRouter 402 (no credit) → respond 503 with message "Jarvis is temporarily unavailable".
- System prompt (fill in name/role/date, Nairobi time zone):
  - You are JARVIS, the assistant inside the Cres Dynamics CRM, talking to {name} ({role}).
  - Answer only from tool results; look things up before answering; never invent names,
    figures, dates or statuses.
  - Read-only: if asked to change something, say which CRM page to use.
  - If data is outside the role or a tool says "Not allowed", say their role doesn't have
    access — no guessing, no workarounds.
  - Never reveal another person's salary, personal details or private messages unless the
    tool returned them for this user.
  - Brief: direct answer first, then key facts; KES for money; short lists/tables.
  - List the allowed endpoint ids with their descriptions.

#### Catalog

`any` = at least one permission required; `roles` = only these roles.
STAFF = admin, director, sales, developer, finance, pm, hr. LEADERS = admin, director.

| id | path | any | roles |
|---|---|---|---|
| me | /api/auth/me | – | STAFF + client |
| notifications | /api/notifications | notifications:view | – |
| approvals | /api/approvals | – | STAFF |
| admin_dashboard | /api/admin/dashboard | query:view | LEADERS |
| daily_digest | /api/admin/daily-digest | reports:view | LEADERS |
| director_dashboard | /api/director/dashboard | projects:approve, invoices:view | LEADERS |
| director_approvals | /api/director/approvals | projects:approve | LEADERS |
| sales_dashboard | /api/sales/dashboard | leads:view, projects:view | sales + LEADERS |
| developer_dashboard | /api/developer/dashboard | projects:view | developer, admin |
| developer_projects | /api/developer/projects | projects:view | developer, admin |
| pm_dashboard | /api/pm/dashboard | projects:view | pm + LEADERS |
| pm_projects | /api/pm/projects | projects:view | pm + LEADERS |
| pm_project | /api/pm/projects/:id | projects:view | pm + LEADERS |
| finance_overview | /api/finance/overview | cash_flow:view, account_balance:view, invoices:view | finance + LEADERS |
| finance_dashboard | /api/finance/dashboard | cash_flow:view, account_balance:view | finance + LEADERS |
| finance_projects | /api/finance/projects | projects:view | finance + LEADERS |
| cash_flow_report | /api/finance/cash-flow-report | cash_flow:view, account_balance:view | finance + LEADERS |
| website_payments | /api/finance/website-payments | cash_flow:view, payments:view | finance + LEADERS |
| hr_dashboard | /api/hr/dashboard | salaries:view | hr + LEADERS |
| hr_applicants | /api/hr/applicants | employees:view | hr + LEADERS |
| hr_onboarding | /api/hr/onboarding | employees:view | hr + LEADERS |
| site_analytics | /api/analytics/summary | – | LEADERS |
| system_health | /api/admin/health/overview | – | admin |
| failed_jobs | /api/admin/failed-jobs | settings:view | admin |
| email_activity | /api/admin/email-activity | settings:view | admin |
| admin_inbox | /api/admin/inbox | users:view | LEADERS |
| admin_inbox_item | /api/admin/inbox/:id | users:view | LEADERS |
| search | /api/search (query q) | query:view | STAFF |
| clients | /api/clients | clients:view | STAFF |
| client | /api/clients/:id | clients:view | STAFF |
| client_projects | /api/clients/:id/projects | clients:view | STAFF |
| emails | /api/emails | clients:view | STAFF |
| leads | /api/leads | leads:view | STAFF |
| lead | /api/leads/:id | leads:view | STAFF |
| lead_engagements | /api/leads/:id/engagements | leads:view | STAFF |
| projects | /api/projects | projects:view | STAFF |
| project | /api/projects/:id | projects:view | STAFF |
| project_updates | /api/projects/:id/updates | projects:view | STAFF |
| project_change_requests | /api/projects/:id/change-requests | projects:view | STAFF |
| project_timeline | /api/projects/meta/timeline | projects:view | STAFF |
| developer_workload | /api/projects/meta/developer-workload | projects:view | STAFF |
| assignments_pending | /api/assignments/pending | projects:view | STAFF |
| tasks | /api/tasks | tasks:view | STAFF |
| reports | /api/reports | reports:view | STAFF |
| attendance_team | /api/attendance/team | reports:view | STAFF |
| report_compliance | /api/attendance/report-compliance | reports:view | STAFF |
| audit | /api/audit | reports:view | STAFF |
| invoices | /api/invoices | invoices:view | STAFF |
| invoice | /api/invoices/:id | invoices:view | STAFF |
| invoice_followups | /api/invoices/followups | invoice_followups:view | STAFF |
| balances | /api/invoices/meta/balances | account_balance:view | STAFF |
| payments | /api/payments | payments:view | STAFF |
| expenses | /api/expenses | expenses:view | STAFF |
| salaries | /api/salaries | salaries:view | STAFF |
| my_salary | /api/salaries/me | salaries:view | STAFF |
| salary_funding | /api/salaries/funding/summary | salaries:view | STAFF |
| employees | /api/salaries/employees | employees:view | STAFF |
| my_leave | /api/leave/mine | leave:view | STAFF |
| leave | /api/leave | leave:view, employees:view | STAFF |
| conversations | /api/messages/conversations | messages:view | STAFF |
| users | /api/users | users:view | STAFF |
| portal_dashboard | /api/client/dashboard | – | client |
| portal_projects | /api/client/projects | – | client |
| portal_project | /api/client/projects/:id | – | client |
| portal_invoices | /api/client/invoices | – | client |
| portal_change_requests | /api/client/change-requests | – | client |

Do NOT add file downloads (`/receipt/file`), CSV exports, `/api/query`, or any non-GET route.

### `src/routes/jarvis.js` (new), mounted at `/api/jarvis` in `src/app.js`

- `router.use(authenticate)`.
- `GET /capabilities` → `{ ok: true, data: { enabled: Boolean(apiKey), topics: allowedEndpoints(req.user).map(e => ({ id, desc })) } }`.
- `POST /ask` body `{ message, history? }` → validate non-empty `message` (400 otherwise) →
  `askJarvis({ user: req.user, authHeader: req.headers.authorization, message, history })` →
  `{ ok: true, data: { answer, used } }`. Use `asyncHandler` / `AppError` from `src/lib/errors.js`.
- Add `JARVIS_CRM_MODEL` and `JARVIS_CRM_RATE_PER_HOUR` (commented, optional) to `.env.example`.

## Frontend

### `public/js/jarvis.js` (new) + `public/css/jarvis.css` (new)

Loaded in `public/app.html` (script after `api.js`, before `shell.js`; stylesheet with the others).
Must work for every role, including the client portal, without per-role code.

- A floating round **Jarvis button** fixed bottom-right (above other floating UI; don't cover
  existing controls), using `/brand/logo-mark.png` or a glowing arc-reactor style circle.
- Clicking it opens a **right-hand slide-in side panel** (~380 px wide desktop; full screen
  on ≤ 640 px). Header: "JARVIS", subtitle "Ask about your work", close button.
- On open, call `GET /api/jarvis/capabilities` via `CresAPI.request`. If `enabled` is false,
  show "Jarvis isn't switched on yet." and disable input.
- Show 3–4 starter question chips chosen by role (`CresAPI.getUser().role`), e.g.
  sales: "Which leads need follow-up today?"; finance: "What invoices are overdue?";
  developer: "What are my open tasks?"; pm: "Which projects are behind schedule?";
  hr: "Who hasn't submitted a report today?"; director/admin: "Give me today's summary.";
  client: "What's the status of my project?".
- Chat list: user and Jarvis bubbles; Jarvis text rendered safely (escape HTML, then allow
  only **bold**, line breaks and simple `- ` lists — no raw HTML injection).
- Text input + send (Enter sends, Shift+Enter newline). While waiting show a "thinking"
  indicator; disable send. `POST /api/jarvis/ask` with `timeoutMs: 90000`, sending the last
  10 turns as `history`.
- Optional mic button: Web Speech API (`webkitSpeechRecognition`) when available, else hidden.
  Optional speaker toggle: read answers aloud with `speechSynthesis` (off by default).
- Keep the conversation in `sessionStorage` (per tab), cleared on logout. Wrap storage access
  in try/catch.
- Errors: 429/503 → show the server's message; others → "Jarvis couldn't answer just now."
- Keyboard: Escape closes the panel; focus the input on open; `aria-label`s on buttons.
- Match the CRM's design tokens in `public/css/tokens.css` (colours, radius, fonts) and support
  the existing dark/light theme if the CRM has one.

## Out of scope / do not do

- Do not modify `jarvis/`, `.env`, database schema or migrations, or existing routes' guards.
- Do not run the server, migrations, seeds, `git commit`, or `git push`.
- Do not add dependencies (Node 18+ global `fetch` is enough).

## Done means

- `node --check` passes on the new/changed server files.
- New route mounted; `.env.example` updated; panel script/style linked in `app.html`.
- A short summary of what was changed, file by file.
