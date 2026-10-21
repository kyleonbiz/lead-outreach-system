import { z } from 'zod'
import { fail, ok, type HandlerResult, type Role } from './common.ts'
import { NotConfiguredError, ProviderError } from '../types.ts'
import type { CalendarProvider, EmailProvider } from '../ports.ts'
import { classify, parseRules } from '../providers/emailRules.ts'
import { zonedStartOfDay } from '../time.ts'

const Req = z.discriminatedUnion('action', [
  z.object({ action: z.literal('email.triage'), org_id: z.uuid(), days: z.number().int().min(1).max(30).default(3), limit: z.number().int().min(1).max(30).default(20) }),
  z.object({ action: z.literal('calendar.agenda'), org_id: z.uuid(), days: z.number().int().min(1).max(14).default(1) }),
])

export interface ProviderDataDeps {
  userId: string | null
  now(): Date
  getRole(orgId: string): Promise<Role | null>
  timezone(orgId: string): Promise<string>
  emailRules(orgId: string): Promise<unknown>
  email(orgId: string): Promise<EmailProvider>
  calendar(orgId: string): Promise<CalendarProvider>
}

/** Read-only data for the Email and Calendar pages (same adapters and rules the assistant tools use). */
export async function handleProviderData(d: ProviderDataDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = Req.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  if (!(await d.getRole(p.data.org_id))) return fail(403, 'You are not a member of this organization')

  try {
    if (p.data.action === 'email.triage') {
      const mail = await d.email(p.data.org_id)
      const rules = parseRules(await d.emailRules(p.data.org_id))
      const msgs = await mail.search(`in:inbox is:unread newer_than:${p.data.days}d`, p.data.limit)
      return ok({ account: mail.accountEmail(), messages: msgs.map((m) => ({ ...m, triage: classify(m, rules, mail.accountEmail()) })) })
    }
    const tz = await d.timezone(p.data.org_id)
    const start = zonedStartOfDay(d.now(), tz)
    const end = zonedStartOfDay(d.now(), tz, p.data.days)
    const events = await (await d.calendar(p.data.org_id)).listEvents(start.toISOString(), end.toISOString(), 50)
    return ok({ timezone: tz, from: start.toISOString(), to: end.toISOString(), events })
  } catch (e) {
    if (e instanceof NotConfiguredError) return fail(409, e.message, { code: 'not_connected' })
    if (e instanceof ProviderError) return fail(502, e.message, { code: e.kind })
    throw e
  }
}
