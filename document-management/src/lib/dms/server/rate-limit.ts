export interface RateRule {
  /** Namespace so different limits for one caller do not share a counter. */
  name: string;
  max: number;
  windowMs: number;
}

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * Sliding-window limiter held in this process's memory.
 *
 * It is per instance: on a multi-instance or serverless deployment each
 * instance counts separately, so the effective limit is `max × instances` and
 * counters reset on restart. It blunts accidental loops and casual abuse; put a
 * shared limiter (CDN/WAF rule or Redis) in front for hard guarantees.
 */
const g = globalThis as unknown as { __dmsRate?: Map<string, number[]> };
const hits = (g.__dmsRate ??= new Map<string, number[]>());
const MAX_KEYS = 10_000;

export function checkRate(key: string, rule: RateRule, now = Date.now()): RateResult {
  const id = `${rule.name}:${key}`;
  const windowStart = now - rule.windowMs;
  const recent = (hits.get(id) ?? []).filter((t) => t > windowStart);
  if (recent.length >= rule.max) {
    hits.set(id, recent);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + rule.windowMs - now) / 1000)) };
  }
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > MAX_KEYS) prune(now, rule.windowMs);
  return { ok: true, retryAfterSec: 0 };
}

function prune(now: number, windowMs: number) {
  for (const [k, v] of hits) {
    if (!v.length || v[v.length - 1] <= now - windowMs) hits.delete(k);
  }
  // Still over budget (every key active): drop the oldest entries.
  for (const k of hits.keys()) {
    if (hits.size <= MAX_KEYS) break;
    hits.delete(k);
  }
}

export function resetRateLimits() {
  hits.clear();
}

/** Best-effort client address for unauthenticated routes. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "unknown";
}

export const MUTATION_RATE: RateRule = { name: "mutate", max: 120, windowMs: 60_000 };
export const UPLOAD_RATE: RateRule = { name: "upload-init", max: 60, windowMs: 60_000 };
export const SHARE_CREATE_RATE: RateRule = { name: "share-create", max: 20, windowMs: 60_000 };
export const INVITE_RATE: RateRule = { name: "invite", max: 20, windowMs: 60 * 60_000 };
export const PUBLIC_SHARE_RATE: RateRule = { name: "share-public", max: 60, windowMs: 60_000 };
