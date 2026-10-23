import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { simpleParser } from 'mailparser'

/**
 * A work mailbox over IMAP and SMTP (info@cresdynamics.com on Namecheap
 * Private Email), for mail that does not live in Gmail.
 *
 * Settings that are not secret sit in ~/.jarvis/mail.json:
 *   { "user", "imapHost", "imapPort", "smtpHost", "smtpPort" }
 * The password is never in a file. It lives in the macOS login Keychain as a
 * generic password, service "jarvis-mail", account = the mailbox address:
 *   security add-generic-password -U -a <user> -s jarvis-mail -w
 * and is read at the moment of each connection.
 *
 * Reading is free. Writing goes in two steps on purpose: create_draft puts a
 * draft in the mailbox's Drafts folder (visible in webmail, editable there),
 * and send_draft sends one of those drafts. The server name contains "mail",
 * so decideTool treats it as mail: reads always, drafts and sending only with
 * writes enabled.
 */

const CONFIG_FILE = process.env.JARVIS_MAIL_CONFIG ?? join(homedir(), '.jarvis', 'mail.json')
const KEYCHAIN_SERVICE = 'jarvis-mail'

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return cfg.user && cfg.imapHost ? cfg : null
  } catch {
    return null
  }
}

/** Whether a mailbox is configured at all; the server is only built if so. */
export function mailConfigured() {
  return process.platform === 'darwin' && loadConfig() !== null
}

function keychainPassword(user) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-a', user, '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 10_000 },
      (err, stdout) => (err ? reject(new Error('The mailbox password is not in the Keychain.')) : resolve(stdout.trim())),
    )
  })
}

async function withImap(fn) {
  const cfg = loadConfig()
  if (!cfg) throw new Error('No mailbox is configured.')
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort ?? 993,
    secure: true,
    auth: { user: cfg.user, pass: await keychainPassword(cfg.user) },
    logger: false,
  })
  await client.connect()
  try {
    return await fn(client, cfg)
  } finally {
    await client.logout().catch(() => {})
  }
}

/** The folder carrying an IMAP special-use flag, e.g. \Drafts or \Sent. */
async function specialFolder(client, use, fallback) {
  const list = await client.list()
  return list.find((f) => f.specialUse === use)?.path ?? list.find((f) => f.name === fallback)?.path ?? fallback
}

const addr = (list) => (list ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')

function summarise(msg) {
  const e = msg.envelope ?? {}
  return (
    `uid ${msg.uid} · ${e.date ? new Date(e.date).toISOString().slice(0, 16).replace('T', ' ') : '?'}` +
    ` · from ${addr(e.from)} · "${e.subject ?? '(no subject)'}"` +
    (msg.flags?.has('\\Seen') ? '' : ' · UNREAD')
  )
}

async function readMessage(client, folder, uid) {
  const lock = await client.getMailboxLock(folder)
  try {
    const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true })
    if (!msg) return null
    return { parsed: await simpleParser(msg.source), source: msg.source }
  } finally {
    lock.release()
  }
}

export function mailServer() {
  const cfg = loadConfig()
  return createSdkMcpServer({
    name: 'jarvis_mail',
    version: '1.0.0',
    instructions:
      `The work mailbox ${cfg?.user ?? ''}: search and read its mail, prepare replies and ` +
      'follow-ups as drafts, and send a draft once the user has said to send it.',
    tools: [
      tool(
        'search_mail',
        `Search the work mailbox (${cfg?.user ?? 'info@'}). With no arguments, lists the last ` +
          'three days of the inbox, newest first. Returns one line per message with its uid.',
        {
          query: z.string().optional().describe('Words to find in the subject, sender or body.'),
          from: z.string().optional().describe('Sender name or address to match.'),
          unread: z.boolean().optional().describe('Only unread messages.'),
          days: z.number().int().min(1).max(365).optional().describe('How many days back. Default 3.'),
          folder: z.enum(['inbox', 'sent', 'drafts']).optional().describe('Default inbox.'),
          limit: z.number().int().min(1).max(50).optional().describe('Most messages to return. Default 15.'),
        },
        async (args) => {
          try {
            return await withImap(async (client) => {
              const folder =
                args.folder === 'sent'
                  ? await specialFolder(client, '\\Sent', 'Sent')
                  : args.folder === 'drafts'
                    ? await specialFolder(client, '\\Drafts', 'Drafts')
                    : 'INBOX'
              const lock = await client.getMailboxLock(folder)
              try {
                const criteria = { since: new Date(Date.now() - (args.days ?? 3) * 86_400_000) }
                if (args.unread) criteria.seen = false
                if (args.from) criteria.from = args.from
                if (args.query) criteria.text = args.query
                const uids = (await client.search(criteria, { uid: true })) || []
                const pick = uids.slice(-(args.limit ?? 15))
                if (!pick.length) return ok('No messages match.')
                const lines = []
                for await (const msg of client.fetch(pick.join(','), { envelope: true, flags: true }, { uid: true })) {
                  lines.push(summarise(msg))
                }
                return ok(`${uids.length} match; newest ${lines.length}:\n` + lines.reverse().join('\n'))
              } finally {
                lock.release()
              }
            })
          } catch (err) {
            return fail(`Could not reach the mailbox: ${err.message}`)
          }
        },
      ),

      tool(
        'read_mail',
        'Read one message from the work mailbox by uid (from search_mail): who, when, subject and ' +
          'the text. Marks it as read.',
        {
          uid: z.number().int().describe('The uid from search_mail.'),
          folder: z.enum(['inbox', 'sent', 'drafts']).optional().describe('Default inbox.'),
        },
        async (args) => {
          try {
            return await withImap(async (client) => {
              const folder =
                args.folder === 'sent'
                  ? await specialFolder(client, '\\Sent', 'Sent')
                  : args.folder === 'drafts'
                    ? await specialFolder(client, '\\Drafts', 'Drafts')
                    : 'INBOX'
              const got = await readMessage(client, folder, args.uid)
              if (!got) return fail(`No message with uid ${args.uid}.`)
              const m = got.parsed
              const text = (m.text ?? '').trim().slice(0, 12_000)
              return ok(
                `From: ${m.from?.text ?? ''}\nTo: ${m.to?.text ?? ''}\n` +
                  (m.cc ? `Cc: ${m.cc.text}\n` : '') +
                  `Date: ${m.date?.toISOString() ?? ''}\nSubject: ${m.subject ?? ''}\n\n${text}`,
              )
            })
          } catch (err) {
            return fail(`Could not reach the mailbox: ${err.message}`)
          }
        },
      ),

      tool(
        'create_draft',
        'Write an email from the work address and save it in the mailbox Drafts folder. Nothing ' +
          'is sent. For a reply or follow-up give reply_to_uid (an inbox uid) and it threads ' +
          'correctly; `to` and the subject then default to the original. Returns the draft uid.',
        {
          body: z.string().describe('The plain-text email body, signed off as the user would.'),
          to: z.string().optional().describe('Recipient address(es), comma separated.'),
          cc: z.string().optional(),
          subject: z.string().optional(),
          reply_to_uid: z.number().int().optional().describe('Inbox uid of the message being answered.'),
        },
        async (args) => {
          try {
            return await withImap(async (client, cfg) => {
              const mail = { from: cfg.user, text: args.body, to: args.to, cc: args.cc, subject: args.subject }
              if (args.reply_to_uid) {
                const got = await readMessage(client, 'INBOX', args.reply_to_uid)
                if (!got) return fail(`No inbox message with uid ${args.reply_to_uid}.`)
                const o = got.parsed
                mail.to ??= o.replyTo?.text ?? o.from?.text
                mail.subject ??= /^re:/i.test(o.subject ?? '') ? o.subject : `Re: ${o.subject ?? ''}`
                if (o.messageId) {
                  mail.inReplyTo = o.messageId
                  mail.references = [...[o.references ?? []].flat(), o.messageId]
                }
              }
              if (!mail.to) return fail('Who is it to?')
              const raw = await new MailComposer(mail).compile().build()
              const drafts = await specialFolder(client, '\\Drafts', 'Drafts')
              const res = await client.append(drafts, raw, ['\\Draft', '\\Seen'])
              return ok(`Draft saved (draft uid ${res.uid}) to ${mail.to}, subject "${mail.subject ?? ''}". Not sent.`)
            })
          } catch (err) {
            return fail(`Could not save the draft: ${err.message}`)
          }
        },
      ),

      tool(
        'send_draft',
        'Send a draft from the Drafts folder by its draft uid. Only call this after the user has ' +
          'heard who it is to and what it says, and has explicitly told you to send it. Files a ' +
          'copy in Sent and removes the draft.',
        { draft_uid: z.number().int().describe('The draft uid from create_draft or search_mail (drafts).') },
        async (args) => {
          try {
            return await withImap(async (client, cfg) => {
              const drafts = await specialFolder(client, '\\Drafts', 'Drafts')
              const got = await readMessage(client, drafts, args.draft_uid)
              if (!got) return fail(`No draft with uid ${args.draft_uid}.`)
              const m = got.parsed
              const rcpt = [m.to, m.cc, m.bcc]
                .flatMap((x) => (Array.isArray(x) ? x : x ? [x] : []))
                .flatMap((x) => x.value.map((a) => a.address))
                .filter(Boolean)
              if (!rcpt.length) return fail('That draft has no recipients.')
              const smtp = nodemailer.createTransport({
                host: cfg.smtpHost ?? cfg.imapHost,
                port: cfg.smtpPort ?? 465,
                secure: true,
                auth: { user: cfg.user, pass: await keychainPassword(cfg.user) },
              })
              await smtp.sendMail({ envelope: { from: cfg.user, to: rcpt }, raw: got.source })
              const sent = await specialFolder(client, '\\Sent', 'Sent')
              await client.append(sent, got.source, ['\\Seen']).catch(() => {})
              const lock = await client.getMailboxLock(drafts)
              try {
                await client.messageDelete(String(args.draft_uid), { uid: true })
              } finally {
                lock.release()
              }
              return ok(`Sent to ${rcpt.join(', ')}: "${m.subject ?? ''}".`)
            })
          } catch (err) {
            return fail(`Could not send: ${err.message}`)
          }
        },
      ),
    ],
  })
}
