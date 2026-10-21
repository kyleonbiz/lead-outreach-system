import { z } from 'zod'
import { fail, ok, type HandlerResult, type Role } from './common.ts'
import { approvalOutcomeMessage, executeApproval, type ApprovalExecution, type ApprovedAction } from '../approvals.ts'
import type { Store } from '../execute.ts'
import type { ToolContext, ToolRegistry } from '../tools/registry.ts'

export const DecisionRequest = z.object({
  approval_id: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(500).optional(),
})

export interface ApprovalRow extends ApprovedAction {
  status: string
  summary: string
  requested_by: string | null
}

export interface ApproveDeps {
  userId: string | null
  now(): Date
  getRole(orgId: string): Promise<Role | null>
  /** read with the user's token: invisible (other org) approvals come back null */
  loadApproval(id: string): Promise<ApprovalRow | null>
  /** user-token UPDATE; RLS + trigger enforce who may decide and stamp decided_by. false = blocked/no-op */
  decide(id: string, decision: 'approved' | 'rejected', note?: string): Promise<boolean>
  /** service-role atomic claim: sets executed_at where status='approved' and executed_at is null */
  claim(id: string): Promise<boolean>
  finish(id: string, r: { status: 'executed' | 'failed'; error?: string }): Promise<void>
  /** execution runtime bound to the approving user */
  runtime(orgId: string): Promise<{ store: Store; tools: ToolRegistry; ctx: ToolContext }>
  appendMessage(conversationId: string, text: string, kind: string): Promise<void>
}

export async function handleDecision(d: ApproveDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const parsed = DecisionRequest.safeParse(raw)
  if (!parsed.success) return fail(400, 'Invalid request')
  const { approval_id, decision, note } = parsed.data

  const row = await d.loadApproval(approval_id)
  if (!row) return fail(404, 'Approval request not found')
  if (!(await d.getRole(row.org_id))) return fail(403, 'You are not a member of this organization')
  if (row.status !== 'pending') return fail(409, `This request was already ${row.status}`)
  if (Date.parse(row.expires_at) < d.now().getTime()) return fail(410, 'This request has expired')

  if (!(await d.decide(approval_id, decision, note))) {
    return fail(403, 'You are not allowed to decide this request, or it was already decided')
  }

  if (decision === 'rejected') {
    if (row.conversation_id) await d.appendMessage(row.conversation_id, approvalOutcomeMessage('rejected', undefined, row.summary), 'approval_outcome')
    return ok({ status: 'rejected' })
  }

  if (!(await d.claim(approval_id))) return fail(409, 'This action is already being executed')

  const rt = await d.runtime(row.org_id)
  let result: ApprovalExecution
  try {
    result = await executeApproval(rt.store, rt.tools, rt.ctx, row, d.now())
  } catch (e) {
    result = { status: 'failed', error: e instanceof Error ? e.message : String(e), summary: row.summary }
  }

  if (result.status === 'executed') await d.finish(approval_id, { status: 'executed' })
  else if (result.status === 'failed' || result.status === 'invalid') {
    await d.finish(approval_id, { status: 'failed', error: result.status === 'failed' ? result.error : result.error })
  }
  if (row.conversation_id) {
    await d.appendMessage(row.conversation_id, approvalOutcomeMessage('approved', result, row.summary), 'approval_outcome')
  }
  return ok({
    status: result.status,
    ...(result.status === 'failed' || result.status === 'invalid' ? { error: result.error } : {}),
  })
}
