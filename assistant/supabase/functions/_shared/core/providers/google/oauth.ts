import { ProviderError } from '../../types.ts'

export type GoogleProviderId = 'google_gmail' | 'google_calendar'

/** Minimum scopes per capability. Gmail "compose" covers drafts AND send; the app gates sending behind approvals. */
export const GOOGLE_SCOPES: Record<GoogleProviderId, string[]> = {
  google_gmail: [
    'openid', 'email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  google_calendar: [
    'openid', 'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.freebusy',
  ],
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

export interface GoogleClient { clientId: string; clientSecret: string; redirectUri: string }

export function buildAuthUrl(c: GoogleClient, provider: GoogleProviderId, state: string, loginHint?: string): string {
  const u = new URL(AUTH_URL)
  u.searchParams.set('client_id', c.clientId)
  u.searchParams.set('redirect_uri', c.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', GOOGLE_SCOPES[provider].join(' '))
  u.searchParams.set('state', state)
  u.searchParams.set('access_type', 'offline')       // we need a refresh token
  u.searchParams.set('prompt', 'consent')            // ...and Google only issues it on consent
  u.searchParams.set('include_granted_scopes', 'false') // don't accumulate scopes from other connections
  if (loginHint) u.searchParams.set('login_hint', loginHint)
  return u.toString()
}

export interface TokenSet { access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string }

async function tokenRequest(f: typeof fetch, params: Record<string, string>): Promise<TokenSet> {
  const res = await f(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  })
  const j = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    const code = String(j.error ?? res.status)
    // invalid_grant = refresh token revoked/expired: the user must reconnect
    throw new ProviderError(`Google token error: ${code}`, code === 'invalid_grant' ? 'auth' : res.status >= 500 ? 'unavailable' : 'bad_request', res.status)
  }
  return j as unknown as TokenSet
}

export const exchangeCode = (f: typeof fetch, c: GoogleClient, code: string) =>
  tokenRequest(f, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' })

export const refreshAccessToken = (f: typeof fetch, c: GoogleClient, refreshToken: string) =>
  tokenRequest(f, { refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' })

/** Returns true if Google confirmed revocation (also true if the token was already invalid). */
export async function revokeToken(f: typeof fetch, token: string): Promise<boolean> {
  try {
    const res = await f(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) })
    return res.ok || res.status === 400 // 400 invalid_token: already revoked/expired
  } catch { return false }
}

export async function fetchAccountEmail(f: typeof fetch, accessToken: string): Promise<string> {
  const res = await f(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new ProviderError(`Could not read the Google account email (${res.status})`, 'bad_request', res.status)
  const j = await res.json() as { email?: string; email_verified?: boolean }
  if (!j.email) throw new ProviderError('Google did not return an email address', 'bad_request')
  return j.email.toLowerCase()
}

/** True if every scope we need was actually granted (users can untick boxes on the consent screen). */
export function hasRequiredScopes(provider: GoogleProviderId, granted: string): boolean {
  const g = new Set(granted.split(/\s+/))
  return GOOGLE_SCOPES[provider].filter((s) => s.startsWith('https://')).every((s) => g.has(s))
}
