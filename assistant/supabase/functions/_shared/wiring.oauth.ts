import type { SupabaseClient } from '@supabase/supabase-js'
import type { CallbackDeps, DisconnectDeps, OAuthConfig, StartDeps } from './core/handlers/oauth.ts'
import type { ProviderDataDeps } from './core/handlers/providerData.ts'
import type { Role } from './core/handlers/common.ts'
import type { ActionLogEntry } from './core/types.ts'
import { env } from './runtime.ts'
import { calendarFor, gmailFor } from './adapters/google.ts'

export const oauthConfig = (): OAuthConfig => ({
  clientId: env('GOOGLE_OAUTH_CLIENT_ID'), clientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET'),
  redirectUri: env('GOOGLE_OAUTH_REDIRECT_URI'), encryptionKey: env('TOKEN_ENCRYPTION_KEY'),
  appUrl: env('APP_URL') ?? 'http://localhost:5173',
})

const roleOf = (client: SupabaseClient, userId: string | null) => async (orgId: string): Promise<Role | null> => {
  if (!userId) return null
  const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
  return (data?.role as Role | undefined) ?? null
}

const auditTo = (svc: SupabaseClient) => async (e: ActionLogEntry) => { await svc.from('action_logs').insert(e) }

export function startDeps(userId: string | null, client: SupabaseClient): StartDeps {
  return { userId, now: () => new Date(), config: oauthConfig(), getRole: roleOf(client, userId) }
}

export function callbackDeps(svc: SupabaseClient): CallbackDeps {
  return {
    now: () => new Date(), config: oauthConfig(), fetch,
    async getRoleOf(orgId, userId) {
      const { data } = await svc.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      return (data?.role as Role | undefined) ?? null
    },
    async findIntegrationId(orgId, provider, email) {
      const { data } = await svc.from('connected_integrations').select('id').eq('org_id', orgId).eq('provider', provider).eq('external_account', email).maybeSingle()
      return (data?.id as string | undefined) ?? null
    },
    async saveIntegration(r) {
      const up = await svc.from('connected_integrations').upsert({
        id: r.id, org_id: r.org_id, connected_by: r.user_id, provider: r.provider, external_account: r.email,
        scopes: r.scopes, status: 'connected', last_error: null,
      }, { onConflict: 'id' })
      if (up.error) throw new Error(`save integration: ${up.error.message}`)
      const cr = await svc.from('integration_credentials').upsert({
        integration_id: r.id, org_id: r.org_id, encrypted_payload: r.encrypted, updated_at: new Date().toISOString(),
      }, { onConflict: 'integration_id' })
      if (cr.error) throw new Error(`save credentials: ${cr.error.message}`)
    },
    audit: auditTo(svc),
  }
}

export function disconnectDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): DisconnectDeps {
  return {
    userId, config: oauthConfig(), fetch, getRole: roleOf(client, userId),
    async loadIntegration(id) {
      const { data } = await client.from('connected_integrations').select('id, org_id, provider, external_account').eq('id', id).maybeSingle()
      return data as Awaited<ReturnType<DisconnectDeps['loadIntegration']>>
    },
    async loadEncrypted(id) {
      const { data } = await svc.from('integration_credentials').select('encrypted_payload').eq('integration_id', id).maybeSingle()
      return (data?.encrypted_payload as string | undefined) ?? null
    },
    async deleteCredentials(id) { await svc.from('integration_credentials').delete().eq('integration_id', id) },
    async markRevoked(id) { await svc.from('connected_integrations').update({ status: 'revoked', last_error: null }).eq('id', id) },
    audit: auditTo(svc),
  }
}

export function providerDataDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): ProviderDataDeps {
  return {
    userId, now: () => new Date(), getRole: async (orgId) => roleOf(client, userId)(orgId),
    async timezone(orgId) {
      return ((await client.from('organization_settings').select('timezone').eq('org_id', orgId).maybeSingle()).data?.timezone as string) ?? 'UTC'
    },
    async emailRules(orgId) {
      return (await client.from('organization_settings').select('email_rules').eq('org_id', orgId).maybeSingle()).data?.email_rules ?? {}
    },
    email: (orgId) => gmailFor(svc, orgId),
    calendar: (orgId) => calendarFor(svc, orgId),
  }
}
