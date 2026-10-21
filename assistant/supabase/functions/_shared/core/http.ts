import type { HandlerResult } from './handlers/common.ts'

// Pure HTTP helpers shared by every edge function (kept free of Deno APIs so they are unit-tested).

export const MAX_BODY_BYTES = 1_000_000

export function corsHeaders(allowOrigin: string | undefined): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowOrigin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  }
}

export function toResponse(r: HandlerResult, allowOrigin?: string): Response {
  if (r.status === 302 && typeof r.body.location === 'string') {
    return new Response(null, { status: 302, headers: { Location: r.body.location } })
  }
  return new Response(JSON.stringify(r.body), {
    status: r.status, headers: { ...corsHeaders(allowOrigin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** Parses a JSON body, refusing anything larger than `maxBytes`. Returns null for missing/invalid/oversized bodies. */
export async function readJson(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  try {
    const text = await req.text()
    if (text.length > maxBytes) return null
    return JSON.parse(text)
  } catch { return null }
}

/** CORS preflight + a last-resort error boundary: unexpected errors become a generic 500, details go to the logs only. */
export function guard(
  fn: (req: Request) => Promise<Response>, allowOrigin: () => string | undefined, log: (...a: unknown[]) => void = console.error,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(allowOrigin()) })
    try {
      return await fn(req)
    } catch (e) {
      log('unhandled', e instanceof Error ? e.stack : e)
      return toResponse({ status: 500, body: { error: 'Internal error' } }, allowOrigin())
    }
  }
}
