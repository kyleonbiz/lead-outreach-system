import { z } from 'zod'
import type { ToolDef } from './registry.ts'
import { classify, parseRules } from '../providers/emailRules.ts'

const emails = z.array(z.email()).min(1).max(20)

export const emailSearch: ToolDef = {
  name: 'email.search',
  description: 'Search the connected mailbox using Gmail search syntax (e.g. "is:unread newer_than:2d", "from:acme.com invoice"). Returns message summaries.',
  risk: 'read', untrusted: true,
  input: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(25).default(10) }),
  summarize: (i) => `Search email for "${i.query}"`,
  async execute(ctx, i) { return (await ctx.ports.email()).search(i.query, i.limit) },
}

export const emailGetThread: ToolDef = {
  name: 'email.get_thread',
  description: 'Read the full text of an email thread (last 10 messages). Use to summarize a conversation or prepare a reply.',
  risk: 'read', untrusted: true,
  input: z.object({ thread_id: z.string().min(1).max(100) }),
  summarize: (i) => `Read email thread ${i.thread_id}`,
  async execute(ctx, i) { return (await ctx.ports.email()).getThread(i.thread_id) },
}

export const emailTriage: ToolDef = {
  name: 'email.triage',
  description: 'List recent unread inbox messages with rule-based flags: urgent, needs a response, and why. Good for "summarize my unread email and what is urgent".',
  risk: 'read', untrusted: true,
  input: z.object({ days: z.number().int().min(1).max(30).default(3), limit: z.number().int().min(1).max(30).default(15) }),
  summarize: (i) => `Triage unread email from the last ${i.days} days`,
  async execute(ctx, i) {
    const mail = await ctx.ports.email()
    const rules = parseRules(await ctx.ports.emailRules?.())
    const msgs = await mail.search(`in:inbox is:unread newer_than:${i.days}d`, i.limit)
    return msgs.map((m) => ({ ...m, triage: classify(m, rules, mail.accountEmail()) }))
  },
}

export const emailCreateDraft: ToolDef = {
  name: 'email.create_draft',
  description: 'Save a draft in the user\'s mailbox. Does NOT send anything. Use this for "draft a reply"; the user reviews and sends it themselves.',
  risk: 'write',
  input: z.object({
    to: emails, cc: z.array(z.email()).max(20).optional(), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000),
    reply_to_thread_id: z.string().max(100).optional(),
  }),
  summarize: (i) => `Save a draft to ${i.to.join(', ')}: "${i.subject}"`,
  async execute(ctx, i) {
    const r = await (await ctx.ports.email()).createDraft({ to: i.to, cc: i.cc, subject: i.subject, body: i.body, inReplyToThreadId: i.reply_to_thread_id })
    return { ...r, note: 'Draft saved. It has NOT been sent.' }
  },
}

export const emailSend: ToolDef = {
  name: 'email.send',
  description: 'Send an email to external recipients. ALWAYS requires the user\'s approval unless they pre-authorized these exact recipients. Prefer email.create_draft unless the user clearly asked to send.',
  risk: 'sensitive',
  input: z.object({
    to: emails, cc: z.array(z.email()).max(20).optional(), bcc: z.array(z.email()).max(20).optional(),
    subject: z.string().min(1).max(300), body: z.string().min(1).max(20000), reply_to_thread_id: z.string().max(100).optional(),
  }),
  summarize: (i) => `Send email to ${[...i.to, ...(i.cc ?? []), ...(i.bcc ?? [])].join(', ')} — subject "${i.subject}" (${i.body.length} characters)`,
  async execute(ctx, i) {
    const r = await (await ctx.ports.email()).send({ to: i.to, cc: i.cc, bcc: i.bcc, subject: i.subject, body: i.body, inReplyToThreadId: i.reply_to_thread_id })
    return { sent: true, messageId: r.messageId }
  },
}

export const emailTools = [emailSearch, emailGetThread, emailTriage, emailCreateDraft, emailSend]
