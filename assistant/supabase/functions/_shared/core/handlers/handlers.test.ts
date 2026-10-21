import { describe, expect, it, vi } from 'vitest'
import { handleChat, type ChatDeps } from './chat.ts'
import { handleDecision, type ApproveDeps, type ApprovalRow } from './approve.ts'
import { ScriptedProvider, text } from '../llm/fake.ts'
import { buildRegistry } from '../tools/index.ts'
import { MemoryStore, ORG, USER, makeCtx, makePorts } from '../testkit.ts'

const ORG2 = '33333333-3333-4333-8333-333333333333'
const CONV = '44444444-4444-4444-8444-444444444444'

function chatDeps(over: Partial<ChatDeps> = {}): ChatDeps & { store: MemoryStore; provider: ScriptedProvider } {
  const store = new MemoryStore()
  const provider = new ScriptedProvider([text('hello there')])
  return {
    store, provider,
    userId: USER, now: () => new Date('2026-10-21T15:00:00Z'), rateLimit: { max: 3, windowMs: 60_000 },
    getRole: async (o) => (o === ORG ? 'member' : null),
    recentUserMessageTimes: async () => [],
    dailyTokenLimit: 0, tokensUsedToday: async () => 0,
    missingConfig: () => [],
    loadOrg: async () => ({ orgName: 'Acme', timezone: 'America/Chicago', model: null, policy: { auto_approve: [] } }),
    createConversation: async () => CONV,
    loadHistory: async (id, org) => (id === CONV && org === ORG ? [] : null),
    makeRunner: async () => ({ provider, model: 'm', tools: buildRegistry(), store, policy: { auto_approve: [] }, ctx: makeCtx(makePorts()) }),
    ...over,
  }
}

describe('POST assistant-chat: authorization & guards', () => {
  const body = { org_id: ORG, message: 'hi' }

  it('401 without a verified user', async () => {
    expect((await handleChat(chatDeps({ userId: null }), body)).status).toBe(401)
  })
  it('400 on malformed input (bad org id, empty/oversized message)', async () => {
    expect((await handleChat(chatDeps(), { org_id: 'nope', message: 'hi' })).status).toBe(400)
    expect((await handleChat(chatDeps(), { org_id: ORG, message: '   ' })).status).toBe(400)
    expect((await handleChat(chatDeps(), { org_id: ORG, message: 'x'.repeat(8001) })).status).toBe(400)
  })
  it('403 for an organization the user does not belong to — before anything else runs', async () => {
    const d = chatDeps()
    const spy = vi.spyOn(d, 'loadOrg')
    const r = await handleChat(d, { org_id: ORG2, message: 'hi' })
    expect(r.status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
    expect(d.provider.requests).toHaveLength(0)
  })
  it('503 not_configured lists what is missing and never calls the model', async () => {
    const d = chatDeps({ missingConfig: () => ['ANTHROPIC_API_KEY'] })
    const r = await handleChat(d, body)
    expect(r).toMatchObject({ status: 503, body: { code: 'not_configured', missing: ['ANTHROPIC_API_KEY'] } })
    expect(d.provider.requests).toHaveLength(0)
  })
  it('429 with retry-after when the user floods the assistant', async () => {
    const now = new Date('2026-10-21T15:00:00Z').getTime()
    const r = await handleChat(chatDeps({ recentUserMessageTimes: async () => [now - 1000, now - 2000, now - 3000] }), body)
    expect(r.status).toBe(429)
    expect(r.body.retry_after_seconds).toBeGreaterThan(0)
  })
  it('429 usage_limit once the org has spent its daily AI token budget — before any model call', async () => {
    const d = chatDeps({ dailyTokenLimit: 1000, tokensUsedToday: async () => 1000 })
    const r = await handleChat(d, body)
    expect(r).toMatchObject({ status: 429, body: { code: 'usage_limit' } })
    expect(d.provider.requests).toHaveLength(0)
    expect((await handleChat(chatDeps({ dailyTokenLimit: 1000, tokensUsedToday: async () => 999 }), body)).status).toBe(200)
    expect((await handleChat(chatDeps({ dailyTokenLimit: 0, tokensUsedToday: async () => 10 ** 9 }), body)).status).toBe(200) // 0 = unlimited
  })
  it("404 for someone else's / another org's conversation", async () => {
    expect((await handleChat(chatDeps(), { ...body, conversation_id: '55555555-5555-4555-8555-555555555555' })).status).toBe(404)
  })
  it('happy path creates a conversation and returns the reply', async () => {
    const r = await handleChat(chatDeps(), body)
    expect(r).toMatchObject({ status: 200, body: { conversation_id: CONV, reply: 'hello there', pending_approvals: [] } })
  })
})

function approveDeps(over: Partial<ApproveDeps> = {}, row: Partial<ApprovalRow> = {}) {
  const store = new MemoryStore()
  const ports = makePorts()
  ports.tasksMem.tasks.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old' } as any)
  const approval: ApprovalRow = {
    id: '66666666-6666-4666-8666-666666666666', org_id: ORG, action_type: 'tasks.delete', status: 'pending',
    summary: 'Permanently delete task "Old"', requested_by: USER, conversation_id: CONV,
    payload: { id: 'aaaaaaaa-0000-4000-8000-000000000001' }, expires_at: '2099-01-01T00:00:00Z', ...row,
  }
  const state = { status: approval.status, claimed: false, finished: null as any, messages: [] as string[], decided: 0 }
  const deps: ApproveDeps & { state: typeof state; ports: typeof ports; store: MemoryStore } = {
    state, ports, store,
    userId: USER, now: () => new Date('2026-10-21T15:00:00Z'),
    getRole: async (o) => (o === ORG ? 'member' : null),
    loadApproval: async (id) => (id === approval.id ? { ...approval, status: state.status } : null),
    decide: async (_id, decision) => { state.decided++; state.status = decision; return true },
    claim: async () => { if (state.claimed) return false; state.claimed = true; return true },
    finish: async (_id, r) => { state.finished = r },
    runtime: async () => ({ store, tools: buildRegistry(), ctx: makeCtx(ports) }),
    appendMessage: async (_c, t) => { state.messages.push(t) },
    ...over,
  }
  return { deps, approval }
}

describe('POST assistant-approve: authorization & execution', () => {
  it('approving executes the action once, records the outcome and reports it', async () => {
    const { deps, approval } = approveDeps()
    const r = await handleDecision(deps, { approval_id: approval.id, decision: 'approved' })
    expect(r).toMatchObject({ status: 200, body: { status: 'executed' } })
    expect(deps.ports.tasksMem.tasks).toHaveLength(0)
    expect(deps.state.finished).toEqual({ status: 'executed' })
    expect(deps.state.messages[0]).toMatch(/^Done — /)
  })
  it('rejecting does NOT execute anything', async () => {
    const { deps, approval } = approveDeps()
    const r = await handleDecision(deps, { approval_id: approval.id, decision: 'rejected' })
    expect(r.body.status).toBe('rejected')
    expect(deps.ports.tasksMem.tasks).toHaveLength(1)
    expect(deps.state.messages[0]).toMatch(/Nothing was done/)
  })
  it('404 for approvals the user cannot see (other organizations)', async () => {
    const { deps } = approveDeps()
    expect((await handleDecision(deps, { approval_id: '77777777-7777-4777-8777-777777777777', decision: 'approved' })).status).toBe(404)
  })
  it('403 when RLS refuses the decision (e.g. a plain member who is not the requester)', async () => {
    const { deps, approval } = approveDeps({ decide: async () => false })
    const r = await handleDecision(deps, { approval_id: approval.id, decision: 'approved' })
    expect(r.status).toBe(403)
    expect(deps.ports.tasksMem.tasks).toHaveLength(1)
  })
  it('409 for already-decided and 410 for expired requests', async () => {
    expect((await handleDecision(approveDeps({}, { status: 'executed' }).deps, { approval_id: '66666666-6666-4666-8666-666666666666', decision: 'approved' })).status).toBe(409)
    expect((await handleDecision(approveDeps({}, { expires_at: '2000-01-01T00:00:00Z' }).deps, { approval_id: '66666666-6666-4666-8666-666666666666', decision: 'approved' })).status).toBe(410)
  })
  it('double-submit executes only once (second claim loses)', async () => {
    const { deps, approval } = approveDeps()
    // simulate a racing second request that passed decide() but loses the claim
    const first = await handleDecision(deps, { approval_id: approval.id, decision: 'approved' })
    deps.state.status = 'pending'
    const second = await handleDecision(deps, { approval_id: approval.id, decision: 'approved' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(deps.store.logs.filter((l) => l.tool_name === 'tasks.delete' && l.status === 'success')).toHaveLength(1)
  })
  it('a tool failure is reported as failed, persisted, and told to the user', async () => {
    const { deps, approval } = approveDeps({}, { payload: { id: 'aaaaaaaa-0000-4000-8000-0000000000ff' } })
    const r = await handleDecision(deps, { approval_id: approval.id, decision: 'approved' })
    expect(r.body.status).toBe('failed')
    expect(deps.state.finished).toMatchObject({ status: 'failed' })
    expect(deps.state.messages[0]).toMatch(/FAILED/)
  })
  it('401 when unauthenticated', async () => {
    const { deps, approval } = approveDeps({ userId: null })
    expect((await handleDecision(deps, { approval_id: approval.id, decision: 'approved' })).status).toBe(401)
  })
})
