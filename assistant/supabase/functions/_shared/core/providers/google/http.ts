import { ProviderError } from '../../types.ts'
import type { TokenSource } from './tokens.ts'

export interface GoogleHttp { fetch: typeof fetch; tokens: TokenSource }

/** Authenticated Google API call: refreshes once on 401, maps errors to ProviderError, never leaks tokens. */
export async function gjson<T>(h: GoogleHttp, url: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await h.tokens.getAccessToken(attempt === 1)
    const res = await h.fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    })
    if (res.status === 401 && attempt === 0) continue
    if (res.ok) return (res.status === 204 ? {} : await res.json()) as T
    let detail = res.statusText
    try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail } catch { /* ignore */ }
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'unavailable' : 'bad_request'
    throw new ProviderError(`Google API error (${res.status}): ${detail.slice(0, 200)}`, kind, res.status)
  }
  throw new ProviderError('Google rejected the credentials', 'auth', 401)
}
