// Provider-neutral domain types shared by the orchestrator, tools, adapters and workflow engine.
// Pure TypeScript: runs unchanged under Vitest (Node) and Supabase Edge Functions (Deno).

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface LLMRequest {
  model: string
  system: string
  messages: LLMMessage[]
  tools: ToolSchema[]
  max_tokens: number
}

export interface LLMResponse {
  content: Block[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other'
  usage: { input_tokens: number; output_tokens: number }
}

export interface LLMProvider {
  readonly name: string
  complete(req: LLMRequest): Promise<LLMResponse>
}

export type ActorType = 'user' | 'assistant' | 'workflow' | 'system'

export interface ActionLogEntry {
  org_id: string
  user_id: string | null
  actor_type: ActorType
  category: 'tool_call' | 'audit' | 'integration' | 'error'
  tool_name: string | null
  action: string
  status: 'success' | 'failure' | 'pending' | 'denied'
  summary: string | null
  input?: unknown
  output?: unknown
  error?: string | null
  conversation_id?: string | null
  approval_id?: string | null
  workflow_run_id?: string | null
  idempotency_key?: string | null
  duration_ms?: number | null
}

/** Thrown by a tool when a required integration/capability is not set up. Surfaced verbatim, never faked. */
export class NotConfiguredError extends Error {
  constructor(public readonly what: string, message?: string) {
    super(message ?? `${what} is not connected. The user needs to set it up in Integrations.`)
    this.name = 'NotConfiguredError'
  }
}

/** Thrown for failures of an upstream provider (Google, Anthropic, ...). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'auth' | 'rate_limit' | 'unavailable' | 'bad_request' | 'unknown' = 'unknown',
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
