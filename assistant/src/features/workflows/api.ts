import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import { callFunction } from '@/features/assistant/api'
import type { Definition, Trigger } from '@core/workflow/definition'

export interface WorkflowRow {
  id: string; name: string; description: string | null; enabled: boolean; kind: 'custom' | 'daily_briefing'
  trigger_type: 'manual' | 'schedule' | 'event'; trigger_config: { cron?: string; event?: string }; current_version: number
  definition: Definition | null
}
export interface RunStep {
  step_key: string; step_type: string; status: string; attempt: number; error: string | null; output: unknown
  started_at: string | null; finished_at: string | null
}
export interface RunRow {
  id: string; workflow_id: string; status: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled'
  trigger_source: string; attempt: number; error: string | null; output: { text?: string | null } | null
  created_at: string; finished_at: string | null; workflow_steps: RunStep[]
}

const ACTIVE = ['queued', 'running', 'waiting_approval']

export function useWorkflows(orgId: string) {
  return useQuery({
    queryKey: ['workflows', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('workflows')
        .select('id, name, description, enabled, kind, trigger_type, trigger_config, current_version').eq('org_id', orgId).order('created_at')
      if (error) throw error
      const wfs = (data ?? []) as Omit<WorkflowRow, 'definition'>[]
      if (!wfs.length) return [] as WorkflowRow[]
      const v = await db().from('workflow_versions').select('workflow_id, version, definition').in('workflow_id', wfs.map((w) => w.id))
      if (v.error) throw v.error
      return wfs.map((w) => ({
        ...w, definition: ((v.data ?? []).find((x) => x.workflow_id === w.id && x.version === w.current_version)?.definition ?? null) as Definition | null,
      }))
    },
  })
}

export function useRuns(workflowId: string | null) {
  return useQuery({
    queryKey: ['workflow-runs', workflowId], enabled: !!workflowId,
    queryFn: async () => {
      const { data, error } = await db().from('workflow_runs')
        .select('id, workflow_id, status, trigger_source, attempt, error, output, created_at, finished_at, workflow_steps(step_key, step_type, status, attempt, error, output, started_at, finished_at)')
        .eq('workflow_id', workflowId!).order('created_at', { ascending: false }).limit(10)
      if (error) throw error
      return (data ?? []) as unknown as RunRow[]
    },
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.includes(r.status)) ? 4000 : false),
  })
}

export function useLatestBriefing(orgId: string) {
  return useQuery({
    queryKey: ['briefing', orgId],
    queryFn: async () => {
      const w = await db().from('workflows').select('id, enabled').eq('org_id', orgId).eq('kind', 'daily_briefing').maybeSingle()
      if (w.error) throw w.error
      if (!w.data) return { exists: false as const }
      const r = await db().from('workflow_runs').select('status, output, error, finished_at, created_at').eq('workflow_id', w.data.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (r.error) throw r.error
      return { exists: true as const, enabled: w.data.enabled as boolean, run: r.data as null | { status: string; output: { text?: string | null } | null; error: string | null; finished_at: string | null; created_at: string } }
    },
  })
}

export class SaveError extends Error { constructor(m: string, public errors: string[]) { super(m) } }

export function useSaveWorkflow(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { workflow_id?: string; name: string; description?: string; kind?: string; trigger: Trigger; definition: Definition }) => {
      try { return await callFunction<{ id: string; version: number }>('workflow-save', { org_id: orgId, ...v }) }
      catch (e) {
        const body = (e as { body?: { errors?: string[]; issues?: string[] } }).body
        throw new SaveError((e as Error).message, body?.errors ?? body?.issues ?? [])
      }
    },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['workflows'] }), qc.invalidateQueries({ queryKey: ['briefing'] })]),
  })
}

export function useRunNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (workflowId: string) => callFunction<{ run_id: string; status: string; error?: string }>('workflow-run', { workflow_id: workflowId }),
    onSettled: () => Promise.all(['workflow-runs', 'briefing', 'approvals-pending', 'notifications'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  })
}

export function useToggleWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; enabled: boolean }) => {
      const { error } = await db().from('workflows').update({ enabled: v.enabled }).eq('id', v.id)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['workflows'] }), qc.invalidateQueries({ queryKey: ['workflow-summary'] })]),
  })
}

export function useDeleteWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => { const { error } = await db().from('workflows').delete().eq('id', id); if (error) throw new Error(error.message) },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['workflows'] }), qc.invalidateQueries({ queryKey: ['workflow-summary'] })]),
  })
}
