# CRM UI review — phase progress

Demo logins: `Password123!` · `admin`, `sales`, `director`, `dev`, `finance`, `pm`, `hr`, `client` @cresdynamics.local.

## Phase 1 (approved before this work)

Community CSS restored, dead Inbox AI script removed, modal scroll lock, spec text replaced, `format.js` (KES / 21 Oct 2026 / +254), Chart.js vendored.

## Phase 2 — Profile menu + My work

**Changed**
- Personal items left the sidebar. Profile menu is **My leave · My pay · Settings · Help** for staff. Clients get Settings only (no Cres Ops).
- Staff **My work** (`#/work`) combines today’s tasks with the daily report. Daily fields: Done today · Blocked by · Tomorrow’s top 3. Feelings questions move to a Friday check-in.
- `#/tasks` redirects to My work. Sales / developer / HR `#/reports` redirects (HR to home). Hub Reports stays for Admin, Director, PM, Finance.
- My leave / My pay use `?mine=1` so HR/Admin can still open the people/payroll hubs from the sidebar.

**Verified:** all eight demo roles login and load their home dashboards (200).

**Pending then:** Approvals inbox, Finance billing tabs, Sales pipeline (Phase 3).

## Phase 3 — Approvals, Billing, Pipeline

**Changed**
- One **Approvals** inbox (`GET /api/approvals`) for project, expense, salary funding, and leave rows, with Approve / Reject on the row.
- Finance **Billing** is one page with tabs over invoices, payments, project balances, and flag follow-up. Payment form has Method (M-Pesa · Bank · Cash) and “M-Pesa code / bank ref”. Expense categories include Hosting, Domains, Transport, Ads, Salaries, Owner’s drawings.
- Sales **Pipeline** uses stage tabs (New · Contacted · Meeting · Proposal · Won · Lost). Existing lead statuses map in the UI without rewriting rows. **Mark as won** creates the client, a pending project, and an optional deposit invoice.
- Director invoices show paid and balance. Finance can use Community chat (server permissions + matrix). Migration `013_pipeline_billing.sql`.

**Verified:** all eight roles login 200; dashboards 200; developer/finance/pm/hr/client 403 on `/api/leads`.

**Pending then:** shared client card and project page (Phase 4).

## Phase 4 — Shared client card and project page

**Changed**
- Shared **client card** (`public/js/clientCard.js`): name, business, Call / WhatsApp / Email, projects, and invoiced / paid / balance for Admin, Finance, Director, Sales. Opens from Pipeline → Clients, global search, and Finance’s payment client summary. PM still has no `clients:view`; contact is on the project page instead.
- Shared **project extras** on the Sales/Admin/Director/Developer modal, the PM page, and (in Phase 5) the client page: contact with Call/WhatsApp, due date, change requests with Accept · Quote · Decline, project message thread, money ledger (Admin / Finance / Director), developer **Blocked, waiting on client**.
- Project list shows value / due / progress where the role can see them. PM health prefers `projects.due_date` when set. Developer **My projects** also shows pending invitations.
- Standalone **Change requests** menu item removed; `#/changes` redirects to projects.
- Migration `014_project_messages_mpesa.sql` (`project_messages`, CR decide fields). Idempotent; no existing rows rewritten.

**Verified:** all eight roles login 200 and dashboards 200. Sales/Finance `GET /api/clients/:id` 200 with balance. PM `GET /api/clients` 403 as designed.

## Phase 5 — Client portal: Pay with M-Pesa and messages

**Changed**
- Unpaid client invoices have **Pay with M-Pesa**. UI shows Paybill **542542** / Account **43869**. Client submits the M-Pesa code; Finance is notified and sees the code on the invoice. No Daraja call — Finance still records the payment.
- One **message thread per project**, visible to the client, Sales, and the PM (not Community chat; Finance cannot post).
- **Request a change** sits on the project page next to milestone sign-off. Staff decide Accept / Quote / Decline there.
- Cres Ops stays hidden from clients (profile + `#/ops` redirect from Phase 2).

**Verified:** all eight roles login 200 and dashboards 200. Client invoices 200 (includes `mpesa_claim_*`). `GET /app.html` 200 with client card modal and M-Pesa panel.

## Phase 6 — Sidebar groups, HR hiring, expense path, login freeze

**Changed**
- Admin sidebar is nine items: **Home · Approvals · Pipeline · Projects · Money · People · Reports · Websites · System**. Tabs live inside the pages. Users / Login audit / System health → System. Employees / Leave / Payroll / Applicants / Onboarding → People. Billing (invoices, record payment, collections) and Expenses → Money. Website traffic and Event registrations → Websites. Team chat is in the Admin profile menu so the sidebar stays at nine.
- **Timeline** is a tab on Projects for Admin, Director, and PM (`#/projects?tab=timeline`). The sidebar item is gone; `#/timeline` redirects.
- Admin and Director **Reports** use tabs: Analytics · Daily reports · Audit. Only the active tab loads.
- **Website payments** is **Event registrations** in the UI (Finance nav item, Admin Websites tab, page copy).
- If `WEBSITE_DATABASE_URL` is unset, traffic and event registrations return HTTP 200 with `connected: false` / `message: "Not connected yet"`. The UI shows **Not connected yet** instead of an error.
- HR **Applicants** (name, email, phone, role applied for, stage Applied/Interview/Offer/Hired/Rejected, interview date, notes) and **Onboarding** (checklist + 30/60/90-day goals per employee) are People tabs. Migration `015_applicants_onboarding.sql`. Guarded with `employees:*` plus hr/admin on the server.
- Director expenses need **Finance** only; **Admin** is required only above the existing threshold (default 500). Admin-submitted expenses are auto-approved.
- Login load: socket connects after first paint (websocket only, 4s timeout, delayed poll fallback), Chart.js animation off, only the signed-in role’s modules mount, traffic/health polling stops when you leave the page.

**Verified:** all eight demo roles login 200. Sidebar APIs for each role 200 (no 5xx). Website traffic and event registrations 200 `connected: false`. HR POST applicant 201. Admin expense auto-approved; Director 200 → Finance `approved`, Director 800 → Finance `pending_admin`. Login + home dashboard APIs returned in well under a second (no ~30s wait on the API side). Browser DevTools were not available in this session, so a visual click-through of every hash route was not run here.

**Still pending**
- Seeded demo phones on existing rows remain `+1…` (ground rules forbade rewriting them).
- Admin Team chat is in the profile menu, not the sidebar, to keep the nine-item cap.
