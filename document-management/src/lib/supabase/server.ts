import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createJsClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getServiceRoleKey, getSupabaseEnv } from "./env";

/** Supabase client bound to the signed-in user's session cookies (RLS applies). */
export async function createServerSupabase(): Promise<SupabaseClient> {
  const env = getSupabaseEnv();
  if (!env) throw new Error("Supabase is not configured");
  const store = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component; the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** Service-role client. Bypasses RLS: use only for the share-link route. */
export function createServiceSupabase(): SupabaseClient | null {
  const env = getSupabaseEnv();
  const key = getServiceRoleKey();
  if (!env || !key) return null;
  return createJsClient(env.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
