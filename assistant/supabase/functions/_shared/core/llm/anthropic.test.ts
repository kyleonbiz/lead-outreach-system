import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from './anthropic.ts'
import { ProviderError } from '../types.ts'
import { buildRegistry } from '../tools/index.ts'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const err = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers })
const req = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [], max_tokens: 100 }

describe('AnthropicProvider (mocked HTTP)', () => {
  it('sends the key only as a header and parses text + tool_use + usage', async () => {
    const f = vi.fn().mockResolvedValue(ok({
      content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu', name: 'tasks__list', input: { limit: 5 } }, { type: 'thinking' }],
      stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 7 },
    }))
    const p = new AnthropicProvider({ apiKey: 'sk-secret', fetch: f as any })
    const r = await p.complete({ ...req, tools: buildRegistry().toSchemas() })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-secret')
    expect(init.body).not.toContain('sk-secret')
    const sent = JSON.parse(init.body)
    expect(sent.tools.map((t: any) => t.name)).toContain('tasks__create')
    expect(sent.tools[0].input_schema.type).toBe('object')
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu', name: 'tasks__list', input: { limit: 5 } }])
    expect(r.stop_reason).toBe('tool_use')
    expect(r.usage).toEqual({ input_tokens: 11, output_tokens: 7 })
  })

  it('retries transient errors with backoff, honoring retry-after', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const f = vi.fn()
      .mockResolvedValueOnce(err(429, 'slow down', { 'retry-after': '2' }))
      .mockResolvedValueOnce(err(529, 'overloaded'))
      .mockResolvedValueOnce(ok({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }))
    const r = await new AnthropicProvider({ apiKey: 'k', fetch: f as any, sleep }).complete(req)
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' })
    expect(f).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls[0][0]).toBe(2000)
  })

  it('does not retry auth/bad-request errors and maps them', async () => {
    const f = vi.fn().mockResolvedValue(err(401, 'invalid x-api-key'))
    await expect(new AnthropicProvider({ apiKey: 'k', fetch: f as any, sleep: async () => {} }).complete(req))
      .rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('gives up after max retries and reports unavailable; network errors are mapped too', async () => {
    const f = vi.fn().mockResolvedValue(err(503, 'down'))
    await expect(new AnthropicProvider({ apiKey: 'k', fetch: f as any, sleep: async () => {}, maxRetries: 2 }).complete(req))
      .rejects.toMatchObject({ kind: 'unavailable' })
    expect(f).toHaveBeenCalledTimes(3)
    const net = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await expect(new AnthropicProvider({ apiKey: 'k', fetch: net as any, sleep: async () => {}, maxRetries: 1 }).complete(req))
      .rejects.toBeInstanceOf(ProviderError)
  })

  it('refuses to construct without a key', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/ANTHROPIC_API_KEY/)
  })
})
