// Deno runtime helpers shared by every edge function. Contains no business logic.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { HandlerResult } from './core/handlers/common.ts'
import { corsHeaders, guard, readJson, toResponse } from './core/http.ts'

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

/** The verified caller, with what account-level actions need (read from the auth server, never from the request body). */
export async function verifiedUser(client: SupabaseClient, req: Request): Promise<{ id: string; email: string | null; lastSignInAt: string | null } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) return null
  return { id: data.user.id, email: data.user.email ?? null, lastSignInAt: data.user.last_sign_in_at ?? null }
}

/** A downloadable zip (the one binary response in the API). */
export function zipResponse(zip: Uint8Array, filename: string): Response {
  return new Response(new Uint8Array(zip), { // a fresh ArrayBuffer-backed copy satisfies BodyInit
    status: 200,
    headers: {
      ...corsHeaders(origin()), 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'no-store',
    },
  })
}
