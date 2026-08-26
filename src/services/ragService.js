/**
 * RAG (Retrieval Augmented Generation) service for Cres Ops.
 * Combines knowledge base + audit trail context to answer employee questions
 * with role-based access control.
 */
const { groqChat } = require('./groq');
const {
  getAccessibleKnowledge,
  getRecentAudit,
  getConversationHistory,
  saveConversation,
} = require('./knowledgeService');

// Roles that can answer sensitive questions
const SENSITIVE_ROLES = {
  finance: ['finance'],
  hr: ['hr', 'admin'],
  strategy: ['director', 'admin'],
  decisions: ['director', 'admin', 'pm'],
};

/**
 * Check if a user's role allows answering a question about a given category.
 * Returns { allowed, redirectRole } — if not allowed, suggests who to contact.
 */
function checkAccess(userRole, questionCategory) {
  // Directors and Admins can access everything
  if (['director', 'admin'].includes(userRole)) {
    return { allowed: true, redirectRole: null };
  }

  // Check sensitive categories
  for (const [cat, allowedRoles] of Object.entries(SENSITIVE_ROLES)) {
    if (questionCategory === cat && !allowedRoles.includes(userRole)) {
      const redirect = cat === 'finance' ? 'Finance'
        : cat === 'hr' ? 'HR'
        : cat === 'strategy' ? 'Director'
        : cat === 'decisions' ? 'Director or PM'
        : 'the appropriate department';
      return { allowed: false, redirectRole: redirect };
    }
  }

  // Sales can access sales, onboarding, processes, general
  // Developer can access development, onboarding, processes, general
  // Everyone can access onboarding, processes, general
  const roleAccess = {
    sales: ['sales', 'onboarding', 'processes', 'general', 'operations'],
    developer: ['development', 'onboarding', 'processes', 'general', 'operations'],
    pm: ['onboarding', 'processes', 'general', 'operations', 'sales', 'development'],
    hr: ['hr', 'onboarding', 'processes', 'general', 'operations'],
    finance: ['finance', 'onboarding', 'processes', 'general', 'operations'],
  };

  const allowed = roleAccess[userRole] || ['general', 'onboarding', 'processes'];
  if (allowed.includes(questionCategory)) {
    return { allowed: true, redirectRole: null };
  }

  return { allowed: false, redirectRole: 'the appropriate department lead' };
}

/**
 * Determine the question category from the text.
 */
function categorizeQuestion(question) {
  const q = question.toLowerCase();
  if (/finance|money|budget|invoice|payment|expense|salary|revenue|profit/.test(q)) return 'finance';
  if (/hr|human resource|leave|holiday|sick|policy|onboard|hiring|employee/.test(q)) return 'hr';
  if (/lead|prospect|client|sale|deal|conversion|pipeline|crm/.test(q)) return 'sales';
  if (/task|project|deploy|code|bug|feature|develop|technical|api/.test(q)) return 'development';
  if (/report|daily|submit|attendance|log/.test(q)) return 'processes';
  if (/strategy|vision|direction|future|plan|growth/.test(q)) return 'strategy';
  if (/decision|approv|who decides|who approves/.test(q)) return 'decisions';
  return 'general';
}

/**
 * Build the guided starter questions for a role.
 */
function getGuidedQuestions(role) {
  const common = [
    'How do I log in and navigate the system?',
    'What is the company org structure?',
    'How do I submit a daily report?',
    'How do I contact the Director or HR?',
  ];

  const byRole = {
    sales: [
      ...common,
      'How do I find and log new leads?',
      'What is the lead conversion process?',
      'How do I create and submit a project proposal?',
      'How do I follow up on outstanding invoices?',
      'What is my daily routine from morning to evening?',
      'How are sales targets measured?',
      'How do I use voice capture for leads?',
    ],
    developer: [
      ...common,
      'How do I view and update my assigned tasks?',
      'How do milestones and project progress work?',
      'How do I log hours against a milestone?',
      'How do I submit work for review?',
      'What is the deployment process?',
      'What is my daily routine from morning to evening?',
    ],
    director: [
      ...common,
      'How do I review and forward daily reports?',
      'How do I approve or reject projects?',
      'How do I leave remarks on team reports?',
      'How do I view company analytics?',
      'How do I assign tasks to team members?',
    ],
    pm: [
      ...common,
      'How do I review sales and developer reports?',
      'How do I forward reports to the Director?',
      'How do I manage project milestones?',
      'How do I reassign developers between projects?',
    ],
    admin: [
      ...common,
      'How do I manage users and roles?',
      'How do I feed data into the knowledge base?',
      'How do I view the full audit trail?',
      'How do I manage system settings?',
    ],
    hr: [
      ...common,
      'How do I manage employee onboarding?',
      'How do I track leave and attendance?',
      'How do I view employee well-being reports?',
      'How do I handle salary funding requests?',
    ],
    finance: [
      ...common,
      'How do I track invoices and payments?',
      'How do I reconcile accounts?',
      'How do I generate financial reports?',
      'How do I handle expense approvals?',
    ],
    client: [
      'How do I view my project progress?',
      'How do I send messages to the team?',
      'How do I review deliverables?',
    ],
  };

  return byRole[role] || common;
}

/**
 * Answer a question using RAG: retrieve context → generate answer.
 */
async function answerQuestion({ question, userId, userRole, userName }) {
  const category = categorizeQuestion(question);
  const access = checkAccess(userRole, category);

  if (!access.allowed) {
    const answer = `This question relates to **${category}** information. For access, please contact **${access.redirectRole}** directly. You can reach them through the messaging system or in person.`;
    await saveConversation({
      userId,
      userRole,
      question,
      answer,
      sources: [],
      blockedReason: `Category: ${category}, requires: ${access.redirectRole}`,
    });
    return { answer, sources: [], blocked: true, redirectRole: access.redirectRole };
  }

  // Retrieve relevant knowledge base entries
  const kbEntries = await getAccessibleKnowledge({ role: userRole, category, limit: 8 });

  // Retrieve recent audit trail for operational context
  const auditEntries = await getRecentAudit({ role: userRole, limit: 10 });

  // Retrieve recent conversation history for continuity
  const history = await getConversationHistory(userId, 4);

  // Build context
  let context = '';

  if (kbEntries.length) {
    context += 'KNOWLEDGE BASE:\n';
    kbEntries.forEach((e, i) => {
      context += `[${i + 1}] ${e.title} (${e.category}):\n${e.content.slice(0, 600)}\n\n`;
    });
  }

  if (auditEntries.length) {
    context += 'RECENT SYSTEM ACTIVITY:\n';
    auditEntries.forEach((e) => {
      context += `- ${e.action} ${e.resource_type}: ${e.summary} (${e.actor_name || 'system'})\n`;
    });
    context += '\n';
  }

  if (history.length) {
    context += 'RECENT CONVERSATIONS:\n';
    history.reverse().forEach((h) => {
      context += `Q: ${h.question}\nA: ${h.answer.slice(0, 200)}\n\n`;
    });
  }

  const system = `You are Cres Ops — the internal knowledge assistant for Cres Dynamics CRM.
You help employees understand how the company works, what their role entails, and how to use the system.

Your user is ${userName} (${userRole}).

RULES:
- Answer based on the provided context (knowledge base + system activity).
- Be concise and actionable. Give step-by-step guidance when appropriate.
- If the context doesn't contain enough info, say "I don't have specific information about that yet. Please contact your Director or HR for more details."
- Never fabricate company policies or procedures.
- Reference specific knowledge base entries when possible (e.g., "According to the onboarding guide...").
- For role-specific questions, tailor the answer to what ${userRole}s are expected to do.
- Use a friendly, helpful tone. This is for employees who may be new.
- If asked about other people's work, give general descriptions, not private details.

CONTEXT:
${context || 'No specific knowledge base entries found for this topic.'}`;

  const { text } = await groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    temperature: 0.3,
  });

  const sources = kbEntries.slice(0, 3).map((e) => ({ id: e.id, title: e.title, category: e.category }));

  await saveConversation({
    userId,
    userRole,
    question,
    answer: text,
    sources,
  });

  return { answer: text, sources, blocked: false };
}

module.exports = {
  answerQuestion,
  getGuidedQuestions,
  categorizeQuestion,
  checkAccess,
};
