// Connects the pure Google adapters to stored, encrypted credentials. Service-role only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { NotConfiguredError } from '../core/types.ts'
import { refreshAccessToken, type GoogleClient, type GoogleProviderId } from '../core/providers/google/oauth.ts'
import { GmailProvider } from '../core/providers/google/gmail.ts'
import { GoogleCalendarProvider } from '../core/providers/google/calendar.ts'
import { env } from '../runtime.ts'
import { storedTokenSource } from './credentials.ts'

const LABEL: Record<GoogleProviderId, string> = { google_gmail: 'Gmail', google_calendar: 'Google Calendar' }

export function googleConfig(): (GoogleClient & { encryptionKey: string }) | null {
  const clientId = env('GOOGLE_OAUTH_CLIENT_ID'), clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET')
  const redirectUri = env('GOOGLE_OAUTH_REDIRECT_URI'), encryptionKey = env('TOKEN_ENCRYPTION_KEY')
  return clientId && clientSecret && redirectUri && encryptionKey ? { clientId, clientSecret, redirectUri, encryptionKey } : null
}

function tokenSource(svc: SupabaseClient, orgId: string, provider: GoogleProviderId) {
  const label = LABEL[provider]
  const cfg = googleConfig()
  if (!cfg) throw new NotConfiguredError(label, `${label} cannot be used: the server is missing Google OAuth settings.`)
  return storedTokenSource(svc, orgId, {
    provider, label, vendor: 'Google', encryptionKey: cfg.encryptionKey, refresh: (rt) => refreshAccessToken(fetch, cfg, rt),
  })
}

export async function gmailFor(svc: SupabaseClient, orgId: string) {
  const s = await tokenSource(svc, orgId, 'google_gmail')
  return new GmailProvider(s.http, s.email)
}

export async function calendarFor(svc: SupabaseClient, orgId: string) {
  const s = await tokenSource(svc, orgId, 'google_calendar')
  return new GoogleCalendarProvider(s.http)
}
