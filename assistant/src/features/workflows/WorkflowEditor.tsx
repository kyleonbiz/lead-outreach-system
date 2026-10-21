import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button, Dialog, Field, Input, Notice, Select, Textarea } from '@/components/ui'
import { buildRegistry } from '@core/tools/index'
import { validateDefinition, EVENT_TYPES, type Step, type Trigger } from '@core/workflow/definition'
import { validateCron } from '@core/workflow/cron'
import { CRON_PRESETS } from './describe'
import { SaveError, useSaveWorkflow, type WorkflowRow } from './api'

const TOOLS = buildRegistry().list().map((t) => ({ name: t.name, risk: t.risk }))
const RETRY = { max_attempts: 1, backoff_seconds: 60 }

type DraftStep = {
  id: string; type: Step['type']; label: string; tool: string; inputJson: string; instruction: string; summary: string
  title: string; body: string; on_failure: 'stop' | 'continue'; attempts: number
}

const blank = (n: number, type: Step['type'] = 'tool'): DraftStep => ({
  id: `step${n}`, type, label: '', tool: 'tasks.list', inputJson: '{}', instruction: '', summary: '', title: '', body: '', on_failure: 'stop', attempts: 1,
})

function fromDefinition(w: WorkflowRow | null): DraftStep[] {
  if (!w?.definition) return [blank(1)]
  return w.definition.steps.map((s) => ({
    ...blank(0, s.type), id: s.id, label: s.label ?? '', on_failure: s.on_failure, attempts: s.retry.max_attempts,
    ...(s.type === 'tool' ? { tool: s.tool, inputJson: JSON.stringify(s.input, null, 2) } : {}),
    ...(s.type === 'summarize' ? { instruction: s.instruction } : {}),
    ...(s.type === 'approval' ? { summary: s.summary } : {}),
    ...(s.type === 'notify' ? { title: s.title, body: s.body } : {}),
  }))
}

function toStep(d: DraftStep): unknown {
  const base = { id: d.id, ...(d.label ? { label: d.label } : {}), on_failure: d.on_failure, retry: { ...RETRY, max_attempts: d.attempts } }
  switch (d.type) {
    case 'tool': return { ...base, type: 'tool', tool: d.tool, input: JSON.parse(d.inputJson || '{}') }
    case 'summarize': return { ...base, type: 'summarize', instruction: d.instruction }
    case 'approval': return { ...base, type: 'approval', summary: d.summary }
    case 'notify': return { ...base, type: 'notify', title: d.title, body: d.body }
  }
}

export function WorkflowEditor({ orgId, workflow, open, onClose }: { orgId: string; workflow: WorkflowRow | null; open: boolean; onClose: () => void }) {
  const save = useSaveWorkflow(orgId)
  const [steps, setSteps] = useState<DraftStep[]>(() => fromDefinition(workflow))
  const [triggerType, setTriggerType] = useState<Trigger['type']>(workflow?.trigger_type ?? 'manual')
  const [cron, setCron] = useState(workflow?.trigger_config.cron ?? '0 8 * * 1-5')
  const [event, setEvent] = useState(workflow?.trigger_config.event ?? EVENT_TYPES[0])
  const [errors, setErrors] = useState<string[]>([])

  const patch = (i: number, p: Partial<DraftStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const move = (i: number, d: number) => setSteps((s) => { const a = [...s]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a })
  const cronError = triggerType === 'schedule' ? validateCron(cron) : null

  function submit(f: FormData) {
    let definition
    try { definition = { steps: steps.map(toStep) } } catch { setErrors(['One of the step inputs is not valid JSON.']); return }
    const trigger: Trigger = triggerType === 'schedule' ? { type: 'schedule', cron } : triggerType === 'event' ? { type: 'event', event: event as (typeof EVENT_TYPES)[number] } : { type: 'manual' }
    const v = validateDefinition(definition, TOOLS.map((t) => t.name))
    if (!v.ok) { setErrors(v.errors); return }
    if (cronError) { setErrors([`Schedule: ${cronError}`]); return }
    setErrors([])
    save.mutate({ workflow_id: workflow?.id, name: String(f.get('name')).trim(), description: String(f.get('description') ?? ''), kind: workflow?.kind, trigger, definition: v.def }, {
      onSuccess: onClose, onError: (e) => setErrors(e instanceof SaveError && e.errors.length ? e.errors : [e.message]),
    })
  }

  return (
    <Dialog open={open} onClose={onClose} title={workflow ? 'Edit workflow' : 'New workflow'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="wf-form" variant="primary" loading={save.isPending}>Save workflow</Button></>}>
      <form id="wf-form" className="space-y-5" onSubmit={(e) => { e.preventDefault(); submit(new FormData(e.currentTarget)) }}>
        <Field label="Name">{(id) => <Input id={id} name="name" required maxLength={200} defaultValue={workflow?.name} />}</Field>
        <Field label="Description">{(id) => <Input id={id} name="description" maxLength={1000} defaultValue={workflow?.description ?? ''} />}</Field>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">When should it run?</legend>
          <Select aria-label="Trigger" value={triggerType} onChange={(e) => setTriggerType(e.target.value as Trigger['type'])}>
            <option value="manual">Only when I run it</option><option value="schedule">On a schedule</option><option value="event">When something happens</option>
          </Select>
          {triggerType === 'schedule' && (
            <div className="space-y-2">
              <Select aria-label="Schedule preset" value="" onChange={(e) => e.target.value && setCron(e.target.value)}>
                <option value="">Pick a preset…</option>{CRON_PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
              </Select>
              <Input aria-label="Cron expression" value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" />
              <p className={cronError ? 'text-xs text-danger' : 'text-xs text-muted'}>{cronError ?? 'minute hour day-of-month month day-of-week — evaluated in your organization time zone.'}</p>
            </div>
          )}
          {triggerType === 'event' && (
            <Select aria-label="Event" value={event} onChange={(e) => setEvent(e.target.value as typeof event)}>
              <option value="task.overdue">A task becomes overdue</option><option value="document.ready">A document finishes processing</option>
            </Select>
          )}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Steps</legend>
          <p className="text-xs text-muted">Steps run in order. Later steps can use earlier results, e.g. <code className="font-mono">{'{{steps.step1.output}}'}</code>. Actions that send, delete or change things always ask for approval.</p>
          {steps.map((s, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="w-6 text-sm text-muted">{i + 1}.</span>
                <Select aria-label={`Step ${i + 1} type`} value={s.type} onChange={(e) => patch(i, { type: e.target.value as Step['type'] })} className="flex-1">
                  <option value="tool">Run a tool</option><option value="summarize">Write a summary (AI)</option>
                  <option value="approval">Ask for approval</option><option value="notify">Send me a notification</option>
                </Select>
                <Input aria-label={`Step ${i + 1} id`} value={s.id} onChange={(e) => patch(i, { id: e.target.value })} className="w-28 font-mono text-xs" />
                <Button variant="ghost" type="button" aria-label="Move up" onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button variant="ghost" type="button" aria-label="Move down" onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                <Button variant="ghost" type="button" aria-label="Remove step" disabled={steps.length === 1} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
              {s.type === 'tool' && (<>
                <Select aria-label={`Step ${i + 1} tool`} value={s.tool} onChange={(e) => patch(i, { tool: e.target.value })}>
                  {TOOLS.map((t) => <option key={t.name} value={t.name}>{t.name}{t.risk === 'sensitive' ? ' (needs approval)' : ''}</option>)}
                </Select>
                <Textarea aria-label={`Step ${i + 1} input`} value={s.inputJson} onChange={(e) => patch(i, { inputJson: e.target.value })} rows={3} className="font-mono text-xs" />
              </>)}
              {s.type === 'summarize' && <Textarea aria-label={`Step ${i + 1} instruction`} value={s.instruction} onChange={(e) => patch(i, { instruction: e.target.value })} rows={3} placeholder="What should the summary cover?" />}
              {s.type === 'approval' && <Input aria-label={`Step ${i + 1} approval text`} value={s.summary} onChange={(e) => patch(i, { summary: e.target.value })} placeholder="What are you asking permission for?" />}
              {s.type === 'notify' && (<>
                <Input aria-label={`Step ${i + 1} title`} value={s.title} onChange={(e) => patch(i, { title: e.target.value })} placeholder="Title" />
                <Input aria-label={`Step ${i + 1} body`} value={s.body} onChange={(e) => patch(i, { body: e.target.value })} placeholder="Message (optional)" />
              </>)}
              <div className="flex flex-wrap gap-3">
                <Select aria-label={`Step ${i + 1} on failure`} value={s.on_failure} onChange={(e) => patch(i, { on_failure: e.target.value as 'stop' | 'continue' })} className="w-52">
                  <option value="stop">If it fails: stop the workflow</option><option value="continue">If it fails: keep going</option>
                </Select>
                <Select aria-label={`Step ${i + 1} attempts`} value={s.attempts} onChange={(e) => patch(i, { attempts: Number(e.target.value) })} className="w-40">
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 1 ? 'No retries' : `Up to ${n} attempts`}</option>)}
                </Select>
              </div>
            </div>
          ))}
          <Button type="button" onClick={() => setSteps((s) => [...s, blank(s.length + 1)])}><Plus className="h-4 w-4" /> Add step</Button>
        </fieldset>

        {errors.length > 0 && <Notice tone="danger" title="Fix these before saving"><ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Notice>}
      </form>
    </Dialog>
  )
}
