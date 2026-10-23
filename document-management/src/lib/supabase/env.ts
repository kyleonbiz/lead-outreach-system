export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

/** Public (browser-safe) Supabase settings, or null when not configured. */
export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Server-only. Never import this from a client component. */
export function getServiceRoleKey(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

/**
 * In-memory "development mode" is only allowed when Supabase is not configured
 * AND we are not in production, unless explicitly forced with DMS_ALLOW_DEV_MODE=true.
 */
export function devModeAllowed(): boolean {
  if (getSupabaseEnv()) return false;
  return process.env.NODE_ENV !== "production" || process.env.DMS_ALLOW_DEV_MODE === "true";
}
