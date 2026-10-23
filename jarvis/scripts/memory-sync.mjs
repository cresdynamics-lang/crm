/**
 * Carry JARVIS's memory between computers through the repository.
 *
 *   npm run memory:save     copy ~/.jarvis → memory/ (credentials removed), to commit
 *   npm run memory:restore  copy memory/ → ~/.jarvis, filling in what is missing
 *
 * `npm start` runs the restore by itself, so on a new computer the first start
 * already knows the user. A file that exists on this computer is never
 * overwritten by restore; pass --force to replace them.
 *
 * Saving removes credentials. Any exchange or note that mentions a password,
 * PIN, key or token is left out of the copy: the repository is not the place
 * for secrets even when it is private, and a spoken password cannot be told
 * apart from the rest of a sentence reliably enough to cut out only the secret.
 *
 * Only the memory files travel. The browser profile, logs and anything else in
 * ~/.jarvis stay on the computer they belong to.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME_DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory')
const FILES = ['profile.md', 'notes.md', 'history.jsonl', 'contacts.json']

const SECRET =
  /\b(pass ?word|passwd|passcode|pin( code| number)?|api[ _-]?key|secret|token|cvv|card number|otp|one[- ]time code)\b/i

function redact(name, text) {
  if (name === 'history.jsonl') {
    const kept = []
    let dropped = 0
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (SECRET.test(`${entry.user} ${entry.jarvis}`)) dropped++
      else kept.push(line)
    }
    return { text: kept.join('\n') + (kept.length ? '\n' : ''), dropped }
  }
  if (name === 'notes.md') {
    const lines = text.split(/\r?\n/)
    const kept = lines.filter((l) => !SECRET.test(l))
    return { text: kept.join('\n'), dropped: lines.length - kept.length }
  }
  return { text, dropped: 0 }
}

function save() {
  mkdirSync(REPO_DIR, { recursive: true })
  for (const name of FILES) {
    const from = join(HOME_DIR, name)
    if (!existsSync(from)) continue
    const { text, dropped } = redact(name, readFileSync(from, 'utf8'))
    writeFileSync(join(REPO_DIR, name), text)
    console.log(`  saved ${name}${dropped ? ` (${dropped} item(s) with credentials left out)` : ''}`)
  }
  console.log(`Memory copied to ${REPO_DIR}. Commit and push to take it to another computer.`)
}

function restore(force) {
  if (!existsSync(REPO_DIR)) return
  mkdirSync(HOME_DIR, { recursive: true })
  let restored = 0
  for (const name of FILES) {
    const from = join(REPO_DIR, name)
    const to = join(HOME_DIR, name)
    if (!existsSync(from) || (existsSync(to) && !force)) continue
    copyFileSync(from, to)
    restored++
    console.log(`  restored ${name}`)
  }
  if (restored) console.log(`JARVIS's memory was restored into ${HOME_DIR}.`)
}

const mode = process.argv[2]
if (mode === 'save') save()
else if (mode === 'restore') restore(process.argv.includes('--force'))
else console.log('usage: node scripts/memory-sync.mjs save | restore [--force]')
