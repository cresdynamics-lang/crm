/**
 * Project milestones live in projects.milestones (JSONB).
 * Shape:
 * {
 *   id, title, status, due_date?,
 *   tasks: [{ id, title, hours, status, created_at? }]
 * }
 */
const { randomUUID } = require('crypto');

const MS_STATUSES = new Set(['not_started', 'in_progress', 'blocked', 'completed']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'done']);

function normalizeStatus(status) {
  if (!status || status === 'pending') return 'not_started';
  return MS_STATUSES.has(status) ? status : 'not_started';
}

function normalizeTaskStatus(status) {
  if (!status) return 'pending';
  return TASK_STATUSES.has(status) ? status : 'pending';
}

function normalizeTask(raw = {}) {
  const hours = Number(raw.hours);
  return {
    id: raw.id || randomUUID(),
    title: String(raw.title || '').trim() || 'Task',
    hours: Number.isFinite(hours) && hours >= 0 ? hours : 0,
    status: normalizeTaskStatus(raw.status),
    created_at: raw.created_at || new Date().toISOString(),
  };
}

function normalizeMilestone(raw = {}, index = 0) {
  const title = String(raw.title || raw.name || '').trim() || `Milestone ${index + 1}`;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask) : [];
  return {
    id: raw.id || randomUUID(),
    title,
    status: normalizeStatus(raw.status),
    due_date: raw.due_date || null,
    tasks,
  };
}

function normalizeMilestones(list) {
  if (!Array.isArray(list)) return [];
  return list.map((m, i) => normalizeMilestone(m, i));
}

function milestoneLabel(m) {
  return m?.title || m?.name || 'Milestone';
}

function pendingHours(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  let hours = 0;
  let tasks = 0;
  for (const m of list) {
    for (const t of m.tasks || []) {
      if (t.status !== 'done') {
        hours += Number(t.hours) || 0;
        tasks += 1;
      }
    }
  }
  return { pending_hours: hours, pending_tasks: tasks };
}

/** % complete from milestone statuses (developer-updated ceilings / milestones). */
function progressPercent(milestones) {
  const list = normalizeMilestones(Array.isArray(milestones) ? milestones : []);
  if (!list.length) return 0;
  const done = list.filter((m) => normalizeStatus(m.status) === 'completed').length;
  return Math.round((done / list.length) * 100);
}

function newlyCompletedMilestones(beforeList, afterList) {
  const before = Array.isArray(beforeList) ? beforeList : [];
  const after = Array.isArray(afterList) ? afterList : [];
  const completed = [];
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    const aStatus = normalizeStatus(a.status);
    if (aStatus !== 'completed') continue;
    const b = before.find((x) => x.id && a.id && x.id === a.id) || before[i];
    const bStatus = normalizeStatus(b?.status);
    if (bStatus !== 'completed') {
      completed.push(normalizeMilestone(a, i));
    }
  }
  return completed;
}

const STATUS_WORDS = {
  not_started: 'not started',
  in_progress: 'in progress',
  blocked: 'on hold',
  completed: 'completed',
};

function fmtDate(d) {
  if (!d) return null;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' });
}

/**
 * Client-facing list of milestone changes between two lists (matched by id,
 * falling back to the same title). Task-level edits are internal and not included.
 * Returns [{ kind, title, text }].
 */
function describeMilestoneChanges(beforeList, afterList) {
  const before = normalizeMilestones(Array.isArray(beforeList) ? beforeList : []);
  const after = normalizeMilestones(Array.isArray(afterList) ? afterList : []);
  const usedBefore = new Set();
  const out = [];

  after.forEach((a) => {
    // Match by id; otherwise (older rows saved without ids) by the same title.
    let b = before.find((x) => !usedBefore.has(x) && x.id && x.id === a.id);
    if (!b) {
      b = before.find(
        (x) => !usedBefore.has(x) && !after.some((y) => y.id === x.id) && milestoneLabel(x) === milestoneLabel(a)
      );
    }
    if (b) usedBefore.add(b);
    const title = milestoneLabel(a);
    if (!b) {
      out.push({ kind: 'added', title, text: `New milestone added: "${title}"${a.due_date ? ` (due ${fmtDate(a.due_date)})` : ''}` });
      return;
    }
    if (milestoneLabel(b) !== title) {
      out.push({ kind: 'renamed', title, text: `Milestone "${milestoneLabel(b)}" renamed to "${title}"` });
    }
    if (b.status !== a.status) {
      out.push({
        kind: a.status === 'completed' ? 'completed' : 'status',
        title,
        text: a.status === 'completed'
          ? `Milestone "${title}" is completed`
          : `Milestone "${title}" is now ${STATUS_WORDS[a.status] || a.status.replace(/_/g, ' ')}`,
      });
    }
    if ((b.due_date || null) !== (a.due_date || null)) {
      out.push({
        kind: 'due_date',
        title,
        text: a.due_date
          ? `Milestone "${title}" due date set to ${fmtDate(a.due_date)}`
          : `Milestone "${title}" due date removed`,
      });
    }
  });

  for (const b of before) {
    if (!usedBefore.has(b)) {
      out.push({ kind: 'removed', title: milestoneLabel(b), text: `Milestone "${milestoneLabel(b)}" removed from the plan` });
    }
  }
  return out;
}

module.exports = {
  describeMilestoneChanges,
  MS_STATUSES,
  TASK_STATUSES,
  normalizeStatus,
  normalizeTaskStatus,
  normalizeTask,
  normalizeMilestone,
  normalizeMilestones,
  milestoneLabel,
  pendingHours,
  progressPercent,
  newlyCompletedMilestones,
};
