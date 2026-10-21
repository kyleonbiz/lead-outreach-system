import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import type { Task } from '@/lib/types'
import { sortTasks } from '@/lib/utils'

const key = (orgId: string) => ['tasks', orgId]

export type TaskInput = Partial<Pick<Task,
  'title' | 'description' | 'notes' | 'status' | 'priority' | 'category' | 'due_at' | 'recurrence' | 'assignee_id'>>

export function useTasks(orgId: string) {
  return useQuery({
    queryKey: key(orgId),
    queryFn: async () => {
      // org filter keeps the query indexed; Row Level Security is what actually enforces isolation.
      const { data, error } = await db().from('tasks').select('*').eq('org_id', orgId).limit(1000)
      if (error) throw error
      return sortTasks((data ?? []) as Task[])
    },
  })
}

function useInvalidate(orgId: string) {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: key(orgId) })
}

export function useCreateTask(orgId: string) {
  const invalidate = useInvalidate(orgId)
  return useMutation({
    mutationFn: async (input: TaskInput & { title: string }) => {
      const { error } = await db().from('tasks').insert({ ...input, org_id: orgId })
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}

export function useUpdateTask(orgId: string) {
  const invalidate = useInvalidate(orgId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: TaskInput & { id: string }) => {
      const { error } = await db().from('tasks').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}

/** Uses the DB function so recurring tasks spawn their next occurrence exactly as the assistant's tool will. */
export function useCompleteTask(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().rpc('complete_task', { p_task_id: id })
      if (error) throw error
    },
    // optimistic: tick the box immediately, roll back if the server refuses
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key(orgId) })
      const previous = qc.getQueryData<Task[]>(key(orgId))
      qc.setQueryData<Task[]>(key(orgId), (old) =>
        old?.map((t) => (t.id === id ? { ...t, status: 'done' as const } : t)))
      return { previous }
    },
    onError: (_e, _id, ctx) => { if (ctx?.previous) qc.setQueryData(key(orgId), ctx.previous) },
    onSettled: () => qc.invalidateQueries({ queryKey: key(orgId) }),
  })
}

export function useDeleteTask(orgId: string) {
  const invalidate = useInvalidate(orgId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from('tasks').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}
