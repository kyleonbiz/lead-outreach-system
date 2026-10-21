import type { LLMProvider, LLMRequest, LLMResponse } from '../types.ts'

type Step = LLMResponse | ((req: LLMRequest, call: number) => LLMResponse | Promise<LLMResponse>)

/** Deterministic provider for tests: plays back scripted responses and records every request. */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly requests: LLMRequest[] = []
  private i = 0
  constructor(private steps: Step[]) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req))
    const step = this.steps[this.i++]
    if (!step) throw new Error('ScriptedProvider: no more scripted responses')
    return typeof step === 'function' ? step(req, this.i - 1) : step
  }
}

export const text = (t: string): LLMResponse => ({
  content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
})
export const toolUse = (id: string, name: string, input: unknown, preface?: string): LLMResponse => ({
  content: [...(preface ? [{ type: 'text' as const, text: preface }] : []), { type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
})
