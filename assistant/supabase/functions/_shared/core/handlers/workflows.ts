import { z } from 'zod'
import { fail, isAdmin, ok, type HandlerResult, type Role } from './common.ts'
import { Trigger, validateDefinition } from '../workflow/definition.ts'
import { cronMatches } from '../workflow/cron.ts'
import { localParts } from '../workflow/cron.ts'
import type { RunSummary } from '../workflow/runner.ts'
import type { ActionLogEntry } from '../types.ts'

// ------------------------------------------------------------------ save
const SaveRequest = z.object({
  org_id: z.uuid(),
  workflow_id: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
  kind: z.enum(['custom', 'daily_briefing']).default('custom'),
  trigger: Trigger,
  definition: z.unknown(),
})

export interface SaveDeps {
  userId: string | null
  getRole(orgId: string): Promise<Role | null>
  /** tool names a workflow may reference (the registry) */
  knownTools(): string[]
  /** service-role write: creates the workflow + a new version atomically; null = workflow not found in that org */
  save(w: {
    org_id: string; workflow_id?: string; name: string; description: string | null; kind: string
    trigger_type: string; trigger_config: Record<string, unknown>; definition: unknown; user_id: string
  }): Promise<{ id: string; version: number } | null>
  audit(e: ActionLogEntry): Promise<void>
}

export async function handleWorkflowSave(d: SaveDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = SaveRequest.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request', { issues: p.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`) })
  if (!isAdmin(await d.getRole(p.data.org_id))) return fail(403, 'Only owners and admins can create or edit workflows')

  const v = validateDefinition(p.data.definition, d.knownTools())
  if (!v.ok) return fail(422, 'The workflow definition is not valid', { errors: v.errors })

  const t = p.data.trigger
  const saved = await d.save({
    org_id: p.data.org_id, workflow_id: p.data.workflow_id, name: p.data.name, description: p.data.description ?? null, kind: p.data.kind,
    trigger_type: t.type, trigger_config: t.type === 'schedule' ? { cron: t.cron } : t.type === 'event' ? { event: t.event } : {},
    definition: v.def, user_id: d.userId,
  })
  if (!saved) return fail(404, 'Workflow not found')
  await d.audit({
    org_id: p.data.org_id, user_id: d.userId, actor_type: 'user', category: 'audit', tool_name: null,
    action: p.data.workflow_id ? 'workflow.updated' : 'workflow.created', status: 'success', summary: `Saved workflow "${p.data.name}" (v${saved.version})`,
  })
  return ok({ id: saved.id, version: saved.version })
}

// ------------------------------------------------------------------- run
export interface RunDeps {
  userId: string | null
  getRole(orgId: string): Promise<Role | null>
  /** read with the user's token (RLS) */
  loadWorkflow(id: string): Promise<{ id: string; org_id: string; name: string } | null>
  enqueue(workflowId: string, source: 'manual', key: string): Promise<string | null>
  processNow(limit: number): Promise<RunSummary[]>
  runStatus(runId: string): Promise<{ status: string; error: string | null } | null>
  newKey(): string
}

export async function handleWorkflowRun(d: RunDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = z.object({ workflow_id: z.uuid() }).safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  const wf = await d.loadWorkflow(p.data.workflow_id)
  if (!wf) return fail(404, 'Workflow not found')
  if (!isAdmin(await d.getRole(wf.org_id))) return fail(403, 'Only owners and admins can run workflows')

  const runId = await d.enqueue(wf.id, 'manual', `manual:${d.newKey()}`)
  if (!runId) return fail(409, 'This workflow has no saved version to run')
  await d.processNow(3)
  const s = await d.runStatus(runId)
  return ok({ run_id: runId, status: s?.status ?? 'queued', ...(s?.error ? { error: s.error } : {}) })
}

// ------------------------------------------------------------------ tick
export interface TickDeps {
  authorized: boolean
  now(): Date
  lookbackMinutes?: number
  listScheduled(): Promise<Array<{ id: string; cron: string; timezone: string }>>
  enqueue(workflowId: string, source: 'schedule', key: string): Promise<string | null>
  dispatchEvents(): Promise<number>
  /** marks overdue approvals expired and fails workflow steps still waiting on them */
  expireApprovals(): Promise<number>
  processNow(limit: number): Promise<RunSummary[]>
  /** announces newly overdue tasks as notifications; returns how many tasks were announced */
  notifyOverdue?(): Promise<number>
  /** sends queued e-mail / Slack / Teams deliveries */
  dispatchNotifications?(): Promise<{ claimed: number; sent: number; failed: number; retried: number; skipped: number }>
  /** deletes old delivery records */
  pruneNotifications?(): Promise<number>
}

/**
 * Called every minute by pg_cron. Scheduling is catch-up safe: it looks back a few minutes and relies on the
 * unique idempotency key (sched:<workflow>:<local minute>) so late/duplicate ticks never create duplicate runs.
 */
export async function handleTick(d: TickDeps): Promise<HandlerResult> {
  if (!d.authorized) return fail(401, 'Unauthorized')
  const now = d.now()
  const base = Math.floor(now.getTime() / 60_000) * 60_000
  let scheduled = 0
  for (const w of await d.listScheduled()) {
    for (let k = 0; k < (d.lookbackMinutes ?? 5); k++) {
      const at = new Date(base - k * 60_000)
      if (!cronMatches(w.cron, at, w.timezone)) continue
      if (await d.enqueue(w.id, 'schedule', `sched:${w.id}:${localParts(at, w.timezone).key}`)) scheduled++
    }
  }
  const expired = await d.expireApprovals()
  const fromEvents = await d.dispatchEvents()
  const runs = await d.processNow(3)

  // Notification delivery must never break workflow processing: failures are reported, not thrown.
  const notifications: Record<string, unknown> = {}
  const safely = async (name: string, fn?: () => Promise<unknown>) => {
    if (!fn) return
    try { notifications[name] = await fn() } catch (e) { notifications[`${name}_error`] = (e as Error).message.slice(0, 200) }
  }
  await safely('overdue_announced', d.notifyOverdue)
  await safely('deliveries', d.dispatchNotifications)
  if (now.getUTCMinutes() === 0) await safely('pruned', d.pruneNotifications)

  return ok({ scheduled, from_events: fromEvents, expired_approvals: expired, processed: runs.length, runs, notifications })
}
