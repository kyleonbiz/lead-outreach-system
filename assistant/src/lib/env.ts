import { z } from 'zod'

const schema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(20),
})

export type ClientEnv = z.infer<typeof schema>

/** Returns the validated env, or the names of the variables that are missing/invalid. */
export function readEnv(
  raw: Record<string, unknown>,
): { ok: true; env: ClientEnv } | { ok: false; missing: string[] } {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, env: parsed.data }
  const missing = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))]
  return { ok: false, missing }
}
