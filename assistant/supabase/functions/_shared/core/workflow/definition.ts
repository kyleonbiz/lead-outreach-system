import { z } from 'zod'
import { validateCron } from './cron.ts'

// Workflow definitions are DATA, not code: a list of steps drawn from a fixed set of types, referencing
// registered tools by name. There is no expression language, no eval, no scripting, no arbitrary HTTP.

const id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'step ids are lowercase letters, digits and underscores')

export const Condition = z.object({
  step: id,
  path: z.string().max(200).optional(),
  op: z.enum(['exists', 'empty', 'not_empty', 'eq', 'neq', 'gt', 'lt', 'contains', 'succeeded', 'failed']),
  value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
})
export type Condition = z.infer<typeof Condition>

const Retry = z.object({
  max_attempts: z.number().int().min(1).max(5).default(1),
  backoff_seconds: z.number().int().min(5).max(3600).default(60),
}).default({ max_attempts: 1, backoff_seconds: 60 })

const base = {
  id,
  label: z.string().max(100).optional(),
  when: Condition.optional(),
  on_failure: z.enum(['stop', 'continue']).default('stop'),
  retry: Retry,
}

export const Step = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('tool'), tool: z.string().min(1).max(60), input: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ ...base, type: z.literal('summarize'), instruction: z.string().min(1).max(2000), from: z.array(id).max(25).optional() }),
  z.object({ ...base, type: z.literal('approval'), summary: z.string().min(1).max(500) }),
  z.object({ ...base, type: z.literal('notify'), title: z.string().min(1).max(120), body: z.string().max(2000).default('') }),
])
export type Step = z.infer<typeof Step>

export const Definition = z.object({ steps: z.array(Step).min(1).max(25) })
export type Definition = z.infer<typeof Definition>

export const EVENT_TYPES = ['task.overdue', 'document.ready'] as const

export const Trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('schedule'), cron: z.string().min(9).max(100).superRefine((v, ctx) => {
    const e = validateCron(v); if (e) ctx.addIssue({ code: 'custom', message: `Invalid schedule: ${e}` })
  }) }),
  z.object({ type: z.literal('event'), event: z.enum(EVENT_TYPES) }),
])
export type Trigger = z.infer<typeof Trigger>

const TEMPLATE_REF = /\{\{\s*steps\.([a-z][a-z0-9_]*)[.\s}]/g

function* strings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v
  else if (Array.isArray(v)) for (const x of v) yield* strings(x)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* strings(x)
}

export type Validation = { ok: true; def: Definition } | { ok: false; errors: string[] }

/** Structural + referential validation. `knownTools` is the allow-list of tool names a workflow may call. */
export function validateDefinition(raw: unknown, knownTools: Iterable<string>): Validation {
  const parsed = Definition.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`) }
  const def = parsed.data
  const tools = new Set(knownTools)
  const errors: string[] = []
  const seen = new Set<string>()

  def.steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s.id})`
    if (seen.has(s.id)) errors.push(`${at}: duplicate step id`)
    if (s.type === 'tool' && !tools.has(s.tool)) errors.push(`${at}: unknown tool "${s.tool}"`)
    if (s.when && !seen.has(s.when.step)) errors.push(`${at}: condition refers to "${s.when.step}", which is not an earlier step`)
    if (s.type === 'summarize') for (const f of s.from ?? []) if (!seen.has(f)) errors.push(`${at}: "from" refers to "${f}", which is not an earlier step`)
    const texts = s.type === 'tool' ? [...strings(s.input)] : s.type === 'notify' ? [s.title, s.body] : []
    for (const t of texts) for (const m of t.matchAll(TEMPLATE_REF)) if (!seen.has(m[1])) errors.push(`${at}: template refers to "${m[1]}", which is not an earlier step`)
    seen.add(s.id)
  })
  return errors.length ? { ok: false, errors } : { ok: true, def }
}
