import { z } from 'zod'
import { fail, ok, type HandlerResult, type Role } from './common.ts'
import { b64url } from '../crypto.ts'
import { clean } from '../notify/format.ts'
import type { Mailer } from '../notify/mailer.ts'
import { ProviderError, type ActionLogEntry } from '../types.ts'

export const INVITE_DAYS = 7

const Request = z.strictObject({
  org_id: z.uuid(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.enum(['admin', 'member']), // never 'owner'
})

export type CreateResult = { ok: true; id: string } | { ok: false; code: string; message: string }

export interface InviteDeps {
  userId: string | null
  getRole(orgId: string): Promise<Role | null>
  appUrl: string
  mailer: Mailer | null
  mailerMissing?: string[]
  /** 32 random bytes, base64url. Exists in plaintext only in the e-mailed link. */
  newToken(): string
  sha256Hex(s: string): Promise<string>
  orgName(orgId: string): Promise<string>
  inviterName(userId: string): Promise<string | null>
  /** service-role RPC; stores only the hash and re-checks that the actor is an owner */
  create(a: { actor: string; org: string; email: string; role: 'admin' | 'member'; tokenHash: string; days: number }): Promise<CreateResult>
  audit(e: ActionLogEntry): Promise<void>
}

export const newInviteToken = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)))
export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const FAILURES: Record<string, { status: number; text?: string }> = {
  '42501': { status: 403, text: 'Only owners can invite people' },
  '23505': { status: 409, text: 'That person is already a member' },
  '53400': { status: 429 },
  '22023': { status: 422 },
  '23514': { status: 422, text: 'That is not a valid e-mail address' },
}

export function inviteLink(appUrl: string, token: string): string | null {
  try {
    const u = new URL(appUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}/invite/${token}`
  } catch { return null }
}

export async function handleInvite(d: InviteDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = Request.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request', { issues: p.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`) })
  const { org_id, email, role } = p.data
  if ((await d.getRole(org_id)) !== 'owner') return fail(403, 'Only owners can invite people')

  const token = d.newToken()
  const created = await d.create({ actor: d.userId, org: org_id, email, role, tokenHash: await d.sha256Hex(token), days: INVITE_DAYS })
  if (!created.ok) {
    const f = FAILURES[created.code]
    if (!f) throw new Error(`create invitation failed: ${created.code} ${created.message}`)
    return fail(f.status, f.text ?? created.message)
  }

  const link = inviteLink(d.appUrl, token)
  const [org, inviter] = await Promise.all([d.orgName(org_id), d.inviterName(d.userId)])
  const log = (action: string, status: 'success' | 'failure', summary: string, error?: string): ActionLogEntry => ({
    org_id, user_id: d.userId, actor_type: 'system', category: 'audit', tool_name: null, action, status, summary, error: error ?? null,
  })

  // The link is the only way in. If we cannot e-mail it, hand it to the owner (once) rather than lose the invitation.
  const undelivered = async (reason: string): Promise<HandlerResult> => {
    await d.audit(log('invitation.email_failed', 'failure', `Could not e-mail the invitation to ${email}`, reason))
    return ok({ id: created.id, emailed: false, reason, ...(link ? { link } : {}) })
  }
  if (!link) return undelivered('The server has no valid APP_URL, so a link cannot be built.')
  if (!d.mailer) {
    const missing = d.mailerMissing?.length ? ` (missing: ${d.mailerMissing.join(', ')})` : ''
    return undelivered(`E-mail delivery is not configured on this server${missing}. Share the link with ${email} yourself.`)
  }

  const who = clean(inviter, 80) || 'Someone'
  const orgText = clean(org, 80) || 'their team'
  try {
    await d.mailer.send({
      to: email,
      subject: clean(`${who} invited you to ${orgText} on Aide`, 120).replace(/\s*\n\s*/g, ' '),
      text: [
        `${who} invited you to join ${orgText} on Aide as ${role === 'admin' ? 'an admin' : 'a member'}.`,
        '', `Accept the invitation: ${link}`, '',
        `This link works once, only for ${email}, and expires in ${INVITE_DAYS} days. Sign in or create your account using that address.`,
        '', "If you weren't expecting this, you can ignore this e-mail.",
      ].join('\n'),
      idempotencyKey: `aide-invite-${created.id}`,
    })
  } catch (e) {
    return undelivered(e instanceof ProviderError ? e.message : 'The e-mail could not be sent.')
  }
  await d.audit(log('invitation.emailed', 'success', `E-mailed the invitation to ${email}`))
  return ok({ id: created.id, emailed: true })
}
