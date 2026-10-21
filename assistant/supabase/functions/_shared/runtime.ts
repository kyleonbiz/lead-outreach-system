// Deno runtime helpers shared by every edge function. Contains no business logic.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { HandlerResult } from './core/handlers/common.ts'

export const env = (k: string): string | undefined => Deno.env.get(k) || undefined

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env('APP_URL') ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  }
}

export function json(r: HandlerResult): Response {
  if (r.status === 302 && typeof r.body.location === 'string') {
    return new Response(null, { status: 302, headers: { Location: r.body.location } })
  }
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders() }) : null
}

function requireEnv(k: string): string {
  const v = env(k)
  if (!v) throw new Error(`Missing server environment variable ${k}`)
  return v
}

/** Client acting AS THE CALLER: Row Level Security applies to everything it does. */
export function userClient(req: Request): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Privileged client (bypasses RLS). Only for server-owned writes: logs, approvals, credentials, jobs. */
export function serviceClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function verifiedUserId(client: SupabaseClient, req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await client.auth.getUser(token)
  return error ? null : data.user?.id ?? null
}

export async function readJson(req: Request): Promise<unknown> {
  try { return await req.json() } catch { return null }
}

/** Wraps a handler so unexpected errors become a generic 500 (details go to logs, never to the client). */
export function guarded(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    const pre = preflight(req)
    if (pre) return pre
    try {
      return await fn(req)
    } catch (e) {
      console.error('unhandled', e instanceof Error ? e.stack : e)
      return json({ status: 500, body: { error: 'Internal error' } })
    }
  }
}
