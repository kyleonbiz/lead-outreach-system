import { describe, expect, it, vi } from 'vitest'
import { handleDisconnect, handleOAuthCallback, handleOAuthStart, type CallbackDeps, type DisconnectDeps, type OAuthConfig, type StartDeps } from './oauth.ts'
import { handleProviderData, type ProviderDataDeps } from './providerData.ts'
import { decryptSecret, signState } from '../crypto.ts'
import { GOOGLE_SCOPES } from '../providers/google/oauth.ts'
import { NotConfiguredError, ProviderError } from '../types.ts'
import { buildRegistry } from '../tools/index.ts'
import { decide, parsePolicy } from '../policy.ts'
import { executeTool } from '../execute.ts'
import { MemoryStore, ORG, USER, makeCtx, makePorts } from '../testkit.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)))
const config: OAuthConfig = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://x/cb', encryptionKey: KEY, appUrl: 'https://app.test' }
const NOW = new Date('2026-10-21T15:00:00Z')
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

const startDeps = (o: Partial<StartDeps> = {}): StartDeps => ({ userId: USER, now: () => NOW, config, getRole: async () => 'owner', ...o })

describe('google-oauth-start', () => {
  const body = { org_id: ORG, provider: 'google_gmail' }
  it('401 / 400 / 403 (plain members cannot connect accounts)', async () => {
    expect((await handleOAuthStart(startDeps({ userId: null }), body)).status).toBe(401)
    expect((await handleOAuthStart(startDeps(), { org_id: ORG, provider: 'yahoo' })).status).toBe(400)
    expect((await handleOAuthStart(startDeps({ getRole: async () => 'member' }), body)).status).toBe(403)
    expect((await handleOAuthStart(startDeps({ getRole: async () => null }), body)).status).toBe(403)
  })
  it('503 not_configured names exactly the missing settings', async () => {
    const r = await handleOAuthStart(startDeps({ config: { ...config, clientSecret: undefined, encryptionKey: undefined } }), body)
    expect(r).toMatchObject({ status: 503, body: { code: 'not_configured', missing: ['GOOGLE_OAUTH_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'] } })
  })
  it('returns a Google URL carrying a signed, expiring state; the client secret never appears', async () => {
    const r = await handleOAuthStart(startDeps(), body)
    const url = new URL(r.body.url as string)
    expect(url.host).toBe('accounts.google.com')
    expect(url.searchParams.get('state')!.split('.')).toHaveLength(2)
    expect(r.body.url).not.toContain('csec')
  })
})

function callbackDeps(over: Partial<CallbackDeps> = {}, tokenScope = GOOGLE_SCOPES.google_gmail.join(' '), refresh: string | null = 'rt-1') {
  const saved: any[] = []
  const audits: any[] = []
  const f = vi.fn(async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at-1', refresh_token: refresh ?? undefined, expires_in: 3600, scope: tokenScope })
    if (url.includes('userinfo')) return json({ email: 'Owner@Acme.com' })
    return new Response('', { status: 404 })
  })
  const deps: CallbackDeps = {
    now: () => NOW, config, fetch: f as any, getRoleOf: async () => 'owner', findIntegrationId: async () => null,
    saveIntegration: async (r) => { saved.push(r) }, audit: async (e) => { audits.push(e) }, ...over,
  }
  return { deps, saved, audits, f }
}
const goodState = (o: Partial<{ exp: number; provider: string; user: string }> = {}) =>
  signState({ org: ORG, user: USER, provider: 'google_gmail', nonce: 'n', exp: NOW.getTime() + 60_000, ...o }, KEY)
const loc = (r: { body: Record<string, unknown> }) => new URL(r.body.location as string)

describe('google-oauth-callback', () => {
  it('stores credentials ENCRYPTED (bound to the integration id) and logs the connection', async () => {
    const { deps, saved, audits } = callbackDeps()
    const r = await handleOAuthCallback(deps, { code: 'c', state: await goodState() })
    expect(r.status).toBe(302)
    expect(loc(r).searchParams.get('connected')).toBe('google_gmail')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ org_id: ORG, user_id: USER, provider: 'google_gmail', email: 'owner@acme.com' })
    expect(JSON.stringify(saved[0])).not.toMatch(/at-1|rt-1/)      // no plaintext tokens in what is persisted
    const creds = JSON.parse(await decryptSecret(saved[0].encrypted, KEY, saved[0].id))
    expect(creds).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1' })
    expect(JSON.stringify(audits)).not.toMatch(/at-1|rt-1/)         // and none in the audit log
    expect(audits[0]).toMatchObject({ action: 'integration.connected', category: 'integration' })
  })
  it('reconnecting the same account reuses the integration id', async () => {
    const { deps, saved } = callbackDeps({ findIntegrationId: async () => 'existing-id' })
    await handleOAuthCallback(deps, { code: 'c', state: await goodState() })
    expect(saved[0].id).toBe('existing-id')
  })
  it('rejects forged, expired and missing state without calling Google or saving', async () => {
    const { deps, saved, f } = callbackDeps()
    for (const state of ['x.y', undefined, await goodState({ exp: NOW.getTime() - 1 })]) {
      const r = await handleOAuthCallback(deps, { code: 'c', state })
      expect(loc(r).searchParams.get('error')).toBe('invalid_state')
    }
    expect(f).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
  })
  it('a user who lost admin rights since starting the flow cannot complete it', async () => {
    const { deps, saved } = callbackDeps({ getRoleOf: async () => 'member' })
    const r = await handleOAuthCallback(deps, { code: 'c', state: await goodState() })
    expect(loc(r).searchParams.get('error')).toBe('forbidden')
    expect(saved).toHaveLength(0)
  })
  it('handles user denial, missing refresh token and partially granted scopes without saving', async () => {
    const a = callbackDeps()
    expect(loc(await handleOAuthCallback(a.deps, { error: 'access_denied', state: await goodState() })).searchParams.get('error')).toBe('access_denied')
    const b = callbackDeps({}, undefined, null)
    expect(loc(await handleOAuthCallback(b.deps, { code: 'c', state: await goodState() })).searchParams.get('error')).toBe('no_refresh_token')
    const c = callbackDeps({}, 'openid email https://www.googleapis.com/auth/gmail.readonly')
    expect(loc(await handleOAuthCallback(c.deps, { code: 'c', state: await goodState() })).searchParams.get('error')).toBe('missing_scopes')
    for (const x of [a, b, c]) expect(x.saved).toHaveLength(0)
    expect(b.audits[0]).toMatchObject({ action: 'integration.connect_failed', status: 'failure' })
  })
  it('token exchange failure is reported and logged, not swallowed', async () => {
    const { deps, saved, audits } = callbackDeps({ fetch: (async () => json({ error: 'invalid_grant' }, 400)) as any })
    expect(loc(await handleOAuthCallback(deps, { code: 'bad', state: await goodState() })).searchParams.get('error')).toBe('exchange_failed')
    expect(saved).toHaveLength(0)
    expect(audits[0].status).toBe('failure')
  })
})

describe('integration-disconnect', () => {
  const integ = { id: '99999999-9999-4999-8999-999999999999', org_id: ORG, provider: 'google_gmail', external_account: 'owner@acme.com' }
  async function deps(over: Partial<DisconnectDeps> = {}, revokeStatus = 200) {
    const calls: string[] = []
    const audits: any[] = []
    const encrypted = (await import('../crypto.ts')).encryptSecret(JSON.stringify({ access_token: 'a', refresh_token: 'rt-9', expires_at: 1, scope: 's' }), KEY, integ.id)
    const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push(`${url} ${(init?.body as URLSearchParams)?.get?.('token')}`); return new Response('', { status: revokeStatus }) })
    const d: DisconnectDeps = {
      userId: USER, config, fetch: f as any, getRole: async () => 'owner',
      loadIntegration: async (id) => (id === integ.id ? integ : null), loadEncrypted: async () => encrypted,
      deleteCredentials: async () => { calls.push('delete-creds') }, markRevoked: async () => { calls.push('mark-revoked') },
      audit: async (e) => { audits.push(e) }, ...over,
    }
    return { d, calls, audits }
  }
  it('revokes the token at Google, deletes stored credentials, marks revoked, audits', async () => {
    const { d, calls, audits } = await deps()
    const r = await handleDisconnect(d, { integration_id: integ.id })
    expect(r).toMatchObject({ status: 200, body: { status: 'disconnected', provider_revoked: true } })
    expect(calls[0]).toMatch(/oauth2\.googleapis\.com\/revoke rt-9/)
    expect(calls.slice(1)).toEqual(['delete-creds', 'mark-revoked'])
    expect(audits[0].action).toBe('integration.disconnected')
  })
  it('still deletes credentials and is honest when Google revocation is not confirmed', async () => {
    const { d, calls } = await deps({}, 500)
    const r = await handleDisconnect(d, { integration_id: integ.id })
    expect(r.body).toMatchObject({ provider_revoked: false })
    expect(String(r.body.note)).toMatch(/myaccount\.google\.com/)
    expect(calls).toContain('delete-creds')
  })
  it('even undecryptable credentials are removed', async () => {
    const { d, calls } = await deps({ loadEncrypted: async () => 'v1.bad.bad' })
    expect((await handleDisconnect(d, { integration_id: integ.id })).body.provider_revoked).toBe(false)
    expect(calls).toContain('delete-creds')
  })
  it('404 for invisible integrations, 403 for plain members, 401 unauthenticated — nothing deleted', async () => {
    const a = await deps()
    expect((await handleDisconnect(a.d, { integration_id: '11111111-1111-4111-8111-111111111112' })).status).toBe(404)
    const b = await deps({ getRole: async () => 'member' })
    expect((await handleDisconnect(b.d, { integration_id: integ.id })).status).toBe(403)
    const c = await deps({ userId: null })
    expect((await handleDisconnect(c.d, { integration_id: integ.id })).status).toBe(401)
    for (const x of [a, b, c]) expect(x.calls).not.toContain('delete-creds')
  })
})

describe('provider data (Email / Calendar pages)', () => {
  const email = { provider: 'g', accountEmail: () => 'me@acme.com', search: vi.fn(async () => [{ id: 'm', threadId: 't', from: 'Dana <d@c.com>', to: [], subject: 'URGENT quote?', snippet: 'Can you send it?', date: '', unread: true, labels: [] }]), getThread: vi.fn(), createDraft: vi.fn(), send: vi.fn() }
  const deps = (o: Partial<ProviderDataDeps> = {}): ProviderDataDeps => ({
    userId: USER, now: () => NOW, getRole: async (org) => (org === ORG ? 'member' : null), timezone: async () => 'America/Chicago', emailRules: async () => ({}),
    email: async () => email as any, calendar: async () => ({ provider: 'g', listEvents: vi.fn(async () => []), freeBusy: vi.fn(), createEvent: vi.fn(), updateEvent: vi.fn() }) as any, ...o,
  })
  it('returns triaged mail with reasons, and a day-aligned agenda window in the org time zone', async () => {
    const r = await handleProviderData(deps(), { action: 'email.triage', org_id: ORG })
    expect((r.body.messages as any[])[0].triage).toMatchObject({ urgent: true, needsResponse: true })
    const cal = await handleProviderData(deps(), { action: 'calendar.agenda', org_id: ORG, days: 1 })
    expect(cal.body).toMatchObject({ from: '2026-10-21T05:00:00.000Z', to: '2026-10-22T05:00:00.000Z', timezone: 'America/Chicago' })
  })
  it('403 for other orgs, 409 not_connected when no account, 502 on provider failure', async () => {
    expect((await handleProviderData(deps(), { action: 'email.triage', org_id: '33333333-3333-4333-8333-333333333333' })).status).toBe(403)
    const nc = await handleProviderData(deps({ email: async () => { throw new NotConfiguredError('Gmail') } }), { action: 'email.triage', org_id: ORG })
    expect(nc).toMatchObject({ status: 409, body: { code: 'not_connected' } })
    const pe = await handleProviderData(deps({ email: async () => { throw new ProviderError('Google API error (503)', 'unavailable') } }), { action: 'email.triage', org_id: ORG })
    expect(pe.status).toBe(502)
  })
})

describe('email & calendar tools: gating and validation', () => {
  const tools = buildRegistry()
  const send = tools.get('email.send')!
  const create = tools.get('calendar.create_event')!

  it('sending mail and creating/updating events require approval by default; drafts and reads do not', () => {
    const p = parsePolicy(undefined)
    for (const [t, i] of [[send, { to: ['a@b.com'] }], [create, { attendees: [] }], [tools.get('calendar.update_event')!, { id: 'x' }]] as const) {
      expect(decide(t, i, p).kind).toBe('needs_approval')
    }
    for (const n of ['email.create_draft', 'email.search', 'email.get_thread', 'email.triage', 'calendar.list_events', 'calendar.free_busy']) {
      expect(decide(tools.get(n)!, {}, p).kind).toBe('allow')
    }
  })
  it('calendar.update_event can never be pre-authorized', () => {
    const p = parsePolicy({ auto_approve: [{ action: 'calendar.update_event', internal_domains: ['acme.com'] }] })
    expect(decide(tools.get('calendar.update_event')!, { attendees: [] }, p).kind).toBe('needs_approval')
  })
  it('validates addresses, requires an explicit time zone + attendee list, and end after start', () => {
    expect(send.input.safeParse({ to: ['not-an-email'], subject: 's', body: 'b' }).success).toBe(false)
    expect(send.input.safeParse({ to: ['a@b.com\nBcc: x@y.com'], subject: 's', body: 'b' }).success).toBe(false)
    const base = { title: 'Meet', start: '2026-10-22T10:00:00-05:00', end: '2026-10-22T11:00:00-05:00', time_zone: 'America/Chicago', attendees: [] }
    expect(create.input.safeParse(base).success).toBe(true)
    expect(create.input.safeParse({ ...base, time_zone: undefined }).success).toBe(false)
    expect(create.input.safeParse({ ...base, time_zone: 'Mars/Olympus' }).success).toBe(false)
    expect(create.input.safeParse({ ...base, attendees: undefined }).success).toBe(false)
    expect(create.input.safeParse({ ...base, end: '2026-10-22T09:00:00-05:00' }).success).toBe(false)
    expect(create.input.safeParse({ ...base, start: '2026-10-22 10:00' }).success).toBe(false)
  })
  it('the approval summary spells out recipients, subject and time zone', () => {
    expect(send.summarize({ to: ['a@b.com'], cc: ['c@d.com'], subject: 'Quote', body: 'xx' })).toMatch(/a@b\.com, c@d\.com.*Quote/)
    expect(create.summarize({ title: 'Meet', start: 's', end: 'e', time_zone: 'America/Chicago', attendees: ['g@x.com'] })).toMatch(/America\/Chicago.*g@x\.com/)
  })
  it('an unconnected mailbox yields a SETUP-style failure, logged as failure — not a fake success', async () => {
    const store = new MemoryStore()
    const ctx = makeCtx(makePorts())
    const out = await executeTool(store, ctx, tools.get('email.search')!, { query: 'x', limit: 5 })
    expect(out).toMatchObject({ ok: false, notConfigured: true })
    expect(store.logs[0].status).toBe('failure')
  })
})
