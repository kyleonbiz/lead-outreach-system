import { z } from 'zod'
import type { ToolDef } from './tools/registry.ts'

// Approval policy. DEFAULT = everything sensitive needs approval. An organization may add narrow
// pre-authorizations, but only for actions in AUTO_APPROVABLE and only with the constraints below.
// Deletes, payments, signing and settings changes can never be pre-authorized.

export const AutoApproveRule = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('email.send'),
    /** exact addresses ("a@b.com") or whole domains ("@b.com"); ALL recipients must match */
    allowed_recipients: z.array(z.string().min(3).max(200)).min(1).max(50),
  }),
  z.object({
    action: z.literal('calendar.create_event'),
    /** only auto-approve when every attendee is at one of these domains (or there are none) */
    internal_domains: z.array(z.string().min(3).max(200)).min(1).max(20),
  }),
])
export type AutoApproveRule = z.infer<typeof AutoApproveRule>

export const ApprovalPolicy = z.object({
  auto_approve: z.array(AutoApproveRule).max(50).default([]),
})
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>

export const AUTO_APPROVABLE = ['email.send', 'calendar.create_event'] as const

/** Parses the stored JSON; an invalid policy silently falls back to the strictest one (no auto-approvals). */
export function parsePolicy(raw: unknown): ApprovalPolicy {
  const r = ApprovalPolicy.safeParse(raw)
  return r.success ? r.data : { auto_approve: [] }
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
