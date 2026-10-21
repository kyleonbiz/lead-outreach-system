import type { SupabaseClient } from '@supabase/supabase-js'
import type { Role } from './core/handlers/common.ts'
import { parseDailyTokenLimit, type UsageDeps, type UsageSummary } from './core/handlers/usage.ts'
import { env } from './runtime.ts'

export function usageDeps(userId: string | null, client: SupabaseClient): UsageDeps {
  return {
    userId, now: () => new Date(), dailyTokenLimit: parseDailyTokenLimit(env('ASSISTANT_DAILY_TOKEN_LIMIT')),
    async getRole(orgId) {
      if (!userId) return null
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      return (data?.role as Role | undefined) ?? null
    },
    // the caller's own token: the function re-checks that they are an owner/admin and Row Level Security applies underneath
    async summary(orgId, days) {
      const { data, error } = await client.rpc('usage_summary', { p_org: orgId, p_days: days })
      if (error) throw new Error(`usage_summary: ${error.message}`)
      return data as UsageSummary
    },
  }
}
