import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import type { ActionLog, ConnectedIntegration } from '@/lib/types'

export const PAGE = 25

export function useActivity(orgId: string, status: ActionLog['status'] | 'all') {
  return useInfiniteQuery({
    queryKey: ['activity', orgId, status],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      let q = db().from('action_logs')
        .select('id, org_id, actor_type, category, tool_name, action, status, summary, error, duration_ms, created_at')
        .eq('org_id', orgId).order('created_at', { ascending: false }).limit(PAGE)
      if (status !== 'all') q = q.eq('status', status)
      if (pageParam) q = q.lt('created_at', pageParam)
      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as ActionLog[]
    },
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].created_at : undefined),
  })
}

export function useRecentActivity(orgId: string, limit = 5) {
  return useQuery({
    queryKey: ['activity-recent', orgId, limit],
    queryFn: async () => {
      const { data, error } = await db().from('action_logs')
        .select('id, org_id, actor_type, category, tool_name, action, status, summary, error, duration_ms, created_at')
        .eq('org_id', orgId).neq('category', 'audit').order('created_at', { ascending: false }).limit(limit)
      if (error) throw error
      return (data ?? []) as ActionLog[]
    },
  })
}

export function useIntegrations(orgId: string) {
  return useQuery({
    queryKey: ['integrations', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('connected_integrations')
        .select('id, provider, status, external_account, last_error, last_synced_at').eq('org_id', orgId)
      if (error) throw error
      return (data ?? []) as ConnectedIntegration[]
    },
  })
}

export function useWorkflowSummary(orgId: string) {
  return useQuery({
    queryKey: ['workflow-summary', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('workflows').select('id, enabled').eq('org_id', orgId)
      if (error) throw error
      const rows = data ?? []
      return { total: rows.length, enabled: rows.filter((w) => w.enabled).length }
    },
  })
}
