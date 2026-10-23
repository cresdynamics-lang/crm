You are working in this repo (cres-dynamics-crm: Express + Postgres backend in src/, vanilla JS frontend in public/). Below is a UI and screen-logic review of every role. Implement it in the order given in section 6 "Order of work", one phase at a time. After each phase: run the app (npm run dev, port 3000), check every role still loads (demo logins use Password123!; admin, sales, director, dev, finance, pm, hr, client @cresdynamics.local), and give me a short summary of what changed and anything left pending.

Ground rules:
- Do not drop data or change existing database rows. If a schema change is needed, add an idempotent migration in src/db/migrations and run npm run db:migrate. Also apply the pending migration 012_report_review_attendance.sql (Reports currently returns 500 for every role because daily_reports.remarks_reply_by is missing).
- Keep permissions server-side: hiding a menu item is not security. Any role/permission change goes in src/db/seed.js ROLE_PERMS and the matching route guard.
- Reuse components; don't duplicate per-role markup where one shared component with role-based sections will do.
- Use KES, dates like 21 Oct 2026, and +254 phone placeholders.
- Start with Phase 1 now.

# CRES Dynamics CRM: UI and screen-logic review, role by role (21 October 2026)

Scope: screens, sidebars, labels and the logic of what each role sees. Data and seeding are ignored, as requested.

## 1. Broken on screen for everyone
1. **Community styles are missing.** public/css/community.css was deleted but is still linked in app.html. The chat right-click menu ("Mute / Archive / Clear chat") and the "New conversation" box render as raw text under the sidebar on EVERY page for every role, and the Community page itself is unstyled. Restore the file or remove the link and the markup.
2. **Inbox AI is dead.** public/js/adminInbox.js was deleted but the Admin menu item and the script tag remain.
3. **Modals don't lock the page.** Scrolling inside "Create project" scrolls the page behind it, so the bottom of the form can't be reached.
4. **About 30 seconds of freeze after login** (seen as Admin and Sales).
5. The notification bell shows a red **0**. Hide the badge at zero.
6. **Spec text shown to users.** Admin home says "Department faces ... reuse the same components unlocked by Admin RBAC". Every home has a blurb listing what the role is not allowed to see ("no client invoice or cash-flow access", "No staff chat"). Page subtitles read like rules ("Finance cannot create projects", "In/out status only. No balances"). Replace them with one action line: what to do here.
7. Dates show US style (10/21/2026) and the phone placeholder is "+1…". Use 21 Oct 2026, +254 and KES everywhere.
8. **HR sees a "New report" button but has no permission to create reports.** Submitting will fail.

## 2. The sidebar: what to merge
The rule: one menu item per job, not per database table. Anything personal goes under the profile menu.

### Move out of every sidebar (all staff roles)
Leave, My payroll, Settings and Cres Ops are personal and help items. Put them in the profile dropdown (top right) as "My leave · My pay · Settings · Help". That removes 4 items from every role.

### Tasks + Reports become "My work"
Every staff role has Tasks and Reports (the daily report) as two items. They are one job: what I must do today, and what I did. One page, with today's tasks on top and the daily report box under them.

### Proposed menus
| Role | Today | Proposed |
|---|---|---|
| Admin | 26 items | Home · Approvals · Sales (leads, clients) · Projects (list, timeline) · Money (invoices, payments, expenses, collections) · People (employees, payroll, leave) · Reports · Websites (traffic, payments) · System (users, login audit, health, settings) |
| Sales | 14 | Home · Pipeline (leads + clients as tabs) · Projects · Collections (was My Follow-ups) · My work · Team chat |
| Director | 17 | Home · Approvals · Pipeline (view) · Projects (with timeline tab) · Money (invoices + expenses) · Team (reports, tasks) · Website traffic |
| Developer | 9 | Home · My projects · My work · Team chat |
| Finance | 16 | Home · Billing (invoices, record payment, project balances, collections/flag) · Spending (expenses + money approvals) · Reports (financial + website payments) · Team chat |
| PM | 10 | Home · Projects (list + timeline) · Team (reports review, tasks) · Team chat |
| HR | 8 | Home · People (employees, leave decisions) · Payroll (payroll + salary funding as tabs) |
| Client | 6 | Home · My projects (with change requests and messages inside) · Invoices & documents. Remove Cres Ops: it's the staff help desk. |

## 3. Screen by screen: what doesn't make sense

### Admin
- Admin sees both "My Follow-ups" (the Sales inbox) and "Flag follow-up" (the Finance tool): the flagger and the flagged. Keep one Collections page with the flag action on it.
- Approvals is split: projects in one panel, money in another, and leave is on a different page. Make **one Approvals inbox** for everything that waits on you (project, expense, salary funding, leave), each row with Approve and Reject buttons.
- Timeline is a separate page but is only a view of Projects. Make it a tab.
- "Website payments" is event-ticket registrations (Payer, Event, Ticket), not client payments. Rename it "Event registrations" and put it under Websites, or drop it.
- The Reports page mixes analytics, the action audit log and daily reports on one long scroll. Split into tabs: Analytics · Daily reports · Audit.

### Sales
- **Leads and Clients are the same person at two stages.** One Pipeline page with stage tabs: New, Contacted, Meeting, Proposal, Won (= client), Lost.
- Leads table has no next follow-up date and no deal value: the two columns a salesperson works from.
- Clients page is "read-only" with no phone, email, WhatsApp or balance, though Sales has permission to create and edit clients. No action is possible from it.
- **Create project** asks for the client all over again (manual name, business, email) instead of starting from the won lead. It has no deadline, no deposit and no currency on the value. The flow should be: Lead, then "Mark as won", which creates the client, the project and the deposit invoice in one step.
- Projects table shows no value, no due date and no progress, so Sales can't tell a client where their job stands.
- "Email client" is a separate page. Email belongs on the lead or client record as a button, with the history kept there.
- "Change requests" for staff is a read-only list that says "Respond offline". Move it inside the project page with buttons: Accept · Quote · Decline.
- Home: replace Prospects and Deals with Calls today (target 5) · Meetings this week · Deposits collected (KES) · Overdue follow-ups.

### Director
- "Invoices overview: in/out status only, no balances". A director who can see invoice amounts but not what's paid gets the worst of both. Either show balances or remove the page.
- Director can submit expenses that go Finance, then Admin. For CRES, where you are both, that's approving your own spending twice.
- Reports: the default filter is "Forwarded", so a director sees nothing until the PM acts. With a small team, show everything by default.
- Home has both "Leads total" and "Lead conversion rate". Keep the rate and add "Revenue this month".

### Developer
- Projects, Tasks and Reports are three places for one day's work. Use "My projects" plus "My work".
- No way on the screen to say "blocked, waiting on client". Add a Blocked button on the project that notifies the PM and Sales.
- "Pending invitations" (project assignments to accept) sits on Home only. It should also show as a banner on My projects.

### Finance
- Invoices, Payments, Flag follow-up and Project finances are four menu items for one cycle: bill, collect, chase. Make one Billing page with tabs.
- **Record payment** requires a "Bank reference", with an M-Pesa code only as an example in the voice prompt. Add a Method field (M-Pesa · Bank · Cash), and make the field "M-Pesa code / bank ref".
- Expense categories are only "Operational" and "Other". Add Hosting · Domains · Transport · Ads · Salaries · Owner's drawings.
- Finance is blocked from Community chat entirely, so the accountant can't message the team. Allow it.
- Clients in Finance's menu exists only to attach a client to a payment. Do that inside the payment form and remove the menu item.

### Project manager
- Projects and Timeline are separate. Make Timeline a tab.
- The PM can't see the client's name or phone, so can't chase content. Show the contact on the project page (no money).
- The project page health status ("due soon", "overdue") is computed from milestone dates only, and there's no project deadline field on the create form.
- Reports hub: review, then forward to the Director. Allow "Approve" without forwarding when nothing needs the Director.

### HR
- Employees, Payroll and Salary funding are three items for one job. Use People (directory + leave) and Payroll (monthly sheet + funding request).
- The Reports item opens the daily report form, which HR can't submit (no permission). Remove it or grant permission.
- No hiring screen: add Applicants (stage, interview date, notes) and an onboarding checklist per new hire.

### Client portal
- Read-only invoices with "Payments are recorded by Finance". Add a **Pay with M-Pesa** button on each unpaid invoice.
- No way to message anyone ("No staff chat"). Add one message thread per project, visible to Sales and the PM.
- Change requests is a separate menu item. Put "Request a change" inside the project, next to the milestone sign-off that already exists.
- Cres Ops (the staff knowledge assistant) is shown to clients. Hide it.

## 4. Things that should be the same component in every role
1. **Client card:** name, business, phone with WhatsApp and call buttons, email, projects, balance (money hidden for roles without money access), activity history. Today each role builds its own partial client table.
2. **Project page:** one page for every role, with sections shown by role: overview, milestones, files, change requests, messages, and money (Finance, Admin, Director only).
3. **Approvals inbox:** one list, filtered to what waits on the signed-in person.
4. **My work:** tasks plus the daily report for all staff.
5. **Formatting:** KES amounts, dates as 21 Oct 2026, +254 phones, and the same status colours everywhere.

## 5. The daily report form
Ten boxes, including "How are you feeling", "What made you think twice" and "considering leaving", every day. People will stop filling it in within a week. Daily: Done today · Blocked by · Tomorrow's top 3. Move the feelings questions to a Friday weekly check-in.

## 6. Order of work
1. Restore community.css, remove the dead Inbox AI script and menu, fix the modal scroll and the bell, remove the spec text (half a day).
2. Profile menu for personal items, and My work (Tasks + Reports) for all roles.
3. One Approvals inbox. Billing tabs for Finance. Pipeline for Sales, with the lead-to-project flow.
4. Shared client card and project page.
5. Client portal: Pay with M-Pesa and messages.
