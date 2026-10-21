import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { cronMatches, parseCron, validateCron } from './cron.ts'
import { validateDefinition, Trigger } from './definition.ts'
import { evalCondition, getPath, resolveTemplates, TemplateError, type Scope } from './template.ts'
import { advanceRun, type EngineDeps, type RunInfo, type StepState, type WorkflowStore } from './engine.ts'
import { processRuns, type ClaimedRun } from './runner.ts'
import { DAILY_BRIEFING } from './templates.ts'
import { ScriptedProvider, text } from '../llm/fake.ts'
import { buildRegistry } from '../tools/index.ts'
import type { ToolDef } from '../tools/registry.ts'
import { MemoryStore, makeCtx, makePorts, ORG } from '../testkit.ts'
import { NotConfiguredError, ProviderError } from '../types.ts'

const allTools = () => buildRegistry().list().map((t) => t.name)

describe('cron', () => {
  it('validates and rejects malformed schedules with a reason', () => {
    expect(validateCron('0 8 * * 1-5')).toBeNull()
    expect(validateCron('*/15 9-17 * * *')).toBeNull()
    expect(validateCron('0 8 * *')).toMatch(/5 fields/)
    expect(validateCron('61 8 * * *')).toMatch(/minute.*out of range/)
    expect(validateCron('0 8 * * mon')).toMatch(/invalid segment/)
    expect(validateCron('*/0 * * * *')).toMatch(/step/)
  })
  it('matches in the org time zone (weekday 8am Chicago = 13:00Z in CDT, 14:00Z in CST)', () => {
    expect(cronMatches('0 8 * * 1-5', new Date('2026-10-21T13:00:00Z'), 'America/Chicago')).toBe(true)  // Wed, CDT
    expect(cronMatches('0 8 * * 1-5', new Date('2026-10-21T14:00:00Z'), 'America/Chicago')).toBe(false)
    expect(cronMatches('0 8 * * 1-5', new Date('2026-11-04T14:00:00Z'), 'America/Chicago')).toBe(true)  // Wed, CST
    expect(cronMatches('0 8 * * 1-5', new Date('2026-10-24T13:00:00Z'), 'America/Chicago')).toBe(false) // Saturday
  })
  it('supports lists, steps and the dom/dow OR rule; Sunday may be 0 or 7', () => {
    expect(cronMatches('*/15 * * * *', new Date('2026-10-21T13:45:00Z'), 'UTC')).toBe(true)
    expect(cronMatches('*/15 * * * *', new Date('2026-10-21T13:46:00Z'), 'UTC')).toBe(false)
    expect(cronMatches('0 9 1,15 * 1', new Date('2026-10-15T09:00:00Z'), 'UTC')).toBe(true)  // 15th (Thu): dom matches
    expect(cronMatches('0 9 1,15 * 1', new Date('2026-10-19T09:00:00Z'), 'UTC')).toBe(true)  // Monday: dow matches
    expect(cronMatches('0 9 1,15 * 1', new Date('2026-10-20T09:00:00Z'), 'UTC')).toBe(false)
    expect(cronMatches('0 9 * * 7', new Date('2026-10-25T09:00:00Z'), 'UTC')).toBe(true)
    expect('error' in parseCron('nope')).toBe(true)
  })
  it('trigger schema rejects an invalid cron', () => {
    expect(Trigger.safeParse({ type: 'schedule', cron: '0 8 * * 1-5' }).success).toBe(true)
    expect(Trigger.safeParse({ type: 'schedule', cron: 'every day' }).success).toBe(false)
    expect(Trigger.safeParse({ type: 'event', event: 'email.received' }).success).toBe(false)
  })
})

describe('definition validation (no code, only allow-listed steps and tools)', () => {
  const ok = { steps: [{ id: 'a', type: 'tool', tool: 'tasks.list', input: {} }, { id: 'b', type: 'notify', title: 'n {{steps.a.output}}' }] }
  it('accepts the built-in daily briefing', () => {
    expect(validateDefinition(DAILY_BRIEFING.definition, allTools()).ok).toBe(true)
  })
  it('rejects unknown step types (e.g. script/http/shell), unknown tools, duplicate ids and forward references', () => {
    expect(validateDefinition({ steps: [{ id: 'x', type: 'script', code: 'fetch(...)' }] }, allTools()).ok).toBe(false)
    expect(validateDefinition({ steps: [{ id: 'x', type: 'http', url: 'https://evil.test' }] }, allTools()).ok).toBe(false)
    const unknown = validateDefinition({ steps: [{ id: 'x', type: 'tool', tool: 'shell.exec' }] }, allTools())
    expect(unknown).toMatchObject({ ok: false, errors: [expect.stringMatching(/unknown tool "shell.exec"/)] })
    const dup = validateDefinition({ steps: [{ id: 'a', type: 'notify', title: 't' }, { id: 'a', type: 'notify', title: 't' }] }, allTools())
    expect(dup).toMatchObject({ ok: false, errors: [expect.stringMatching(/duplicate/)] })
    const fwd = validateDefinition({ steps: [{ id: 'a', type: 'notify', title: '{{steps.b.output}}' }, { id: 'b', type: 'notify', title: 't' }] }, allTools())
    expect(fwd).toMatchObject({ ok: false, errors: [expect.stringMatching(/not an earlier step/)] })
    const cond = validateDefinition({ steps: [{ id: 'a', type: 'notify', title: 't', when: { step: 'zzz', op: 'failed' } }] }, allTools())
    expect(cond.ok).toBe(false)
    expect(validateDefinition(ok, allTools()).ok).toBe(true)
  })
  it('enforces limits (1-25 steps, retry bounds, id format)', () => {
    expect(validateDefinition({ steps: [] }, allTools()).ok).toBe(false)
    expect(validateDefinition({ steps: Array.from({ length: 26 }, (_, i) => ({ id: `s${i}`, type: 'notify', title: 't' })) }, allTools()).ok).toBe(false)
    expect(validateDefinition({ steps: [{ id: 'a', type: 'notify', title: 't', retry: { max_attempts: 99 } }] }, allTools()).ok).toBe(false)
    expect(validateDefinition({ steps: [{ id: 'Bad-Id', type: 'notify', title: 't' }] }, allTools()).ok).toBe(false)
  })
})

describe('templates (data lookup only, nothing is evaluated)', () => {
  const scope: Scope = {
    steps: { a: { status: 'succeeded', output: { items: [{ n: 1 }], count: 3, text: 'hi' } } },
    time: { now: 'N', today_start: 'S', today_end: 'E', tomorrow_end: 'E2', date: '2026-10-21' }, org: { timezone: 'UTC' }, event: { id: 'e1' }, run: { id: 'r1' },
  }
  it('resolves whole-value refs with their type and interpolates inside strings', () => {
    expect(resolveTemplates({ n: '{{steps.a.output.count}}', t: 'got {{steps.a.output.text}} on {{time.date}}', l: '{{steps.a.output.items}}' }, scope))
      .toEqual({ n: 3, t: 'got hi on 2026-10-21', l: [{ n: 1 }] })
  })
  it('cannot reach prototypes or run code', () => {
    for (const bad of ['{{steps.a.output.__proto__}}', '{{steps.a.output.constructor}}', '{{constructor.constructor}}', '{{process.env.SECRET}}', '{{steps.zzz.output}}']) {
      expect(() => resolveTemplates(bad, scope)).toThrow(TemplateError)
    }
    expect(getPath({ a: 1 }, 'toString')).toBeUndefined()
  })
  it('evaluates structured conditions', () => {
    const c = (op: any, path?: string, value?: any) => evalCondition({ step: 'a', op, path, value }, scope)
    expect(c('succeeded')).toBe(true); expect(c('failed')).toBe(false)
    expect(c('gt', 'count', 2)).toBe(true); expect(c('lt', 'count', 2)).toBe(false)
    expect(c('not_empty', 'items')).toBe(true); expect(c('empty', 'missing')).toBe(true)
    expect(c('contains', 'text', 'h')).toBe(true); expect(c('eq', 'text', 'hi')).toBe(true)
  })
})

// -------------------------------------------------------------------------- engine
class MemWorkflowStore implements WorkflowStore {
  rows: Record<string, StepState> = {}
  async getSteps() { return structuredClone(this.rows) }
  async saveStep(_r: string, key: string, _t: string, patch: any) { this.rows[key] = { ...(this.rows[key] ?? { status: 'pending', attempt: 0 }), ...patch } }
}

function engine(over: Partial<EngineDeps> = {}, tools: ToolDef[] = [], ports = makePorts()) {
  const store = new MemWorkflowStore()
  const exec = new MemoryStore()
  const notes: any[] = []
  let now = new Date('2026-10-21T13:00:00Z')
  const d: EngineDeps = {
    store, execStore: exec, tools: buildRegistry(tools), policy: { auto_approve: [] }, ctx: makeCtx(ports, { actor: 'workflow', now: () => now }),
    provider: null, model: 'm', notify: async (n) => { notes.push(n) }, now: () => now, ...over,
  }
  return { d, store, exec, notes, ports, advance: (def: any, extra: Partial<RunInfo> = {}) => advanceRun(d, { id: 'run1', workflowName: 'Test WF', definition: def, ...extra }),
    setNow: (t: string) => { now = new Date(t) } }
}
const tool = (id: string, t: string, input: any = {}, extra: any = {}) => ({ id, type: 'tool', tool: t, input, on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 }, ...extra })
const D = (...steps: any[]) => ({ steps: steps.map((s) => ({ on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 }, ...s })) })

describe('engine', () => {
  it('runs steps in order, passing outputs through templates', async () => {
    const e = engine()
    e.ports.tasksMem.tasks.push({ id: 'aaaaaaaa-0000-4000-8000-000000000009', title: 'Old', status: 'todo' } as any)
    const r = await e.advance(D(
      tool('create', 'tasks.create', { title: 'Follow up on {{time.date}}' }),
      tool('list', 'tasks.list', {}),
      { id: 'tell', type: 'notify', title: 'Created', body: 'Task id {{steps.create.output.id}}' },
    ))
    expect(r.status).toBe('succeeded')
    expect(e.ports.tasksMem.tasks.some((t) => t.title === 'Follow up on 2026-10-21')).toBe(true)
    expect(e.notes[0].body).toMatch(/^Task id aaaaaaaa-/)
    expect(e.exec.logs.filter((l) => l.actor_type === 'workflow' && l.workflow_run_id === 'run1').length).toBeGreaterThanOrEqual(2)
  })

  it('skips steps whose condition is false', async () => {
    const e = engine()
    const r = await e.advance(D(tool('list', 'tasks.list', {}), tool('c', 'tasks.create', { title: 'only if tasks exist' }, { when: { step: 'list', op: 'not_empty' } })))
    expect(r.status).toBe('succeeded')
    expect(e.store.rows.c.status).toBe('skipped')
    expect(e.ports.tasksMem.tasks).toHaveLength(0)
  })

  it('a failing step stops the run, records the error and raises a failure notification', async () => {
    const boom: ToolDef = { name: 'x.boom', description: '', risk: 'read', input: z.object({}), summarize: () => 'boom', execute: async () => { throw new Error('kaboom') } }
    const e = engine({}, [boom])
    const r = await e.advance(D(tool('b', 'x.boom'), tool('after', 'tasks.create', { title: 'never' })))
    expect(r).toEqual({ status: 'failed', error: 'Step "b" failed: kaboom' })
    expect(e.store.rows.b).toMatchObject({ status: 'failed', error: 'kaboom' })
    expect(e.store.rows.after).toBeUndefined()
    expect(e.notes[0]).toMatchObject({ type: 'workflow_failed', body: expect.stringContaining('kaboom') })
  })

  it('on_failure=continue keeps going and the summary is told the section is unavailable', async () => {
    const provider = new ScriptedProvider([text('Briefing: calendar unavailable.')])
    const e = engine({ provider }) // calendar not connected in makePorts()
    const r = await e.advance(D(
      tool('agenda', 'calendar.list_events', { time_min: '{{time.today_start}}', time_max: '{{time.today_end}}' }, { on_failure: 'continue' }),
      tool('overdue', 'tasks.list', {}),
      { id: 'brief', type: 'summarize', instruction: 'brief me' },
    ))
    expect(r).toMatchObject({ status: 'succeeded', output: { text: 'Briefing: calendar unavailable.', steps: { agenda: 'failed', overdue: 'succeeded', brief: 'succeeded' } } })
    const prompt = (provider.requests[0].messages[0].content[0] as any).text as string
    expect(prompt).toMatch(/"status":"failed"/)
    expect(prompt).toMatch(/Google Calendar is not connected/)
    expect(prompt).toMatch(/<<<UNTRUSTED_DATA source="workflow_steps"/)
    expect(provider.requests[0].tools).toEqual([])
  })

  it('transient failures retry with exponential backoff, then succeed; permanent "not configured" does not retry', async () => {
    let calls = 0
    const flaky: ToolDef = { name: 'x.flaky', description: '', risk: 'read', input: z.object({}), summarize: () => 'f',
      execute: async () => { if (++calls < 3) throw new Error('503 upstream'); return { ok: true } } }
    const e = engine({}, [flaky])
    const def = D(tool('f', 'x.flaky', {}, { retry: { max_attempts: 3, backoff_seconds: 60 } }))
    const r1 = await e.advance(def)
    expect(r1).toMatchObject({ status: 'queued', next_attempt_at: '2026-10-21T13:01:00.000Z' })
    expect((await e.advance(def)).status).toBe('queued')                      // too early: waits, does not run
    expect(calls).toBe(1)
    e.setNow('2026-10-21T13:01:01Z')
    expect(await e.advance(def)).toMatchObject({ status: 'queued', next_attempt_at: '2026-10-21T13:03:01.000Z' }) // 2nd failure: 120s backoff
    e.setNow('2026-10-21T13:03:02Z')
    expect((await e.advance(def)).status).toBe('succeeded')
    expect(calls).toBe(3)

    const e2 = engine({})
    const r2 = await e2.advance(D(tool('m', 'email.search', { query: 'x' }, { retry: { max_attempts: 5, backoff_seconds: 60 } })))
    expect(r2.status).toBe('failed')   // calendar/mail not connected: no pointless retries
    expect(e2.store.rows.m.attempt).toBe(1)
  })

  it('a sensitive tool step is queued for approval (not executed), the run waits, and resumes after approval', async () => {
    const e = engine()
    e.ports.tasksMem.tasks.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old', status: 'todo' } as any)
    const def = D(tool('del', 'tasks.delete', { id: 'aaaaaaaa-0000-4000-8000-000000000001' }), { id: 'after', type: 'notify', title: 'done' })
    expect((await e.advance(def)).status).toBe('waiting_approval')
    expect(e.ports.tasksMem.tasks).toHaveLength(1)
    expect(e.exec.approvals[0]).toMatchObject({ action_type: 'tasks.delete' })
    expect(e.notes[0].type).toBe('approval_needed')
    expect((await e.advance(def)).status).toBe('waiting_approval')            // still waiting; no second approval
    expect(e.exec.approvals).toHaveLength(1)
    // approve handler executes the action and marks the step succeeded
    e.store.rows.del = { ...e.store.rows.del, status: 'succeeded', output: { deleted: true } }
    expect((await e.advance(def)).status).toBe('succeeded')
    expect(e.store.rows.after.status).toBe('succeeded')
  })

  it('a rejected approval fails the run (or is skipped past with on_failure=continue)', async () => {
    const e = engine()
    const def = D({ id: 'gate', type: 'approval', summary: 'Proceed with the mailing?' }, { id: 'send', type: 'notify', title: 'sent' })
    expect((await e.advance(def)).status).toBe('waiting_approval')
    expect(e.exec.approvals[0]).toMatchObject({ action_type: 'workflow.gate' })
    e.store.rows.gate = { ...e.store.rows.gate, status: 'failed', error: 'Rejected by the user' }
    expect(await e.advance(def)).toMatchObject({ status: 'failed' })
    expect(e.store.rows.send).toBeUndefined()
    const def2 = D({ id: 'gate', type: 'approval', summary: 's', on_failure: 'continue' }, { id: 'send', type: 'notify', title: 'sent' })
    const e2 = engine(); e2.store.rows.gate = { status: 'failed', attempt: 1, error: 'Rejected by the user' }
    expect((await e2.advance(def2)).status).toBe('succeeded')
  })

  it('at-most-once: a step interrupted mid-flight is NOT repeated after a crash', async () => {
    const e = engine()
    const def = D(tool('c', 'tasks.create', { title: 'charge the card once' }))
    // simulate: worker reserved attempt 1 (tool ran, effect happened), then died before saving 'succeeded'
    e.store.rows.c = { status: 'running', attempt: 1 }
    await e.exec.reserveAction({ idempotency_key: 'wf:run1:c:1' } as any)
    const r = await e.advance(def)
    expect(r.status).toBe('failed')
    expect(e.ports.tasksMem.tasks).toHaveLength(0)                            // not executed again
    expect(e.store.rows.c.error).toMatch(/may already have run/)
  })

  it('summarize without an AI provider fails honestly instead of inventing a summary', async () => {
    const e = engine({ provider: null })
    const r = await e.advance(D({ id: 's', type: 'summarize', instruction: 'x' }))
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/not configured/) })
  })

  it('summarize retries transient AI errors but fails on bad requests', async () => {
    const flaky = { name: 'p', complete: vi.fn().mockRejectedValueOnce(new ProviderError('overloaded', 'unavailable', 529)).mockResolvedValueOnce(text('ok')) }
    const e = engine({ provider: flaky as any })
    const def = D({ id: 's', type: 'summarize', instruction: 'x', retry: { max_attempts: 2, backoff_seconds: 30 } })
    expect((await e.advance(def)).status).toBe('queued')
    e.setNow('2026-10-21T13:01:00Z')
    expect((await e.advance(def)).status).toBe('succeeded')
    const bad = engine({ provider: { name: 'p', complete: async () => { throw new ProviderError('bad', 'bad_request', 400) } } as any })
    expect((await bad.advance(D({ id: 's', type: 'summarize', instruction: 'x', retry: { max_attempts: 3, backoff_seconds: 30 } }))).status).toBe('failed')
  })

  it('template errors and invalid tool input fail the step with a clear message', async () => {
    const e = engine()
    expect(await e.advance(D(tool('x', 'tasks.create', { title: '{{steps.nope.output}}' })))).toMatchObject({ status: 'failed', error: expect.stringMatching(/Template error/) })
    const e2 = engine()
    expect(await e2.advance(D(tool('x', 'tasks.create', { title: '' })))).toMatchObject({ status: 'failed', error: expect.stringMatching(/Invalid input for tasks.create/) })
    const e3 = engine()
    expect(await e3.advance(D(tool('x', 'no.such.tool')))).toMatchObject({ status: 'failed', error: expect.stringMatching(/Unknown tool/) })
  })

  it('event payload is available to templates', async () => {
    const e = engine()
    const r = await e.advance(D(tool('c', 'tasks.create', { title: 'Chase {{event.title}}' })), { event: { title: 'overdue invoice' } })
    expect(r.status).toBe('succeeded')
    expect(e.ports.tasksMem.tasks[0].title).toBe('Chase overdue invoice')
  })
})

describe('runner', () => {
  const claimed = (id: string): ClaimedRun => ({ id, org_id: ORG, workflow_id: 'w', version_id: 'v', attempt: 1 })
  it('processes runs independently: an invalid definition and a crash do not stop the next run; outcomes are finalized', async () => {
    const finals: Record<string, any> = {}
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = engine()
    const defs: Record<string, unknown> = { r1: { steps: [] }, r2: 'boom', r3: D(tool('l', 'tasks.list', {})) }
    const summary = await processRuns({
      claim: async () => [claimed('r1'), claimed('r2'), claimed('r3')],
      load: async (r) => (r.id === 'r2' ? (() => { throw new Error('db down') })() : { workflowName: 'W', definition: defs[r.id] }),
      engineFor: async () => e.d,
      finalize: async (id, o) => { finals[id] = o },
    })
    expect(finals.r1).toMatchObject({ status: 'failed', error: expect.stringMatching(/invalid/) })
    expect(finals.r2).toMatchObject({ status: 'failed', error: expect.stringMatching(/unexpected error/) })
    expect(finals.r3.status).toBe('succeeded')
    expect(summary.map((s) => s.status)).toEqual(['failed', 'failed', 'succeeded'])
    spy.mockRestore()
  })
  it('a deleted workflow fails its run', async () => {
    const finals: any[] = []
    await processRuns({ claim: async () => [claimed('r')], load: async () => null, engineFor: async () => engine().d, finalize: async (_i, o) => { finals.push(o) } })
    expect(finals[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/no longer exists/) })
  })
})

void NotConfiguredError
