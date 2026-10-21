import { z } from 'zod'
import { fail, isAdmin, ok, type HandlerResult, type Role } from './common.ts'
import { encryptSecret, decryptSecret, signState, verifyState, randomUuid } from '../crypto.ts'
import * as google from '../providers/google/oauth.ts'
import * as microsoft from '../providers/microsoft/oauth.ts'
import type { StoredCredentials } from '../providers/google/tokens.ts'
import type { ActionLogEntry } from '../types.ts'

const STATE_TTL_MS = 10 * 60_000
type ProviderId = google.GoogleProviderId | microsoft.MicrosoftProviderId
const PROVIDER_IDS = [...Object.keys(google.GOOGLE_SCOPES), ...Object.keys(microsoft.MICROSOFT_SCOPES)] as [ProviderId, ...ProviderId[]]
const Provider = z.enum(PROVIDER_IDS)

export interface OAuthConfig {
  clientId?: string; clientSecret?: string; redirectUri?: string; encryptionKey?: string; appUrl: string
  /** Microsoft identity platform app registration; `tenant` defaults to "common" (work, school and personal accounts) */
  microsoft?: { clientId?: string; clientSecret?: string; redirectUri?: string; tenant?: string }
}
const requireKey = (c: OAuthConfig) => (c.encryptionKey ? [] : ['TOKEN_ENCRYPTION_KEY'])
export const missingOAuthConfig = (c: OAuthConfig): string[] =>
  [['GOOGLE_OAUTH_CLIENT_ID', c.clientId], ['GOOGLE_OAUTH_CLIENT_SECRET', c.clientSecret],
   ['GOOGLE_OAUTH_REDIRECT_URI', c.redirectUri], ['TOKEN_ENCRYPTION_KEY', c.encryptionKey]]
    .filter(([, v]) => !v).map(([k]) => k as string)
export const missingMicrosoftConfig = (c: OAuthConfig): string[] =>
  [['MICROSOFT_OAUTH_CLIENT_ID', c.microsoft?.clientId], ['MICROSOFT_OAUTH_CLIENT_SECRET', c.microsoft?.clientSecret],
   ['MICROSOFT_OAUTH_REDIRECT_URI', c.microsoft?.redirectUri], ['TOKEN_ENCRYPTION_KEY', c.encryptionKey]]
    .filter(([, v]) => !v).map(([k]) => k as string)

/** Everything that differs between identity providers. The flow around it (signed state, role checks, encryption, audit) is shared. */
interface Strategy {
  label: string
  /** error code placed in the redirect when the provider itself reports an error */
  errorCode: string
  missing(c: OAuthConfig): string[]
  authUrl(c: OAuthConfig, provider: ProviderId, state: string): string
  exchange(f: typeof fetch, c: OAuthConfig, code: string): Promise<google.TokenSet>
  scopesGranted(provider: ProviderId, granted: string): boolean
  accountEmail(f: typeof fetch, accessToken: string): Promise<string>
  /** absent when the provider offers apps no way to revoke a user's token */
  revoke?(f: typeof fetch, creds: StoredCredentials): Promise<boolean>
  /** shown when the provider's side could not be revoked */
  notRevokedNote: string
}

const googleClient = (c: OAuthConfig): google.GoogleClient => ({ clientId: c.clientId!, clientSecret: c.clientSecret!, redirectUri: c.redirectUri! })
const microsoftClient = (c: OAuthConfig): microsoft.MicrosoftClient => ({
  clientId: c.microsoft!.clientId!, clientSecret: c.microsoft!.clientSecret!, redirectUri: c.microsoft!.redirectUri!, tenant: c.microsoft?.tenant || 'common',
})

const GOOGLE: Strategy = {
  label: 'Google', errorCode: 'google_error', missing: missingOAuthConfig,
  authUrl: (c, p, state) => google.buildAuthUrl(googleClient(c), p as google.GoogleProviderId, state),
  exchange: (f, c, code) => google.exchangeCode(f, googleClient(c), code),
  scopesGranted: (p, g) => google.hasRequiredScopes(p as google.GoogleProviderId, g),
  accountEmail: google.fetchAccountEmail,
  revoke: (f, creds) => google.revokeToken(f, creds.refresh_token),
  notRevokedNote: 'Stored credentials were deleted, but Google did not confirm revocation. You can remove access at myaccount.google.com/permissions.',
}

const MICROSOFT: Strategy = {
  label: 'Microsoft', errorCode: 'microsoft_error', missing: missingMicrosoftConfig,
  authUrl: (c, p, state) => microsoft.buildAuthUrl(microsoftClient(c), p as microsoft.MicrosoftProviderId, state),
  exchange: (f, c, code) => microsoft.exchangeCode(f, microsoftClient(c), code),
  scopesGranted: (p, g) => microsoft.hasRequiredScopes(p as microsoft.MicrosoftProviderId, g),
  accountEmail: microsoft.fetchAccountEmail,
  notRevokedNote: microsoft.MICROSOFT_REVOCATION_NOTE,
}

const strategyFor = (p: ProviderId): Strategy => (p in microsoft.MICROSOFT_SCOPES ? MICROSOFT : GOOGLE)

// ---------------------------------------------------------------- start
export interface StartDeps {
  userId: string | null
  now(): Date
  config: OAuthConfig
  getRole(orgId: string): Promise<Role | null>
}

export async function handleOAuthStart(d: StartDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = z.object({ org_id: z.uuid(), provider: Provider }).safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  if (!isAdmin(await d.getRole(p.data.org_id))) return fail(403, 'Only owners and admins can connect accounts')
  const strategy = strategyFor(p.data.provider)
  const missing = strategy.missing(d.config)
  if (missing.length) return fail(503, `${strategy.label} connections are not configured yet`, { code: 'not_configured', missing })

  const state = await signState({
    org: p.data.org_id, user: d.userId, provider: p.data.provider, nonce: randomUuid(), exp: d.now().getTime() + STATE_TTL_MS,
  }, d.config.encryptionKey!)
  return ok({ url: strategy.authUrl(d.config, p.data.provider, state) })
}

// ------------------------------------------------------------- callback
export interface CallbackDeps {
  now(): Date
  config: OAuthConfig
  fetch: typeof fetch
  /** membership lookup via service role (the callback request carries no user JWT) */
  getRoleOf(orgId: string, userId: string): Promise<Role | null>
  findIntegrationId(orgId: string, provider: string, email: string): Promise<string | null>
  saveIntegration(r: { id: string; org_id: string; user_id: string; provider: string; email: string; scopes: string[]; encrypted: string }): Promise<void>
  audit(e: ActionLogEntry): Promise<void>
}

const redirect = (appUrl: string, query: Record<string, string>): HandlerResult =>
  ({ status: 302, body: { location: `${appUrl.replace(/\/$/, '')}/integrations?${new URLSearchParams(query)}` } })

export async function handleOAuthCallback(
  d: CallbackDeps, q: { code?: string | null; state?: string | null; error?: string | null },
): Promise<HandlerResult> {
  const app = d.config.appUrl
  if (requireKey(d.config).length) return redirect(app, { error: 'not_configured' })
  if (!q.state) return redirect(app, { error: 'invalid_state' })
  const st = await verifyState(q.state, d.config.encryptionKey!, d.now().getTime())
  if (!st) return redirect(app, { error: 'invalid_state' })

  const provider = Provider.safeParse(st.provider)
  if (!provider.success) return redirect(app, { error: 'invalid_state' })
  const strategy = strategyFor(provider.data)
  if (strategy.missing(d.config).length) return redirect(app, { error: 'not_configured', provider: provider.data })
  if (q.error) return redirect(app, { error: q.error === 'access_denied' ? 'access_denied' : strategy.errorCode, provider: provider.data })
  if (!q.code) return redirect(app, { error: 'invalid_state' })
  // the person who started the flow must STILL be an admin of that org
  if (!isAdmin(await d.getRoleOf(st.org, st.user))) return redirect(app, { error: 'forbidden', provider: provider.data })

  const failLog = (error: string) => d.audit({
    org_id: st.org, user_id: st.user, actor_type: 'user', category: 'integration', tool_name: null,
    action: 'integration.connect_failed', status: 'failure', summary: `Connecting ${provider.data} failed`, error,
  })

  let tokens
  try { tokens = await strategy.exchange(d.fetch, d.config, q.code) } catch (e) {
    await failLog(e instanceof Error ? e.message : 'token exchange failed')
    return redirect(app, { error: 'exchange_failed', provider: provider.data })
  }
  if (!tokens.refresh_token) {
    await failLog(`${strategy.label} returned no refresh token`)
    return redirect(app, { error: 'no_refresh_token', provider: provider.data })
  }
  if (!strategy.scopesGranted(provider.data, tokens.scope ?? '')) {
    await failLog('required permissions were not granted')
    return redirect(app, { error: 'missing_scopes', provider: provider.data })
  }

  let email: string
  try { email = await strategy.accountEmail(d.fetch, tokens.access_token) } catch (e) {
    await failLog(e instanceof Error ? e.message : 'could not read account')
    return redirect(app, { error: 'exchange_failed', provider: provider.data })
  }

  const id = (await d.findIntegrationId(st.org, provider.data, email)) ?? randomUuid()
  const creds: StoredCredentials = {
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    expires_at: d.now().getTime() + tokens.expires_in * 1000, scope: tokens.scope,
  }
  // bound to the integration id: a ciphertext can't be copied onto another row
  const encrypted = await encryptSecret(JSON.stringify(creds), d.config.encryptionKey!, id)
  await d.saveIntegration({ id, org_id: st.org, user_id: st.user, provider: provider.data, email, scopes: tokens.scope.split(/\s+/), encrypted })
  await d.audit({
    org_id: st.org, user_id: st.user, actor_type: 'user', category: 'integration', tool_name: null,
    action: 'integration.connected', status: 'success', summary: `Connected ${provider.data} (${email})`,
  })
  return redirect(app, { connected: provider.data })
}

// ----------------------------------------------------------- disconnect
export interface DisconnectDeps {
  userId: string | null
  config: OAuthConfig
  fetch: typeof fetch
  getRole(orgId: string): Promise<Role | null>
  /** read with the user's token (RLS): other orgs' integrations are invisible */
  loadIntegration(id: string): Promise<{ id: string; org_id: string; provider: string; external_account: string } | null>
  loadEncrypted(id: string): Promise<string | null>
  deleteCredentials(id: string): Promise<void>
  markRevoked(id: string): Promise<void>
  audit(e: ActionLogEntry): Promise<void>
}

/** What disconnecting an account does after authorization has been decided: revoke at the provider where possible, ALWAYS delete our copy, audit. */
export async function revokeAndRemove(
  d: Pick<DisconnectDeps, 'config' | 'fetch' | 'loadEncrypted' | 'deleteCredentials' | 'markRevoked' | 'audit'>,
  integ: { id: string; org_id: string; provider: string; external_account: string },
  actorUserId: string | null,
): Promise<{ providerRevoked: boolean; strategyNote: string }> {
  const parsed = Provider.safeParse(integ.provider)
  const strategy = parsed.success ? strategyFor(parsed.data) : GOOGLE
  let providerRevoked = false
  const encrypted = await d.loadEncrypted(integ.id)
  if (encrypted && d.config.encryptionKey && strategy.revoke) {
    try {
      const creds = JSON.parse(await decryptSecret(encrypted, d.config.encryptionKey, integ.id)) as StoredCredentials
      providerRevoked = await strategy.revoke(d.fetch, creds)
    } catch { providerRevoked = false }
  }
  await d.deleteCredentials(integ.id)
  await d.markRevoked(integ.id)
  await d.audit({
    org_id: integ.org_id, user_id: actorUserId, actor_type: 'user', category: 'integration', tool_name: null,
    action: 'integration.disconnected', status: 'success',
    summary: `Disconnected ${integ.provider} (${integ.external_account})${providerRevoked ? '' : strategy.revoke ? ` — ${strategy.label} revocation not confirmed` : ` — ${strategy.label} cannot revoke remotely; remove the app in the account settings`}`,
  })
  return { providerRevoked, strategyNote: strategy.notRevokedNote }
}

export async function handleDisconnect(d: DisconnectDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = z.object({ integration_id: z.uuid() }).safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  const integ = await d.loadIntegration(p.data.integration_id)
  if (!integ) return fail(404, 'Integration not found')
  if (!isAdmin(await d.getRole(integ.org_id))) return fail(403, 'Only owners and admins can disconnect accounts')

  const { providerRevoked, strategyNote } = await revokeAndRemove(d, integ, d.userId)
  return ok({
    status: 'disconnected', provider_revoked: providerRevoked,
    ...(providerRevoked ? {} : { note: strategyNote }),
  })
}
