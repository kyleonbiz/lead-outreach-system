import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import { callFunction } from '@/features/assistant/api'

export const EVENT_LABELS = {
  workflow_failed: 'A workflow fails',
  approval_needed: 'Something needs approval',
  task_overdue: 'Tasks become overdue',
  workflow_message: 'A workflow posts a message',
} as const
export type EventType = keyof typeof EVENT_LABELS

export interface Prefs { email_workflow_failed: boolean; email_approval_needed: boolean; email_task_overdue: boolean }
export const DEFAULT_PREFS: Prefs = { email_workflow_failed: true, email_approval_needed: true, email_task_overdue: false }

export interface Channel {
  id: string; kind: 'slack' | 'teams'; name: string; url_hint: string; events: EventType[]; enabled: boolean
  last_status: 'ok' | 'failed' | null; last_error: string | null; last_sent_at: string | null
}
export interface Delivery {
  id: string; channel: 'email' | 'slack' | 'teams'; status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'
  attempts: number; last_error: string | null; created_at: string; sent_at: string | null
}

export function usePrefs(orgId: string, userId: string) {
  return useQuery({
    queryKey: ['notify-prefs', orgId, userId],
    queryFn: async (): Promise<Prefs> => {
      const { data, error } = await db().from('notification_preferences')
        .select('email_workflow_failed, email_approval_needed, email_task_overdue').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      if (error) throw error
      return (data as Prefs | null) ?? DEFAULT_PREFS
    },
  })
}

export function useSavePrefs(orgId: string, userId: string) {
  const qc = useQueryClient()
  const key = ['notify-prefs', orgId, userId]
  return useMutation({
    mutationFn: async (next: Prefs) => {
      // column grants allow updating only the three flags, so update first and insert when the row does not exist yet
      const up = await db().from('notification_preferences').update(next).eq('org_id', orgId).eq('user_id', userId).select('user_id')
      if (up.error) throw new Error(up.error.message)
      if (up.data && up.data.length > 0) return
      const ins = await db().from('notification_preferences').insert({ org_id: orgId, user_id: userId, ...next })
      if (ins.error) throw new Error(ins.error.message)
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Prefs>(key)
      qc.setQueryData(key, next)
      return { previous }
    },
    onError: (_e, _n, ctx) => { if (ctx?.previous) qc.setQueryData(key, ctx.previous) },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}

export function useChannels(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['notify-channels', orgId], enabled,
    queryFn: async () => {
      const { data, error } = await db().from('notification_channels')
        .select('id, kind, name, url_hint, events, enabled, last_status, last_error, last_sent_at').eq('org_id', orgId).order('created_at')
      if (error) throw error
      return (data ?? []) as Channel[]
    },
  })
}

export function useDeliveries(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['notify-deliveries', orgId], enabled, refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await db().from('notification_deliveries')
        .select('id, channel, status, attempts, last_error, created_at, sent_at').eq('org_id', orgId)
        .order('created_at', { ascending: false }).limit(10)
      if (error) throw error
      return (data ?? []) as Delivery[]
    },
  })
}

export function useChannelAction(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => callFunction<Record<string, unknown>>('notification-channels', body),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['notify-channels', orgId] }); qc.invalidateQueries({ queryKey: ['notify-deliveries', orgId] }) },
  })
}
