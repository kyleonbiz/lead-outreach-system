export interface RateLimit { max: number; windowMs: number }

/** Sliding-window check over prior event timestamps (ms). */
export function checkRateLimit(
  eventTimes: number[], now: number, limit: RateLimit,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const recent = eventTimes.filter((t) => now - t < limit.windowMs).sort((a, b) => a - b)
  if (recent.length < limit.max) return { ok: true }
  const oldestBlocking = recent[recent.length - limit.max]
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldestBlocking + limit.windowMs - now) / 1000)) }
}
