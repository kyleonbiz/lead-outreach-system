import type { SupabaseClient } from '@supabase/supabase-js'
import type { Role } from './core/handlers/common.ts'
import { newInviteToken, sha256Hex, type InviteDeps } from './core/handlers/invitations.ts'
import { mailerFromEnv } from './core/notify/mailer.ts'
import { env } from './runtime.ts'

export function inviteDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): InviteDeps {
  const setup = mailerFromEnv({
    NOTIFY_EMAIL_PROVIDER: env('NOTIFY_EMAIL_PROVIDER'), RESEND_API_KEY: env('RESEND_API_KEY'), NOTIFY_FROM_EMAIL: env('NOTIFY_FROM_EMAIL'),
  })
  return {
    userId, appUrl: env('APP_URL') ?? 'http://localhost:5173',
    mailer: setup.ok ? setup.mailer : null, mailerMissing: setup.ok ? undefined : setup.missing,
    newToken: newInviteToken, sha256Hex,
    async getRole(orgId) {
      if (!userId) return null
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      return (data?.role as Role | undefined) ?? null
    },
    async orgName(orgId) { return ((await client.from('organizations').select('name').eq('id', orgId).maybeSingle()).data?.name as string | undefined) ?? '' },
    async inviterName(id) { return ((await client.from('profiles').select('full_name').eq('id', id).maybeSingle()).data?.full_name as string | null | undefined) ?? null },
    async create(a) {
      const { data, error } = await svc.rpc('create_invitation', {
        p_actor: a.actor, p_org: a.org, p_email: a.email, p_role: a.role, p_token_hash: a.tokenHash, p_days: a.days,
      })
      if (error) return { ok: false, code: error.code ?? 'unknown', message: error.message }
      return { ok: true, id: data as string }
    },
    audit: async (e) => { await svc.from('action_logs').insert(e) },
  }
}
