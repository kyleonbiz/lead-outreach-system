import { describe, expect, it, vi } from 'vitest'
import { handleDisconnect, handleOAuthCallback, handleOAuthStart, type CallbackDeps, type DisconnectDeps, type OAuthConfig, type StartDeps } from './oauth.ts'
import { decryptSecret, encryptSecret, signState } from '../crypto.ts'
import { MICROSOFT_SCOPES } from '../providers/microsoft/oauth.ts'
import { MemoryStore, ORG, USER } from '../testkit.ts'

void MemoryStore
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)))
const ms = { clientId: 'ms-client-id-for-tests', clientSecret: 'ms-client-secret-for-tests', redirectUri: 'https://x.supabase.co/functions/v1/microsoft-oauth-callback', tenant: 'common' }
const config: OAuthConfig = { clientId: 'gid', clientSecret: 'gsec', redirectUri: 'https://x/gcb', encryptionKey: KEY, appUrl: 'https://app.test', microsoft: ms }
const NOW = new Date('2026-10-21T15:00:00Z')
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const MAIL_SCOPE = 'openid email profile User.Read Mail.ReadWrite Mail.Send'

const startDeps = (o: Partial<StartDeps> = {}): StartDeps => ({ userId: USER, now: () => NOW, config, getRole: async () => 'owner', ...o })

describe('oauth-start with Microsoft', () => {
  const body = { org_id: ORG, provider: 'microsoft_mail' }
  it.each(['microsoft_mail', 'microsoft_calendar'])('returns a Microsoft sign-in URL for %s with a signed state and no secrets', async (provider) => {
    const r = await handleOAuthStart(startDeps(), { org_id: ORG, provider })
    const url = new URL(r.body.url as string)
    expect(url.host).toBe('login.microsoftonline.com')
    expect(url.searchParams.get('client_id')).toBe(ms.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(ms.redirectUri)
    expect(url.searchParams.get('state')!.split('.')).toHaveLength(2)
    expect(url.searchParams.get('scope')).toContain(provider === 'microsoft_mail' ? 'Mail.ReadWrite' : 'Calendars.ReadWrite')
    expect(r.body.url).not.toContain(ms.clientSecret)
  })
  it('names exactly the missing MICROSOFT_ settings (Google settings do not count)', async () => {
    const r = await handleOAuthStart(startDeps({ config: { ...config, microsoft: { ...ms, clientSecret: undefined, redirectUri: undefined }, encryptionKey: undefined } }), body)
    expect(r).toMatchObject({ status: 503, body: { code: 'not_configured', missing: ['MICROSOFT_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY'] } })
    expect(String(r.body.error)).toMatch(/Microsoft connections are not configured/)
  })
  it('a server with only Google configured says Microsoft is not set up, and the reverse', async () => {
    expect((await handleOAuthStart(startDeps({ config: { ...config, microsoft: undefined } }), body)).status).toBe(503)
    expect((await handleOAuthStart(startDeps({ config: { ...config, clientId: undefined } }), { org_id: ORG, provider: 'google_gmail' })).status).toBe(503)
    expect((await handleOAuthStart(startDeps({ config: { ...config, clientId: undefined } }), body)).status).toBe(200)
  })
  it('keeps the same authorization rules: sign-in, owners/admins only, valid provider', async () => {
    expect((await handleOAuthStart(startDeps({ userId: null }), body)).status).toBe(401)
    expect((await handleOAuthStart(startDeps({ getRole: async () => 'member' }), body)).status).toBe(403)
    expect((await handleOAuthStart(startDeps({ getRole: async () => null }), body)).status).toBe(403)
    expect((await handleOAuthStart(startDeps(), { org_id: ORG, provider: 'microsoft_teams' })).status).toBe(400)
  })
  it('an invalid tenant in the server settings fails loudly instead of building a hostile URL', async () => {
    await expect(handleOAuthStart(startDeps({ config: { ...config, microsoft: { ...ms, tenant: 'evil.test/..%2F' } } }), body)).rejects.toThrow(/tenant/)
  })
})

function callbackDeps(over: Partial<CallbackDeps> = {}, tokenScope = MAIL_SCOPE, refresh: string | null = 'ms-rt-1') {
  const saved: any[] = []
  const audits: any[] = []
  const f = vi.fn(async (url: string) => {
    if (url.includes('login.microsoftonline.com') && url.endsWith('/token')) return json({ access_token: 'ms-at-1', refresh_token: refresh ?? undefined, expires_in: 3600, scope: tokenScope })
    if (url.startsWith('https://graph.microsoft.com/v1.0/me')) return json({ mail: 'Owner@Contoso.com', userPrincipalName: 'owner@contoso.onmicrosoft.com' })
    return new Response('', { status: 404 })
  })
  const deps: CallbackDeps = {
    now: () => NOW, config, fetch: f as any, getRoleOf: async () => 'owner', findIntegrationId: async () => null,
    saveIntegration: async (r) => { saved.push(r) }, audit: async (e) => { audits.push(e) }, ...over,
  }
  return { deps, saved, audits, f }
}
const state = (o: Partial<{ exp: number; provider: string }> = {}) =>
  signState({ org: ORG, user: USER, provider: 'microsoft_mail', nonce: 'n', exp: NOW.getTime() + 60_000, ...o }, KEY)
const loc = (r: { body: Record<string, unknown> }) => new URL(r.body.location as string)

describe('microsoft-oauth-callback', () => {
  it('stores the credentials ENCRYPTED, bound to the integration id, and never logs tokens', async () => {
    const { deps, saved, audits, f } = callbackDeps()
    const r = await handleOAuthCallback(deps, { code: 'c', state: await state() })
    expect(loc(r).searchParams.get('connected')).toBe('microsoft_mail')
    expect(saved[0]).toMatchObject({ org_id: ORG, user_id: USER, provider: 'microsoft_mail', email: 'owner@contoso.com' })
    expect(JSON.stringify(saved[0])).not.toMatch(/ms-at-1|ms-rt-1/)
    expect(JSON.parse(await decryptSecret(saved[0].encrypted, KEY, saved[0].id))).toMatchObject({ access_token: 'ms-at-1', refresh_token: 'ms-rt-1' })
    await expect(decryptSecret(saved[0].encrypted, KEY, 'another-integration')).rejects.toThrow() // cannot be moved to another row
    expect(JSON.stringify(audits)).not.toMatch(/ms-at-1|ms-rt-1/)
    expect(audits[0]).toMatchObject({ action: 'integration.connected', category: 'integration' })
    // the flow talked to Microsoft only, never to Google
    expect(f.mock.calls.every(([u]) => !String(u).includes('google'))).toBe(true)
  })
  it('stores the granted scopes, normalised', async () => {
    const { deps, saved } = callbackDeps({}, 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid')
    await handleOAuthCallback(deps, { code: 'c', state: await state() })
    expect(saved[0].scopes).toContain('https://graph.microsoft.com/Mail.Send')
  })
  it('does not save when a permission was not granted, when no refresh token came back, or when the exchange fails', async () => {
    const partial = callbackDeps({}, 'openid User.Read Mail.ReadWrite')
    expect(loc(await handleOAuthCallback(partial.deps, { code: 'c', state: await state() })).searchParams.get('error')).toBe('missing_scopes')
    const noRefresh = callbackDeps({}, MAIL_SCOPE, null)
    expect(loc(await handleOAuthCallback(noRefresh.deps, { code: 'c', state: await state() })).searchParams.get('error')).toBe('no_refresh_token')
    const bad = callbackDeps({ fetch: (async () => json({ error: 'invalid_grant', error_description: 'AADSTS70008: expired code' }, 400)) as any })
    expect(loc(await handleOAuthCallback(bad.deps, { code: 'c', state: await state() })).searchParams.get('error')).toBe('exchange_failed')
    for (const x of [partial, noRefresh, bad]) { expect(x.saved).toHaveLength(0); expect(x.audits[0]).toMatchObject({ action: 'integration.connect_failed', status: 'failure' }) }
    expect(JSON.stringify(bad.audits)).toContain('AADSTS70008')
  })
  it('reports the provider\'s own error with a Microsoft-specific code, and user denial as denial', async () => {
    const { deps, saved } = callbackDeps()
    expect(loc(await handleOAuthCallback(deps, { error: 'access_denied', state: await state() })).searchParams.get('error')).toBe('access_denied')
    expect(loc(await handleOAuthCallback(deps, { error: 'server_error', state: await state() })).searchParams.get('error')).toBe('microsoft_error')
    expect(saved).toHaveLength(0)
  })
  it('rejects forged or expired state and users who lost admin rights, without calling Microsoft', async () => {
    const { deps, saved, f } = callbackDeps()
    for (const s of ['x.y', undefined, await state({ exp: NOW.getTime() - 1 })]) {
      expect(loc(await handleOAuthCallback(deps, { code: 'c', state: s })).searchParams.get('error')).toBe('invalid_state')
    }
    expect(f).not.toHaveBeenCalled()
    const demoted = callbackDeps({ getRoleOf: async () => 'member' })
    expect(loc(await handleOAuthCallback(demoted.deps, { code: 'c', state: await state() })).searchParams.get('error')).toBe('forbidden')
    expect(demoted.saved).toHaveLength(0)
    expect(saved).toHaveLength(0)
  })
  it('a state for an unknown provider is invalid; Microsoft state with Microsoft unconfigured is "not_configured" and does nothing', async () => {
    const a = callbackDeps()
    expect(loc(await handleOAuthCallback(a.deps, { code: 'c', state: await state({ provider: 'microsoft_teams' }) })).searchParams.get('error')).toBe('invalid_state')
    const b = callbackDeps({ config: { ...config, microsoft: undefined } })
    expect(loc(await handleOAuthCallback(b.deps, { code: 'c', state: await state() })).searchParams.get('error')).toBe('not_configured')
    expect(b.f).not.toHaveBeenCalled()
  })
  it('without the encryption key nothing can be verified or stored', async () => {
    const { deps, f } = callbackDeps({ config: { ...config, encryptionKey: undefined } })
    expect(loc(await handleOAuthCallback(deps, { code: 'c', state: await state() })).searchParams.get('error')).toBe('not_configured')
    expect(f).not.toHaveBeenCalled()
  })
  it('both Microsoft capabilities are described by their own minimal scope lists', () => {
    expect(MICROSOFT_SCOPES.microsoft_mail).toContain('Mail.Send')
    expect(MICROSOFT_SCOPES.microsoft_calendar).not.toContain('Mail.Send')
  })
})

describe('integration-disconnect for Microsoft', () => {
  const integ = { id: '99999999-9999-4999-8999-999999999999', org_id: ORG, provider: 'microsoft_mail', external_account: 'owner@contoso.com' }
  async function deps(over: Partial<DisconnectDeps> = {}) {
    const calls: string[] = []
    const audits: any[] = []
    const encrypted = encryptSecret(JSON.stringify({ access_token: 'a', refresh_token: 'ms-rt-9', expires_at: 1, scope: 's' }), KEY, integ.id)
    const f = vi.fn(async (url: string) => { calls.push(`fetch ${url}`); return new Response('', { status: 200 }) })
    const d: DisconnectDeps = {
      userId: USER, config, fetch: f as any, getRole: async () => 'owner',
      loadIntegration: async (id) => (id === integ.id ? integ : null), loadEncrypted: async () => encrypted,
      deleteCredentials: async () => { calls.push('delete-creds') }, markRevoked: async () => { calls.push('mark-revoked') },
      audit: async (e) => { audits.push(e) }, ...over,
    }
    return { d, calls, audits, f }
  }
  it('deletes our copy of the credentials and is honest that Microsoft cannot revoke remotely (no fake "revoked")', async () => {
    const { d, calls, audits, f } = await deps()
    const r = await handleDisconnect(d, { integration_id: integ.id })
    expect(r).toMatchObject({ status: 200, body: { status: 'disconnected', provider_revoked: false } })
    expect(String(r.body.note)).toMatch(/myapps\.microsoft\.com/)
    expect(String(r.body.note)).toMatch(/account\.microsoft\.com\/privacy\/app-access/)
    expect(calls).toEqual(['delete-creds', 'mark-revoked'])
    expect(f).not.toHaveBeenCalled() // no call is made to Microsoft, and the token is never sent anywhere
    expect(audits[0].summary).toMatch(/Microsoft cannot revoke remotely/)
    expect(JSON.stringify(audits)).not.toContain('ms-rt-9')
  })
  it('keeps the same authorization rules', async () => {
    expect((await handleDisconnect((await deps({ getRole: async () => 'member' })).d, { integration_id: integ.id })).status).toBe(403)
    expect((await handleDisconnect((await deps({ userId: null })).d, { integration_id: integ.id })).status).toBe(401)
    const hidden = await deps()
    expect((await handleDisconnect(hidden.d, { integration_id: '11111111-1111-4111-8111-111111111112' })).status).toBe(404)
    expect(hidden.calls).toEqual([])
  })
})
