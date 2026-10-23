import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What JARVIS knows about the person he works for.
 *
 * Two plain files in the user's home directory, deliberately outside the
 * repository so nothing personal is ever committed:
 *
 *   ~/.jarvis/profile.md  written by the user (or for them): who they are,
 *                         their company, the people and projects around them.
 *   ~/.jarvis/notes.md    written by JARVIS through the `remember` tool: things
 *                         he is told or works out along the way.
 *   ~/.jarvis/history.jsonl  every exchange, saved automatically, so a
 *                         conversation survives a reload or a restart.
 *
 * All three are read when a conversation starts and placed in the system
 * prompt, so he begins every session already knowing them. Editing or deleting
 * any of them by hand works; it takes effect at the next start.
 */

const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const PROFILE_FILE = join(DIR, 'profile.md')
const NOTES_FILE = join(DIR, 'notes.md')

/** Enough for a thorough profile; small enough not to slow every turn. */
const MAX_PROFILE_CHARS = 8000
const MAX_NOTES = 150

const read = (file) => readFile(file, 'utf8').catch(() => '')
const readSync = (file) => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const parseNotes = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

const loadNotes = async () => parseNotes(await read(NOTES_FILE))

async function saveNotes(notes) {
  await mkdir(dirname(NOTES_FILE), { recursive: true })
  await writeFile(NOTES_FILE, notes.map((n) => `- ${n}`).join('\n') + '\n')
}

const simplify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The block appended to the system prompt, or '' when nothing is known yet.
 * Read fresh for every conversation so an edit never needs a restart — and
 * synchronously, because a conversation is set up in one uninterrupted step
 * and these are two small local files.
 */
export function memoryPrompt() {
  const profile = readSync(PROFILE_FILE).trim().slice(0, MAX_PROFILE_CHARS)
  const notes = parseNotes(readSync(NOTES_FILE))
  const recent = recentConversation()
  if (!profile && !notes.length && !recent) return ''
  return [
    '',
    'THE PERSON YOU WORK FOR.',
    'What follows is what you know about them. Where it says how to address them,',
    'that replaces "sir" everywhere in the rules above; the placement rules still',
    'apply. Use this knowledge naturally — to understand what they mean, to fill in',
    'who and what they are referring to, to read a misheard word as the name it',
    'almost certainly was. Never recite it back, and never announce that you',
    'remember something.',
    '',
    profile,
    notes.length ? '\nThings you have learned along the way:\n' + notes.map((n) => `- ${n}`).join('\n') : '',
    '',
    'Keeping this up to date: when they tell you something lasting about themselves —',
    'a person, a number, a project, a preference, a correction ("when I say X I mean',
    'Y") — save it with the remember tool, in one short sentence, without comment.',
    'Do not save passing requests, and never save passwords, PINs or card numbers.',
    recent
      ? '\nEARLIER CONVERSATIONS with them, oldest first. This is what was said before ' +
        'this session began; pick up from it as someone who was there would, and do ' +
        'not read it back.\n' + recent
      : '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

/**
 * Every exchange, one JSON object per line: { at, user, jarvis }.
 *
 * A session's own memory ends when the page reloads or the bridge restarts.
 * This is what carries a conversation across that: the last exchanges are put
 * in front of him at the start of the next session.
 */
const HISTORY_FILE = join(DIR, 'history.jsonl')
/** How much of it he is shown at the start of a session. */
const RECALL_EXCHANGES = 30
const RECALL_CHARS = 6000
/** How much is kept on disk before the oldest lines are dropped. */
const KEEP_EXCHANGES = 2000

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function readHistory() {
  return readSync(HISTORY_FILE)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((e) => e?.user && e?.jarvis)
}

function recentConversation() {
  const lines = readHistory()
    .slice(-RECALL_EXCHANGES)
    .map((e) => {
      const when = new Date(e.at).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi',
      })
      return `[${when}] They said: ${clip(e.user, 300)}\n  You said: ${clip(e.jarvis, 400)}`
    })
  // Keep the newest when the whole thing would be too long.
  let out = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length + lines[i].length > RECALL_CHARS) break
    out = lines[i] + (out ? '\n' + out : '')
  }
  return out
}

let writes = 0
/** Save one finished exchange. Never throws: memory must not break a turn. */
export async function recordExchange(user, jarvis) {
  const u = clip(user, 2000)
  const j = clip(jarvis, 4000)
  if (!u || !j) return
  try {
    await mkdir(DIR, { recursive: true })
    await appendFile(HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), user: u, jarvis: j }) + '\n')
    // Trim now and then rather than on every turn.
    if (++writes % 200 === 0) {
      const all = readHistory()
      if (all.length > KEEP_EXCHANGES) {
        await writeFile(HISTORY_FILE, all.slice(-KEEP_EXCHANGES).map((e) => JSON.stringify(e)).join('\n') + '\n')
      }
    }
  } catch (err) {
    console.warn('[jarvis] could not save the conversation:', err?.message ?? err)
  }
}

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      'Your long-term memory of the person you work for. Save lasting facts with ' +
      'remember; they are there at the start of every future conversation.',
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        'Save one lasting fact about the user so you know it in every future conversation: ' +
          'a person and who they are, a project, a preference, how they like something done, ' +
          'or what they mean by a word you misheard. One short sentence. Never passwords, PINs ' +
          'or card numbers.',
        { fact: z.string().describe('The fact, as one short sentence.') },
        async (args) => {
          const fact = String(args.fact ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
          if (!fact) return { isError: true, content: [{ type: 'text', text: 'Nothing to remember.' }] }
          if (/\b(password|passcode|pin|cvv|card number)\b/i.test(fact)) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'That looks like a secret. Secrets are not stored; tell the user so.' }],
            }
          }
          const notes = await loadNotes()
          if (notes.some((n) => simplify(n) === simplify(fact))) {
            return { content: [{ type: 'text', text: 'Already known.' }] }
          }
          notes.push(fact)
          // The oldest notes go first once the list is full.
          await saveNotes(notes.slice(-MAX_NOTES))
          return { content: [{ type: 'text', text: 'Remembered.' }] }
        },
      ),

      tool(
        'forget',
        'Remove something you remembered, when the user says it is wrong or no longer true. ' +
          'Give a few words that identify it.',
        { about: z.string().describe('Words that identify the note to remove.') },
        async (args) => {
          const want = simplify(args.about)
          if (!want) return { isError: true, content: [{ type: 'text', text: 'Say what to forget.' }] }
          const notes = await loadNotes()
          const kept = notes.filter((n) => !simplify(n).includes(want))
          if (kept.length === notes.length) {
            return { content: [{ type: 'text', text: 'Nothing remembered matches that.' }] }
          }
          await saveNotes(kept)
          return { content: [{ type: 'text', text: `Forgot ${notes.length - kept.length} note(s).` }] }
        },
      ),
    ],
  })
}
