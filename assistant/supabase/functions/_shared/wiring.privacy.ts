import type { SupabaseClient } from '@supabase/supabase-js'
import type { Role } from './core/handlers/common.ts'
import type { AccountDeletionDeps, PlanRow } from './core/handlers/accountDeletion.ts'
import type { ExportDeps, ExportTable } from './core/handlers/dataExport.ts'
import { revokeAndRemove } from './core/handlers/oauth.ts'
import { disconnectDeps } from './wiring.oauth.ts'

/** Columns that may be selected where the table grants only some columns to signed-in users (never the token hash). */
const COLUMNS: Partial<Record<ExportTable, string>> = {
  organization_invitations: 'id, org_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at',
}

/** Every read uses the CALLER's token: Row Level Security bounds the export to what this person may already see. */
export function exportDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): ExportDeps {
  return {
    userId, now: () => new Date(),
    async getRole(orgId) {
      if (!userId) return null
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      return (data?.role as Role | undefined) ?? null
    },
    async org(orgId) { return (await client.from('organizations').select('id, name').eq('id', orgId).maybeSingle()).data as { id: string; name: string } | null },
    async settings(orgId) { return (await client.from('organization_settings').select('*').eq('org_id', orgId).maybeSingle()).data as Record<string, unknown> | null },
    async members(orgId) {
      const { data, error } = await client.rpc('org_members', { p_org: orgId })
      if (error) throw new Error(`members: ${error.message}`)
      return (data ?? []) as Array<Record<string, unknown>>
    },
    async rows(table, orgId, offset, limit) {
      // id as a tiebreaker keeps pages stable when many rows share a timestamp
      const { data, error } = await client.from(table).select(COLUMNS[table] ?? '*').eq('org_id', orgId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit - 1)
      if (error) throw new Error(`${table}: ${error.message}`)
      return (data ?? []) as unknown as Array<Record<string, unknown>>
    },
    async lastExportAt(orgId) {
      const { data } = await client.from('action_logs').select('created_at').eq('org_id', orgId).eq('action', 'org.exported')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      return data?.created_at ? new Date(data.created_at as string) : null
    },
    audit: async (e) => { await svc.from('action_logs').insert(e) },
  }
}

/** Removes every file stored under `<orgId>/` (database cascades do not touch Storage). Throws rather than leave files behind silently. */
export async function removeOrgFiles(svc: SupabaseClient, orgId: string): Promise<number> {
  const bucket = svc.storage.from('documents')
  const prefixes = [orgId]
  let removed = 0
  for (let guard = 0; prefixes.length && guard < 500; guard++) {
    const prefix = prefixes.shift()!
    const files: string[] = []
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket.list(prefix, { limit: 1000, offset })
      if (error) throw new Error(`list files: ${error.message}`)
      // entries without an id are folders: descend into them; everything else is a file
      for (const item of data ?? []) (item.id ? files : prefixes).push(`${prefix}/${item.name}`)
      if ((data ?? []).length < 1000) break
    }
    for (let i = 0; i < files.length; i += 100) {
      const { error } = await bucket.remove(files.slice(i, i + 100))
      if (error) throw new Error(`remove files: ${error.message}`)
      removed += Math.min(100, files.length - i)
    }
  }
  if (prefixes.length) throw new Error('too many nested folders to delete safely')
  return removed
}

export function accountDeletionDeps(
  user: { id: string; email: string | null; lastSignInAt: string | null } | null, svc: SupabaseClient,
): AccountDeletionDeps {
  return {
    userId: user?.id ?? null, userEmail: user?.email ?? null, lastSignInAt: user?.lastSignInAt ?? null, now: () => new Date(),
    async plan(userId) {
      const { data, error } = await svc.rpc('account_deletion_plan', { p_user: userId })
      if (error) throw new Error(`plan: ${error.message}`)
      return ((data ?? []) as Array<{ org_id: string; org_name: string; role: string; member_count: number | string; owner_count: number | string; plan: PlanRow['plan'] }>)
        .map((r) => ({ ...r, member_count: Number(r.member_count), owner_count: Number(r.owner_count) }))
    },
    // the mailboxes and calendars THIS person connected are disconnected (and revoked where the provider allows it)
    async disconnectIntegrations(userId) {
      const { data, error } = await svc.from('connected_integrations').select('id, org_id, provider, external_account').eq('connected_by', userId).neq('status', 'revoked')
      if (error) throw new Error(`integrations: ${error.message}`)
      const deps = disconnectDeps(userId, svc, svc)
      const out = []
      for (const i of (data ?? []) as Array<{ id: string; org_id: string; provider: string; external_account: string }>) {
        const r = await revokeAndRemove(deps, i, userId)
        out.push({ provider: i.provider, account: i.external_account, revoked: r.providerRevoked })
      }
      return out
    },
    async deleteOrganization(orgId) {
      await removeOrgFiles(svc, orgId)
      const { error } = await svc.from('organizations').delete().eq('id', orgId)
      if (error) throw new Error(`delete organization: ${error.message}`)
    },
    async scrubLogs(userId, email) {
      const { data, error } = await svc.rpc('scrub_user_log_text', { p_user: userId, p_email: email })
      if (error) throw new Error(`scrub: ${error.message}`)
      return (data as number) ?? 0
    },
    async deleteUser(userId) {
      const { error } = await svc.auth.admin.deleteUser(userId)
      if (error) throw new Error(`delete user: ${error.message}`)
    },
    audit: async (e) => { await svc.from('action_logs').insert(e) },
  }
}
