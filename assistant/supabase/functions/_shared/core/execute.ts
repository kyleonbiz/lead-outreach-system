import { NotConfiguredError, type ActionLogEntry } from './types.ts'
import type { ToolContext, ToolDef } from './tools/registry.ts'
import { redact } from './redact.ts'

export interface Store {
  addMessage(m: { role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[] | null; metadata?: Record<string, unknown> }): Promise<void>
  /** Insert a finished log entry. */
  logAction(e: ActionLogEntry): Promise<void>
  /** Insert a 'pending' entry holding the idempotency key. Returns null if the key already exists (duplicate). */
  reserveAction(e: ActionLogEntry): Promise<{ id: string } | null>
  finishAction(id: string, patch: { status: 'success' | 'failure'; output?: unknown; error?: string | null; duration_ms: number }): Promise<void>
  createApproval(a: {
    org_id: string; requested_by: string | null; conversation_id: string | null; workflow_run_id?: string | null
    action_type: string; summary: string; payload: unknown; risk: 'low' | 'medium' | 'high'
  }): Promise<{ id: string }>
  recordUsage(u: { kind: 'llm_input_tokens' | 'llm_output_tokens' | 'tool_call'; quantity: number; model?: string }): Promise<void>
}

export type ToolOutcome =
  | { ok: true; output: unknown; duration_ms: number }
  | { ok: false; error: string; notConfigured: boolean; duration_ms: number }
  | { ok: 'duplicate' }

export interface ExecMeta {
  idempotencyKey?: string
  conversationId?: string | null
  approvalId?: string | null
  workflowRunId?: string | null
}

/**
 * Runs a tool and records what ACTUALLY happened. Failures are returned (never swallowed or reported as
 * success). Non-read tools reserve their idempotency key first, so a retried call cannot act twice.
 */
export async function executeTool(
  store: Store, ctx: ToolContext, tool: ToolDef, input: unknown, meta: ExecMeta = {},
): Promise<ToolOutcome> {
  const base: ActionLogEntry = {
    org_id: ctx.orgId, user_id: ctx.userId, actor_type: ctx.actor, category: 'tool_call',
    tool_name: tool.name, action: tool.name, status: 'pending',
    summary: tool.summarize(input), input: redact(input),
    conversation_id: meta.conversationId ?? null, approval_id: meta.approvalId ?? null,
    workflow_run_id: meta.workflowRunId ?? null, idempotency_key: meta.idempotencyKey ?? null,
  }

  let reservation: { id: string } | null = null
  if (tool.risk !== 'read' && meta.idempotencyKey) {
    reservation = await store.reserveAction(base)
    if (!reservation) return { ok: 'duplicate' }
  }

  const started = Date.now()
  try {
    const output = await tool.execute(ctx, input)
    const duration_ms = Date.now() - started
    if (reservation) await store.finishAction(reservation.id, { status: 'success', output: redact(output), duration_ms })
    else await store.logAction({ ...base, status: 'success', output: redact(output), duration_ms, idempotency_key: null })
    void store.recordUsage({ kind: 'tool_call', quantity: 1 }).catch(() => {})
    return { ok: true, output, duration_ms }
  } catch (e) {
    const duration_ms = Date.now() - started
    const error = e instanceof Error ? e.message : String(e)
    if (reservation) await store.finishAction(reservation.id, { status: 'failure', error, duration_ms })
    else await store.logAction({ ...base, status: 'failure', error, duration_ms, idempotency_key: null })
    return { ok: false, error, notConfigured: e instanceof NotConfiguredError, duration_ms }
  }
}
