/** Offset of `tz` from UTC at instant `at`, in ms (local = utc + offset). */
export function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Local midnight (in `tz`) of the day containing `at`, shifted by `addDays` calendar days. DST-safe. */
export function zonedStartOfDay(at: Date, tz: string, addDays = 0): Date {
  const local = new Date(at.getTime() + tzOffsetMs(at, tz))
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays)
  let guess = target
  for (let i = 0; i < 3; i++) guess = target - tzOffsetMs(new Date(guess), tz)
  return new Date(guess)
}
