// Connects the pure Microsoft Graph adapters to stored, encrypted credentials. Service-role only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { NotConfiguredError } from '../core/types.ts'
import { refreshAccessToken, type MicrosoftClient, type MicrosoftProviderId } from '../core/providers/microsoft/oauth.ts'
import { OutlookMailProvider } from '../core/providers/microsoft/mail.ts'
import { OutlookCalendarProvider } from '../core/providers/microsoft/calendar.ts'
import { env } from '../runtime.ts'
import { storedTokenSource } from './credentials.ts'

const LABEL: Record<MicrosoftProviderId, string> = { microsoft_mail: 'Outlook Mail', microsoft_calendar: 'Outlook Calendar' }

export function microsoftConfig(): (MicrosoftClient & { encryptionKey: string }) | null {
  const clientId = env('MICROSOFT_OAUTH_CLIENT_ID'), clientSecret = env('MICROSOFT_OAUTH_CLIENT_SECRET')
  const redirectUri = env('MICROSOFT_OAUTH_REDIRECT_URI'), encryptionKey = env('TOKEN_ENCRYPTION_KEY')
  return clientId && clientSecret && redirectUri && encryptionKey
    ? { clientId, clientSecret, redirectUri, tenant: env('MICROSOFT_OAUTH_TENANT') ?? 'common', encryptionKey } : null
}

function tokenSource(svc: SupabaseClient, orgId: string, provider: MicrosoftProviderId) {
  const label = LABEL[provider]
  const cfg = microsoftConfig()
  if (!cfg) throw new NotConfiguredError(label, `${label} cannot be used: the server is missing Microsoft OAuth settings.`)
  return storedTokenSource(svc, orgId, {
    provider, label, vendor: 'Microsoft', encryptionKey: cfg.encryptionKey, refresh: (rt) => refreshAccessToken(fetch, cfg, rt, provider),
  })
}

export async function outlookMailFor(svc: SupabaseClient, orgId: string) {
  const s = await tokenSource(svc, orgId, 'microsoft_mail')
  return new OutlookMailProvider(s.http, s.email)
}

export async function outlookCalendarFor(svc: SupabaseClient, orgId: string) {
  const s = await tokenSource(svc, orgId, 'microsoft_calendar')
  const { data } = await svc.from('organization_settings').select('timezone').eq('org_id', orgId).maybeSingle()
  return new OutlookCalendarProvider(s.http, (data?.timezone as string | undefined) ?? 'UTC')
}
