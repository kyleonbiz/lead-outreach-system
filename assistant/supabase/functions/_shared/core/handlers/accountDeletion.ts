import { z } from 'zod'
import { fail, ok, type HandlerResult } from './common.ts'
import type { ActionLogEntry } from '../types.ts'

// "Delete my account". Irreversible, so it is gated three ways: the person must type their own e-mail address, must have
// signed in recently (a stolen, still-valid session cannot delete the account), and must explicitly acknowledge every
// organization that will be deleted along with them. An organization they solely own that still has other members blocks the
// deletion until ownership is transferred: nobody's team is ever destroyed by someone else leaving.

export const RECENT_SIGN_IN_MINUTES = 15

export interface PlanRow { org_id: string; org_name: string; role: string; member_count: number; owner_count: number; plan: 'leave' | 'delete_org' | 'blocked' }
export interface DisconnectedIntegration { provider: string; account: string; revoked: boolean }

const Request = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('preview') }),
  z.strictObject({ action: z.literal('delete'), confirm_email: z.string().max(320), delete_org_ids: z.array(z.uuid()).max(50).default([]) }),
])

export interface AccountDeletionDeps {
  userId: string | null
  /** from the verified session, never from the request body */
  userEmail: string | null
  lastSignInAt: string | null
  now(): Date
  plan(userId: string): Promise<PlanRow[]>
  /** disconnects every provider account this person connected (revoking where the provider allows it) and deletes our stored credentials */
  disconnectIntegrations(userId: string): Promise<DisconnectedIntegration[]>
  /** removes the organization's files and then the organization (and with it all its data) */
  deleteOrganization(orgId: string): Promise<void>
  scrubLogs(userId: string, email: string): Promise<number>
  deleteUser(userId: string): Promise<void>
  audit(e: ActionLogEntry): Promise<void>
}

const recentSignIn = (d: AccountDeletionDeps): boolean => {
  const t = Date.parse(d.lastSignInAt ?? '')
  return Number.isFinite(t) && d.now().getTime() - t <= RECENT_SIGN_IN_MINUTES * 60_000
}
const view = (r: PlanRow) => ({ id: r.org_id, name: r.org_name, role: r.role, members: r.member_count, plan: r.plan })

export async function handleAccountDeletion(d: AccountDeletionDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = Request.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  const plan = await d.plan(d.userId)

  if (p.data.action === 'preview') {
    return ok({
      email: d.userEmail, recent_sign_in: recentSignIn(d), recent_sign_in_minutes: RECENT_SIGN_IN_MINUTES,
      organizations: plan.map(view), can_delete: !plan.some((r) => r.plan === 'blocked'),
    })
  }

  const { confirm_email, delete_org_ids } = p.data
  if (!d.userEmail || confirm_email.trim().toLowerCase() !== d.userEmail.trim().toLowerCase()) {
    return fail(400, 'Type your e-mail address exactly to confirm', { code: 'confirmation_mismatch' })
  }
  if (!recentSignIn(d)) {
    return fail(403, `For your security, sign in again (within the last ${RECENT_SIGN_IN_MINUTES} minutes) before deleting your account`, { code: 'reauth_required' })
  }
  const blocked = plan.filter((r) => r.plan === 'blocked')
  if (blocked.length) {
    return fail(409, 'Transfer ownership of these organizations before deleting your account', { code: 'ownership_transfer_required', organizations: blocked.map(view) })
  }
  const willDelete = plan.filter((r) => r.plan === 'delete_org')
  const known = new Set(willDelete.map((r) => r.org_id))
  if (delete_org_ids.some((id) => !known.has(id))) return fail(400, 'That list contains an organization that is not yours to delete', { code: 'unknown_organization' })
  if (willDelete.some((r) => !delete_org_ids.includes(r.org_id))) {
    return fail(409, 'These organizations will be permanently deleted with your account. Confirm each one to continue', { code: 'confirm_organizations', organizations: willDelete.map(view) })
  }

  // Every step is idempotent: if one fails the account still exists and the whole request can simply be repeated.
  const done: string[] = []
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | HandlerResult> => {
    try { const r = await fn(); done.push(name); return r } catch (e) {
      console.error('account deletion step failed', name, e instanceof Error ? e.message : e)
      return fail(500, 'Deleting your account did not finish. Nothing more was removed; you can try again', { code: 'incomplete', failed_step: name, completed_steps: done })
    }
  }
  const isFailure = (x: unknown): x is HandlerResult => typeof x === 'object' && x !== null && 'status' in x && 'body' in x

  const integrations = await step('disconnect_integrations', () => d.disconnectIntegrations(d.userId!))
  if (isFailure(integrations)) return integrations
  for (const org of willDelete) {
    const r = await step(`delete_organization:${org.org_id}`, () => d.deleteOrganization(org.org_id))
    if (isFailure(r)) return r
  }
  const scrubbed = await step('scrub_audit_log', () => d.scrubLogs(d.userId!, d.userEmail!))
  if (isFailure(scrubbed)) return scrubbed
  for (const org of plan.filter((r) => r.plan === 'leave')) {
    // a neutral note for the people who remain; it does not name the person who left
    await d.audit({
      org_id: org.org_id, user_id: null, actor_type: 'system', category: 'audit', tool_name: null, action: 'member.account_deleted', status: 'success',
      summary: 'A team member deleted their account',
    }).catch(() => {})
  }
  const gone = await step('delete_account', () => d.deleteUser(d.userId!))
  if (isFailure(gone)) return gone

  return ok({
    deleted: true, deleted_organizations: willDelete.map((r) => r.org_name),
    disconnected_integrations: integrations as DisconnectedIntegration[], audit_entries_anonymized: scrubbed as number,
  })
}
