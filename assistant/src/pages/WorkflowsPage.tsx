import { useState } from 'react'
import { format } from 'date-fns'
import { Bell, Plus, Play, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import { Badge, Button, EmptyState, Notice, PageHeader, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useOrg } from '@/features/org/OrgProvider'
import {
  useDeleteWorkflow, useRunNow, useRuns, useSaveWorkflow, useToggleWorkflow, useWorkflows, type RunRow, type WorkflowRow,
} from '@/features/workflows/api'
import { describeTrigger } from '@/features/workflows/describe'
import { WorkflowEditor } from '@/features/workflows/WorkflowEditor'
import { DAILY_BRIEFING } from '@core/workflow/templates'

const runTone = { queued: 'neutral', running: 'warn', waiting_approval: 'warn', succeeded: 'ok', failed: 'danger', cancelled: 'neutral' } as const
const runLabel = { queued: 'Queued', running: 'Running', waiting_approval: 'Waiting for approval', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' } as const
const stepTone: Record<string, 'neutral' | 'ok' | 'danger' | 'warn'> = { succeeded: 'ok', failed: 'danger', waiting_approval: 'warn', running: 'warn', skipped: 'neutral', pending: 'neutral' }
const icons = { tool: Wrench, summarize: Sparkles, approval: ShieldCheck, notify: Bell }

export default function WorkflowsPage() {
  const { orgId, isAdmin } = useOrg()
  const wfs = useWorkflows(orgId)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<WorkflowRow | 'new' | null>(null)
  const save = useSaveWorkflow(orgId)
  const current = wfs.data?.find((w) => w.id === selected) ?? wfs.data?.[0] ?? null
  const hasBriefing = wfs.data?.some((w) => w.kind === 'daily_briefing')

  return (
    <>
      <PageHeader title="Workflows" description="Repeatable routines the assistant runs for you, on a schedule or when something happens. Sensitive steps always wait for your approval."
        actions={isAdmin ? <>
          {!hasBriefing && <Button loading={save.isPending} onClick={() => save.mutate({ name: DAILY_BRIEFING.name, description: DAILY_BRIEFING.description, kind: 'daily_briefing', trigger: DAILY_BRIEFING.trigger, definition: DAILY_BRIEFING.definition })}>Set up daily briefing</Button>}
          <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New workflow</Button>
        </> : undefined} />
      {!isAdmin && <div className="mb-4"><Notice>Only owners and admins can create, edit or run workflows.</Notice></div>}
      {save.isError && <div className="mb-4"><Notice tone="danger" title="Couldn't save">{(save.error as Error).message}</Notice></div>}
      {wfs.isLoading && <Spinner />}
      {wfs.isError && <Notice tone="danger">{(wfs.error as Error).message}</Notice>}
      {wfs.data?.length === 0 && <EmptyState title="No workflows yet">Start with the daily briefing, or build your own. New workflows are switched off until you enable them.</EmptyState>}

      {!!wfs.data?.length && current && (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <ul className="space-y-1">
            {wfs.data.map((w) => (
              <li key={w.id}>
                <button onClick={() => setSelected(w.id)} className={cn('w-full rounded-lg border px-3 py-2.5 text-left', w.id === current.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken')}>
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-xs text-muted"><Badge tone={w.enabled ? 'ok' : 'neutral'}>{w.enabled ? 'On' : 'Off'}</Badge><span className="truncate">{describeTrigger(w)}</span></span>
                </button>
              </li>
            ))}
          </ul>
          <Detail wf={current} isAdmin={isAdmin} onEdit={() => setEditing(current)} />
        </div>
      )}
      {editing && <WorkflowEditor key={editing === 'new' ? 'new' : editing.id + editing.current_version} orgId={orgId} workflow={editing === 'new' ? null : editing} open onClose={() => setEditing(null)} />}
    </>
  )
}

function Detail({ wf, isAdmin, onEdit }: { wf: WorkflowRow; isAdmin: boolean; onEdit: () => void }) {
  const runs = useRuns(wf.id)
  const run = useRunNow()
  const toggle = useToggleWorkflow()
  const del = useDeleteWorkflow()
  const [confirm, setConfirm] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  return (
    <section className="min-w-0 space-y-5">
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{wf.name}</h2>
            {wf.description && <p className="mt-0.5 text-sm text-muted">{wf.description}</p>}
            <p className="mt-1 text-xs text-muted">{describeTrigger(wf)} · version {wf.current_version}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={wf.enabled} disabled={!isAdmin || toggle.isPending} onChange={(e) => toggle.mutate({ id: wf.id, enabled: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
            {wf.enabled ? 'Enabled' : 'Disabled'}
          </label>
        </div>
        {toggle.isError && <div className="mt-3"><Notice tone="danger">{(toggle.error as Error).message}</Notice></div>}
        {run.isError && <div className="mt-3"><Notice tone="danger">{(run.error as Error).message}</Notice></div>}
        {run.data?.status === 'failed' && <div className="mt-3"><Notice tone="danger" title="Run failed">{run.data.error}</Notice></div>}
        {run.data?.status === 'waiting_approval' && <div className="mt-3"><Notice tone="warn" title="Waiting for your approval">Approve it from the dashboard to continue.</Notice></div>}
        {isAdmin && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={run.isPending} onClick={() => run.mutate(wf.id)}><Play className="h-4 w-4" /> Run now</Button>
            <Button onClick={onEdit}>Edit</Button>
            {confirm ? <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(wf.id)}>Confirm delete</Button> : <Button variant="ghost" onClick={() => setConfirm(true)}>Delete</Button>}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold">Steps</h3>
        <ol className="relative space-y-2 border-l border-line pl-5">
          {wf.definition?.steps.map((s, i) => {
            const Icon = icons[s.type]
            return (
              <li key={s.id} className="relative rounded-lg border border-line bg-surface px-3.5 py-2.5">
                <span className="absolute -left-[1.62rem] top-3.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-[10px] font-semibold text-accent-ink" aria-hidden>{i + 1}</span>
                <p className="flex items-center gap-2 text-sm font-medium"><Icon className="h-3.5 w-3.5 text-muted" aria-hidden />{s.label ?? s.id}</p>
                <p className="mt-0.5 break-words text-xs text-muted">
                  {s.type === 'tool' && <code className="font-mono">{s.tool}</code>}
                  {s.type === 'summarize' && 'AI-written summary'}{s.type === 'approval' && `Waits for approval: ${s.summary}`}{s.type === 'notify' && `Notifies: ${s.title}`}
                  {s.when && ` · only if ${s.when.step} ${s.when.op.replace('_', ' ')}`}
                  {s.retry.max_attempts > 1 && ` · up to ${s.retry.max_attempts} attempts`}
                  {s.on_failure === 'continue' && ' · continues if it fails'}
                </p>
              </li>
            )
          }) ?? <li className="text-sm text-muted">No definition.</li>}
        </ol>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold">Recent runs</h3>
        {runs.isLoading && <Spinner />}
        {runs.data?.length === 0 && <p className="text-sm text-muted">No runs yet.</p>}
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {runs.data?.map((r: RunRow) => (
            <li key={r.id} className="px-4 py-3">
              <button className="flex w-full items-center gap-3 text-left" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                <Badge tone={runTone[r.status]}>{runLabel[r.status]}</Badge>
                <span className="flex-1 text-sm">{format(new Date(r.created_at), 'MMM d, h:mm a')} <span className="text-xs text-muted">· {r.trigger_source}</span></span>
              </button>
              {r.error && <p className="mt-1.5 text-xs text-danger">{r.error}</p>}
              {open === r.id && (
                <div className="mt-3 space-y-2">
                  {r.output?.text && <pre className="whitespace-pre-wrap break-words rounded bg-sunken p-3 font-sans text-sm">{r.output.text}</pre>}
                  <ul className="space-y-1">
                    {[...r.workflow_steps].sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '')).map((s) => (
                      <li key={s.step_key} className="text-xs">
                        <Badge tone={stepTone[s.status] ?? 'neutral'}>{s.status.replace('_', ' ')}</Badge> <span className="font-mono">{s.step_key}</span>
                        {s.attempt > 1 && <span className="text-muted"> · attempt {s.attempt}</span>}
                        {s.error && <span className="text-danger"> — {s.error}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
