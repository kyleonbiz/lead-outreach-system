// Cross-module tests: real handlers + engine + orchestrator wired to in-memory ports.
import { describe, expect, it } from 'vitest'
import { handleChat, type ChatDeps } from './handlers/chat.ts'
import { handleDecision, type ApprovalRow, type ApproveDeps } from './handlers/approve.ts'
import { handleDisconnect, handleOAuthStart, type DisconnectDeps, type StartDeps } from './handlers/oauth.ts'
import { handleProviderData, type ProviderDataDeps } from './handlers/providerData.ts'
import { handleDocumentProcess, type DocumentProcessDeps } from './handlers/documentProcess.ts'
import { handleTick, handleWorkflowRun, handleWorkflowSave, type RunDeps, type SaveDeps, type TickDeps } from './handlers/workflows.ts'
import type { Role } from './handlers/common.ts'
import { buildRegistry } from './tools/index.ts'
import { ScriptedProvider, text, toolUse } from './llm/fake.ts'
import { MemoryStore, ORG, USER, makeCtx, makePorts } from './testkit.ts'
import { advanceRun, type EngineDeps, type StepState, type WorkflowStore } from './workflow/engine.ts'
import { processRuns, type ClaimedRun } from './workflow/runner.ts'
import { DAILY_BRIEFING } from './workflow/templates.ts'
import type { Definition } from './workflow/definition.ts'
import type { LLMMessage } from './types.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OTHER_ORG = U(99)
const CONV = U(5), APPROVAL = U(6), INTEG = U(7), DOC = U(8), WF = U(9)

type Who = 'anonymous' | 'outsider' | 'member' | 'admin' | 'owner'
const WHO: Who[] = ['anonymous', 'outsider', 'member', 'admin', 'owner']
const uid = (w: Who) => (w === 'anonymous' ? null : USER)
const role = (w: Who): Role | null => (w === 'anonymous' || w === 'outsider' ? null : w)
const getRole = (w: Who) => async (org: string): Promise<Role | null> => (org === ORG ? role(w) : null)

// Each endpoint: [name, status expected for every kind of caller, a way to call it].
// An "outsider" (signed in, but not in this org) must never learn whether a resource exists, so wherever a row
// would have been read with the caller's own token (RLS), they get 404, not 403.
type Call = (w: Who) => Promise<number>
const matrix: Array<[string, Record<Who, number>, Call]> = [
  ['assistant-chat', { anonymous: 401, outsider: 403, member: 200, admin: 200, owner: 200 }, async (w) => {
    const provider = new ScriptedProvider([text('hi')]); const store = new MemoryStore()
    const d: ChatDeps = {
      userId: uid(w), now: () => new Date(), rateLimit: { max: 5, windowMs: 60_000 }, getRole: getRole(w), recentUserMessageTimes: async () => [],
      dailyTokenLimit: 0, tokensUsedToday: async () => 0, missingConfig: () => [], loadOrg: async () => ({ orgName: 'A', timezone: 'UTC', model: null, policy: {} }),
      createConversation: async () => CONV, loadHistory: async () => [],
      makeRunner: async () => ({ provider, model: 'm', tools: buildRegistry(), store, policy: { auto_approve: [] }, ctx: makeCtx(makePorts()) }),
    }
    return (await handleChat(d, { org_id: ORG, message: 'hello' })).status
  }],
  ['assistant-approve', { anonymous: 401, outsider: 404, member: 200, admin: 200, owner: 200 }, async (w) => {
    const row: ApprovalRow = { id: APPROVAL, org_id: ORG, action_type: 'workflow.gate', status: 'pending', summary: 's', requested_by: null, conversation_id: null, payload: {}, expires_at: '2099-01-01T00:00:00Z' }
    const d: ApproveDeps = {
      userId: uid(w), now: () => new Date(), getRole: getRole(w), loadApproval: async () => (w === 'outsider' ? null : row),
      decide: async () => true, claim: async () => true, finish: async () => {}, runtime: async () => ({ store: new MemoryStore(), tools: buildRegistry(), ctx: makeCtx(makePorts()) }), appendMessage: async () => {},
    }
    return (await handleDecision(d, { approval_id: APPROVAL, decision: 'approved' })).status
  }],
  ['google-oauth-start', { anonymous: 401, outsider: 403, member: 403, admin: 200, owner: 200 }, async (w) => {
    const d: StartDeps = { userId: uid(w), now: () => new Date(), getRole: getRole(w), config: { clientId: 'c', clientSecret: 's', redirectUri: 'https://r', encryptionKey: KEY, appUrl: 'https://app' } }
    return (await handleOAuthStart(d, { org_id: ORG, provider: 'google_gmail' })).status
  }],
  ['integration-disconnect', { anonymous: 401, outsider: 404, member: 403, admin: 200, owner: 200 }, async (w) => {
    const d: DisconnectDeps = {
      userId: uid(w), config: { appUrl: 'x' }, fetch: (async () => new Response('', { status: 200 })) as any, getRole: getRole(w),
      loadIntegration: async () => (w === 'outsider' ? null : { id: INTEG, org_id: ORG, provider: 'google_gmail', external_account: 'a@b.c' }),
      loadEncrypted: async () => null, deleteCredentials: async () => {}, markRevoked: async () => {}, audit: async () => {},
    }
    return (await handleDisconnect(d, { integration_id: INTEG })).status
  }],
  ['provider-data', { anonymous: 401, outsider: 403, member: 200, admin: 200, owner: 200 }, async (w) => {
    const d: ProviderDataDeps = {
      userId: uid(w), now: () => new Date(), getRole: getRole(w), timezone: async () => 'UTC', emailRules: async () => ({}),
      email: async () => ({ provider: 'g', accountEmail: () => 'me@x.com', search: async () => [], getThread: async () => ({ id: '', messages: [] }), createDraft: async () => ({ draftId: '' }), send: async () => ({ messageId: '' }) }),
      calendar: async () => ({ provider: 'g', listEvents: async () => [], freeBusy: async () => [], createEvent: async () => ({}) as any, updateEvent: async () => ({}) as any }),
    }
    return (await handleProviderData(d, { action: 'calendar.agenda', org_id: ORG })).status
  }],
  ['document-process', { anonymous: 401, outsider: 404, member: 200, admin: 200, owner: 200 }, async (w) => {
    const d: DocumentProcessDeps = {
      userId: uid(w), getRole: getRole(w),
      loadDocument: async () => (w === 'outsider' ? null : { id: DOC, org_id: ORG, name: 'a.txt', mime_type: 'text/plain', storage_path: `${ORG}/x/a.txt` }),
      download: async () => new TextEncoder().encode('hello'), markProcessing: async () => true, saveChunks: async () => {}, saveResult: async () => {},
    }
    return (await handleDocumentProcess(d, { document_id: DOC })).status
  }],
  ['workflow-save', { anonymous: 401, outsider: 403, member: 403, admin: 200, owner: 200 }, async (w) => {
    const d: SaveDeps = { userId: uid(w), getRole: getRole(w), knownTools: () => buildRegistry().list().map((t) => t.name), save: async () => ({ id: WF, version: 1 }), audit: async () => {} }
    return (await handleWorkflowSave(d, { org_id: ORG, name: 'x', trigger: { type: 'manual' }, definition: { steps: [{ id: 'a', type: 'notify', title: 't' }] } })).status
  }],
  ['workflow-run', { anonymous: 401, outsider: 404, member: 403, admin: 200, owner: 200 }, async (w) => {
    const d: RunDeps = {
      userId: uid(w), getRole: getRole(w), loadWorkflow: async () => (w === 'outsider' ? null : { id: WF, org_id: ORG, name: 'W' }),
      enqueue: async () => U(1), processNow: async () => [], runStatus: async () => ({ status: 'succeeded', error: null }), newKey: () => 'k',
    }
    return (await handleWorkflowRun(d, { workflow_id: WF })).status
  }],
]

describe('authorization matrix: every endpoint x every kind of caller', () => {
  for (const [name, expected, call] of matrix) {
    it(`${name}`, async () => {
      const got = {} as Record<Who, number>
      for (const w of WHO) got[w] = await call(w)
      expect(got).toEqual(expected)
    })
  }
  it('workflow-tick: only the scheduler secret may start work', async () => {
    const base: TickDeps = { authorized: false, now: () => new Date(), listScheduled: async () => [], enqueue: async () => null, dispatchEvents: async () => 0, expireApprovals: async () => 0, processNow: async () => [] }
    expect((await handleTick(base)).status).toBe(401)
    expect((await handleTick({ ...base, authorized: true })).status).toBe(200)
  })
  it('nothing the matrix allows is reachable for another organization', async () => {
    // an admin of ORG asking about a different org is an outsider there
    const d: StartDeps = { userId: USER, now: () => new Date(), getRole: async (o) => (o === ORG ? 'admin' : null), config: { clientId: 'c', clientSecret: 's', redirectUri: 'r', encryptionKey: KEY, appUrl: 'a' } }
    expect((await handleOAuthStart(d, { org_id: OTHER_ORG, provider: 'google_gmail' })).status).toBe(403)
  })
})

describe('flow: chat -> approval -> execution (the safety loop end to end)', () => {
  it('a delete requested in chat is queued, does nothing until approved, then runs exactly once and is reported', async () => {
    const store = new MemoryStore(); const ports = makePorts()
    const taskId = 'aaaaaaaa-0000-4000-8000-000000000001'
    ports.tasksMem.tasks.push({ id: taskId, title: 'Old', status: 'todo' } as any)
    const provider = new ScriptedProvider([
      toolUse('t1', 'tasks__delete', { id: taskId, title: 'Old' }),
      text('I asked for your approval to delete "Old".'),
    ])
    const history: Array<{ role: string; content: string; tool_calls: unknown[] | null }> = []
    const chat: ChatDeps = {
      userId: USER, now: () => new Date(), rateLimit: { max: 5, windowMs: 60_000 }, getRole: async () => 'member', recentUserMessageTimes: async () => [],
      dailyTokenLimit: 0, tokensUsedToday: async () => 0, missingConfig: () => [], loadOrg: async () => ({ orgName: 'A', timezone: 'UTC', model: null, policy: {} }),
      createConversation: async () => CONV, loadHistory: async () => history,
      makeRunner: async () => ({ provider, model: 'm', tools: buildRegistry(), store, policy: { auto_approve: [] }, ctx: makeCtx(ports) }),
    }

    const r = await handleChat(chat, { org_id: ORG, message: 'delete the old task' })
    expect(r.body.pending_approvals).toHaveLength(1)
    expect(ports.tasksMem.tasks).toHaveLength(1)                                   // not deleted yet
    expect(store.logs.filter((l) => l.status === 'success')).toHaveLength(0)

    // user clicks Approve in the UI -> assistant-approve
    const pending = store.approvals[0]
    const row: ApprovalRow = { id: pending.id, org_id: ORG, action_type: pending.action_type, status: 'pending', summary: pending.summary, requested_by: USER, conversation_id: CONV, payload: pending.payload, expires_at: '2099-01-01T00:00:00Z' }
    let status = 'pending'; const appended: string[] = []
    const approve: ApproveDeps = {
      userId: USER, now: () => new Date(), getRole: async () => 'member', loadApproval: async () => ({ ...row, status }),
      decide: async (_i, dec) => { status = dec; return true }, claim: async () => status === 'approved', finish: async () => {},
      runtime: async () => ({ store, tools: buildRegistry(), ctx: makeCtx(ports) }), appendMessage: async (_c, t) => { appended.push(t) },
    }
    expect((await handleDecision(approve, { approval_id: row.id, decision: 'approved' })).body.status).toBe('executed')
    expect(ports.tasksMem.tasks).toHaveLength(0)
    expect(appended[0]).toMatch(/^Done — Permanently delete task "Old"/)
    // audit trail: pending entry for the request + a success for the execution
    expect(store.logs.map((l) => `${l.tool_name}:${l.status}`)).toEqual(['tasks.delete:pending', 'tasks.delete:success'])
    // a second click cannot repeat it
    expect((await handleDecision(approve, { approval_id: row.id, decision: 'approved' })).status).toBe(409)
    expect(ports.tasksMem.calls.filter((c) => c === 'remove')).toHaveLength(1)
  })

  it('history written by one turn is valid input for the next (tool_use/tool_result pairing survives persistence)', async () => {
    const store = new MemoryStore(); const ports = makePorts()
    const provider = new ScriptedProvider([toolUse('t1', 'tasks__create', { title: 'A' }), text('Created.'), text('Anything else?')])
    const deps = { provider, model: 'm', tools: buildRegistry(), store, policy: { auto_approve: [] }, ctx: makeCtx(ports) }
    const { runTurn, toProviderMessages } = await import('./orchestrator.ts')
    await runTurn(deps, { conversationId: 'c', system: 's', history: [], userText: 'make a task' })
    const rows = store.messages.map((m) => ({ role: m.role, content: m.content, tool_calls: (m.tool_calls as unknown[]) ?? null }))
    const hist: LLMMessage[] = toProviderMessages(rows)
    await runTurn(deps, { conversationId: 'c', system: 's', history: hist, userText: 'thanks' })
    const second = provider.requests[2].messages
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect((second[2].content[0] as any).type).toBe('tool_result')
  })
})

// ------------------------------------------------------------------ workflow flow
class MemQueue {
  runs: Array<{ id: string; status: string; keys: Set<string>; next?: string; event?: unknown; def: Definition; output?: unknown; error?: string }> = []
  keys = new Set<string>()
  steps: Record<string, Record<string, StepState>> = {}
  enqueue(key: string, def: Definition) {
    if (this.keys.has(key)) return null
    this.keys.add(key); const id = `run${this.runs.length + 1}`
    this.runs.push({ id, status: 'queued', keys: new Set([key]), def }); return id
  }
}

describe('flow: schedule tick -> workflow -> approval pause -> approve -> completion', () => {
  it('runs end to end with duplicate-trigger protection, an approval gate and a notification trail', async () => {
    const q = new MemQueue(); const exec = new MemoryStore(); const notes: any[] = []
    const ports = makePorts(); ports.tasksMem.tasks.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Stale', status: 'todo' } as any)
    const def: Definition = {
      steps: [
        { id: 'list', type: 'tool', tool: 'tasks.list', input: {}, on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 } },
        { id: 'purge', type: 'tool', tool: 'tasks.delete', input: { id: 'aaaaaaaa-0000-4000-8000-000000000001' }, on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 } },
        { id: 'done', type: 'notify', title: 'Cleanup finished', body: 'Removed {{steps.purge.output.id}}', on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 } },
      ],
    }
    const stepStore = (runId: string): WorkflowStore => ({
      getSteps: async () => structuredClone(q.steps[runId] ?? {}),
      saveStep: async (_r, k, _t, p: any) => { (q.steps[runId] ??= {})[k] = { ...(q.steps[runId]?.[k] ?? { status: 'pending', attempt: 0 }), ...p } },
    })
    const engineFor = async (run: ClaimedRun): Promise<EngineDeps> => ({
      store: stepStore(run.id), execStore: exec, tools: buildRegistry(), policy: { auto_approve: [] }, ctx: makeCtx(ports, { actor: 'workflow', userId: null }),
      provider: null, model: 'm', notify: async (n) => { notes.push(n) }, now: () => new Date('2026-10-21T13:00:30Z'),
    })
    const runner = (limit: number) => processRuns({
      claim: async (n) => q.runs.filter((r) => r.status === 'queued' && (!r.next || r.next <= '2026-10-21T13:00:30Z')).slice(0, n)
        .map((r) => { r.status = 'running'; return { id: r.id, org_id: ORG, workflow_id: WF, version_id: 'v', attempt: 1 } }),
      load: async (r) => ({ workflowName: 'Cleanup', definition: q.runs.find((x) => x.id === r.id)!.def }),
      engineFor,
      finalize: async (id, o) => { const r = q.runs.find((x) => x.id === id)!; r.status = o.status; if ('error' in o) r.error = o.error; if ('output' in o) r.output = o.output; if ('next_attempt_at' in o) r.next = o.next_attempt_at },
    }, limit)
    const tick = (now: string) => handleTick({
      authorized: true, now: () => new Date(now), listScheduled: async () => [{ id: WF, cron: '0 8 * * 1-5', timezone: 'America/Chicago' }],
      enqueue: async (_w, _s, key) => q.enqueue(key, def), dispatchEvents: async () => 0, expireApprovals: async () => 0, processNow: runner,
    })

    // 1. 8:00 Chicago: the schedule fires, the run starts and pauses at the sensitive step
    const t1 = await tick('2026-10-21T13:00:20Z')
    expect(t1.body).toMatchObject({ scheduled: 1, processed: 1 })
    expect(q.runs[0].status).toBe('waiting_approval')
    expect(ports.tasksMem.tasks).toHaveLength(1)
    expect(notes.map((n) => n.type)).toEqual(['approval_needed'])
    // 2. a repeated / late tick for the same minute creates nothing and does not touch the paused run
    expect((await tick('2026-10-21T13:00:50Z')).body).toMatchObject({ scheduled: 0, processed: 0 })
    expect(q.runs).toHaveLength(1)
    // 3. the owner approves in the UI -> the action executes and the run is released
    const pend = exec.approvals[0]
    const row: ApprovalRow = { id: pend.id, org_id: ORG, action_type: pend.action_type, status: 'pending', summary: pend.summary, requested_by: null, conversation_id: null, payload: pend.payload, expires_at: '2099-01-01T00:00:00Z', workflow_run_id: 'run1', workflow_step_key: 'purge' }
    let st = 'pending'
    const approve: ApproveDeps = {
      userId: USER, now: () => new Date('2026-10-21T13:05:00Z'), getRole: async () => 'owner', loadApproval: async () => ({ ...row, status: st }),
      decide: async (_i, d) => { st = d; return true }, claim: async () => true, finish: async () => {},
      runtime: async () => ({ store: exec, tools: buildRegistry(), ctx: makeCtx(ports, { actor: 'workflow' }) }), appendMessage: async () => {},
      resumeWorkflow: async (r, res) => { q.steps[r.workflow_run_id!][r.workflow_step_key!] = { ...q.steps[r.workflow_run_id!][r.workflow_step_key!], status: res.status, output: res.output as any, error: res.error }; q.runs[0].status = 'queued' },
    }
    expect((await handleDecision(approve, { approval_id: row.id, decision: 'approved' })).body.status).toBe('executed')
    expect(ports.tasksMem.tasks).toHaveLength(0)
    // 4. the next tick finishes the run, using the approved step's output
    await tick('2026-10-21T13:06:20Z')
    expect(q.runs[0].status).toBe('succeeded')
    expect(notes.at(-1)).toMatchObject({ type: 'workflow_message', title: 'Cleanup finished', body: 'Removed aaaaaaaa-0000-4000-8000-000000000001' })
    // the activity log attributes everything to the workflow actor, and the deletion ran exactly once
    expect(exec.logs.filter((l) => l.tool_name === 'tasks.delete' && l.status === 'success')).toHaveLength(1)
    expect(exec.logs.every((l) => l.actor_type === 'workflow')).toBe(true)
  })

  it('the built-in daily briefing degrades gracefully with no integrations or AI: sections fail visibly, the run reports why', async () => {
    const exec = new MemoryStore(); const rows: Record<string, StepState> = {}
    const store: WorkflowStore = { getSteps: async () => structuredClone(rows), saveStep: async (_r, k, _t, p: any) => { rows[k] = { ...(rows[k] ?? { status: 'pending', attempt: 0 }), ...p } } }
    const d: EngineDeps = { store, execStore: exec, tools: buildRegistry(), policy: { auto_approve: [] }, ctx: makeCtx(makePorts(), { actor: 'workflow' }), provider: null, model: 'm', notify: async () => {}, now: () => new Date('2026-10-21T13:00:00Z') }
    const r = await advanceRun(d, { id: 'r', workflowName: 'Daily briefing', definition: DAILY_BRIEFING.definition as Definition })
    expect(rows.agenda.status).toBe('failed'); expect(rows.agenda.error).toMatch(/Google Calendar is not connected/)
    expect(rows.mail.status).toBe('failed'); expect(rows.overdue.status).toBe('succeeded')
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/not configured/) })   // no AI key => no fake briefing
  })
})
