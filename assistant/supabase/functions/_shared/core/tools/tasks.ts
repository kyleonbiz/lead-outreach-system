import { z } from 'zod'
import type { ToolDef } from './registry.ts'

const iso = z.iso.datetime({ offset: true })
const priority = z.enum(['low', 'medium', 'high', 'urgent'])
const status = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled'])
const recurrence = z.enum(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'])

export const tasksList: ToolDef = {
  name: 'tasks.list',
  description: 'List tasks. Use overdue=true to find overdue open tasks. Returns at most `limit` tasks ordered by due date.',
  risk: 'read',
  input: z.object({
    status: z.array(status).optional().describe('Filter by status. Default: all open statuses'),
    overdue: z.boolean().optional(),
    due_before: iso.optional(),
    category: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  summarize: () => 'List tasks',
  execute: (ctx, i) => ctx.ports.tasks.list(i),
}

export const tasksCreate: ToolDef = {
  name: 'tasks.create',
  description: 'Create a task. due_at must be an ISO 8601 timestamp with UTC offset.',
  risk: 'write',
  input: z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(20000).optional(),
    due_at: iso.optional(),
    priority: priority.default('medium'),
    category: z.string().max(80).optional(),
    recurrence: recurrence.optional(),
  }),
  summarize: (i) => `Create task "${i.title}"`,
  execute: (ctx, i) => ctx.ports.tasks.create(i),
}

export const tasksUpdate: ToolDef = {
  name: 'tasks.update',
  description: 'Update fields of an existing task by id. To finish a task use tasks.complete instead.',
  risk: 'write',
  input: z.object({
    id: z.uuid(),
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20000).nullable().optional(),
    due_at: iso.nullable().optional(),
    priority: priority.optional(),
    category: z.string().max(80).nullable().optional(),
    status: z.enum(['todo', 'in_progress', 'blocked', 'cancelled']).optional(),
    recurrence: recurrence.nullable().optional(),
  }),
  summarize: (i) => `Update task ${i.id}`,
  async execute(ctx, { id, ...patch }) {
    const t = await ctx.ports.tasks.update(id, patch)
    if (!t) throw new Error(`Task ${id} not found`)
    return t
  },
}

export const tasksComplete: ToolDef = {
  name: 'tasks.complete',
  description: 'Mark a task done. Recurring tasks automatically get their next occurrence.',
  risk: 'write',
  input: z.object({ id: z.uuid() }),
  summarize: (i) => `Complete task ${i.id}`,
  async execute(ctx, { id }) {
    const r = await ctx.ports.tasks.complete(id)
    if (!r.completed) throw new Error(`Task ${id} was not found or is already finished`)
    return r
  },
}

export const tasksDelete: ToolDef = {
  name: 'tasks.delete',
  description: 'Permanently delete a task. Requires the user\'s approval.',
  risk: 'sensitive',
  input: z.object({ id: z.uuid(), title: z.string().max(300).optional().describe('Task title, for the approval prompt') }),
  summarize: (i) => `Permanently delete task ${i.title ? `"${i.title}"` : i.id}`,
  async execute(ctx, { id }) {
    if (!(await ctx.ports.tasks.remove(id))) throw new Error(`Task ${id} not found`)
    return { deleted: true, id }
  },
}

export const taskTools = [tasksList, tasksCreate, tasksUpdate, tasksComplete, tasksDelete]
