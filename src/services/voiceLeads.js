/**
 * Voice lead capture: speech-to-text via Groq Whisper, then LLM extraction of
 * structured leads from a sales rep's spoken narration.
 *
 * A rep records e.g. "Spark Lights, that's a shop selling lights, number is
 * 0712345678 ... next one is ..." for up to ~20 contacts in one take; the
 * transcript is parsed into lead rows (business name, phone, suggested
 * business type) ready for review and import.
 */
const config = require('../config');
const { groqChat } = require('./groq');

function apiKeys() {
  return [config.groq.apiKey, config.groq.apiKeySecondary, config.groq.apiKeyTertiary].filter(
    Boolean
  );
}

/** Transcribe audio via Groq's Whisper endpoint. Returns { text, model }. */
async function transcribeAudio({ buffer, filename = 'audio.webm', mimetype = 'audio/webm' }) {
  const keys = apiKeys();
  if (!keys.length) {
    throw new Error('GROQ_API_KEY is not configured');
  }
  let lastErr;
  for (const key of keys) {
    try {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mimetype }), filename);
      form.append('model', config.groq.whisperModel);
      form.append('response_format', 'json');
      form.append(
        'prompt',
        'Kenyan sales agent narrating a list of business leads. ' +
          'Contains business names, phone numbers like 0712 345 678 or 254712345678, and business descriptions.'
      );

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(240000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error?.message || `Groq transcription HTTP ${res.status}`);
      }
      const text = String(data?.text || '').trim();
      if (!text) throw new Error('Empty transcription - no speech detected?');
      return { text, model: data.model || config.groq.whisperModel };
    } catch (err) {
      lastErr = err;
      if (err && err.name === 'TimeoutError') {
        lastErr = new Error('Transcription timed out after 4 minutes — try a shorter take or retry');
      }
      console.warn(`[voiceLeads] transcription key failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('Transcription unavailable');
}

function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to brace scan */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  throw new Error('AI returned unparseable JSON');
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  // Normalize +25471... / 25471... / 071... → keep local 07xx style used by reps
  let p = digits.replace(/^\+/, '');
  if (/^254(\d{9})$/.test(p)) p = `0${p.slice(3)}`;
  else if (/^7(\d{8})$/.test(p)) p = `0${p}`;
  return p;
}

function normalizeLead(raw) {
  const businessName = String(raw.business_name || raw.businessName || '').trim();
  const contactName = String(raw.name || raw.contact_name || '').trim();
  const type = String(raw.business_type || raw.businessType || '').trim();
  const phone = normalizePhone(raw.phone);
  const email = String(raw.email || '').trim() || null;
  const label = businessName || contactName;
  if (!label && !phone) return null;
  return {
    name: contactName || label || 'Unnamed lead',
    phone,
    email,
    business_name: businessName || null,
    business_type: type || null,
    notes: String(raw.notes || '').trim() || null,
  };
}

/**
 * Parse a spoken narration into structured leads. The LLM infers/suggests the
 * business type from context ("spark lights ... selling lights" -> lighting).
 */
async function parseLeadsFromTranscript(transcript) {
  const system = `You extract sales leads from a Kenyan sales representative's spoken narration (speech-to-text transcript).
The rep narrates multiple businesses/contacts in one go, sometimes 20+. Split the transcript into individual distinct leads.

For each lead return:
- "business_name": the business/shop name as said. If only a person's name was given, leave this null.
- "name": contact person's full name if mentioned; otherwise fall back to the business name.
- "phone": phone number. Convert spoken digits to numerals and join pieces: "zero seven one two three four five six seven eight" or "0712 345 678" become "0712345678". Keep Kenyan formats (07XXXXXXXX or 01XXXXXXXX). If no number was given, null.
- "business_type": SHORT category describing what they sell/do, inferred from context clues (e.g. "spark lights ... a business selling lights" -> "Lighting & Electricals"; "sells shoes" -> "Footwear"; "mama mboga" -> "Grocery Kiosk"). Max 4 words.
- "notes": any extra detail worth keeping (one short sentence), else null.

Rules:
- Do NOT invent leads that were not spoken. Skip filler words.
- If the same business repeats, output it once.
- Numbers may appear mid-sentence; attach each number to the correct lead by order of narration.

Respond with ONLY valid JSON, no markdown:
{"leads":[{"business_name":null,"name":null,"phone":null,"business_type":null,"notes":null}]}`;

  const { text } = await groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Transcript:\n"""${transcript.slice(0, 12000)}"""` },
    ],
    temperature: 0.1,
  });

  const parsed = extractJson(text);
  const list = Array.isArray(parsed?.leads)
    ? parsed.leads
    : Array.isArray(parsed)
      ? parsed
      : [];
  const seen = new Set();
  const leads = [];
  for (const raw of list) {
    const lead = normalizeLead(raw);
    if (!lead) continue;
    const key = `${(lead.business_name || lead.name || '').toLowerCase()}|${lead.phone || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push(lead);
  }
  return { leads, model: config.groq.model };
}

module.exports = { transcribeAudio, parseLeadsFromTranscript, normalizePhone };
