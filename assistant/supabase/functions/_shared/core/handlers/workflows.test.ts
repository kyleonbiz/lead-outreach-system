import { describe, expect, it, vi } from 'vitest'
import { handleTick, handleWorkflowRun, handleWorkflowSave, type RunDeps, type SaveDeps, type TickDeps } from './workflows.ts'
import { handleDecision, type ApproveDeps, type ApprovalRow } from './approve.ts'
import { buildRegistry } from '../tools/index.ts'
import { DAILY_BRIEFING } from '../workflow/templates.ts'
import { MemoryStore, ORG, USER, makeCtx, makePorts } from '../testkit.ts'

const ORG2 = '33333333-3333-4333-8333-333333333333'
const WF = 'aaaa0000-0000-4000-8000-000000000001'
const tools = () => buildRegistry().list().map((t) => t.name)

function saveDeps(o: Partial<SaveDeps> = {}) {
  const saved: any[] = []; const audits: any[] = []
  const d: SaveDeps = {
    userId: USER, getRole: async (org) => (org === ORG ? 'admin' : null), knownTools: tools,
    save: async (w) => { saved.push(w); return { id: WF, version: 1 } }, audit: async (e) => { audits.push(e) }, ...o,
  }
  return { d, saved, audits }
}
const body = (o: any = {}) => ({ org_id: ORG, name: 'Daily', trigger: { type: 'manual' }, definition: { steps: [{ id: 'a', type: 'notify', title: 'hi' }] }, ...o })

describe('workflow-save', () => {
  it('401 / 400 / 403 for anonymous, malformed and non-admin callers — nothing is written', async () => {
    for (const [o, status] of [[{ userId: null }, 401], [{ getRole: async () => 'member' as const }, 403], [{ getRole: async () => null }, 403]] as const) {
      const { d, saved } = saveDeps(o as any)
      expect((await handleWorkflowSave(d, body())).status).toBe(status)
      expect(saved).toHaveLength(0)
    }
    expect((await handleWorkflowSave(saveDeps().d, { org_id: 'x' })).status).toBe(400)
    expect((await handleWorkflowSave(saveDeps().d, body({ trigger: { type: 'schedule', cron: 'nonsense' } }))).status).toBe(400)
  })
  it('422 with specific errors for invalid definitions: scripts, unknown tools, forward references', async () => {
    const { d, saved } = saveDeps()
    for (const definition of [
      { steps: [{ id: 'x', type: 'script', code: 'process.exit()' }] },
      { steps: [{ id: 'x', type: 'tool', tool: 'shell.exec', input: {} }] },
      { steps: [{ id: 'a', type: 'notify', title: '{{steps.b.output}}' }, { id: 'b', type: 'notify', title: 'x' }] },
    ]) {
      const r = await handleWorkflowSave(d, body({ definition }))
      expect(r.status).toBe(422)
      expect((r.body.errors as string[]).length).toBeGreaterThan(0)
    }
    expect(saved).toHaveLength(0)
  })
  it('saves a valid definition with normalized defaults, the trigger config, and an audit entry', async () => {
    const { d, saved, audits } = saveDeps()
    const r = await handleWorkflowSave(d, body({ ...DAILY_BRIEFING, org_id: ORG, kind: 'daily_briefing' }))
    expect(r).toMatchObject({ status: 200, body: { id: WF, version: 1 } })
    expect(saved[0]).toMatchObject({ kind: 'daily_briefing', trigger_type: 'schedule', trigger_config: { cron: '0 8 * * 1-5' }, user_id: USER })
    expect(saved[0].definition.steps[0].retry).toEqual({ max_attempts: 2, backoff_seconds: 60 })
    expect(audits[0]).toMatchObject({ action: 'workflow.created', category: 'audit' })
  })
  it('404 when updating a workflow that is not in that org', async () => {
    const { d } = saveDeps({ save: async () => null })
    expect((await handleWorkflowSave(d, body({ workflow_id: WF }))).status).toBe(404)
  })
})

describe('workflow-run (manual)', () => {
  const runDeps = (o: Partial<RunDeps> = {}): RunDeps & { enq: any } => {
    const enq = vi.fn(async () => 'run-1')
    return { userId: USER, getRole: async () => 'owner', loadWorkflow: async (id) => (id === WF ? { id, org_id: ORG, name: 'W' } : null),
      enqueue: enq, processNow: async () => [], runStatus: async () => ({ status: 'succeeded', error: null }), newKey: () => 'k', enq, ...o }
  }
  it('enqueues with a unique manual key, processes, and reports the real status', async () => {
    const d = runDeps()
    expect(await handleWorkflowRun(d, { workflow_id: WF })).toMatchObject({ status: 200, body: { run_id: 'run-1', status: 'succeeded' } })
    expect(d.enq).toHaveBeenCalledWith(WF, 'manual', 'manual:k')
  })
  it('reports failures honestly; 403 for members, 404 for invisible workflows, 401 anonymous', async () => {
    expect((await handleWorkflowRun(runDeps({ runStatus: async () => ({ status: 'failed', error: 'Step "a" failed: x' }) }), { workflow_id: WF })).body).toMatchObject({ status: 'failed', error: expect.stringContaining('failed') })
    const m = runDeps({ getRole: async () => 'member' })
    expect((await handleWorkflowRun(m, { workflow_id: WF })).status).toBe(403)
    expect(m.enq).not.toHaveBeenCalled()
    expect((await handleWorkflowRun(runDeps(), { workflow_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(404)
    expect((await handleWorkflowRun(runDeps({ userId: null }), { workflow_id: WF })).status).toBe(401)
  })
})

describe('workflow-tick', () => {
  const tick = (o: Partial<TickDeps> = {}) => {
    const enq = vi.fn(async (_w: string, _s: string, _k: string): Promise<string | null> => 'r')
    const d: TickDeps = {
      authorized: true, now: () => new Date('2026-10-21T13:00:20Z'),
      listScheduled: async () => [{ id: 'w1', cron: '0 8 * * 1-5', timezone: 'America/Chicago' }, { id: 'w2', cron: '30 9 * * *', timezone: 'UTC' }],
      enqueue: enq, dispatchEvents: async () => 2, expireApprovals: async () => 1, processNow: async () => [{ runId: 'r', status: 'succeeded' }], ...o,
    }
    return { d, enq }
  }
  it('rejects unauthenticated callers before doing anything', async () => {
    const { d, enq } = tick({ authorized: false })
    expect((await handleTick(d)).status).toBe(401)
    expect(enq).not.toHaveBeenCalled()
  })
  it('enqueues exactly the due schedules with deterministic keys, dispatches events and processes runs', async () => {
    const { d, enq } = tick()
    const r = await handleTick(d)
    expect(enq.mock.calls).toEqual([['w1', 'schedule', 'sched:w1:202610210800']])   // 08:00 Chicago = 13:00Z
    expect(r.body).toMatchObject({ scheduled: 1, from_events: 2, expired_approvals: 1, processed: 1 })
  })
  it('catches up after a delayed tick (lookback) and is safe to repeat: duplicates are rejected by key', async () => {
    const { d, enq } = tick({ now: () => new Date('2026-10-21T13:03:10Z') })   // tick arrived 3 minutes late
    await handleTick(d)
    expect(enq.mock.calls.map((c) => c[2])).toEqual(['sched:w1:202610210800'])
    const dup = tick({ now: () => new Date('2026-10-21T13:03:10Z'), enqueue: vi.fn(async (_w: string, _s: string, _k: string): Promise<string | null> => null) })
    expect((await handleTick(dup.d)).body.scheduled).toBe(0)                    // key already used -> nothing new
  })
  it('does not fire outside the lookback window or on non-matching days', async () => {
    expect((await handleTick(tick({ now: () => new Date('2026-10-21T13:10:00Z') }).d)).body.scheduled).toBe(0)
    expect((await handleTick(tick({ now: () => new Date('2026-10-24T13:00:00Z') }).d)).body.scheduled).toBe(0) // Saturday
  })
})

describe('approvals that resume workflows', () => {
  const ROW = (o: Partial<ApprovalRow> = {}): ApprovalRow => ({
    id: '66666666-6666-4666-8666-666666666666', org_id: ORG, action_type: 'tasks.delete', status: 'pending', summary: 'Daily: Permanently delete task',
    requested_by: null, conversation_id: null, payload: { id: 'aaaaaaaa-0000-4000-8000-000000000001' }, expires_at: '2099-01-01T00:00:00Z',
    workflow_run_id: 'run-9', workflow_step_key: 'del', ...o,
  })
  function setup(row: ApprovalRow) {
    const store = new MemoryStore(); const ports = makePorts()
    ports.tasksMem.tasks.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old' } as any)
    const resumed: any[] = []; const actors: any[] = []
    const d: ApproveDeps = {
      userId: USER, now: () => new Date('2026-10-21T15:00:00Z'), getRole: async () => 'owner', loadApproval: async () => row,
      decide: async () => true, claim: async () => true, finish: async () => {},
      runtime: async (_o, actor) => { actors.push(actor); return { store, tools: buildRegistry(), ctx: makeCtx(ports) } },
      appendMessage: async () => {}, resumeWorkflow: async (_r, r) => { resumed.push(r) },
    }
    return { d, resumed, actors, ports }
  }
  const req = (decision: string) => ({ approval_id: '66666666-6666-4666-8666-666666666666', decision })

  it('approving a workflow tool step executes it (attributed to the workflow) and resumes the run with the output', async () => {
    const { d, resumed, actors, ports } = setup(ROW())
    expect((await handleDecision(d, req('approved'))).body.status).toBe('executed')
    expect(ports.tasksMem.tasks).toHaveLength(0)
    expect(actors).toEqual(['workflow'])
    expect(resumed).toEqual([{ status: 'succeeded', output: { deleted: true, id: 'aaaaaaaa-0000-4000-8000-000000000001' } }])
  })
  it('rejecting resumes the run as FAILED without executing anything', async () => {
    const { d, resumed, ports } = setup(ROW())
    await handleDecision(d, req('rejected'))
    expect(ports.tasksMem.tasks).toHaveLength(1)
    expect(resumed).toEqual([{ status: 'failed', error: 'Rejected by the user' }])
  })
  it('an approval gate runs nothing, just releases the workflow', async () => {
    const { d, resumed, actors } = setup(ROW({ action_type: 'workflow.gate', payload: { step: 'gate' }, workflow_step_key: 'gate' }))
    expect((await handleDecision(d, req('approved'))).body.status).toBe('executed')
    expect(actors).toEqual([])
    expect(resumed).toEqual([{ status: 'succeeded', output: null }])
  })
  it('a failing approved step resumes the run as failed with the real error', async () => {
    const { d, resumed } = setup(ROW({ payload: { id: 'aaaaaaaa-0000-4000-8000-0000000000ff' } }))
    expect((await handleDecision(d, req('approved'))).body.status).toBe('failed')
    expect(resumed[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/not found/) })
  })
})

void ORG2
