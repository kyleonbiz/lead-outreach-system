import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readEnv } from './env'

const result = readEnv(import.meta.env as Record<string, unknown>)

export const envStatus = result

/** Only the anon key ever reaches the browser; all data access is gated by Row Level Security. */
export const supabase: SupabaseClient | null = result.ok
  ? createClient(result.env.VITE_SUPABASE_URL, result.env.VITE_SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

export function db(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured')
  return supabase
}
