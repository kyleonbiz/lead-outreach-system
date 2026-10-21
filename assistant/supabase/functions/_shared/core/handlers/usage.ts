import { z } from 'zod'
import { fail, isAdmin, ok, type HandlerResult, type Role } from './common.ts'

export const DEFAULT_DAILY_TOKEN_LIMIT = 500_000

/**
 * The per-organization daily token budget from the server setting. Unset = default; "0" = explicitly unlimited.
 * A typo ("abc", "-5", "1e999") must NOT silently remove the limit, so anything unusable falls back to the default.
 */
export function parseDailyTokenLimit(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_DAILY_TOKEN_LIMIT
  const t = raw.trim()
  // plain decimal digits only: Number() would also accept "0x10" (16), "1e3" and " " (0), which are typos, not intentions
  return /^\d{1,15}$/.test(t) ? Number(t) : DEFAULT_DAILY_TOKEN_LIMIT
}

const Request = z.strictObject({ org_id: z.uuid(), days: z.number().int().min(1).max(90).default(30) })

export interface UsageSummary {
  window_days: number
  from: string
  tokens_today: number
  daily: Array<{ day: string; input_tokens: number; output_tokens: number; tool_calls: number }>
  totals: { input_tokens: number; output_tokens: number; tool_calls: number }
  by_model: Array<{ model: string; input_tokens: number; output_tokens: number }>
  tools: Array<{ tool: string; calls: number; failures: number }>
  workflow_runs: Record<string, number>
  storage: { bytes: number; documents: number }
}

export interface UsageDeps {
  userId: string | null
  now(): Date
  getRole(orgId: string): Promise<Role | null>
  /** the database function, called with the caller's own token (Row Level Security applies) */
  summary(orgId: string, days: number): Promise<UsageSummary>
  /** 0 = unlimited */
  dailyTokenLimit: number
}

const nextUtcMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()

export async function handleUsage(d: UsageDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = Request.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  if (!isAdmin(await d.getRole(p.data.org_id))) return fail(403, 'Only owners and admins can see usage')

  const s = await d.summary(p.data.org_id, p.data.days)
  const limit = d.dailyTokenLimit > 0 ? d.dailyTokenLimit : null
  return ok({
    ...s,
    today: {
      tokens: s.tokens_today, limit,
      // not capped at 100: if an organization is over its limit the screen should say so plainly
      percent: limit ? Math.round((s.tokens_today / limit) * 1000) / 10 : null,
      remaining: limit ? Math.max(0, limit - s.tokens_today) : null,
      resets_at: nextUtcMidnight(d.now()),
    },
    generated_at: d.now().toISOString(),
  })
}
