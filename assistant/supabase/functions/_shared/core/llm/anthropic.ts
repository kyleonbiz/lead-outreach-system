import { ProviderError, type Block, type LLMProvider, type LLMRequest, type LLMResponse } from '../types.ts'

export interface AnthropicOptions {
  apiKey: string
  fetch?: typeof fetch
  baseUrl?: string
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529])

/** Anthropic Messages API adapter. Retries transient failures with backoff and maps errors to ProviderError. */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  private f: typeof fetch
  private base: string
  private retries: number
  private sleep: (ms: number) => Promise<void>

  constructor(private opts: AnthropicOptions) {
    if (!opts.apiKey) throw new ProviderError('ANTHROPIC_API_KEY is not set', 'auth')
    this.f = opts.fetch ?? fetch
    this.base = opts.baseUrl ?? 'https://api.anthropic.com'
    this.retries = opts.maxRetries ?? 3
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const body = JSON.stringify({
      model: req.model, max_tokens: req.max_tokens, system: req.system, messages: req.messages,
      ...(req.tools.length ? { tools: req.tools } : {}),
    })

    let lastErr: ProviderError | null = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let res: Response
      try {
        res = await this.f(`${this.base}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body,
        })
      } catch {
        lastErr = new ProviderError('Could not reach the AI provider', 'unavailable')
        if (attempt < this.retries) { await this.sleep(backoff(attempt)); continue }
        throw lastErr
      }

      if (res.ok) return parse(await res.json())

      const status = res.status
      const detail = await safeMessage(res)
      const kind = status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : status >= 500 ? 'unavailable' : 'bad_request'
      lastErr = new ProviderError(`AI provider error (${status}): ${detail}`, kind, status)
      if (RETRYABLE.has(status) && attempt < this.retries) {
        const ra = Number(res.headers.get('retry-after'))
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : backoff(attempt))
        continue
      }
      throw lastErr
    }
    throw lastErr ?? new ProviderError('AI provider failed', 'unknown')
  }
}

const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8000)

async function safeMessage(res: Response): Promise<string> {
  try {
    const j = await res.json() as { error?: { message?: string } }
    return (j.error?.message ?? res.statusText).slice(0, 300)
  } catch { return res.statusText }
}

function parse(j: any): LLMResponse {
  const content: Block[] = (j.content ?? []).flatMap((b: any): Block[] => {
    if (b.type === 'text') return [{ type: 'text', text: String(b.text ?? '') }]
    if (b.type === 'tool_use') return [{ type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input ?? {} }]
    return []
  })
  const sr = j.stop_reason
  return {
    content,
    stop_reason: sr === 'end_turn' || sr === 'tool_use' || sr === 'max_tokens' ? sr : 'other',
    usage: { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: j.usage?.output_tokens ?? 0 },
  }
}
