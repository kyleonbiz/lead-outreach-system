import { ProviderError } from '../../types.ts'

// Microsoft identity platform (v2.0) + Microsoft Graph. Works for work/school (Entra ID) and personal Microsoft accounts
// when the app registration is multi-tenant ("common"). Delegated permissions only: the assistant acts as the signed-in user.

export type MicrosoftProviderId = 'microsoft_mail' | 'microsoft_calendar'

/** Minimum scopes per capability. Mail.ReadWrite covers reading AND creating drafts; Mail.Send is only used after an approval. */
export const MICROSOFT_SCOPES: Record<MicrosoftProviderId, string[]> = {
  microsoft_mail: ['openid', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
  microsoft_calendar: ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite'],
}

/** OpenID scopes are not reported back as Graph permissions, so they are not part of the "was everything granted" check. */
const OIDC_SCOPES = new Set(['openid', 'email', 'profile', 'offline_access'])

export interface MicrosoftClient { clientId: string; clientSecret: string; redirectUri: string; tenant: string }

const TENANT_RE = /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i
export const isValidTenant = (t: string): boolean => TENANT_RE.test(t)

const authority = (c: MicrosoftClient) => {
  if (!isValidTenant(c.tenant)) throw new ProviderError('MICROSOFT_OAUTH_TENANT is not a valid tenant (use common, organizations, consumers, a tenant id or a domain)', 'bad_request')
  return `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0`
}
const GRAPH = 'https://graph.microsoft.com/v1.0'

export function buildAuthUrl(c: MicrosoftClient, provider: MicrosoftProviderId, state: string, loginHint?: string): string {
  const u = new URL(`${authority(c)}/authorize`)
  u.searchParams.set('client_id', c.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', c.redirectUri)
  u.searchParams.set('response_mode', 'query')
  u.searchParams.set('scope', MICROSOFT_SCOPES[provider].join(' '))
  u.searchParams.set('state', state)
  u.searchParams.set('prompt', 'select_account') // people often have several mailboxes; make them choose the intended one
  if (loginHint) u.searchParams.set('login_hint', loginHint)
  return u.toString()
}

export interface TokenSet { access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string }

async function tokenRequest(f: typeof fetch, c: MicrosoftClient, params: Record<string, string>): Promise<TokenSet> {
  const res = await f(`${authority(c)}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  })
  const j = await res.json().catch(() => ({})) as { error?: string; error_description?: string }
  if (!res.ok) {
    const code = String(j.error ?? res.status)
    const aadsts = /AADSTS\d+/.exec(j.error_description ?? '')?.[0] // the support code; the rest of the description can carry account details
    // the user must sign in again when the refresh token is revoked, expired or needs fresh consent
    const reauth = code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required'
    throw new ProviderError(
      `Microsoft token error: ${code}${aadsts ? ` (${aadsts})` : ''}`,
      reauth ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'unavailable' : 'bad_request', res.status,
    )
  }
  return j as unknown as TokenSet
}

export const exchangeCode = (f: typeof fetch, c: MicrosoftClient, code: string) =>
  tokenRequest(f, c, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' })

export const refreshAccessToken = (f: typeof fetch, c: MicrosoftClient, refreshToken: string, provider: MicrosoftProviderId) =>
  tokenRequest(f, c, {
    refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token',
    scope: MICROSOFT_SCOPES[provider].join(' '),
  })

/** The mailbox address (not the sign-in name, which for guests looks like user_domain#EXT#@tenant.onmicrosoft.com). */
export async function fetchAccountEmail(f: typeof fetch, accessToken: string): Promise<string> {
  const res = await f(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new ProviderError(`Could not read the Microsoft account (${res.status})`, 'bad_request', res.status)
  const j = await res.json() as { mail?: string | null; userPrincipalName?: string | null }
  const email = (j.mail || j.userPrincipalName || '').trim().toLowerCase()
  if (!email.includes('@')) throw new ProviderError('Microsoft did not return an email address for this account', 'bad_request')
  return email
}

/** True if every Graph permission we need was granted (people can untick boxes, and admins can restrict apps). */
export function hasRequiredScopes(provider: MicrosoftProviderId, granted: string): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()))
  return MICROSOFT_SCOPES[provider].filter((s) => !OIDC_SCOPES.has(s)).every((s) => have.has(s.toLowerCase()))
}

/** Microsoft offers apps no endpoint to revoke a user's refresh token, so disconnecting can only delete our copy. */
export const MICROSOFT_REVOCATION_NOTE =
  'Stored credentials were deleted. Microsoft does not let apps revoke access remotely, so also remove the app at myapps.microsoft.com ' +
  '(work or school) or account.microsoft.com/privacy/app-access (personal).'
