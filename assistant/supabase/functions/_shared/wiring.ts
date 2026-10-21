// Composition root: builds the real dependencies for the assistant endpoints.
import type { SupabaseClient } from '@supabase/supabase-js'
import { AnthropicProvider } from './core/llm/anthropic.ts'
import { buildRegistry } from './core/tools/index.ts'
import { parsePolicy } from './core/policy.ts'
import type { ChatDeps } from './core/handlers/chat.ts'
import type { ApproveDeps } from './core/handlers/approve.ts'
import type { Ports } from './core/ports.ts'
import { NotConfiguredError } from './core/types.ts'
import { SupabaseKnowledge, SupabaseStore, SupabaseTasks } from './adapters/supabase.ts'
import { env } from './runtime.ts'
import { extraTools, makeProviderPorts } from './wiring.integrations.ts'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

export function buildPorts(
  client: SupabaseClient, svc: SupabaseClient, orgId: string, actor: 'assistant' | 'workflow',
): Ports {
  const provider = makeProviderPorts(svc, orgId)
  return {
    tasks: new SupabaseTasks(client, orgId, actor),
    knowledge: new SupabaseKnowledge(client, orgId),
    documents: provider.documents(client),
    email: () => provider.email(),
    calendar: () => provider.calendar(),
    emailRules: provider.emailRules,
  }
}

async function orgContext(client: SupabaseClient, orgId: string) {
  const [org, settings, kb] = await Promise.all([
    client.from('organizations').select('name').eq('id', orgId).maybeSingle(),
    client.from('organization_settings').select('timezone, ai_model, approval_policy').eq('org_id', orgId).maybeSingle(),
    client.from('knowledge_base_sources').select('kind, title, content').eq('org_id', orgId).eq('is_active', true)
      .in('kind', ['company', 'service', 'hours', 'policy', 'guideline', 'contact']).limit(40),
  ])
  const digest = (kb.data ?? []).map((k) => `## ${k.title} (${k.kind})\n${k.content}`).join('\n\n').slice(0, 6000)
  return {
    orgName: org.data?.name ?? 'your business',
    timezone: settings.data?.timezone ?? 'UTC',
    model: (settings.data?.ai_model as string | null) ?? null,
    policy: settings.data?.approval_policy ?? { auto_approve: [] },
    knowledgeDigest: digest || undefined,
  }
}

export function buildChatDeps(opts: {
  userId: string | null; client: SupabaseClient; svc: SupabaseClient
}): ChatDeps {
  const { userId, client, svc } = opts
  return {
    userId,
    now: () => new Date(),
    rateLimit: { max: Number(env('ASSISTANT_MESSAGES_PER_MINUTE') ?? 12), windowMs: 60_000 },
    async getRole(orgId) {
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId!).maybeSingle()
      return (data?.role as 'owner' | 'admin' | 'member' | undefined) ?? null
    },
    async recentUserMessageTimes(orgId) {
      const since = new Date(Date.now() - 60_000).toISOString()
      const { data } = await svc.from('assistant_messages')
        .select('created_at, assistant_conversations!inner(user_id)')
        .eq('org_id', orgId).eq('role', 'user').gte('created_at', since).eq('assistant_conversations.user_id', userId!)
      return (data ?? []).map((r) => Date.parse(r.created_at as string))
    },
    missingConfig: () => (env('ANTHROPIC_API_KEY') ? [] : ['ANTHROPIC_API_KEY']),
    loadOrg: (orgId) => orgContext(client, orgId),
    async createConversation(orgId, title) {
      const { data, error } = await client.from('assistant_conversations').insert({ org_id: orgId, title }).select('id').single()
      if (error) throw new Error(`create conversation: ${error.message}`)
      return data.id as string
    },
    async loadHistory(conversationId, orgId) {
      const conv = await client.from('assistant_conversations').select('id').eq('id', conversationId).eq('org_id', orgId).maybeSingle()
      if (!conv.data) return null // RLS hides other users' conversations
      const { data } = await client.from('assistant_messages').select('role, content, tool_calls')
        .eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(200)
      return (data ?? []) as Array<{ role: string; content: string; tool_calls: unknown[] | null }>
    },
    async makeRunner(org, conversationId) {
      const orgId = (await client.from('assistant_conversations').select('org_id').eq('id', conversationId).single()).data!.org_id as string
      const ports = buildPorts(client, svc, orgId, 'assistant')
      return {
        provider: new AnthropicProvider({ apiKey: env('ANTHROPIC_API_KEY')! }),
        model: org.model ?? env('ASSISTANT_DEFAULT_MODEL') ?? DEFAULT_MODEL,
        tools: buildRegistry(extraTools()),
        store: new SupabaseStore(svc, orgId, userId, conversationId),
        policy: parsePolicy(org.policy),
        ctx: { orgId, userId, actor: 'assistant', timezone: org.timezone, now: () => new Date(), ports },
      }
    },
  }
}

export function buildApproveDeps(opts: { userId: string | null; client: SupabaseClient; svc: SupabaseClient }): ApproveDeps {
  const { userId, client, svc } = opts
  return {
    userId,
    now: () => new Date(),
    async getRole(orgId) {
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId!).maybeSingle()
      return (data?.role as 'owner' | 'admin' | 'member' | undefined) ?? null
    },
    async loadApproval(id) {
      const { data } = await client.from('approval_requests')
        .select('id, org_id, action_type, payload, conversation_id, expires_at, status, summary, requested_by').eq('id', id).maybeSingle()
      return data as ReturnType<ApproveDeps['loadApproval']> extends Promise<infer R> ? R : never
    },
    async decide(id, decision, note) {
      // user-token UPDATE: RLS decides who may decide; the DB trigger stamps decided_by/decided_at
      const { data, error } = await client.from('approval_requests')
        .update({ status: decision, decision_note: note ?? null }).eq('id', id).eq('status', 'pending').select('id')
      return !error && (data?.length ?? 0) === 1
    },
    async claim(id) {
      const { data } = await svc.from('approval_requests')
        .update({ executed_at: new Date().toISOString() }).eq('id', id).eq('status', 'approved').is('executed_at', null).select('id')
      return (data?.length ?? 0) === 1
    },
    async finish(id, r) {
      await svc.from('approval_requests').update({ status: r.status, error: r.error ?? null }).eq('id', id)
    },
    async runtime(orgId) {
      const { data } = await client.from('organization_settings').select('timezone').eq('org_id', orgId).maybeSingle()
      const ports = buildPorts(client, svc, orgId, 'assistant')
      return {
        store: new SupabaseStore(svc, orgId, userId, null),
        tools: buildRegistry(extraTools()),
        ctx: { orgId, userId, actor: 'assistant' as const, timezone: (data?.timezone as string) ?? 'UTC', now: () => new Date(), ports },
      }
    },
    async appendMessage(conversationId, text, kind) {
      const { data } = await svc.from('assistant_conversations').select('org_id').eq('id', conversationId).maybeSingle()
      if (!data) return
      await svc.from('assistant_messages').insert({
        org_id: data.org_id, conversation_id: conversationId, role: 'assistant', content: text, metadata: { kind },
      })
    },
  }
}

export { NotConfiguredError }
