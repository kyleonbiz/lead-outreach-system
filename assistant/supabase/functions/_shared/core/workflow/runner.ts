import { Definition } from './definition.ts'
import { advanceRun, type EngineDeps, type RunOutcome } from './engine.ts'

export interface ClaimedRun {
  id: string; org_id: string; workflow_id: string; version_id: string | null; attempt: number; event?: unknown
}

export interface RunnerDeps {
  /** atomically claims runnable runs (skip-locked + lease) */
  claim(limit: number): Promise<ClaimedRun[]>
  /** loads workflow name + definition for the claimed run; null if gone/disabled workflow deleted */
  load(run: ClaimedRun): Promise<{ workflowName: string; definition: unknown } | null>
  engineFor(run: ClaimedRun): Promise<EngineDeps>
  finalize(runId: string, o: RunOutcome | { status: 'failed'; error: string }): Promise<void>
}

export interface RunSummary { runId: string; status: string; error?: string }

/** Processes claimed runs one by one; one run's failure never prevents the others from running. */
export async function processRuns(d: RunnerDeps, limit = 3): Promise<RunSummary[]> {
  const out: RunSummary[] = []
  for (const run of await d.claim(limit)) {
    let outcome: RunOutcome
    let engine: EngineDeps | null = null
    try {
      const loaded = await d.load(run)
      if (!loaded) { outcome = { status: 'failed', error: 'The workflow no longer exists' } }
      else {
        const def = Definition.safeParse(loaded.definition)
        if (!def.success) outcome = { status: 'failed', error: 'The workflow definition is invalid and was not run' }
        else {
          engine = await d.engineFor(run)
          outcome = await advanceRun(engine, { id: run.id, workflowName: loaded.workflowName, definition: def.data, event: run.event })
        }
      }
    } catch (e) {
      console.error('workflow run crashed', run.id, e)
      outcome = { status: 'failed', error: 'The run stopped because of an unexpected error' }
      try { await engine?.notify({ type: 'workflow_failed', title: 'A workflow run failed unexpectedly', link: '/workflows' }) } catch { /* ignore */ }
    }
    await d.finalize(run.id, outcome)
    out.push({ runId: run.id, status: outcome.status, ...('error' in outcome ? { error: outcome.error } : {}) })
  }
  return out
}
