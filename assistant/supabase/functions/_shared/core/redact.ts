const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|credential|cookie/i
const MAX_STRING = 300
const MAX_DEPTH = 6

/** Makes tool input/output safe to persist in the activity log: strips secrets, truncates long text. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more chars]` : value
  }
  if (typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[nested]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => redact(v, depth + 1))
    return value.length > 20 ? [...items, `[${value.length - 20} more items]`] : items
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
  }
  return out
}
