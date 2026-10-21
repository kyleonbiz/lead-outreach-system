// Deno runtime helpers shared by every edge function. Contains no business logic.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { HandlerResult } from './core/handlers/common.ts'
import { guard, readJson, toResponse } from './core/http.ts'

export const env = (k: string): string | undefined => Deno.env.get(k) || undefined

const origin = () => env('APP_URL')

export const json = (r: HandlerResult): Response => toResponse(r, origin())
export { readJson }

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

/** Wraps a handler: CORS preflight and a generic 500 for unexpected errors. */
export const guarded = (fn: (req: Request) => Promise<Response>) => guard(fn, origin)
