import { ProviderError } from '../../types.ts'
import type { TokenSource } from '../google/tokens.ts'

export interface GraphHttp { fetch: typeof fetch; tokens: TokenSource }
export const GRAPH = 'https://graph.microsoft.com/v1.0'

/** An id from the model or a URL, validated before it is placed into a request path or an OData filter. */
/** Graph ids are URL-safe base64 (letters, digits, '-', '_', '='). Slashes, dots and quotes are never valid, so they are refused outright. */
export const GRAPH_ID_RE = /^[A-Za-z0-9_\-=]{8,512}$/
export function assertGraphId(id: string, what: string): string {
  if (!GRAPH_ID_RE.test(id)) throw new ProviderError(`That is not a valid ${what}`, 'bad_request')
  return id
}

/** Authenticated Graph call: refreshes once on 401, maps errors to ProviderError, never leaks tokens. 202/204 return {}. */
export async function graph<T>(h: GraphHttp, path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const url = path.startsWith('https://') ? path : `${GRAPH}${path}`
  if (new URL(url).origin !== 'https://graph.microsoft.com') throw new ProviderError('Refusing to call a non-Graph URL', 'bad_request')
  const { prefer, ...rest } = init
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await h.tokens.getAccessToken(attempt === 1)
    const res = await h.fetch(url, {
      ...rest,
      headers: {
        ...(rest.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`,
        ...(rest.body ? { 'content-type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}),
      },
    })
    if (res.status === 401 && attempt === 0) continue
    if (res.ok) return (res.status === 202 || res.status === 204 ? {} : await res.json()) as T
    let detail = res.statusText
    try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail } catch { /* ignore */ }
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'unavailable' : 'bad_request'
    throw new ProviderError(`Microsoft Graph error (${res.status}): ${detail.slice(0, 200)}`, kind, res.status)
  }
  throw new ProviderError('Microsoft rejected the credentials', 'auth', 401)
}
