import { assertPublicHost, SsrfBlockedError, validateWebhookUrl, type ChannelKind } from './url.ts'

export type SendResult =
  | { ok: true }
  | { ok: false; retry: boolean; retryAfterSeconds?: number; error: string }

export interface WebhookDeps {
  fetch: typeof fetch
  /** resolves A + AAAA records; omit only in tests */
  resolve?: (host: string) => Promise<string[]>
  timeoutMs?: number
}

/** The URL is a secret: it must never appear in an error message, log line or audit entry. */
const scrub = (msg: string, url: string) => msg.split(url).join('[webhook]')

export async function postWebhook(kind: ChannelKind, url: string, payload: unknown, d: WebhookDeps): Promise<SendResult> {
  // re-validate at send time: the stored value could have been tampered with
  const check = validateWebhookUrl(kind, url)
  if (!check.ok) return { ok: false, retry: false, error: `The stored webhook URL is no longer valid: ${check.reason}` }
  try {
    if (d.resolve) await assertPublicHost(check.host, d.resolve)
  } catch (e) {
    const blocked = e instanceof SsrfBlockedError
    return { ok: false, retry: !blocked || (e as Error).message.includes('could not be resolved'), error: (e as Error).message }
  }

  let res: Response
  try {
    res = await d.fetch(check.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual', // a redirect could point somewhere internal; never follow it
      signal: AbortSignal.timeout(d.timeoutMs ?? 8000),
    })
  } catch (e) {
    return { ok: false, retry: true, error: scrub(`Could not reach the webhook: ${(e as Error).message ?? 'network error'}`, check.url).slice(0, 300) }
  }

  if (res.status >= 200 && res.status < 300) return { ok: true }
  if (res.status >= 300 && res.status < 400) return { ok: false, retry: false, error: `The webhook answered with a redirect (HTTP ${res.status}), which is not followed.` }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    return { ok: false, retry: true, retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : undefined, error: 'The webhook is rate limiting us (HTTP 429).' }
  }
  if (res.status >= 500) return { ok: false, retry: true, error: `The chat service had a problem (HTTP ${res.status}).` }
  const hint = res.status === 404 || res.status === 410 ? ' The webhook may have been deleted or revoked.' : ''
  return { ok: false, retry: false, error: `The webhook was rejected (HTTP ${res.status}).${hint}` }
}
