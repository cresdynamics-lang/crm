import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * JARVIS's hands on the desktop itself: see the screen, read its controls,
 * click, type, press keys, scroll and drag — so he can work any app, not only
 * the ones with a dedicated tool.
 *
 * The hands are a small Swift helper (native/input.swift), compiled on first
 * use into ~/.jarvis/bin. macOS asks for two permissions for whichever app
 * started JARVIS (the Jarvis app in the Dock, or the terminal):
 *   - Accessibility, to click, type and read controls
 *   - Screen & System Audio Recording, to see windows
 *
 * Built only when writes are enabled, like pc.mjs and the shell.
 *
 * Guardrails, enforced here rather than left to the model: an action needs
 * `confirmed: true` — which the persona may set only after the user said yes
 * to a question about that exact step — when
 *   - its stated purpose is sending, buying, paying, deleting and the like;
 *   - it types into a password field;
 *   - it presses Return (or types a line break) in a messaging or mail app,
 *     which is what sends there;
 *   - it presses a delete shortcut (cmd+delete moves files to the Bin);
 *   - the app in front is System Settings, Keychain Access, Passwords, a
 *     security prompt, or a terminal.
 *
 * Coordinates are screen points: screenshots are scaled so one image pixel is
 * one point, and the helper posts events in points.
 */

const MAC = process.platform === 'darwin'
const HELPER_SRC = join(dirname(fileURLToPath(import.meta.url)), 'native', 'input.swift')
const HELPER = join(homedir(), '.jarvis', 'bin', 'jarvis-input')

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

function exec(cmd, args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error((stderr || err.message).trim().slice(0, 400)))
      else resolve(stdout)
    })
  })
}

async function ensureHelper() {
  if (existsSync(HELPER)) return
  mkdirSync(dirname(HELPER), { recursive: true })
  await exec('swiftc', ['-O', HELPER_SRC, '-o', HELPER], 300_000)
}

async function hand(...args) {
  await ensureHelper()
  const res = JSON.parse((await exec(HELPER, args.map(String))).trim().split('\n').pop())
  if (!res.ok) throw new Error(res.error)
  return res
}

let screenSize = null
async function points() {
  if (screenSize) return screenSize
  const b = (await exec('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']))
    .split(',')
    .map((n) => Number(n.trim()))
  screenSize = { w: b[2] || 1440, h: b[3] || 900 }
  return screenSize
}

/** A screenshot of the main display, scaled so one image pixel = one screen point. */
async function capture() {
  const { w, h } = await points()
  const png = join(tmpdir(), `jarvis-screen-${process.pid}.png`)
  const jpg = png.replace(/\.png$/, '.jpg')
  await exec('screencapture', ['-x', '-m', '-t', 'png', png])
  await exec('sips', ['--resampleWidth', String(w), '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', png, '--out', jpg])
  const data = (await readFile(jpg)).toString('base64')
  await rm(png, { force: true })
  await rm(jpg, { force: true })
  return { data, w, h }
}

async function look(note, withElements = false) {
  const front = await hand('front').catch(() => ({ app: '?' }))
  const shot = await capture()
  let text =
    `${note ? note + ' ' : ''}Screen ${shot.w}x${shot.h}; image pixels are screen points (x right, y down). ` +
    `Frontmost app: ${front.app}.`
  if (withElements) {
    const els = await hand('elements', 250).catch(() => ({ elements: [] }))
    text +=
      '\nControls in the front window (role "label" @x,y):\n' +
      els.elements.map((e) => `${e.role} "${e.label}" @${e.x},${e.y}${e.secure ? ' [password]' : ''}`).join('\n')
  }
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

const RISKY_PURPOSE =
  /\b(send|sending|submit|post|publish|reply|forward|buy|purchase|pay|payment|checkout|check out|order|subscribe|transfer|donate|delete|remove|trash|erase|wipe|uninstall|empty|format|unsubscribe|sign out|log out)\b/i
const SECURITY_APPS = new Set([
  'com.apple.systempreferences', 'com.apple.Settings', 'com.apple.keychainaccess', 'com.apple.Passwords',
  'com.apple.SecurityAgent', 'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable',
])
const MESSAGING_APPS = new Set([
  'net.whatsapp.WhatsApp', 'desktop.WhatsApp', 'com.apple.MobileSMS', 'com.apple.mail',
  'com.tinyspeck.slackmacgap', 'ru.keepcoder.Telegram', 'org.telegram.desktop', 'com.microsoft.teams2',
  'com.hnc.Discord', 'com.microsoft.Outlook',
])

const needsYes = (why) =>
  fail(
    `CONFIRMATION NEEDED: ${why}. Ask the user one short question naming exactly what will happen ` +
      '(who it goes to and what it says, what is bought and for how much, what is deleted, which ' +
      'setting changes). Only if they clearly say yes, repeat this call with confirmed: true. Never ' +
      'set confirmed on your own judgement.',
  )

async function guard({ purpose, confirmed, kind, text = '', key = '' }) {
  if (!MAC) return fail('Screen control is only built for macOS on this bridge.')
  if (confirmed) return null
  const front = await hand('front').catch(() => ({}))
  if (SECURITY_APPS.has(front.bundle)) return needsYes(`${front.app} is in front (settings, passwords or a terminal)`)
  if (RISKY_PURPOSE.test(purpose ?? '')) return needsYes(`this step is to ${purpose}`)
  if (kind === 'type' && front.subrole === 'AXSecureTextField') return needsYes('this is a password field')
  const sends =
    (kind === 'key' && /^(return|enter|cmd\+return|cmd\+enter)$/i.test(key)) || (kind === 'type' && /[\r\n]/.test(text))
  if (sends && MESSAGING_APPS.has(front.bundle)) return needsYes(`pressing Return in ${front.app} sends the message`)
  if (kind === 'key' && /cmd/i.test(key) && /(delete|backspace)/i.test(key)) return needsYes('that shortcut deletes')
  return null
}

const PURPOSE = z.string().describe('What this step is for, in plain words, e.g. "open the search box".')
const CONFIRMED = z
  .boolean()
  .optional()
  .describe('Only true after the user said yes to your question about this exact step.')

async function act(note, fn) {
  try {
    await fn()
    await new Promise((r) => setTimeout(r, 450))
    return await look(note)
  } catch (err) {
    return fail(`Screen action failed: ${err.message}`)
  }
}

export function screenServer() {
  return createSdkMcpServer({
    name: 'jarvis_screen',
    version: '1.0.0',
    instructions:
      "Control this Mac's screen: look, read controls, click, type, press keys, scroll, drag. " +
      'Look first, act, then check the screenshot that comes back.',
    tools: [
      tool(
        'screen_look',
        'See the screen now: a screenshot (image pixels = screen points) and the app in front. ' +
          "With elements: true, also a list of the front window's buttons, fields and links with " +
          'their centre points — the most accurate way to find where to click.',
        { elements: z.boolean().optional().describe('Also list the clickable controls. Default false.') },
        async (args) => {
          if (!MAC) return fail('Screen control is only built for macOS on this bridge.')
          try {
            const trusted = await hand('trusted', 'prompt').catch(() => ({ trusted: false }))
            const res = await look('', args.elements)
            if (!trusted.trusted) {
              res.content[0].text +=
                '\nNOTE: Accessibility permission is missing, so clicking, typing and reading controls ' +
                'will not work yet. Tell the user to allow it in System Settings → Privacy & Security → Accessibility.'
            }
            return res
          } catch (err) {
            return fail(
              `Could not see the screen: ${err.message}. The user may need to allow Screen Recording ` +
                'in System Settings → Privacy & Security.',
            )
          }
        },
      ),

      tool(
        'screen_click',
        'Click at a point on the screen (screen points from screen_look). Returns a fresh screenshot.',
        {
          x: z.number(),
          y: z.number(),
          button: z.enum(['left', 'right']).optional(),
          count: z.number().int().min(1).max(3).optional().describe('2 for a double-click.'),
          purpose: PURPOSE,
          confirmed: CONFIRMED,
        },
        async (args) =>
          (await guard({ purpose: args.purpose, confirmed: args.confirmed, kind: 'click' })) ??
          act(`Clicked ${Math.round(args.x)},${Math.round(args.y)}.`, () =>
            hand('click', args.x, args.y, args.button ?? 'left', args.count ?? 1),
          ),
      ),

      tool(
        'screen_type',
        'Type text into whatever has focus (click the field first). Does not press Return; use ' +
          'screen_key for that. Returns a fresh screenshot.',
        { text: z.string(), purpose: PURPOSE, confirmed: CONFIRMED },
        async (args) =>
          (await guard({ purpose: args.purpose, confirmed: args.confirmed, kind: 'type', text: args.text })) ??
          act('Typed.', () => hand('type', args.text)),
      ),

      tool(
        'screen_key',
        'Press a key or shortcut, e.g. "return", "escape", "tab", "down", "cmd+t", "cmd+space", ' +
          '"cmd+shift+4". Returns a fresh screenshot.',
        { key: z.string(), purpose: PURPOSE, confirmed: CONFIRMED },
        async (args) =>
          (await guard({ purpose: args.purpose, confirmed: args.confirmed, kind: 'key', key: args.key })) ??
          act(`Pressed ${args.key}.`, () => hand('key', args.key)),
      ),

      tool(
        'screen_scroll',
        'Scroll at a point by lines (positive dy = down, positive dx = right). Returns a fresh screenshot.',
        { x: z.number(), y: z.number(), dy: z.number().int(), dx: z.number().int().optional() },
        async (args) =>
          (await guard({ purpose: 'scroll', confirmed: false, kind: 'scroll' })) ??
          act('Scrolled.', async () => {
            await hand('move', args.x, args.y)
            await hand('scroll', args.dx ?? 0, args.dy)
          }),
      ),

      tool(
        'screen_drag',
        'Drag with the left button from one point to another (windows, sliders, files). Returns a fresh screenshot.',
        { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), purpose: PURPOSE, confirmed: CONFIRMED },
        async (args) =>
          (await guard({ purpose: args.purpose, confirmed: args.confirmed, kind: 'drag' })) ??
          act('Dragged.', () => hand('drag', args.x1, args.y1, args.x2, args.y2)),
      ),
    ],
  })
}
