import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'

export interface Conversation { id: string; title: string | null; updated_at: string }
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string
  tool_calls: Array<{ type: string; name?: string }> | null; metadata: Record<string, unknown>; created_at: string
}
export interface PendingApproval { id: string; summary: string; action_type: string; created_at: string; conversation_id: string | null }

/** Error carrying the server's structured body (e.g. {code:'not_configured', missing:[...]}). */
export class FunctionError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) { super(message) }
}

export async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().functions.invoke(name, { body })
  if (!error) return data as T
  const res = (error as { context?: Response }).context
  if (res && typeof res.json === 'function') {
    const parsed = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new FunctionError(String(parsed.error ?? error.message), res.status, parsed)
  }
  throw new FunctionError(error.message, 0, {})
}

export function useConversations(orgId: string) {
  return useQuery({
    queryKey: ['conversations', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('assistant_conversations').select('id, title, updated_at')
        .eq('org_id', orgId).order('updated_at', { ascending: false }).limit(50)
      if (error) throw error
      return (data ?? []) as Conversation[]
    },
  })
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ['messages', conversationId],
    enabled: !!conversationId,
    queryFn: async () => {
      const { data, error } = await db().from('assistant_messages')
        .select('id, role, content, tool_calls, metadata, created_at').eq('conversation_id', conversationId!)
        .order('created_at', { ascending: true }).limit(500)
      if (error) throw error
      return (data ?? []) as ChatMessage[]
    },
  })
}

export function usePendingApprovalList(orgId: string) {
  return useQuery({
    queryKey: ['approvals-pending', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('approval_requests')
        .select('id, summary, action_type, created_at, conversation_id')
        .eq('org_id', orgId).eq('status', 'pending').gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(20)
      if (error) throw error
      return (data ?? []) as PendingApproval[]
    },
    refetchInterval: 15_000,
  })
}

function useRefreshAll(orgId: string) {
  const qc = useQueryClient()
  return () => Promise.all(['conversations', 'messages', 'approvals-pending', 'tasks', 'activity', 'activity-recent']
    .map((k) => qc.invalidateQueries({ queryKey: [k] })))
    .then(() => qc.invalidateQueries({ queryKey: ['tasks', orgId] }))
}

export function useSendMessage(orgId: string) {
  const refresh = useRefreshAll(orgId)
  return useMutation({
    mutationFn: (v: { conversationId: string | null; message: string }) =>
      callFunction<{ conversation_id: string; reply: string; pending_approvals: unknown[] }>('assistant-chat', {
        org_id: orgId, conversation_id: v.conversationId ?? undefined, message: v.message,
      }),
    onSettled: refresh,
  })
}

export function useDecide(orgId: string) {
  const refresh = useRefreshAll(orgId)
  return useMutation({
    mutationFn: (v: { approvalId: string; decision: 'approved' | 'rejected' }) =>
      callFunction<{ status: string; error?: string }>('assistant-approve', { approval_id: v.approvalId, decision: v.decision }),
    onSettled: refresh,
  })
}
