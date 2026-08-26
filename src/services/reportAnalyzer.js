/**
 * AI-powered report analyzer for Director review.
 * Gathers full context about the reporter and generates director-level questions.
 */
const { query } = require('../config/database');
const { groqChat } = require('./groq');

/**
 * Gather full context about a reporter for AI analysis.
 */
async function gatherReportContext(report) {
  const userId = report.user_id;
  const projectId = report.project_id;

  // 1. Reporter info
  const { rows: reporter } = await query(
    `SELECT u.id, u.name, u.email, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

  // 2. Reporter's tasks (all statuses)
  const { rows: tasks } = await query(
    `SELECT title, description, status, due_date, project_id, created_at
     FROM tasks
     WHERE assigned_to = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );

  // 3. Reporter's recent previous reports (last 5)
  const { rows: previousReports } = await query(
    `SELECT content, blockers_text, needs_attention, work_done, created_at, project_id
     FROM daily_reports
     WHERE user_id = $1 AND id != $2
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId, report.id]
  );

  // 4. Yesterday's report
  const { rows: yesterdayReport } = await query(
    `SELECT content, blockers_text, needs_attention, work_done, created_at
     FROM daily_reports
     WHERE user_id = $1
       AND created_at >= (DATE($2) - INTERVAL '1 day')
       AND created_at < DATE($2) + INTERVAL '1 day'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, report.created_at]
  );

  // 5. Project milestones + timeline (if project linked)
  let projectContext = null;
  if (projectId) {
    const { rows: projects } = await query(
      `SELECT p.name, p.status, p.milestones, p.value_amount, p.assigned_developer_id,
              p.created_at, p.updated_at,
              d.name AS developer_name
       FROM projects p
       LEFT JOIN users d ON d.id = p.assigned_developer_id
       WHERE p.id = $1`,
      [projectId]
    );
    projectContext = projects[0] || null;
  }

  // 6. Reporter's open tasks on the same project
  let projectTasks = [];
  if (projectId) {
    const { rows } = await query(
      `SELECT title, status, due_date, created_at
       FROM tasks
       WHERE assigned_to = $1 AND project_id = $2
       ORDER BY due_date ASC`,
      [userId, projectId]
    );
    projectTasks = rows;
  }

  // 7. Blockers history from all reports
  const { rows: blockerHistory } = await query(
    `SELECT blockers_text, created_at
     FROM daily_reports
     WHERE user_id = $1 AND blockers_text IS NOT NULL AND blockers_text != ''
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId]
  );

  return {
    reporter: reporter[0] || null,
    currentReport: {
      content: report.content,
      work_done: report.work_done,
      blockers_text: report.blockers_text,
      needs_attention: report.needs_attention,
      hard_today: report.hard_today,
      easy_today: report.easy_today,
      happiness: report.happiness,
      concerns: report.concerns,
      created_at: report.created_at,
    },
    tasks,
    previousReports,
    yesterdayReport: yesterdayReport[0] || null,
    projectContext,
    projectTasks,
    blockerHistory,
  };
}

/**
 * Build the Groq prompt for director-level analysis.
 */
function buildAnalysisPrompt(ctx) {
  const tasksSummary = ctx.tasks.length
    ? ctx.tasks.map((t) =>
        `- [${t.status}] ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ''}`
      ).join('\n')
    : 'No tasks assigned.';

  const projectTasksSummary = ctx.projectTasks.length
    ? ctx.projectTasks.map((t) =>
        `- [${t.status}] ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ''}`
      ).join('\n')
    : 'No project-specific tasks.';

  const prevReportsSummary = ctx.previousReports.length
    ? ctx.previousReports.map((r, i) =>
        `Report ${i + 1} (${new Date(r.created_at).toLocaleDateString()}):\n${(r.content || '').slice(0, 300)}`
      ).join('\n\n')
    : 'No previous reports.';

  const milestoneSummary = ctx.projectContext?.milestones
    ? (Array.isArray(ctx.projectContext.milestones) ? ctx.projectContext.milestones : [])
        .map((m) => `- [${m.status || 'pending'}] ${m.title || m.name || 'Unnamed'}${m.due_date ? ` (due: ${m.due_date})` : ''}`)
        .join('\n')
    : 'No milestones defined.';

  const blockerHistory = ctx.blockerHistory.length
    ? ctx.blockerHistory.map((b) =>
        `${new Date(b.created_at).toLocaleDateString()}: ${(b.blockers_text || '').slice(0, 200)}`
      ).join('\n')
    : 'No prior blockers.';

  const system = `You are an experienced Director at Cres Dynamics reviewing a team member's daily report.
Your role is to generate clarifying questions and observations that a thorough director would ask.

Based on the full context provided — the reporter's tasks, project milestones, previous reports, yesterday's report, and blocker history — generate 3-6 targeted questions.

Focus areas:
- Delivery: Are timelines being met? Are tasks progressing as expected?
- Blockers: Are blockers being addressed? Are there recurring patterns?
- Clients: Any client-facing concerns or follow-ups needed?
- Growth: Is the person learning, improving, or stagnating?
- Follow-ups: What needs to happen next that wasn't mentioned?
- Quality: Does the report show thorough work or surface-level reporting?

RULES:
- Questions should be specific and reference actual data (task names, milestone names, dates)
- Be professional but direct — this is how a director naturally communicates
- Do NOT sound robotic or generic
- Do NOT mention AI or automation
- Format as numbered questions, each on its own line
- Tag each question with [DELIVERY], [BLOCKERS], [CLIENTS], [GROWTH], [FOLLOW-UPS], or [QUALITY]`;

  const projectBlock = ctx.projectContext
    ? `
PROJECT: ${ctx.projectContext.name}
Project status: ${ctx.projectContext.status}
Milestones:
${milestoneSummary || 'None'}
Project developer: ${ctx.projectContext.developer_name || 'Unassigned'}`
    : '';

  const user = `REPORTER: ${ctx.reporter?.name || 'Unknown'} (${ctx.reporter?.role || 'unknown role'})

TODAY'S REPORT (${new Date(ctx.currentReport.created_at).toLocaleDateString()}):
${ctx.currentReport.content || '(empty)'}

${ctx.currentReport.blockers_text ? `Blockers: ${ctx.currentReport.blockers_text}` : ''}
${ctx.currentReport.needs_attention ? `Needs attention: ${ctx.currentReport.needs_attention}` : ''}
${ctx.currentReport.concerns ? `Concerns: ${ctx.currentReport.concerns}` : ''}
${ctx.currentReport.happiness ? `Mood: ${ctx.currentReport.happiness}` : ''}
${projectBlock}

REPORTER'S TASKS (all):
${tasksSummary}

TASKS ON THIS PROJECT:
${projectTasksSummary}

YESTERDAY'S REPORT:
${ctx.yesterdayReport ? ctx.yesterdayReport.content : 'No report submitted yesterday.'}

PREVIOUS 5 REPORTS:
${prevReportsSummary}

BLOCKER HISTORY:
${blockerHistory}

Generate 3-6 clarifying questions as a numbered list. Tag each with [TAG].`;

  return { system, user };
}

/**
 * Analyze a report and return director-level questions.
 */
async function analyzeReport(report) {
  const ctx = await gatherReportContext(report);
  const { system, user } = buildAnalysisPrompt(ctx);

  const { text } = await groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  });

  // Parse the numbered questions
  const questions = text
    .split('\n')
    .map((line) => line.replace(/^\d+[\.)]\s*/, '').trim())
    .filter((line) => line.length > 5 && /\[.*\]/.test(line))
    .map((line) => {
      const tagMatch = line.match(/\[([^\]]+)\]/);
      const tag = tagMatch ? tagMatch[1].toLowerCase() : 'general';
      const question = line.replace(/\[[^\]]+\]\s*/, '').trim();
      return { tag, question };
    });

  // If parsing failed to extract tagged questions, return raw as single block
  if (questions.length === 0) {
    return {
      raw: text,
      questions: [{ tag: 'general', question: text }],
      context_summary: buildContextSummary(ctx),
    };
  }

  return {
    raw: text,
    questions,
    context_summary: buildContextSummary(ctx),
  };
}

function buildContextSummary(ctx) {
  const openTasks = ctx.tasks.filter((t) => t.status !== 'done').length;
  const overdueTasks = ctx.tasks.filter((t) =>
    t.due_date && new Date(t.due_date) < new Date() && t.status !== 'done'
  ).length;
  const reportCount = ctx.previousReports.length + 1;

  return {
    open_tasks: openTasks,
    overdue_tasks: overdueTasks,
    total_reports: reportCount,
    has_blockers: !!ctx.currentReport.blockers_text,
    recurring_blockers: ctx.blockerHistory.length > 2,
  };
}

module.exports = { analyzeReport, gatherReportContext };
