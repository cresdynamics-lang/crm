/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 * Pass --open to show him in a window of his own that may speak without being
 * clicked first: `npm start -- --writes --open`.
 */

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = new Map()

/** A half that keeps dying is broken, not unlucky: give up after this many
 *  restarts inside the window rather than spin for ever. */
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 60_000

function run(name, command, args, colour, env, restarts = []) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    if (stopping) return
    // One half crashing used to take the whole assistant down until someone
    // noticed and started it again. Bring that half back instead; the page
    // reconnects to the bridge by itself on the next question.
    const now = Date.now()
    const recent = restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (recent.length >= MAX_RESTARTS) {
      console.log(`\x1b[${colour}m${name}\x1b[0m keeps exiting (${code}); stopping the rest.`)
      return shutdown(code ?? 1)
    }
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); restarting it.`)
    setTimeout(() => {
      if (!stopping) run(name, command, args, colour, env, [...recent, now])
    }, 1000)
  })
  children.set(name, child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children.values()) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()

// On a computer that has never run JARVIS, bring his memory of the user in
// from the repository (memory/), so the first start already knows them. Files
// already on this computer are left alone. See scripts/memory-sync.mjs.
spawnSync(process.execPath, ['scripts/memory-sync.mjs', 'restore'], { stdio: 'inherit' })

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

if (process.argv.includes('--open')) {
  void openWindow(`http://localhost:${port || 5173}`)
} else {
  console.log(
    '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
      'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
  )
}

/**
 * --open: show JARVIS in a window of his own, once the page is being served.
 *
 * Not a convenience so much as a fix. A page may not speak until it has been
 * clicked, so an assistant that starts by himself in an ordinary tab can hear
 * and act but is mute, which is indistinguishable from not answering. A browser
 * started with `--autoplay-policy=no-user-gesture-required` has no such rule.
 * That flag only takes effect on a fresh browser process, hence the profile of
 * its own — which also keeps him out of the user's everyday tabs, where a
 * second copy of this page is the other classic way he stops responding.
 *
 * The microphone is asked for once in that profile and remembered.
 */
async function openWindow(url) {
  const candidates =
    process.platform === 'win32'
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  const browser = candidates.find((p) => p && existsSync(p))
  if (!browser) {
    console.log(`\n  --open: Chrome or Edge was not found. Open ${url} in Chrome yourself.\n`)
    return
  }

  // Wait for the page to be served, so the window does not open on an error.
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const profile = join(homedir(), '.jarvis', 'browser')
  mkdirSync(profile, { recursive: true })
  spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--autoplay-policy=no-user-gesture-required',
      // Keep listening when the window is behind others or minimised. Chrome
      // otherwise treats a covered window as hidden, throttles it and stops
      // its speech recognition — he goes deaf the moment you switch to
      // something else, which is most of the time.
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
    ],
    { stdio: 'ignore', detached: true },
  ).unref()
  console.log(`\n  JARVIS is open in his own window. Ctrl-C here stops everything.\n`)
}
