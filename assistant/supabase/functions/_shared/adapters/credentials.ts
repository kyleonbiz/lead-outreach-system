// Loads a connected account's encrypted OAuth credentials and hands out valid access tokens (refreshing as needed).
// Shared by every OAuth provider; only the refresh call and the labels differ. Service-role only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret, encryptSecret } from '../core/crypto.ts'
import { NotConfiguredError } from '../core/types.ts'
import { TokenSource, type StoredCredentials } from '../core/providers/google/tokens.ts'

export interface ProviderSetup {
  provider: string
  /** user-facing name, e.g. "Gmail" or "Outlook Mail" */
  label: string
  /** "Google" / "Microsoft": names the party that rejected credentials */
  vendor: string
  encryptionKey: string
  refresh(refreshToken: string): Promise<{ access_token: string; expires_in: number; scope?: string; refresh_token?: string }>
}

export async function storedTokenSource(svc: SupabaseClient, orgId: string, s: ProviderSetup) {
  const { data: integ } = await svc.from('connected_integrations').select('id, status, external_account')
    .eq('org_id', orgId).eq('provider', s.provider).neq('status', 'revoked').order('created_at').limit(1).maybeSingle()
  if (!integ) throw new NotConfiguredError(s.label)
  if (integ.status !== 'connected') {
    throw new NotConfiguredError(s.label, `${s.label} needs to be reconnected (${integ.status}). The user must reconnect it in Integrations.`)
  }

  const id = integ.id as string
  let cache: StoredCredentials | null = null
  const load = async (): Promise<StoredCredentials> => {
    if (cache) return cache
    const { data } = await svc.from('integration_credentials').select('encrypted_payload').eq('integration_id', id).maybeSingle()
    if (!data) throw new NotConfiguredError(s.label, `${s.label} credentials are missing. Please reconnect it.`)
    cache = JSON.parse(await decryptSecret(data.encrypted_payload as string, s.encryptionKey, id)) as StoredCredentials
    return cache
  }

  const tokens = new TokenSource({
    load,
    save: async (c) => {
      cache = c
      await svc.from('integration_credentials')
        .update({ encrypted_payload: await encryptSecret(JSON.stringify(c), s.encryptionKey, id), updated_at: new Date().toISOString() })
        .eq('integration_id', id)
    },
    markNeedsReauth: async (message) => {
      await svc.from('connected_integrations').update({ status: 'needs_reauth', last_error: message }).eq('id', id)
      await svc.from('action_logs').insert({
        org_id: orgId, actor_type: 'system', category: 'integration', action: 'integration.needs_reauth',
        status: 'failure', summary: `${s.label} needs to be reconnected`, error: message,
      })
    },
    refresh: s.refresh,
    now: () => Date.now(),
  }, 60_000, s.vendor)
  return { http: { fetch, tokens }, email: integ.external_account as string }
}
