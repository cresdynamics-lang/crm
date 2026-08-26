/**
 * Seed the Cres Ops knowledge base with initial onboarding content.
 * Run once: node src/db/seedOps.js
 */
const { Pool } = require('pg');

const ENTRIES = [
  // General onboarding
  {
    title: 'Welcome to Cres Dynamics — Company Overview',
    content: `Cres Dynamics is a CRM and project management platform. The company operates with these roles: Admin, Director, PM (Project Manager), Sales, Developer, HR, Finance, and Client.\n\nThe system tracks leads, projects, tasks, invoices, payments, expenses, daily reports, and employee well-being. Every action is recorded in the audit trail for transparency.\n\nThe org hierarchy: Admin > Director > PM > Sales/Developer. HR and Finance operate as support functions reporting to the Director.`,
    category: 'onboarding',
    tags: ['welcome', 'overview', 'company'],
    accessible_roles: ['all'],
  },
  {
    title: 'System Navigation Guide',
    content: `The left sidebar (nav) contains all faces/sections you have access to:\n\n- Home: Dashboard with your KPIs and recent activity\n- Leads: Manage sales leads (Sales/Admin)\n- Projects: View and manage projects (all roles see assigned projects)\n- Tasks: Create and track tasks (all roles)\n- Reports: Submit daily reports and view them (Sales/Developer submit; PM reviews; Director views all)\n- Invoices: Generate and manage invoices (Sales/Admin)\n- Payments: Record and track payments (Finance/Admin)\n- Expenses: Track company expenses (Finance/Admin)\n- Cres Ops: This knowledge assistant — ask questions about how things work\n- Settings: Your profile and notification preferences\n\nUse the top search bar to quickly find anything across the system.`,
    category: 'onboarding',
    tags: ['navigation', 'sidebar', 'guide'],
    accessible_roles: ['all'],
  },
  {
    title: 'Daily Report — How and When',
    content: `Every Sales and Developer must submit a daily report by 6 PM. The report includes:\n\n1. What was done today (overall work)\n2. Blockers encountered\n3. What needs attention\n4. How are you feeling (optional HR section): what was hard, what was easy, what made you happy, what made you think twice\n\nYou can type the report or use Voice Report to speak it. Reports go to the PM inbox first, then the PM forwards them to your assigned Director.\n\nThe Director can leave remarks on your report. You'll receive a notification when they do.`,
    category: 'processes',
    tags: ['daily report', 'submit', '6pm'],
    accessible_roles: ['all'],
  },

  // Sales-specific
  {
    title: 'Sales Daily Routine — Morning to Evening',
    content: `EXPECTED DAILY ROUTINE FOR SALES:\n\nMORNING (8:30-9:00 AM):\n- Log in and check the Home dashboard\n- Review any new leads assigned to you\n- Check Director/PM messages and notifications\n\nMID-MORNING (9:00-11:00 AM):\n- Follow up on warm leads (calls, messages)\n- Log new leads from conversations or referrals\n- Update lead status and notes\n\nAFTERNOON (11:00 AM - 4:00 PM):\n- Attend client meetings if scheduled\n- Create project proposals for qualified leads\n- Send invoices for completed work\n- Follow up on outstanding payments\n\nEND OF DAY (4:00-6:00 PM):\n- Submit your daily report via Voice Report or typing\n- Update lead pipeline status\n- Review tomorrow's tasks and appointments\n\nWHAT YOU ARE MEASURED ON:\n- Number of leads converted to projects\n- Revenue generated\n- Client satisfaction\n- Daily report consistency`,
    category: 'sales',
    tags: ['daily routine', 'sales', 'schedule'],
    accessible_roles: ['sales'],
  },
  {
    title: 'Lead Management Process',
    content: `HOW LEADS WORK AT CRES DYNAMICS:\n\n1. LEAD CAPTURE: Leads come from referrals, website, or direct outreach. Log them via the Leads page or Voice Capture.\n\n2. LEAD QUALIFICATION: Assess if the lead has budget, authority, need, and timeline (BANT).\n\n3. PROPOSAL: Create a project proposal with milestones, value, and developer assignment.\n\n4. CONVERSION: Once the client approves, the lead becomes a project. Invoice is generated.\n\n5. FOLLOW-UP: Track outstanding invoices and maintain client relationships.\n\nLead statuses: new → contacted → qualified → proposal → converted / lost\n\nUse the Voice Capture button to narrate multiple leads at once — the AI transcribes and structures them.`,
    category: 'sales',
    tags: ['leads', 'process', 'conversion'],
    accessible_roles: ['sales', 'director', 'admin'],
  },

  // Developer-specific
  {
    title: 'Developer Daily Routine',
    content: `EXPECTED DAILY ROUTINE FOR DEVELOPERS:\n\nMORNING (8:30-9:00 AM):\n- Check assigned tasks on the Tasks board\n- Review project updates and milestones\n- Check for any urgent messages from PM or Director\n\nWORK HOURS (9:00 AM - 5:00 PM):\n- Work on assigned tasks and update status (open → in_progress → done)\n- Log hours against milestones when completing work\n- Submit work for review when milestones are complete\n- Communicate blockers immediately to PM\n\nEND OF DAY (5:00-6:00 PM):\n- Update all task statuses\n- Submit daily report via Voice Report or typing\n- Note any blockers or needs for tomorrow\n\nWHAT YOU ARE MEASURED ON:\n- Task completion rate and quality\n- Milestone delivery on time\n- Code quality and attention to detail\n- Communication and collaboration`,
    category: 'development',
    tags: ['daily routine', 'developer', 'tasks'],
    accessible_roles: ['developer'],
  },
  {
    title: 'Task Management Guide',
    content: `HOW TO USE THE TASK SYSTEM:\n\n1. CREATING TASKS: Click "New task" or "Voice task" to create. Set title, description, assignee, and due date.\n\n2. TASK STATUSES: open → in_progress → done (or cancelled)\n\n3. UPDATING: Click the status buttons on any task to advance it.\n\n4. DELETING: Only the creator, assignee, or admin/director/pm can delete.\n\n5. BULK ASSIGN: Director/Admin/PM can assign tasks to all sales or all developers at once.\n\nTasks are visible to the creator, assignee, and hub roles (Director, PM, Admin).`,
    category: 'processes',
    tags: ['tasks', 'management', 'status'],
    accessible_roles: ['all'],
  },

  // Director-specific
  {
    title: 'Director Responsibilities',
    content: `DIRECTOR ROLE:\n\n- Oversee all sales and developer teams\n- Review and provide remarks on daily reports\n- Approve or reject project proposals\n- Set strategic direction for the company\n- Monitor company analytics (lead conversion, project delivery, revenue)\n- Assign tasks to team members\n- Manage the knowledge base (Cres Ops data pool)\n\nREPORT REVIEW PROCESS:\n1. Reports from your assigned team members appear in your Reports hub\n2. Read the report content, blockers, and HR sections\n3. Leave remarks if clarification is needed or to provide guidance\n4. The reporter receives a notification of your remarks\n\nPROJECT APPROVAL:\n- Projects enter as "pending_approval"\n- You approve (→ in_progress) or reject (→ rejected with reason)\n- Approved projects are assigned to developers\n\nANALYTICS:\n- View the Reports panel for lead conversion rates, developer delivery metrics, and sales volume charts`,
    category: 'onboarding',
    tags: ['director', 'responsibilities', 'review'],
    accessible_roles: ['director'],
  },

  // Finance-specific
  {
    title: 'Financial Operations Guide',
    content: `FINANCE ROLE:\n\nINVOICES:\n- Sales creates invoices; Finance tracks and reconciles\n- Invoice statuses: draft → sent → partial → paid\n- Partial payments are tracked with outstanding balance\n\nPAYMENTS:\n- Record payments against invoices via the Payments page\n- Payment receipts are auto-generated as PDF\n- Reconciliation happens automatically when full payment is received\n\nEXPENSES:\n- Track company expenses with receipts\n- Categories: operations, marketing, salaries, tools, travel\n- Expenses are reviewed by Admin/Director\n\nSALARIES:\n- Salary funding requests go: HR → Finance → Admin approval\n- Finance verifies available funds before approving\n\nRECORDS:\n- All financial actions are recorded in the audit trail\n- Monthly summaries available via Reports > Financial reports`,
    category: 'finance',
    tags: ['finance', 'invoices', 'payments', 'expenses'],
    accessible_roles: ['finance', 'director', 'admin'],
  },

  // HR-specific
  {
    title: 'HR Operations and Employee Well-being',
    content: `HR ROLE:\n\nONBOARDING:\n- New employees are created by Admin with role assignment\n- HR manages employee profiles, contracts, and documentation\n- Collect: KRA PIN, bank details, next of kin, home address\n\nLEAVE MANAGEMENT:\n- Employees request leave; HR reviews and approves/rejects\n- Track leave balances and attendance\n\nWELL-BEING:\n- Daily reports include optional HR sections:\n  - What was hard today\n  - What was easy today\n  - What made them happy\n  - What made them think twice about leaving\n- HR monitors these for signs of disengagement or burnout\n\nSALARY FUNDING:\n- HR submits salary funding requests to Finance for verification\n- Finance approves → Admin releases funds\n\nEMPLOYEE TRACKING:\n- Monitor team morale through daily report HR sections\n- Flag concerning patterns to Director`,
    category: 'hr',
    tags: ['HR', 'wellbeing', 'onboarding', 'leave'],
    accessible_roles: ['hr', 'director', 'admin'],
  },

  // Operations
  {
    title: 'How Decisions Are Made',
    content: `DECISION-MAKING AT CRES DYNAMICS:\n\nSTRATEGIC DECISIONS (Director + Admin):\n- Company direction, hiring, major investments\n- Project approval/rejection above threshold\n- Client relationship escalation\n\nOPERATIONAL DECISIONS (PM + Director):\n- Task assignments and reassignments\n- Project milestone adjustments\n- Report forwarding and escalation\n\nFINANCE DECISIONS (Finance + Admin):\n- Invoice approvals, payment processing\n- Expense reimbursements\n- Budget allocations\n\nAll decisions are recorded in the audit trail. The Director and Admin can review the full decision history via the Audit Trail.`,
    category: 'decisions',
    tags: ['decisions', 'governance', 'approval'],
    accessible_roles: ['all'],
  },
  {
    title: 'Project Lifecycle',
    content: `HOW A PROJECT MOVES THROUGH THE SYSTEM:\n\n1. PROPOSAL (Sales → Director): Sales creates project with milestones, value, developer. Status: pending_approval.\n\n2. APPROVAL (Director): Director reviews and approves or rejects. If approved: status → in_progress.\n\n3. DEVELOPMENT (Developer): Developer works on milestones, logs hours, updates progress.\n\n4. REVIEW (PM): PM reviews progress, ensures quality, communicates with client.\n\n5. COMPLETION: All milestones done → project status → completed. Invoice generated.\n\n6. PAYMENT: Client pays invoice. Finance records payment. Receipt generated.\n\nProject statuses: pending_approval → approved/in_progress → blocked → completed → deleted\n\nChange requests can be submitted at any point by Sales or the Client.`,
    category: 'processes',
    tags: ['project', 'lifecycle', 'workflow'],
    accessible_roles: ['all'],
  },
  {
    title: 'Communication and Messaging',
    content: `HOW TO COMMUNICATE IN THE SYSTEM:\n\nMESSAGING:\n- Use the Community face to send messages to any user\n- Messages are real-time via WebSocket\n- You can message anyone in the company (except clients messaging other clients)\n\nNOTIFICATIONS:\n- Bell icon shows unread notifications\n- Click to mark as read; notification preferences in Settings\n- Types: daily_report, project_update, task_assignment, payment, invoice\n\nEMAIL:\n- Sales can send emails to clients via the Email face\n- Emails are logged and tracked\n- Receipt and invoice emails include PDF attachments`,
    category: 'processes',
    tags: ['communication', 'messaging', 'notifications'],
    accessible_roles: ['all'],
  },
];

async function seed() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://airm1@localhost:5432/cres_crm' });

  let count = 0;
  for (const entry of ENTRIES) {
    try {
      await db.query(
        `INSERT INTO knowledge_base (title, content, category, tags, accessible_roles, source_type)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'system')
         ON CONFLICT DO NOTHING`,
        [entry.title, entry.content, entry.category, JSON.stringify(entry.tags), JSON.stringify(entry.accessible_roles)]
      );
      count++;
      console.log(`  + ${entry.title}`);
    } catch (e) {
      console.log(`  ! ${entry.title}: ${e.message.slice(0, 60)}`);
    }
  }

  console.log(`\nSeeded ${count}/${ENTRIES.length} knowledge base entries.`);
  await db.end();
}

seed();
