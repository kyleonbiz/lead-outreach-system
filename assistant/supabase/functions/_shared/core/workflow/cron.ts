import { tzOffsetMs } from '../time.ts'

// Minimal 5-field cron (minute hour day-of-month month day-of-week). Supports *, lists, ranges, steps.
// Evaluated in the organization's time zone so "0 8 * * 1-5" means 8:00 local, DST included.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 }, { name: 'hour', min: 0, max: 23 }, { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 }, { name: 'day of week', min: 0, max: 7 },
] as const

function parseField(src: string, min: number, max: number): Set<number> | string {
  const out = new Set<number>()
  for (const part of src.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!m) return `invalid segment "${part}"`
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) return 'step must be at least 1'
    let lo: number, hi: number
    if (m[1] === '*') { lo = min; hi = max } else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number) } else { lo = Number(m[1]); hi = m[2] ? max : lo }
    if (lo < min || hi > max || lo > hi) return `"${part}" is out of range (${min}-${max})`
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export interface ParsedCron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

export function parseCron(expr: string): ParsedCron | { error: string } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return { error: 'Use 5 fields: minute hour day-of-month month day-of-week' }
  const sets: Array<Set<number>> = []
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], FIELDS[i].min, FIELDS[i].max)
    if (typeof r === 'string') return { error: `${FIELDS[i].name}: ${r}` }
    sets.push(r)
  }
  const dow = new Set([...sets[4]].map((d) => d % 7))
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' }
}

export function validateCron(expr: string): string | null {
  const r = parseCron(expr)
  return 'error' in r ? r.error : null
}

/** Local wall-clock fields of `at` in `tz`. */
export function localParts(at: Date, tz: string) {
  const l = new Date(at.getTime() + tzOffsetMs(at, tz))
  return { minute: l.getUTCMinutes(), hour: l.getUTCHours(), dom: l.getUTCDate(), month: l.getUTCMonth() + 1, dow: l.getUTCDay(),
    key: `${l.getUTCFullYear()}${String(l.getUTCMonth() + 1).padStart(2, '0')}${String(l.getUTCDate()).padStart(2, '0')}${String(l.getUTCHours()).padStart(2, '0')}${String(l.getUTCMinutes()).padStart(2, '0')}` }
}

export function cronMatches(expr: string, at: Date, tz: string): boolean {
  const c = parseCron(expr)
  if ('error' in c) return false
  const p = localParts(at, tz)
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false
  const domOk = c.dom.has(p.dom), dowOk = c.dow.has(p.dow)
  // standard cron: when both day fields are restricted, either may match
  return c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk
}
