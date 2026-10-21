// Connects the pure Google adapters to stored, encrypted credentials. Service-role only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret, encryptSecret } from '../core/crypto.ts'
import { NotConfiguredError } from '../core/types.ts'
import { refreshAccessToken, type GoogleClient, type GoogleProviderId } from '../core/providers/google/oauth.ts'
import { TokenSource, type StoredCredentials } from '../core/providers/google/tokens.ts'
import { GmailProvider } from '../core/providers/google/gmail.ts'
import { GoogleCalendarProvider } from '../core/providers/google/calendar.ts'
import { env } from '../runtime.ts'

const LABEL: Record<GoogleProviderId, string> = { google_gmail: 'Gmail', google_calendar: 'Google Calendar' }

export function googleConfig(): (GoogleClient & { encryptionKey: string }) | null {
  const clientId = env('GOOGLE_OAUTH_CLIENT_ID'), clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET')
  const redirectUri = env('GOOGLE_OAUTH_REDIRECT_URI'), encryptionKey = env('TOKEN_ENCRYPTION_KEY')
  return clientId && clientSecret && redirectUri && encryptionKey ? { clientId, clientSecret, redirectUri, encryptionKey } : null
}

async function tokenSource(svc: SupabaseClient, orgId: string, provider: GoogleProviderId) {
  const label = LABEL[provider]
  const cfg = googleConfig()
  if (!cfg) throw new NotConfiguredError(label, `${label} cannot be used: the server is missing Google OAuth settings.`)

  const { data: integ } = await svc.from('connected_integrations').select('id, status, external_account')
    .eq('org_id', orgId).eq('provider', provider).neq('status', 'revoked').order('created_at').limit(1).maybeSingle()
  if (!integ) throw new NotConfiguredError(label)
  if (integ.status !== 'connected') {
    throw new NotConfiguredError(label, `${label} needs to be reconnected (${integ.status}). The user must reconnect it in Integrations.`)
  }

  const id = integ.id as string
  let cache: StoredCredentials | null = null
  const load = async (): Promise<StoredCredentials> => {
    if (cache) return cache
    const { data } = await svc.from('integration_credentials').select('encrypted_payload').eq('integration_id', id).maybeSingle()
    if (!data) throw new NotConfiguredError(label, `${label} credentials are missing. Please reconnect it.`)
    cache = JSON.parse(await decryptSecret(data.encrypted_payload as string, cfg.encryptionKey, id)) as StoredCredentials
    return cache
  }

  const tokens = new TokenSource({
    load,
    save: async (c) => {
      cache = c
      await svc.from('integration_credentials')
        .update({ encrypted_payload: await encryptSecret(JSON.stringify(c), cfg.encryptionKey, id), updated_at: new Date().toISOString() })
        .eq('integration_id', id)
    },
    markNeedsReauth: async (message) => {
      await svc.from('connected_integrations').update({ status: 'needs_reauth', last_error: message }).eq('id', id)
      await svc.from('action_logs').insert({
        org_id: orgId, actor_type: 'system', category: 'integration', action: 'integration.needs_reauth',
        status: 'failure', summary: `${label} needs to be reconnected`, error: message,
      })
    },
    refresh: (rt) => refreshAccessToken(fetch, cfg, rt),
    now: () => Date.now(),
  })
  return { http: { fetch, tokens }, email: integ.external_account as string }
}

export async function gmailFor(svc: SupabaseClient, orgId: string) {
  const s = await tokenSource(svc, orgId, 'google_gmail')
  return new GmailProvider(s.http, s.email)
}

export async function calendarFor(svc: SupabaseClient, orgId: string) {
  const s = await tokenSource(svc, orgId, 'google_calendar')
  return new GoogleCalendarProvider(s.http)
}
