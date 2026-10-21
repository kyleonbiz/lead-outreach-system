import type { ToolContext, ToolRegistry } from './tools/registry.ts'
import { executeTool, type Store } from './execute.ts'

export interface ApprovedAction {
  id: string
  org_id: string
  action_type: string
  payload: unknown
  conversation_id: string | null
  expires_at: string
}

export type ApprovalExecution =
  | { status: 'executed'; output: unknown; summary: string }
  | { status: 'failed'; error: string; summary: string }
  | { status: 'duplicate' }
  | { status: 'invalid'; error: string }

/**
 * Executes an approved action. The payload is RE-VALIDATED against the tool schema (it came from
 * the database, not from trusted code), expiry is enforced, and the idempotency key `approval:<id>`
 * guarantees at-most-once execution even if the approval endpoint is called twice concurrently.
 */
export async function executeApproval(
  store: Store, tools: ToolRegistry, ctx: ToolContext, a: ApprovedAction, now: Date = new Date(),
): Promise<ApprovalExecution> {
  if (a.org_id !== ctx.orgId) return { status: 'invalid', error: 'Approval belongs to a different organization' }
  if (Date.parse(a.expires_at) < now.getTime()) return { status: 'invalid', error: 'This approval has expired' }
  const tool = tools.get(a.action_type)
  if (!tool) return { status: 'invalid', error: `Unknown action type "${a.action_type}"` }
  const parsed = tool.input.safeParse(a.payload)
  if (!parsed.success) return { status: 'invalid', error: 'Stored approval payload no longer matches the tool schema' }

  const summary = tool.summarize(parsed.data)
  const outcome = await executeTool(store, ctx, tool, parsed.data, {
    idempotencyKey: `approval:${a.id}`, approvalId: a.id, conversationId: a.conversation_id,
  })
  if (outcome.ok === 'duplicate') return { status: 'duplicate' }
  if (!outcome.ok) return { status: 'failed', error: outcome.error, summary }
  return { status: 'executed', output: outcome.output, summary }
}

/** Plain, code-generated (not model-generated) message appended to the conversation after a decision. */
export function approvalOutcomeMessage(
  decision: 'approved' | 'rejected', r?: ApprovalExecution, summary?: string,
): string {
  if (decision === 'rejected') return `You declined: ${summary ?? 'the requested action'}. Nothing was done.`
  if (!r) return `Approved: ${summary ?? 'action'}.`
  switch (r.status) {
    case 'executed': return `Done — ${r.summary}.`
    case 'failed': return `That approved action FAILED: ${r.summary}. Error: ${r.error}`
    case 'duplicate': return `That approved action had already been run; it was not run again.`
    case 'invalid': return `That approved action could not be run: ${r.error}`
  }
}
