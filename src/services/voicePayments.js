/**
 * Voice payment parser — transcribes finance voice commands and extracts
 * payment details: amount, client, project, description, bank reference.
 */
const { transcribeAudio } = require('./voiceLeads');
const { groqChat } = require('./groq');

/**
 * Parse a voice transcript into structured payment data.
 */
async function parsePaymentFromTranscript(transcript, clients = [], projects = []) {
  const clientList = clients.map((c) => `- ${c.name}${c.business_name ? ` (${c.business_name})` : ''} [id:${c.id}]`).join('\n') || 'None available';
  const projectList = projects.map((p) => `- ${p.name} [id:${p.id}]`).join('\n') || 'None available';

  const system = `You are a payment data parser for Cres Dynamics CRM.
Parse the user's spoken payment description into structured fields.

RULES:
- Extract the exact amount (number only, no currency symbols)
- Extract the client or person name mentioned
- Extract the project name if mentioned
- Extract any bank reference, M-Pesa code, or transaction reference
- Extract a short description of what the payment is for
- If the speaker says "received from" or "paid by", the client is the payer
- If amounts are in words (e.g. "fifty thousand"), convert to numbers
- Return valid JSON only, no explanation`;

  const user = `Clients in the system:
${clientList}

Projects in the system:
${projectList}

Voice transcript:
"${transcript}"

Return JSON with these fields:
{
  "amount": <number>,
  "client_name": "<name as spoken>",
  "client_id": "<id if matched, else null>",
  "project_name": "<name as spoken>",
  "project_id": "<id if matched, else null>",
  "bank_reference": "<reference code if mentioned, else null>",
  "description": "<short description of what this payment is for>",
  "paid_at": "<ISO date if mentioned, else null>"
}`;

  const { text } = await groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
  });

  // Extract JSON from response (may be wrapped in markdown code block)
  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    parsed = {
      amount: 0,
      client_name: transcript,
      client_id: null,
      project_name: null,
      project_id: null,
      bank_reference: null,
      description: transcript.slice(0, 200),
      paid_at: null,
    };
  }

  // Try to match client by fuzzy name
  if (!parsed.client_id && parsed.client_name && clients.length) {
    const lower = parsed.client_name.toLowerCase();
    const match = clients.find((c) =>
      c.name.toLowerCase().includes(lower) ||
      lower.includes(c.name.toLowerCase()) ||
      (c.business_name && c.business_name.toLowerCase().includes(lower))
    );
    if (match) {
      parsed.client_id = match.id;
      parsed.client_name = match.name;
    }
  }

  // Try to match project by fuzzy name
  if (!parsed.project_id && parsed.project_name && projects.length) {
    const lower = parsed.project_name.toLowerCase();
    const match = projects.find((p) =>
      p.name.toLowerCase().includes(lower) ||
      lower.includes(p.name.toLowerCase())
    );
    if (match) {
      parsed.project_id = match.id;
      parsed.project_name = match.name;
    }
  }

  return parsed;
}

/**
 * Full voice payment capture: transcribe audio + parse into structured data.
 */
async function capturePaymentVoice({ buffer, filename, mimetype, clients, projects }) {
  const { text: transcript, model } = await transcribeAudio({ buffer, filename, mimetype });
  const parsed = await parsePaymentFromTranscript(transcript, clients, projects);
  return { transcript, whisper_model: model, ...parsed };
}

module.exports = { capturePaymentVoice, parsePaymentFromTranscript };
