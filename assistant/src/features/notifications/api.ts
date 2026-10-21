import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'

export interface Notification { id: string; type: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }

export function useNotifications(orgId: string) {
  return useQuery({
    queryKey: ['notifications', orgId], refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await db().from('notifications').select('id, type, title, body, link, read_at, created_at')
        .eq('org_id', orgId).order('created_at', { ascending: false }).limit(20)
      if (error) throw error
      return (data ?? []) as Notification[]
    },
  })
}

export function useMarkRead(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await db().from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications', orgId] }),
  })
}
