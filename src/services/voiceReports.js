/**
 * Voice daily report: speech-to-text via Groq Whisper, then LLM extraction of
 * a structured daily report with HR well-being sections.
 *
 * The speaker narrates their day: work done, blockers, how they feel.
 * The transcript is parsed into all report sections plus a project match.
 */
const { groqChat } = require('./groq');
const { transcribeAudio } = require('./voiceLeads');

/**
 * Parse a spoken narration into a structured daily report with work + HR sections.
 *
 * @param {string} transcript - speech-to-text output
 * @param {Array<{id:string,name:string}>} projects - user's available projects
 * @returns {{ content, blockers_text, needs_attention, hard_today, easy_today, happiness, concerns, project_id, project_name, done }}
 */
async function parseReportFromTranscript(transcript, projects = []) {
  const projectContext = projects.length
    ? `\n\nAvailable projects in the system (match if clearly mentioned):\n${projects.map((p) => `- "${p.name}" (id: ${p.id})`).join('\n')}`
    : '';

  const system = `You structure a daily work report from a spoken narration (speech-to-text transcript).
The speaker is a team member describing their full day — work, challenges, and emotional well-being.

Extract ALL of the following sections. Return empty string "" for any section not mentioned:

WORK SECTIONS:
- "done": array of bullet points — all work completed today (overall, not just one project).
- "blockers": array of bullet points — issues, delays, blockers.
- "needs_attention": string — anything needing follow-up or a decision.

HR / WELL-BEING SECTIONS:
- "hard_today": string — what was challenging, difficult, or frustrating today.
- "easy_today": string — what flowed smoothly, was enjoyable or satisfying.
- "happiness": string — moments that made them happy, feel valued, or part of the team.
- "concerns": string — doubts, frustrations, or thoughts about leaving.

PROJECT MATCHING:
- "project_name": project name if clearly mentioned, or null.
- "project_id": matching project id from the list, or null.

Rules:
- Do NOT fabricate details that were not spoken.
- If a section was not mentioned, return "" (empty string) for that field.
- Keep bullet points concise (one sentence each).
- If the speaker mentioned a project, match to the closest entry. If unsure, null.${projectContext}

Respond with ONLY valid JSON, no markdown:
{"done":["task1"],"blockers":[""],"needs_attention":"","hard_today":"","easy_today":"","happiness":"","concerns":"","project_name":null,"project_id":null}`;

  const { text } = await groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Transcript:\n"""${transcript.slice(0, 12000)}"""` },
    ],
    temperature: 0.1,
  });

  const cleaned = String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } else {
      throw new Error('AI returned unparseable JSON');
    }
  }

  const done = Array.isArray(parsed.done) ? parsed.done.filter(Boolean) : [];
  const blockers = Array.isArray(parsed.blockers) ? parsed.blockers.filter(Boolean) : [];
  const needs_attention = String(parsed.needs_attention || '').trim();
  const hard_today = String(parsed.hard_today || '').trim();
  const easy_today = String(parsed.easy_today || '').trim();
  const happiness = String(parsed.happiness || '').trim();
  const concerns = String(parsed.concerns || '').trim();
  const projectId = parsed.project_id || null;
  const projectName = parsed.project_name || null;

  // Build the main content field (combined formatted text)
  const lines = [];
  if (done.length) {
    lines.push('What was done:');
    done.forEach((d) => lines.push(`- ${d}`));
  }
  if (blockers.length) {
    lines.push('', 'Blockers:');
    blockers.forEach((b) => lines.push(`- ${b}`));
  }
  if (needs_attention) {
    lines.push('', 'Needs attention:', needs_attention);
  }
  if (hard_today) lines.push('', 'What was hard today:', hard_today);
  if (easy_today) lines.push('', 'What was easy today:', easy_today);
  if (happiness) lines.push('', 'What made me happy:', happiness);
  if (concerns) lines.push('', 'What made me think twice:', concerns);
  const content = lines.join('\n').trim() || transcript;

  return {
    content,
    project_id: projectId,
    project_name: projectName,
    done,
    blockers,
    needs_attention,
    hard_today,
    easy_today,
    happiness,
    concerns,
  };
}

module.exports = { transcribeAudio, parseReportFromTranscript };
