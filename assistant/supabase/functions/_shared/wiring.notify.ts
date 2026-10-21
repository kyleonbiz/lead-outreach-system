import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelDeps, ChannelRow } from './core/handlers/notifyChannels.ts'
import type { Role } from './core/handlers/common.ts'
import { decryptSecret } from './core/crypto.ts'
import { dispatchDeliveries, type Claimed, type DispatchDeps, type Outcome } from './core/notify/dispatch.ts'
import { mailerFromEnv } from './core/notify/mailer.ts'
import { ResolverUnavailableError } from './core/notify/url.ts'
import { env } from './runtime.ts'

const appUrl = () => env('APP_URL') ?? 'http://localhost:5173'

/** A and AAAA records. Hosted runtimes without Deno.resolveDns skip this defence-in-depth layer (see url.ts). */
export async function resolveHost(host: string): Promise<string[]> {
  if (typeof Deno.resolveDns !== 'function') throw new ResolverUnavailableError()
  const out: string[] = []
  let supported = false
  for (const type of ['A', 'AAAA'] as const) {
    try { out.push(...await Deno.resolveDns(host, type)); supported = true } catch (e) {
      if (e instanceof Deno.errors.NotFound) { supported = true; continue } // this record type does not exist
      if (e instanceof Deno.errors.PermissionDenied || (e instanceof Error && /not (implemented|supported)/i.test(e.message))) continue
      throw e
    }
  }
  if (!supported) throw new ResolverUnavailableError()
  return out
}

export function channelDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): ChannelDeps {
  return {
    userId, appUrl: appUrl(), encryptionKey: env('TOKEN_ENCRYPTION_KEY'), fetch, resolve: resolveHost, newId: () => crypto.randomUUID(),
    async getRole(orgId) {
      if (!userId) return null
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      return (data?.role as Role | undefined) ?? null
    },
    // the caller's own token: RLS only lets admins of that organization see the channel
    async loadChannel(id) {
      const { data } = await client.from('notification_channels').select('id, org_id, kind, name, enabled').eq('id', id).maybeSingle()
      return (data as ChannelRow | null) ?? null
    },
    async countChannels(orgId) {
      const { count } = await svc.from('notification_channels').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
      return count ?? 0
    },
    async insert(row, encryptedUrl) {
      const a = await svc.from('notification_channels').insert(row)
      if (a.error) throw new Error(`create channel: ${a.error.message}`)
      const b = await svc.from('notification_channel_secrets').insert({ channel_id: row.id, org_id: row.org_id, encrypted_url: encryptedUrl })
      if (b.error) {
        await svc.from('notification_channels').delete().eq('id', row.id) // never leave a channel without its secret
        throw new Error(`store webhook URL: ${b.error.message}`)
      }
    },
    async update(id, orgId, patch, encryptedUrl) {
      if (encryptedUrl) {
        const s = await svc.from('notification_channel_secrets').upsert(
          { channel_id: id, org_id: orgId, encrypted_url: encryptedUrl, updated_at: new Date().toISOString() }, { onConflict: 'channel_id' })
        if (s.error) throw new Error(`store webhook URL: ${s.error.message}`)
      }
      const u = await svc.from('notification_channels').update({ ...patch, last_status: encryptedUrl ? null : undefined, last_error: encryptedUrl ? null : undefined }).eq('id', id).eq('org_id', orgId)
      if (u.error) throw new Error(`update channel: ${u.error.message}`)
    },
    async remove(id, orgId) {
      const r = await svc.from('notification_channels').delete().eq('id', id).eq('org_id', orgId)
      if (r.error) throw new Error(`delete channel: ${r.error.message}`)
    },
    async encryptedUrl(id) {
      const { data } = await svc.from('notification_channel_secrets').select('encrypted_url').eq('channel_id', id).maybeSingle()
      return (data?.encrypted_url as string | undefined) ?? null
    },
    async recordTest(id, orgId, ok, error) {
      await svc.from('notification_channels').update({
        last_status: ok ? 'ok' : 'failed', last_error: ok ? null : (error ?? '').slice(0, 300), ...(ok ? { last_sent_at: new Date().toISOString() } : {}),
      }).eq('id', id).eq('org_id', orgId)
    },
    audit: async (e) => { await svc.from('action_logs').insert(e) },
  }
}

interface ClaimRow {
  delivery_id: string; delivery_org_id: string; delivery_channel: 'email' | 'slack' | 'teams'; delivery_channel_id: string | null
  delivery_attempts: number; recipient_email: string | null; n_type: string; n_title: string; n_body: string | null; n_link: string | null; org_name: string
}

export function dispatchDepsFor(svc: SupabaseClient): DispatchDeps {
  const setup = mailerFromEnv({
    NOTIFY_EMAIL_PROVIDER: env('NOTIFY_EMAIL_PROVIDER'), RESEND_API_KEY: env('RESEND_API_KEY'), NOTIFY_FROM_EMAIL: env('NOTIFY_FROM_EMAIL'),
  })
  const key = env('TOKEN_ENCRYPTION_KEY')
  return {
    appUrl: appUrl(), fetch, resolve: resolveHost,
    mailer: setup.ok ? setup.mailer : null, mailerMissing: setup.ok ? undefined : setup.missing,
    async claim(limit) {
      const { data, error } = await svc.rpc('claim_notification_deliveries', { p_limit: limit })
      if (error) throw new Error(`claim deliveries: ${error.message}`)
      return ((data ?? []) as ClaimRow[]).map((r): Claimed => ({
        id: r.delivery_id, orgId: r.delivery_org_id, channel: r.delivery_channel, channelId: r.delivery_channel_id, attempts: r.delivery_attempts,
        recipientEmail: r.recipient_email,
        notification: { type: r.n_type, title: r.n_title, body: r.n_body, link: r.n_link, orgName: r.org_name },
      }))
    },
    async complete(id: string, outcome: Outcome, error?: string, retryInSeconds?: number) {
      const { error: e } = await svc.rpc('complete_notification_delivery', { p_id: id, p_outcome: outcome, p_error: error ?? null, p_retry_in_seconds: retryInSeconds ?? 300 })
      if (e) throw new Error(`complete delivery: ${e.message}`)
    },
    async webhookUrl(channelId, orgId) {
      if (!key) return null
      const { data } = await svc.from('notification_channel_secrets').select('encrypted_url').eq('channel_id', channelId).eq('org_id', orgId).maybeSingle()
      if (!data) return null
      try { return await decryptSecret(data.encrypted_url as string, key, `notify-channel:${channelId}`) } catch { return null }
    },
  }
}

export function notifyTickDeps(svc: SupabaseClient) {
  return {
    async notifyOverdue() { return ((await svc.rpc('notify_overdue_tasks', { p_limit: 200 })).data as number) ?? 0 },
    dispatchNotifications: () => dispatchDeliveries(dispatchDepsFor(svc)),
    async pruneNotifications() { return ((await svc.rpc('prune_notification_deliveries')).data as number) ?? 0 },
  }
}
