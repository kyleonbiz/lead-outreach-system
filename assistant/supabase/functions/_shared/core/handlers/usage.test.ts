import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DAILY_TOKEN_LIMIT, handleUsage, parseDailyTokenLimit, type UsageDeps, type UsageSummary } from './usage.ts'
import type { Role } from './common.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-10-21T15:30:00Z')
const summary = (o: Partial<UsageSummary> = {}): UsageSummary => ({
  window_days: 30, from: '2026-09-22T00:00:00Z', tokens_today: 120_000, daily: [], totals: { input_tokens: 1, output_tokens: 2, tool_calls: 3 },
  by_model: [], tools: [], workflow_runs: {}, storage: { bytes: 4000, documents: 2 }, ...o,
})
function world(role: Role | null = 'admin', over: Partial<UsageDeps> = {}) {
  const calls: Array<[string, number]> = []
  const d: UsageDeps = {
    userId: 'u1', now: () => NOW, getRole: async () => role, dailyTokenLimit: 500_000,
    summary: async (org, days) => { calls.push([org, days]); return summary() }, ...over,
  }
  return { d, calls }
}

describe('who can see usage', () => {
  it('owners and admins only; everyone else is refused before anything is read', async () => {
    for (const role of ['owner', 'admin'] as const) expect((await handleUsage(world(role).d, { org_id: ORG })).status).toBe(200)
    for (const role of ['member', null] as const) {
      const w = world(role)
      expect((await handleUsage(w.d, { org_id: ORG })).status).toBe(403)
      expect(w.calls).toHaveLength(0)
    }
    expect((await handleUsage(world('owner', { userId: null }).d, { org_id: ORG })).status).toBe(401)
  })
  it('validates the request (window 1-90 days, no extra fields)', async () => {
    for (const bad of [null, {}, { org_id: 'x' }, { org_id: ORG, days: 0 }, { org_id: ORG, days: 91 }, { org_id: ORG, days: 1.5 }, { org_id: ORG, extra: 1 }]) {
      expect((await handleUsage(world().d, bad)).status).toBe(400)
    }
  })
  it('asks the database for exactly the requested organization and window (default 30)', async () => {
    const w = world()
    await handleUsage(w.d, { org_id: ORG })
    await handleUsage(w.d, { org_id: ORG, days: 7 })
    expect(w.calls).toEqual([[ORG, 30], [ORG, 7]])
  })
})

describe("today's budget", () => {
  it('reports use, remaining and when it resets (next UTC midnight)', async () => {
    const r = await handleUsage(world().d, { org_id: ORG })
    expect(r.body.today).toEqual({ tokens: 120_000, limit: 500_000, percent: 24, remaining: 380_000, resets_at: '2026-10-22T00:00:00.000Z' })
    expect(r.body.generated_at).toBe(NOW.toISOString())
    expect(r.body.storage).toEqual({ bytes: 4000, documents: 2 })
  })
  it('says plainly when the limit is exceeded (percent is not capped, remaining is never negative)', async () => {
    const r = await handleUsage(world('admin', { summary: async () => summary({ tokens_today: 650_000 }) }).d, { org_id: ORG })
    expect(r.body.today).toMatchObject({ percent: 130, remaining: 0 })
  })
  it('an unlimited organization has no limit, percentage or remainder (not 0 / Infinity)', async () => {
    const r = await handleUsage(world('admin', { dailyTokenLimit: 0 }).d, { org_id: ORG })
    expect(r.body.today).toMatchObject({ limit: null, percent: null, remaining: null })
  })
  it('the reset time rolls over correctly at month and year ends', async () => {
    const r = await handleUsage(world('admin', { now: () => new Date('2026-12-31T23:59:59Z') }).d, { org_id: ORG })
    expect((r.body.today as { resets_at: string }).resets_at).toBe('2027-01-01T00:00:00.000Z')
  })
  it('does not call the database when refused (no data leaves for a non-admin)', async () => {
    const summaryFn = vi.fn()
    await handleUsage(world('member', { summary: summaryFn }).d, { org_id: ORG })
    expect(summaryFn).not.toHaveBeenCalled()
  })
})

describe('parseDailyTokenLimit: a typo must never remove the limit', () => {
  it('uses the default when unset or blank', () => {
    expect(parseDailyTokenLimit(undefined)).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
    expect(parseDailyTokenLimit(null)).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
    expect(parseDailyTokenLimit('')).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
    expect(parseDailyTokenLimit('   ')).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
  })
  it('accepts a real number, and "0" as an explicit choice of unlimited', () => {
    expect(parseDailyTokenLimit('250000')).toBe(250_000)
    expect(parseDailyTokenLimit(' 1000 ')).toBe(1000)
    expect(parseDailyTokenLimit('0')).toBe(0)
  })
  it.each(['abc', '-5', '1.5', '1e999', '1e3', 'Infinity', 'NaN', '500k', '5,000', '0x10', '+5', '0b11', '12345678901234567890'])('falls back to the default for %s (never to unlimited)', (v) => {
    expect(parseDailyTokenLimit(v)).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
  })
})
