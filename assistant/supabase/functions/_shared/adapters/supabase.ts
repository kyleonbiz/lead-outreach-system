// Real implementations of the core ports on top of Supabase. Thin by design: all rules live in
// SQL (RLS, agent_task_op) or in core/.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionLogEntry } from '../core/types.ts'
import type { Store } from '../core/execute.ts'
import type { KnowledgePort, TaskPort, TaskRecord } from '../core/ports.ts'

const unwrap = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data as T
}

const TASK_COLS = 'id, title, description, status, priority, category, due_at, recurrence, completed_at'

export class SupabaseTasks implements TaskPort {
  /** `client` is the caller's (RLS) client for chat, or the service client for workflows; org scoping is explicit either way. */
  constructor(private client: SupabaseClient, private orgId: string, private actor: 'assistant' | 'workflow') {}

  async list(f: Parameters<TaskPort['list']>[0]): Promise<TaskRecord[]> {
    const open = ['todo', 'in_progress', 'blocked']
    let q = this.client.from('tasks').select(TASK_COLS).eq('org_id', this.orgId)
      .in('status', f.status?.length ? f.status : open)
      .order('due_at', { ascending: true, nullsFirst: false }).limit(f.limit)
    if (f.overdue) q = q.lt('due_at', new Date().toISOString())
    if (f.due_before) q = q.lte('due_at', f.due_before)
    if (f.category) q = q.eq('category', f.category)
    return unwrap(await q, 'list tasks') as TaskRecord[]
  }

  private op(op: string, id: string | null, p: unknown) {
    return this.client.rpc('agent_task_op', { p_org: this.orgId, p_actor: this.actor, p_op: op, p_id: id, p })
  }

  async create(input: Parameters<TaskPort['create']>[0]): Promise<TaskRecord> {
    return unwrap(await this.op('create', null, input), 'create task') as TaskRecord
  }
  async update(id: string, patch: Parameters<TaskPort['update']>[1]): Promise<TaskRecord | null> {
    return unwrap(await this.op('update', id, patch), 'update task') as TaskRecord | null
  }
  async complete(id: string) {
    const r = unwrap(await this.op('complete', id, {}), 'complete task') as { completed: boolean; next_id: string | null }
    return { completed: r.completed, nextId: r.next_id }
  }
  async remove(id: string): Promise<boolean> {
    return unwrap(await this.op('delete', id, {}), 'delete task') as boolean
  }
}

export class SupabaseKnowledge implements KnowledgePort {
  constructor(private client: SupabaseClient, private orgId: string) {}
  async search(query: string, limit: number) {
    const { data, error } = await this.client.rpc('search_knowledge', { p_org: this.orgId, p_query: query, p_limit: limit })
    if (error) throw new Error(`search knowledge: ${error.message}`)
    return (data ?? []) as Array<{ source: 'knowledge' | 'document'; id: string; title: string; snippet: string }>
  }
}

/** Service-role store for the activity log, approvals, messages and usage. */
export class SupabaseStore implements Store {
  constructor(
    private svc: SupabaseClient, private orgId: string, private userId: string | null,
    private conversationId: string | null,
  ) {}

  async addMessage(m: Parameters<Store['addMessage']>[0]) {
    if (!this.conversationId) return
    const { error } = await this.svc.from('assistant_messages').insert({
      org_id: this.orgId, conversation_id: this.conversationId, role: m.role, content: m.content,
      tool_calls: m.tool_calls ?? null, metadata: m.metadata ?? {},
    })
    if (error) throw new Error(`save message: ${error.message}`)
  }

  async logAction(e: ActionLogEntry) {
    const { error } = await this.svc.from('action_logs').insert(e)
    if (error) console.error('action_logs insert failed', error.message) // logging must not break the user's request
  }

  async reserveAction(e: ActionLogEntry) {
    const { data, error } = await this.svc.from('action_logs').insert(e).select('id').single()
    if (error) {
      if (error.code === '23505') return null // idempotency key already used
      throw new Error(`reserve action: ${error.message}`)
    }
    return { id: data.id as string }
  }

  async finishAction(id: string, patch: Parameters<Store['finishAction']>[1]) {
    const { error } = await this.svc.from('action_logs').update(patch).eq('id', id)
    if (error) console.error('action_logs update failed', error.message)
  }

  async createApproval(a: Parameters<Store['createApproval']>[0]) {
    const { data, error } = await this.svc.from('approval_requests').insert(a).select('id').single()
    if (error) throw new Error(`create approval: ${error.message}`)
    return { id: data.id as string }
  }

  async recordUsage(u: Parameters<Store['recordUsage']>[0]) {
    await this.svc.from('usage_records').insert({ org_id: this.orgId, user_id: this.userId, kind: u.kind, quantity: u.quantity, model: u.model ?? null })
  }
}
