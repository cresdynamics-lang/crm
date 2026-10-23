import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Everyday actions on this computer, as direct tools.
 *
 * Opening a site, an app or a WhatsApp chat used to mean the model composing a
 * PowerShell command and the agent starting a shell to run it: seconds of
 * latency, and a quoting mistake away from failing. These do the same things
 * in-process, in milliseconds, with nothing to escape.
 *
 * They open things; they do not operate them. Nothing here clicks, types or
 * sends — a drafted WhatsApp message waits for the user to press send, and a
 * dialled number waits for them to press call.
 *
 * Built only when writes are enabled (see server.mjs), like the shell itself.
 */

const WINDOWS = process.platform === 'win32'
/** Set to 1 to report what would be opened without opening it (tests). */
const DRY_RUN = process.env.JARVIS_PC_DRY_RUN === '1'

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

function run(command, args) {
  if (DRY_RUN) return
  spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref()
}

/** Hand a URL, URI or file to the operating system's default handler. */
function openWithSystem(target) {
  if (WINDOWS) run('rundll32', ['url.dll,FileProtocolHandler', target])
  else if (process.platform === 'darwin') run('open', [target])
  else run('xdg-open', [target])
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * Which browser websites open in. JARVIS_BROWSER = firefox | chrome | edge |
 * default. Firefox unless told otherwise; the system default if it is missing.
 */
const BROWSERS = {
  firefox: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
}
const browserChoice = (process.env.JARVIS_BROWSER ?? 'firefox').toLowerCase()
const browserPath = WINDOWS ? (BROWSERS[browserChoice] ?? []).find((p) => existsSync(p)) : null

function openInBrowser(url) {
  if (!browserPath) return openWithSystem(url)
  run(browserPath, browserChoice === 'firefox' ? ['-new-tab', url] : [url])
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/** Names people say for things that are not in the app list under that name. */
const APP_ALIASES = {
  whatsapp: 'whatsapp:',
  settings: 'ms-settings:',
  'windows settings': 'ms-settings:',
  calculator: 'calc.exe',
  notepad: 'notepad.exe',
  'file explorer': 'explorer.exe',
  files: 'explorer.exe',
  explorer: 'explorer.exe',
  'task manager': 'taskmgr.exe',
  paint: 'mspaint.exe',
  'command prompt': 'cmd.exe',
  terminal: 'wt.exe',
  camera: 'microsoft.windows.camera:',
  photos: 'ms-photos:',
  store: 'ms-windows-store:',
  'microsoft store': 'ms-windows-store:',
  clock: 'ms-clock:',
  mail: 'mailto:',
  'phone link': 'ms-phone:',
}

/**
 * Every app in the Start menu, desktop and Store apps alike, with the id that
 * launches it. Asking Windows once and caching is what lets "open Spotify"
 * work without guessing an install path.
 */
let appCache = null
function installedApps() {
  if (appCache && appCache.until > Date.now()) return appCache.promise
  const promise = new Promise((resolve) => {
    if (process.platform === 'darwin') return resolve(macApps())
    if (!WINDOWS) return resolve([])
    execFile(
      'powershell',
      ['-NoProfile', '-Command', 'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve([])
        try {
          const list = JSON.parse(stdout)
          resolve((Array.isArray(list) ? list : [list]).filter((a) => a?.Name && a?.AppID))
        } catch {
          resolve([])
        }
      },
    )
  })
  appCache = { promise, until: Date.now() + 10 * 60_000 }
  return promise
}
/** On a Mac: every .app in the usual Applications folders, by its name. */
function macApps() {
  const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]
  return dirs.flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.app'))
        .map((f) => ({ Name: f.slice(0, -4), path: join(dir, f) }))
    } catch {
      return []
    }
  })
}

// Warm the list at start-up so the first "open …" is as quick as the rest.
if (WINDOWS && !DRY_RUN) void installedApps()

const simplify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Start-menu entries that belong to an app but are not the app. */
const SIDE_ENTRY = /\b(uninstall|uninstaller|help|readme|documentation|manual|license|website|release notes|setup|updater?|repair)\b/

export async function findApp(name, apps) {
  const want = simplify(name)
  if (!want) return null
  if (APP_ALIASES[want]) return { name: want, target: APP_ALIASES[want] }
  const list = apps ?? (await installedApps())
  const scored = list
    .map((a) => {
      const have = simplify(a.Name)
      const score =
        have === want ? 3 : have.startsWith(want + ' ') || have.endsWith(' ' + want) ? 2 : have.includes(want) ? 1 : 0
      // A program's helpers sit beside it in the Start menu under its name.
      // Nobody means those unless they say so.
      const side = SIDE_ENTRY.test(have) && !SIDE_ENTRY.test(want)
      return { a, score, side, len: have.length }
    })
    .filter((x) => x.score > 0)
    // The app itself before its helpers; then the best kind of match; then,
    // among equals, the shortest name.
    .sort((x, y) => Number(x.side) - Number(y.side) || y.score - x.score || x.len - y.len)
  const best = scored[0]?.a
  if (best?.path) return { name: best.Name, target: best.path }
  return best ? { name: best.Name, target: `shell:AppsFolder\\${best.AppID}` } : null
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Where the user keeps their projects: one folder each. */
const PROJECTS_DIR = process.env.JARVIS_PROJECTS_DIR ?? join(homedir(), 'Projects')
const CURSOR_AGENT = [join(homedir(), '.local', 'bin', 'cursor-agent'), '/usr/local/bin/cursor-agent'].find((p) =>
  existsSync(p),
)

/** A project folder by its spoken name: "trendy fashion" → ~/Projects/TrendyFashion. */
export function findProject(name) {
  const want = simplify(name).replace(/ /g, '')
  if (!want) return null
  let dirs
  try {
    dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  } catch {
    return null
  }
  const scored = dirs
    .map((d) => {
      const have = simplify(d.name).replace(/ /g, '')
      return { d, score: have === want ? 3 : have.startsWith(want) ? 2 : have.includes(want) || want.includes(have) ? 1 : 0 }
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.d.name.length - y.d.name.length)
  const best = scored[0]?.d
  return best ? { name: best.name, path: join(PROJECTS_DIR, best.name) } : null
}

/** Ask Cursor's agent about a project, read-only (ask mode: it cannot edit). */
function askCursor(path, instruction) {
  return new Promise((resolve) => {
    execFile(
      CURSOR_AGENT,
      ['--print', '--output-format', 'text', '--mode', 'ask', '--trust', '--workspace', path, instruction],
      { cwd: path, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          const why = /not logged in|login|auth/i.test(stderr + err.message)
            ? 'Cursor Agent is not signed in. The user runs `cursor-agent login` once.'
            : `Cursor Agent failed: ${(stderr || err.message).trim().slice(0, 400)}`
          return resolve({ error: why })
        }
        resolve({ text: stdout.trim() })
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * A small address book of the user's own, so "call Mum on WhatsApp" works.
 * WhatsApp's contact list is not readable from outside the app, so names are
 * learned as the user mentions them and kept here, on this machine only.
 */
const CONTACTS_FILE = process.env.JARVIS_CONTACTS_FILE ?? join(homedir(), '.jarvis', 'contacts.json')

async function loadContacts() {
  try {
    const data = JSON.parse(await readFile(CONTACTS_FILE, 'utf8'))
    return Array.isArray(data) ? data.filter((c) => c?.name && c?.phone) : []
  } catch {
    return []
  }
}

async function saveContacts(list) {
  await mkdir(dirname(CONTACTS_FILE), { recursive: true })
  await writeFile(CONTACTS_FILE, JSON.stringify(list, null, 2))
}

/** Digits only, with the leading + dropped: the form wa.me and whatsapp:// want. */
export function normalisePhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d]/g, '')
  return digits.length >= 7 && digits.length <= 15 ? digits : null
}

const looksLikeNumber = (s) => /^[+\d][\d\s().-]{5,}$/.test(String(s).trim())

/**
 * A name or a number, resolved to a number. Returns { phone, name } or
 * { error } worded for the model to relay.
 */
async function resolvePerson(to) {
  const asked = String(to ?? '').trim()
  if (!asked) return { error: 'No person or number was given. Ask who.' }
  if (looksLikeNumber(asked)) {
    const phone = normalisePhone(asked)
    return phone
      ? { phone, name: null }
      : { error: 'That number does not look complete. Ask for it with the country code.' }
  }
  const want = simplify(asked)
  const contacts = await loadContacts()
  const exact = contacts.filter((c) => simplify(c.name) === want)
  const matches = exact.length ? exact : contacts.filter((c) => simplify(c.name).includes(want))
  if (matches.length === 1) return { phone: matches[0].phone, name: matches[0].name }
  if (matches.length > 1) {
    return { error: `More than one saved contact matches "${asked}": ${matches.map((c) => c.name).join(', ')}. Ask which.` }
  }
  return {
    error:
      `No saved contact called "${asked}". Ask the user for the number with its country code, ` +
      'save it with save_contact, then try again.',
  }
}

// ---------------------------------------------------------------------------

export function pcServer() {
  return createSdkMcpServer({
    name: 'jarvis_pc',
    version: '1.0.0',
    instructions:
      "Instant actions on the user's computer: open a website or web search, " +
      'open an app, open a WhatsApp chat, dial a number, and remember contacts. ' +
      'Use these instead of the shell whenever one fits; they are much faster.',
    // Behind tool search every "open …" would cost an extra round trip first.
    alwaysLoad: true,
    tools: [
      tool(
        'open_in_browser',
        'Open a web page, a link (including a meeting link), or a visible web search in the ' +
          "user's browser. Give `url` for a specific address or `search` for a search. " +
          'For answering a question yourself, use your own web search instead; this is for ' +
          'when the user wants to see the page.',
        {
          url: z.string().optional().describe('Full http(s) address to open.'),
          search: z.string().optional().describe('Words to search the web for, shown in the browser.'),
        },
        async (args) => {
          let target = String(args.url ?? '').trim()
          if (!target && args.search) {
            target = `https://www.google.com/search?q=${encodeURIComponent(String(args.search))}`
          }
          if (!target) return fail('Give a url or a search.')
          // "youtube.com" and "localhost:5173" get a scheme added; anything that
          // already names a different one (file:, mailto:, …) is not a web page.
          if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(target) && !/^https?:\/\//i.test(target)) {
            return fail('Only web addresses can be opened with this tool.')
          }
          if (!/^https?:\/\//i.test(target)) target = `https://${target}`
          let parsed
          try {
            parsed = new URL(target)
          } catch {
            return fail('That is not a valid web address.')
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return fail('Only web addresses can be opened with this tool.')
          }
          openInBrowser(parsed.href)
          return ok(`Opened ${parsed.hostname} in the browser.`)
        },
      ),

      tool(
        'open_app',
        'Open an app installed on this computer by its everyday name, e.g. "Spotify", ' +
          '"Word", "Calculator", "Settings", "WhatsApp". Opens it; does not operate it.',
        { name: z.string().describe('The app name as the user said it.') },
        async (args) => {
          const app = await findApp(args.name)
          if (!app) {
            return fail(
              `No installed app matches "${args.name}". Tell the user it does not seem to be ` +
                'installed, and offer to install it.',
            )
          }
          // Start-menu entries live in the shell namespace, which only Explorer
          // resolves; programs and app links go through the default handler.
          if (app.target.startsWith('shell:')) run('explorer.exe', [app.target])
          else openWithSystem(app.target)
          return ok(`Opened ${app.name}.`)
        },
      ),

      tool(
        'whatsapp',
        'Open a WhatsApp chat with a person, optionally with a message drafted in the box. ' +
          'Use this for "message X on WhatsApp" and for "call X on WhatsApp". You cannot press ' +
          'send or the call button: after opening, tell the user to press send, or to tap the ' +
          'phone icon to call. `to` is a saved contact name or a phone number with country code.',
        {
          to: z.string().describe('Saved contact name, or phone number with country code.'),
          message: z.string().optional().describe('Text to draft in the chat. Omit for a call.'),
        },
        async (args) => {
          const person = await resolvePerson(args.to)
          if (person.error) return fail(person.error)
          const text = String(args.message ?? '').trim()
          const uri =
            `whatsapp://send?phone=${person.phone}` + (text ? `&text=${encodeURIComponent(text)}` : '')
          openWithSystem(uri)
          const who = person.name ?? `+${person.phone}`
          return ok(
            text
              ? `WhatsApp is open on ${who} with the message drafted. The user presses send.`
              : `WhatsApp is open on the chat with ${who}. The user taps the phone icon to call.`,
          )
        },
      ),

      tool(
        'phone_call',
        "Open the computer's dialler (Phone Link) with a number ready, for an ordinary phone " +
          'call through the paired phone. The user presses call. `to` is a saved contact name ' +
          'or a phone number with country code.',
        { to: z.string().describe('Saved contact name, or phone number with country code.') },
        async (args) => {
          const person = await resolvePerson(args.to)
          if (person.error) return fail(person.error)
          openWithSystem(`tel:+${person.phone}`)
          return ok(
            `The dialler is open with ${person.name ?? `+${person.phone}`}. The user presses call. ` +
              'If nothing opened, Phone Link is not set up with their phone.',
          )
        },
      ),

      tool(
        'cursor_project',
        "Open one of the user's projects (a folder in ~/Projects, named as they say it) in Cursor, " +
          "and optionally have Cursor's agent look into it and report back — e.g. check the status, " +
          'what is unfinished, whether it builds, what changed recently. Cursor only reads and ' +
          'answers; it does not edit. Takes up to a few minutes when an instruction is given. Put a ' +
          'long answer on the display and speak a two-sentence summary.',
        {
          project: z.string().describe('The project name as the user said it.'),
          instruction: z.string().optional().describe("What to ask Cursor's agent about the project."),
          open: z.boolean().optional().describe('Also open the project in the Cursor app. Default true.'),
        },
        async (args) => {
          const project = findProject(args.project)
          if (!project) return fail(`No folder in ~/Projects matches "${args.project}". Ask which project.`)
          if (args.open !== false) run('open', ['-a', 'Cursor', project.path])
          const instruction = String(args.instruction ?? '').trim()
          if (!instruction) return ok(`Opened ${project.name} in Cursor.`)
          if (!CURSOR_AGENT) return fail('Cursor Agent is not installed (curl https://cursor.com/install -fsS | bash).')
          const res = await askCursor(project.path, instruction)
          if (res.error) return fail(res.error)
          return ok(`Cursor on ${project.name}:\n${res.text.slice(0, 12_000)}`)
        },
      ),

      tool(
        'save_contact',
        'Remember a person\'s phone number under a name, so later "call Mum" or "message John" ' +
          'works. Use whenever the user gives a number for a named person. Replaces an existing ' +
          'contact of the same name.',
        {
          name: z.string().describe('The name the user uses for this person.'),
          phone: z.string().describe('Phone number including country code.'),
        },
        async (args) => {
          const name = String(args.name ?? '').trim().slice(0, 80)
          const phone = normalisePhone(args.phone)
          if (!name) return fail('A name is needed.')
          if (!phone) return fail('That number does not look complete. Ask for it with the country code.')
          const contacts = (await loadContacts()).filter((c) => simplify(c.name) !== simplify(name))
          contacts.push({ name, phone })
          contacts.sort((a, b) => a.name.localeCompare(b.name))
          await saveContacts(contacts)
          return ok(`Saved ${name} as +${phone}.`)
        },
      ),

      tool(
        'list_contacts',
        'List the saved contacts, or look one up by name.',
        { name: z.string().optional().describe('Part of a name to look for. Omit to list all.') },
        async (args) => {
          const contacts = await loadContacts()
          const want = simplify(args.name ?? '')
          const found = want ? contacts.filter((c) => simplify(c.name).includes(want)) : contacts
          if (!found.length) return ok(want ? `No saved contact matches "${args.name}".` : 'No contacts are saved yet.')
          return ok(found.map((c) => `${c.name}: +${c.phone}`).join('\n'))
        },
      ),
    ],
  })
}
