import { z } from 'zod'
import type { ToolSchema, ActorType } from '../types.ts'

/** Ports are injected by the runtime so tools stay pure and testable. See ports.ts. */
export interface ToolContext {
  orgId: string
  userId: string | null
  actor: Extract<ActorType, 'assistant' | 'workflow'>
  timezone: string
  now: () => Date
  ports: import('../ports.ts').Ports
}

export interface ToolDef<I = any, O = unknown> {
  /** dotted name, e.g. "tasks.create". Sent to the model with '.' replaced (see wireName). */
  name: string
  description: string
  input: z.ZodType<I>
  /** read: no side effects · write: reversible internal change · sensitive: needs approval by default */
  risk: 'read' | 'write' | 'sensitive'
  /** output contains external content (email, documents): wrap as untrusted before showing to the model */
  untrusted?: boolean
  /** human-readable description of exactly what will happen — shown in approvals and logs */
  summarize(input: I): string
  execute(ctx: ToolContext, input: I): Promise<O>
}

export const wireName = (n: string) => n.replace(/\./g, '__')
export const fromWireName = (n: string) => n.replace(/__/g, '.')

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  constructor(defs: ToolDef[] = []) { defs.forEach((d) => this.register(d)) }

  register(def: ToolDef) {
    if (this.tools.has(def.name)) throw new Error(`Duplicate tool: ${def.name}`)
    this.tools.set(def.name, def)
  }
  get(name: string): ToolDef | undefined { return this.tools.get(name) }
  list(): ToolDef[] { return [...this.tools.values()] }

  /** Subset by name, used to expose only the tools whose integrations are connected. */
  only(names: Iterable<string>): ToolRegistry {
    const set = new Set(names)
    return new ToolRegistry(this.list().filter((t) => set.has(t.name)))
  }

  toSchemas(): ToolSchema[] {
    return this.list().map((t) => {
      const js = z.toJSONSchema(t.input) as Record<string, unknown>
      delete js.$schema
      return { name: wireName(t.name), description: t.description, input_schema: js }
    })
  }
}
