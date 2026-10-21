import { describe, expect, it, vi } from 'vitest'
import { handleAccountDeletion, RECENT_SIGN_IN_MINUTES, type AccountDeletionDeps, type PlanRow } from './accountDeletion.ts'

const NOW = new Date('2026-10-21T12:00:00Z')
const U = 'u-1'
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333'
const row = (org_id: string, plan: PlanRow['plan'], o: Partial<PlanRow> = {}): PlanRow =>
  ({ org_id, org_name: `Org ${org_id.slice(0, 1)}`, role: 'owner', member_count: plan === 'delete_org' ? 1 : 3, owner_count: 1, plan, ...o })

function world(plan: PlanRow[], over: Partial<AccountDeletionDeps> = {}) {
  const calls: string[] = []
  const audits: Array<Record<string, unknown>> = []
  const d: AccountDeletionDeps = {
    userId: U, userEmail: 'Jane@Acme.com', lastSignInAt: new Date(NOW.getTime() - 60_000).toISOString(), now: () => NOW,
    plan: async () => plan,
    disconnectIntegrations: async () => { calls.push('disconnect'); return [{ provider: 'google_gmail', account: 'jane@acme.com', revoked: true }] },
    deleteOrganization: async (id) => { calls.push(`org:${id}`) },
    scrubLogs: async () => { calls.push('scrub'); return 4 },
    deleteUser: async () => { calls.push('user') },
    audit: async (e) => { audits.push(e as unknown as Record<string, unknown>) },
    ...over,
  }
  return { d, calls, audits }
}
const del = (o: Record<string, unknown> = {}) => ({ action: 'delete', confirm_email: 'jane@acme.com', delete_org_ids: [], ...o })

describe('preview', () => {
  it('tells the person exactly what would happen, without changing anything', async () => {
    const w = world([row(A, 'leave', { role: 'member' }), row(B, 'delete_org'), row(C, 'blocked')])
    const r = await handleAccountDeletion(w.d, { action: 'preview' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ email: 'Jane@Acme.com', recent_sign_in: true, can_delete: false })
    expect((r.body.organizations as Array<{ plan: string }>).map((o) => o.plan)).toEqual(['leave', 'delete_org', 'blocked'])
    expect(w.calls).toEqual([])
  })
  it('reports when a fresh sign-in is needed, and that deletion is possible when nothing blocks it', async () => {
    const r = await handleAccountDeletion(world([row(A, 'leave')], { lastSignInAt: new Date(NOW.getTime() - 3_600_000).toISOString() }).d, { action: 'preview' })
    expect(r.body).toMatchObject({ recent_sign_in: false, can_delete: true, recent_sign_in_minutes: RECENT_SIGN_IN_MINUTES })
  })
  it('requires sign-in and a well-formed request', async () => {
    expect((await handleAccountDeletion(world([], { userId: null }).d, { action: 'preview' })).status).toBe(401)
    for (const bad of [null, {}, { action: 'nuke' }, { action: 'preview', extra: 1 }, { action: 'delete' }, { action: 'delete', confirm_email: 'x', delete_org_ids: ['nope'] }]) {
      expect((await handleAccountDeletion(world([]).d, bad)).status).toBe(400)
    }
  })
})

describe('refusals (nothing is touched)', () => {
  it('the typed e-mail must match the signed-in account exactly (case-insensitive)', async () => {
    for (const confirm of ['', 'other@acme.com', 'jane@acme.co', 'jane@acme.com ; x']) {
      const w = world([row(A, 'leave')])
      expect(await handleAccountDeletion(w.d, del({ confirm_email: confirm }))).toMatchObject({ status: 400, body: { code: 'confirmation_mismatch' } })
      expect(w.calls).toEqual([])
    }
    expect((await handleAccountDeletion(world([row(A, 'leave')]).d, del({ confirm_email: '  JANE@acme.COM ' }))).status).toBe(200)
  })
  it('a session older than 15 minutes cannot delete the account', async () => {
    for (const last of [new Date(NOW.getTime() - 16 * 60_000).toISOString(), null, 'garbage', new Date(NOW.getTime() - 86_400_000).toISOString()]) {
      const w = world([row(A, 'leave')], { lastSignInAt: last })
      expect(await handleAccountDeletion(w.d, del())).toMatchObject({ status: 403, body: { code: 'reauth_required' } })
      expect(w.calls).toEqual([])
    }
    expect((await handleAccountDeletion(world([row(A, 'leave')], { lastSignInAt: new Date(NOW.getTime() - 14 * 60_000).toISOString() }).d, del())).status).toBe(200)
  })
  it('a missing account e-mail can never be confirmed', async () => {
    expect((await handleAccountDeletion(world([row(A, 'leave')], { userEmail: null }).d, del({ confirm_email: '' }))).status).toBe(400)
  })
  it('a sole owner of an organization with other members is blocked until ownership is transferred', async () => {
    const w = world([row(A, 'leave'), row(C, 'blocked', { org_name: 'The Big Team' })])
    const r = await handleAccountDeletion(w.d, del())
    expect(r).toMatchObject({ status: 409, body: { code: 'ownership_transfer_required' } })
    expect(JSON.stringify(r.body)).toContain('The Big Team')
    expect(w.calls).toEqual([])
  })
  it('organizations that would be deleted must each be acknowledged, and only those', async () => {
    const w = world([row(B, 'delete_org'), row(A, 'leave')])
    expect(await handleAccountDeletion(w.d, del())).toMatchObject({ status: 409, body: { code: 'confirm_organizations' } })
    expect(w.calls).toEqual([])
    expect(await handleAccountDeletion(w.d, del({ delete_org_ids: [C] }))).toMatchObject({ status: 400, body: { code: 'unknown_organization' } })
    expect(await handleAccountDeletion(w.d, del({ delete_org_ids: [B, A] }))).toMatchObject({ status: 400, body: { code: 'unknown_organization' } }) // a "leave" org cannot be smuggled in
    expect(w.calls).toEqual([])
  })
})

describe('deleting', () => {
  it('runs the steps in a safe order: integrations, organizations, log scrub, notes, then the account itself', async () => {
    const w = world([row(B, 'delete_org'), row(A, 'leave', { role: 'member' })])
    const r = await handleAccountDeletion(w.d, del({ delete_org_ids: [B] }))
    expect(w.calls).toEqual(['disconnect', `org:${B}`, 'scrub', 'user'])
    expect(r).toMatchObject({ status: 200, body: { deleted: true, deleted_organizations: ['Org 2'], audit_entries_anonymized: 4 } })
    expect(r.body.disconnected_integrations).toEqual([{ provider: 'google_gmail', account: 'jane@acme.com', revoked: true }])
  })
  it('leaves a neutral, anonymous note in the organizations that remain (never the person\'s name or e-mail)', async () => {
    const w = world([row(A, 'leave', { role: 'member' }), row(B, 'delete_org')])
    await handleAccountDeletion(w.d, del({ delete_org_ids: [B] }))
    expect(w.audits).toHaveLength(1)
    expect(w.audits[0]).toMatchObject({ org_id: A, user_id: null, action: 'member.account_deleted', summary: 'A team member deleted their account' })
    expect(JSON.stringify(w.audits)).not.toMatch(/jane|acme\.com/i)
  })
  it('the account itself is deleted LAST: a failure earlier leaves it intact and retryable', async () => {
    const w = world([row(B, 'delete_org')], { deleteOrganization: async () => { throw new Error('storage unavailable') } })
    const r = await handleAccountDeletion(w.d, del({ delete_org_ids: [B] }))
    expect(r).toMatchObject({ status: 500, body: { code: 'incomplete', failed_step: `delete_organization:${B}`, completed_steps: ['disconnect_integrations'] } })
    expect(w.calls).not.toContain('user')
    expect(w.calls).not.toContain('scrub')
  })
  it('reports which step failed for each stage, without leaking internal error text', async () => {
    for (const [name, over] of [
      ['disconnect_integrations', { disconnectIntegrations: async () => { throw new Error('db password=hunter2') } }],
      ['scrub_audit_log', { scrubLogs: async () => { throw new Error('boom') } }],
      ['delete_account', { deleteUser: async () => { throw new Error('auth admin 500') } }],
    ] as const) {
      const w = world([row(A, 'leave')], over as Partial<AccountDeletionDeps>)
      const r = await handleAccountDeletion(w.d, del())
      expect(r).toMatchObject({ status: 500, body: { code: 'incomplete', failed_step: name } })
      expect(JSON.stringify(r.body)).not.toMatch(/hunter2|auth admin 500|boom/)
    }
  })
  it('a retry after a partial failure completes (the steps are idempotent)', async () => {
    let first = true
    const w = world([row(B, 'delete_org')], { deleteOrganization: async (id) => { if (first) { first = false; throw new Error('transient') } w.calls.push(`org:${id}`) } })
    expect((await handleAccountDeletion(w.d, del({ delete_org_ids: [B] }))).status).toBe(500)
    expect((await handleAccountDeletion(w.d, del({ delete_org_ids: [B] }))).status).toBe(200)
    expect(w.calls.at(-1)).toBe('user')
  })
  it('an audit-note failure does not stop the deletion', async () => {
    const w = world([row(A, 'leave')], { audit: async () => { throw new Error('log down') } })
    expect((await handleAccountDeletion(w.d, del())).status).toBe(200)
    expect(w.calls.at(-1)).toBe('user')
  })
  it('a person with no organizations can delete their account', async () => {
    const w = world([])
    expect((await handleAccountDeletion(w.d, del())).status).toBe(200)
    expect(w.calls).toEqual(['disconnect', 'scrub', 'user'])
  })
  it('the person to delete always comes from the session, never from the request', async () => {
    const plan = vi.fn().mockResolvedValue([])
    const w = world([], { plan })
    await handleAccountDeletion(w.d, { ...del(), user_id: 'someone-else' }) // an extra field is refused outright
    expect(plan).not.toHaveBeenCalledWith('someone-else')
    expect((await handleAccountDeletion(w.d, { ...del(), user_id: 'someone-else' })).status).toBe(400)
  })
})
