import { z } from 'zod'
import { fail, ok, type HandlerResult, type Role } from './common.ts'
import { runTurn, toProviderMessages, type OrchestratorDeps } from '../orchestrator.ts'
import { buildSystemPrompt } from '../untrusted.ts'
import { checkRateLimit, type RateLimit } from '../ratelimit.ts'

export const ChatRequest = z.object({
  org_id: z.uuid(),
  conversation_id: z.uuid().optional(),
  message: z.string().trim().min(1).max(8000),
})

export interface OrgContext {
  orgName: string
  timezone: string
  model: string | null
  policy: unknown
  knowledgeDigest?: string
}

export interface ChatDeps {
  /** from the verified JWT; null = unauthenticated */
  userId: string | null
  now(): Date
  rateLimit: RateLimit
  /** membership is read with the USER's token, so RLS decides; null = not a member of that org */
  getRole(orgId: string): Promise<Role | null>
  recentUserMessageTimes(orgId: string): Promise<number[]>
  /** daily AI token budget per organization; 0 disables the cap */
  dailyTokenLimit: number
  /** LLM tokens (input + output) used by the organization since 00:00 UTC */
  tokensUsedToday(orgId: string): Promise<number>
  /** which required server-side settings are missing (e.g. ANTHROPIC_API_KEY) */
  missingConfig(): string[]
  loadOrg(orgId: string): Promise<OrgContext>
  createConversation(orgId: string, title: string): Promise<string>
  /** null when the conversation doesn't exist, isn't the caller's, or belongs to another org */
  loadHistory(conversationId: string, orgId: string): Promise<Array<{ role: string; content: string; tool_calls: unknown[] | null }> | null>
  makeRunner(org: OrgContext, conversationId: string): Promise<OrchestratorDeps>
}

export async function handleChat(d: ChatDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const parsed = ChatRequest.safeParse(raw)
  if (!parsed.success) return fail(400, 'Invalid request', { issues: parsed.error.issues.map((i) => i.message) })
  const req = parsed.data

  const role = await d.getRole(req.org_id)
  if (!role) return fail(403, 'You are not a member of this organization')

  const missing = d.missingConfig()
  if (missing.length) {
    return fail(503, 'The assistant is not configured yet', { code: 'not_configured', missing })
  }

  const limited = checkRateLimit(await d.recentUserMessageTimes(req.org_id), d.now().getTime(), d.rateLimit)
  if (!limited.ok) return fail(429, 'You are sending messages too quickly', { retry_after_seconds: limited.retryAfterSeconds })

  if (d.dailyTokenLimit > 0 && (await d.tokensUsedToday(req.org_id)) >= d.dailyTokenLimit) {
    return fail(429, 'Your organization has reached today\'s AI usage limit. It resets at midnight UTC.', { code: 'usage_limit' })
  }

  let history: Awaited<ReturnType<ChatDeps['loadHistory']>> = []
  let conversationId = req.conversation_id
  if (conversationId) {
    history = await d.loadHistory(conversationId, req.org_id)
    if (history === null) return fail(404, 'Conversation not found')
  } else {
    conversationId = await d.createConversation(req.org_id, req.message.slice(0, 80))
  }

  const org = await d.loadOrg(req.org_id)
  const runner = await d.makeRunner(org, conversationId)
  const result = await runTurn(runner, {
    conversationId,
    system: buildSystemPrompt({ orgName: org.orgName, timezone: org.timezone, now: d.now(), knowledgeDigest: org.knowledgeDigest }),
    history: toProviderMessages(history ?? []),
    userText: req.message,
  })

  return ok({
    conversation_id: conversationId,
    reply: result.finalText,
    pending_approvals: result.pendingApprovals,
    ...(result.error ? { provider_error: result.error } : {}),
  })
}
