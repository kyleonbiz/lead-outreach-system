import { z } from 'zod'
import type { EmailMessageSummary } from '../ports.ts'

export const EmailRules = z.object({
  urgent_keywords: z.array(z.string().min(1).max(60)).max(50).default([]),
  vip_senders: z.array(z.string().min(3).max(200)).max(100).default([]),
  ignore_senders: z.array(z.string().min(3).max(200)).max(100).default([]),
})
export type EmailRules = z.infer<typeof EmailRules>

export const DEFAULT_URGENT = ['urgent', 'asap', 'immediately', 'overdue', 'past due', 'final notice', 'deadline', 'time sensitive', 'action required', 'payment failed']

export function parseRules(raw: unknown): EmailRules {
  const r = EmailRules.safeParse(raw ?? {})
  return r.success ? r.data : { urgent_keywords: [], vip_senders: [], ignore_senders: [] }
}

const REQUEST = /\?|\b(can you|could you|would you|please (send|confirm|let|review|call|reply|advise)|let me know|need (you|to)|when can|are you able|waiting (on|for))\b/i
const AUTOMATED = /(no-?reply|do-?not-?reply|notifications?@|newsletter|mailer-daemon|updates@|receipts?@)/i

const senderAddr = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase()
const matches = (addr: string, rules: string[]) => rules.some((r) => (r.startsWith('@') ? addr.endsWith(r.toLowerCase()) : addr === r.toLowerCase()))

export interface Triage { urgent: boolean; needsResponse: boolean; automated: boolean; reasons: string[] }

/** Transparent, rule-based triage (no model call): every flag comes with the reason that triggered it. */
export function classify(m: Pick<EmailMessageSummary, 'from' | 'subject' | 'snippet' | 'unread'>, rules: EmailRules, me: string): Triage {
  const addr = senderAddr(m.from)
  const reasons: string[] = []
  if (matches(addr, rules.ignore_senders)) return { urgent: false, needsResponse: false, automated: true, reasons: ['sender is on your ignore list'] }
  const text = `${m.subject} ${m.snippet}`.toLowerCase()
  const automated = AUTOMATED.test(addr)

  const keyword = [...DEFAULT_URGENT, ...rules.urgent_keywords].find((k) => text.includes(k.toLowerCase()))
  if (keyword) reasons.push(`contains "${keyword}"`)
  const vip = matches(addr, rules.vip_senders)
  if (vip) reasons.push('from a VIP sender')

  const fromMe = addr === me.toLowerCase()
  const asks = REQUEST.test(`${m.subject} ${m.snippet}`)
  const needsResponse = !fromMe && !automated && m.unread && (asks || vip)
  if (needsResponse) reasons.push(asks ? 'asks a question or makes a request' : 'unread message from a VIP')

  return { urgent: !!keyword || vip, needsResponse, automated, reasons }
}
