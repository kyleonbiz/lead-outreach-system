import { notifyTickDeps } from './wiring.notify.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AnthropicProvider } from './core/llm/anthropic.ts'
import { buildRegistry } from './core/tools/index.ts'
import { parsePolicy } from './core/policy.ts'
import type { EngineDeps, StepState, WorkflowStore } from './core/workflow/engine.ts'
import { processRuns, type ClaimedRun, type RunSummary } from './core/workflow/runner.ts'
import type { RunDeps, SaveDeps, TickDeps } from './core/handlers/workflows.ts'
import type { Role } from './core/handlers/common.ts'
import { SupabaseStore } from './adapters/supabase.ts'
import { buildPorts, DEFAULT_MODEL } from './wiring.ts'
import { env } from './runtime.ts'

class SupabaseWorkflowStore implements WorkflowStore {
  constructor(private svc: SupabaseClient, private orgId: string) {}

  async getSteps(runId: string): Promise<Record<string, StepState>> {
    const { data } = await this.svc.from('workflow_steps').select('step_key, status, attempt, output, error, next_attempt_at').eq('run_id', runId)
    return Object.fromEntries((data ?? []).map((r) => [r.step_key as string, {
      status: r.status, attempt: r.attempt, output: r.output ?? undefined, error: r.error, next_attempt_at: r.next_attempt_at,
    } as StepState]))
  }

  async saveStep(runId: string, key: string, type: string, patch: Partial<StepState> & { input?: unknown }) {
    const now = new Date().toISOString()
    const { error } = await this.svc.from('workflow_steps').upsert({
      run_id: runId, org_id: this.orgId, step_key: key, step_type: type, ...patch,
      ...(patch.status === 'running' ? { started_at: now } : {}),
      ...(patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'skipped' ? { finished_at: now } : {}),
    }, { onConflict: 'run_id,step_key' })
    if (error) throw new Error(`save step: ${error.message}`)
  }
}

async function engineFor(svc: SupabaseClient, run: ClaimedRun): Promise<EngineDeps> {
  const { data: s } = await svc.from('organization_settings').select('timezone, ai_model, approval_policy').eq('org_id', run.org_id).maybeSingle()
  const key = env('ANTHROPIC_API_KEY')
  const timezone = (s?.timezone as string) ?? 'UTC'
  const ports = buildPorts(svc, svc, run.org_id, 'workflow', null)   // service client, always org-scoped by the adapters
  return {
    store: new SupabaseWorkflowStore(svc, run.org_id),
    execStore: new SupabaseStore(svc, run.org_id, null, null),
    tools: buildRegistry(),
    policy: parsePolicy(s?.approval_policy),
    ctx: { orgId: run.org_id, userId: null, actor: 'workflow', timezone, now: () => new Date(), ports },
    provider: key ? new AnthropicProvider({ apiKey: key }) : null,
    model: (s?.ai_model as string | null) ?? env('ASSISTANT_DEFAULT_MODEL') ?? DEFAULT_MODEL,
    notify: async (n) => { await svc.from('notifications').insert({ org_id: run.org_id, type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null }) },
    now: () => new Date(),
  }
}

export function processNow(svc: SupabaseClient): (limit: number) => Promise<RunSummary[]> {
  return (limit) => processRuns({
    async claim(n) {
      const { data, error } = await svc.rpc('claim_workflow_runs', { p_limit: n, p_lease_seconds: 300 })
      if (error) throw new Error(`claim runs: ${error.message}`)
      return (data ?? []).map((r: any) => ({ id: r.id, org_id: r.org_id, workflow_id: r.workflow_id, version_id: r.version_id, attempt: r.attempt, event: r.event ?? undefined })) as ClaimedRun[]
    },
    async load(run) {
      const [wf, ver] = await Promise.all([
        svc.from('workflows').select('name').eq('id', run.workflow_id).maybeSingle(),
        run.version_id ? svc.from('workflow_versions').select('definition').eq('id', run.version_id).maybeSingle() : Promise.resolve({ data: null }),
      ])
      return wf.data && ver.data ? { workflowName: wf.data.name as string, definition: ver.data.definition } : null
    },
    engineFor: (run) => engineFor(svc, run),
    async finalize(runId, o) {
      const base = { locked_until: null as string | null }
      const patch = o.status === 'succeeded' ? { ...base, status: 'succeeded', finished_at: new Date().toISOString(), output: o.output, error: null }
        : o.status === 'failed' ? { ...base, status: 'failed', finished_at: new Date().toISOString(), error: o.error }
        : o.status === 'waiting_approval' ? { ...base, status: 'waiting_approval' }
        : { ...base, status: 'queued', next_attempt_at: o.next_attempt_at }
      await svc.from('workflow_runs').update(patch).eq('id', runId)
    },
  }, limit)
}

const roleOf = (client: SupabaseClient, userId: string | null) => async (orgId: string): Promise<Role | null> => {
  if (!userId) return null
  const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle()
  return (data?.role as Role | undefined) ?? null
}

export function saveDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): SaveDeps {
  return {
    userId, getRole: roleOf(client, userId), knownTools: () => buildRegistry().list().map((t) => t.name),
    async save(w) {
      let id = w.workflow_id
      let version = 1
      if (id) {
        const cur = await svc.from('workflows').select('current_version').eq('id', id).eq('org_id', w.org_id).maybeSingle()
        if (!cur.data) return null
        version = (cur.data.current_version as number) + 1
      } else {
        const ins = await svc.from('workflows').insert({
          org_id: w.org_id, name: w.name, description: w.description, kind: w.kind, trigger_type: w.trigger_type,
          trigger_config: w.trigger_config, created_by: w.user_id, current_version: 1,
        }).select('id').single()
        if (ins.error) throw new Error(`create workflow: ${ins.error.message}`)
        id = ins.data.id as string
      }
      const v = await svc.from('workflow_versions').insert({ org_id: w.org_id, workflow_id: id, version, definition: w.definition, created_by: w.user_id })
      if (v.error) throw new Error(`save version: ${v.error.message}`)
      if (w.workflow_id) {
        const up = await svc.from('workflows').update({
          name: w.name, description: w.description, trigger_type: w.trigger_type, trigger_config: w.trigger_config, current_version: version,
        }).eq('id', id).eq('org_id', w.org_id)
        if (up.error) throw new Error(`update workflow: ${up.error.message}`)
      }
      return { id: id!, version }
    },
    audit: async (e) => { await svc.from('action_logs').insert(e) },
  }
}

export function runDeps(userId: string | null, client: SupabaseClient, svc: SupabaseClient): RunDeps {
  return {
    userId, getRole: roleOf(client, userId),
    async loadWorkflow(id) { return (await client.from('workflows').select('id, org_id, name').eq('id', id).maybeSingle()).data },
    async enqueue(workflowId, source, key) {
      const { data, error } = await svc.rpc('enqueue_workflow_run', { p_workflow: workflowId, p_source: source, p_key: key })
      if (error) throw new Error(`enqueue: ${error.message}`)
      return (data as string | null) ?? null
    },
    processNow: processNow(svc),
    async runStatus(runId) { return (await svc.from('workflow_runs').select('status, error').eq('id', runId).maybeSingle()).data },
    newKey: () => crypto.randomUUID(),
  }
}

/** Constant-time comparison so the cron secret can't be recovered through timing. */
export function secretsMatch(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export function tickDeps(svc: SupabaseClient, authorized: boolean): TickDeps {
  return {
    authorized, now: () => new Date(),
    async listScheduled() {
      const { data: wfs } = await svc.from('workflows').select('id, org_id, trigger_config').eq('enabled', true).eq('trigger_type', 'schedule')
      if (!wfs?.length) return []
      const { data: tz } = await svc.from('organization_settings').select('org_id, timezone').in('org_id', [...new Set(wfs.map((w) => w.org_id as string))])
      const zone = new Map((tz ?? []).map((t) => [t.org_id as string, t.timezone as string]))
      return wfs.filter((w) => typeof (w.trigger_config as { cron?: string })?.cron === 'string')
        .map((w) => ({ id: w.id as string, cron: (w.trigger_config as { cron: string }).cron, timezone: zone.get(w.org_id as string) ?? 'UTC' }))
    },
    async enqueue(id, source, key) { return ((await svc.rpc('enqueue_workflow_run', { p_workflow: id, p_source: source, p_key: key })).data as string | null) ?? null },
    async dispatchEvents() { return ((await svc.rpc('dispatch_workflow_events', { p_limit: 50 })).data as number) ?? 0 },
    async expireApprovals() { return ((await svc.rpc('expire_approvals')).data as number) ?? 0 },
    processNow: processNow(svc),
    ...notifyTickDeps(svc),
  }
}
