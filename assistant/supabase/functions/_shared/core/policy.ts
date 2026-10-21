import { z } from 'zod'
import type { ToolDef } from './tools/registry.ts'

// Approval policy. DEFAULT = everything sensitive needs approval. An organization may add narrow
// pre-authorizations, but only for actions in AUTO_APPROVABLE and only with the constraints below.
// Deletes, payments, signing and settings changes can never be pre-authorized.

// --- Narrowness rules -------------------------------------------------------------------------
// A pre-authorization must name specific people or ONE specific organization's domain. Anything that
// effectively means "anyone" is refused. The same rules are enforced in SQL
// (private.approval_policy_error in migration 0008); a test keeps the two lists identical.

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`, 'i')
const EMAIL_RE = new RegExp(`^[a-z0-9._%+-]{1,64}@${LABEL}(?:\\.${LABEL})+$`, 'i')

/** Domains anyone can obtain an address on, plus common public suffixes. A rule for one of these means "everyone". */
export const BROAD_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
  'yandex.com', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'qq.com',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.in', 'com.br', 'co.jp',
]

const stripAt = (d: string) => (d.startsWith('@') ? d.slice(1) : d)

/** Returns a human-readable problem with a rule entry, or null when the entry is acceptable. */
export function entryProblem(entry: string, kind: 'recipient' | 'domain'): string | null {
  const e = entry.trim().toLowerCase()
  if (!e) return 'is empty'
  if (e.length > 200) return 'is too long'
  const checkDomain = (d: string) => {
    if (!DOMAIN_RE.test(d)) return 'is not a valid domain (use a full domain like acme.com)'
    if (BROAD_DOMAINS.includes(d)) return `would allow everyone on ${d}; list exact addresses instead`
    return null
  }
  if (kind === 'domain') return checkDomain(stripAt(e))
  if (e.startsWith('@')) return checkDomain(e.slice(1))
  if (!EMAIL_RE.test(e)) return 'is not a valid email address (use name@acme.com or a whole domain like @acme.com)'
  return null
}

const entries = (kind: 'recipient' | 'domain', max: number) =>
  z.array(z.string())
    .min(1, 'add at least one address or domain to each rule you turn on')
    .max(max, `a rule can list at most ${max} entries`)
    .superRefine((list, ctx) => {
    list.forEach((entry, index) => {
      const problem = entryProblem(entry, kind)
      if (problem) ctx.addIssue({ code: 'custom', path: [index], message: `"${entry}" ${problem}` })
    })
  })

export const AutoApproveRule = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('email.send'),
    /** exact addresses ("a@b.com") or whole domains ("@b.com"); ALL recipients must match */
    allowed_recipients: entries('recipient', 50),
  }),
  z.strictObject({
    action: z.literal('calendar.create_event'),
    /** only auto-approve when every attendee is at one of these domains (or there are none) */
    internal_domains: entries('domain', 20),
  }),
])
export type AutoApproveRule = z.infer<typeof AutoApproveRule>

export const ApprovalPolicy = z.strictObject({
  auto_approve: z.array(AutoApproveRule).max(50).default([]).superRefine((rules, ctx) => {
    const seen = new Set<string>()
    rules.forEach((r, index) => {
      if (seen.has(r.action)) ctx.addIssue({ code: 'custom', path: [index], message: `only one rule per action is allowed (${r.action})` })
      seen.add(r.action)
    })
  }),
})
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>

export const AUTO_APPROVABLE = ['email.send', 'calendar.create_event'] as const

/** Parses the stored JSON; an invalid policy silently falls back to the strictest one (no auto-approvals). */
export function parsePolicy(raw: unknown): ApprovalPolicy {
  const r = ApprovalPolicy.safeParse(raw)
  return r.success ? r.data : { auto_approve: [] }
}

/**
 * Canonical form for storage: trimmed, lower-cased, de-duplicated, domains prefixed with "@".
 * Returns every problem found so the UI can show them all at once. Never throws.
 */
export function validatePolicyInput(raw: unknown): { ok: true; policy: ApprovalPolicy } | { ok: false; errors: string[] } {
  const canon = (list: unknown, kind: 'recipient' | 'domain') => {
    const cleaned = (Array.isArray(list) ? list : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      .map((x) => (kind === 'domain' && !x.startsWith('@') && !x.includes('@') ? `@${x}` : x))
    return [...new Set(cleaned)]
  }
  const input = raw as { auto_approve?: Array<Record<string, unknown>> } | null
  const rules = (input?.auto_approve ?? []).map((r) =>
    r?.action === 'email.send' ? { ...r, allowed_recipients: canon(r.allowed_recipients, 'recipient') }
    : r?.action === 'calendar.create_event' ? { ...r, internal_domains: canon(r.internal_domains, 'domain') }
    : r)
  const parsed = ApprovalPolicy.safeParse({ auto_approve: rules })
  if (parsed.success) return { ok: true, policy: parsed.data }
  return { ok: false, errors: parsed.error.issues.map((i) => i.message) }
}

export type Decision = { kind: 'allow' } | { kind: 'needs_approval'; reason: string }

const norm = (s: string) => s.trim().toLowerCase()

export function recipientAllowed(addr: string, allowed: string[]): boolean {
  const a = norm(addr)
  return allowed.some((rule) => {
    const r = norm(rule)
    return r.startsWith('@') ? a.endsWith(r) : a === r
  })
}

function ruleMatches(rule: AutoApproveRule, input: unknown): boolean {
  const i = input as Record<string, unknown>
  if (rule.action === 'email.send') {
    const to = [...((i.to as string[]) ?? []), ...((i.cc as string[]) ?? []), ...((i.bcc as string[]) ?? [])]
    return to.length > 0 && to.every((a) => recipientAllowed(a, rule.allowed_recipients))
  }
  if (rule.action === 'calendar.create_event') {
    const attendees = (i.attendees as string[]) ?? []
    return attendees.every((a) => recipientAllowed(a, rule.internal_domains.map((d) => (d.startsWith('@') ? d : `@${d}`))))
  }
  return false
}

export function decide(tool: Pick<ToolDef, 'name' | 'risk'>, input: unknown, policy: ApprovalPolicy): Decision {
  if (tool.risk !== 'sensitive') return { kind: 'allow' }
  if ((AUTO_APPROVABLE as readonly string[]).includes(tool.name)) {
    const rule = policy.auto_approve.find((r) => r.action === tool.name && ruleMatches(r, input))
    if (rule) return { kind: 'allow' }
  }
  return { kind: 'needs_approval', reason: 'This action is sensitive and requires your approval.' }
}
