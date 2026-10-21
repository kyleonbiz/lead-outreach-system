// Test doubles shared by unit tests. Not imported by production code.
import type { ActionLogEntry } from './types.ts'
import type { Store } from './execute.ts'
import type { ToolContext } from './tools/registry.ts'
import type { Ports, TaskRecord } from './ports.ts'
import { NotConfiguredError } from './types.ts'

export class MemoryStore implements Store {
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] | null; metadata?: unknown }> = []
  logs: Array<ActionLogEntry & { id: string }> = []
  approvals: Array<{ id: string; action_type: string; summary: string; payload: unknown; org_id: string }> = []
  usage: Array<{ kind: string; quantity: number }> = []
  private keys = new Set<string>()
  private n = 0

  async addMessage(m: any) { this.messages.push(m) }
  async logAction(e: ActionLogEntry) {
    if (e.idempotency_key) { if (this.keys.has(e.idempotency_key)) throw new Error('duplicate key'); this.keys.add(e.idempotency_key) }
    this.logs.push({ ...e, id: `log${++this.n}` })
  }
  async reserveAction(e: ActionLogEntry) {
    if (e.idempotency_key) { if (this.keys.has(e.idempotency_key)) return null; this.keys.add(e.idempotency_key) }
    const id = `log${++this.n}`
    this.logs.push({ ...e, id })
    return { id }
  }
  async finishAction(id: string, patch: any) {
    const l = this.logs.find((x) => x.id === id)!
    Object.assign(l, patch)
  }
  async createApproval(a: any) {
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`
    this.approvals.push({ id, action_type: a.action_type, summary: a.summary, payload: a.payload, org_id: a.org_id })
    return { id }
  }
  async recordUsage(u: any) { this.usage.push(u) }
}

export const ORG = '11111111-1111-4111-8111-111111111111'
export const USER = '22222222-2222-4222-8222-222222222222'

export class MemoryTasks {
  tasks: TaskRecord[] = []
  calls: string[] = []
  private n = 0
  async list(f: { limit: number; status?: string[] }) {
    this.calls.push('list')
    return this.tasks.filter((t) => !f.status || f.status.includes(t.status)).slice(0, f.limit)
  }
  async create(i: any) {
    this.calls.push('create')
    const t: TaskRecord = {
      id: `aaaaaaaa-0000-4000-8000-${String(++this.n).padStart(12, '0')}`, title: i.title, description: i.description ?? null,
      status: 'todo', priority: i.priority ?? 'medium', category: i.category ?? null, due_at: i.due_at ?? null,
      recurrence: i.recurrence ?? null, completed_at: null,
    }
    this.tasks.push(t); return t
  }
  async update(id: string, patch: any) {
    this.calls.push('update'); const t = this.tasks.find((x) => x.id === id); if (!t) return null; Object.assign(t, patch); return t
  }
  async complete(id: string) {
    this.calls.push('complete'); const t = this.tasks.find((x) => x.id === id)
    if (!t || t.status === 'done') return { completed: false, nextId: null }
    t.status = 'done'; return { completed: true, nextId: null }
  }
  async remove(id: string) {
    this.calls.push('remove'); const i = this.tasks.findIndex((x) => x.id === id)
    if (i < 0) return false; this.tasks.splice(i, 1); return true
  }
}

export function makePorts(over: Partial<Ports> = {}): Ports & { tasksMem: MemoryTasks } {
  const tasksMem = new MemoryTasks()
  return {
    tasksMem,
    tasks: tasksMem,
    knowledge: { search: async (q) => [{ source: 'knowledge', id: 'k1', title: 'Policy', snippet: `about ${q}` }] },
    documents: {
      list: async () => [],
      get: async (id) => ({ id, name: 'Doc', category: null, summary: 'sum', status: 'ready', created_at: new Date().toISOString(), extracted: {}, text: 'body' }),
      createGenerated: async (i) => ({ id: 'd1', name: i.title, category: i.category ?? null, summary: null, status: 'ready', created_at: new Date().toISOString() }),
    },
    email: async () => { throw new NotConfiguredError('Gmail') },
    calendar: async () => { throw new NotConfiguredError('Google Calendar') },
    ...over,
  }
}

export function makeCtx(ports: Ports, over: Partial<ToolContext> = {}): ToolContext {
  return { orgId: ORG, userId: USER, actor: 'assistant', timezone: 'America/Chicago', now: () => new Date('2026-10-21T15:00:00Z'), ports, ...over }
}
