import { describe, expect, it } from 'vitest'
import { decide, parsePolicy, recipientAllowed } from './policy.ts'
import { checkRateLimit } from './ratelimit.ts'
import { redact } from './redact.ts'

const send = { name: 'email.send', risk: 'sensitive' as const }

describe('approval policy', () => {
  it('requires approval for sensitive tools by default and allows reads/writes', () => {
    const p = parsePolicy(undefined)
    expect(decide(send, { to: ['a@b.com'] }, p).kind).toBe('needs_approval')
    expect(decide({ name: 'tasks.create', risk: 'write' }, {}, p).kind).toBe('allow')
    expect(decide({ name: 'tasks.list', risk: 'read' }, {}, p).kind).toBe('allow')
  })

  it('narrow pre-authorization: ALL recipients must match', () => {
    const p = parsePolicy({ auto_approve: [{ action: 'email.send', allowed_recipients: ['@acme.com', 'boss@gmail.com'] }] })
    expect(decide(send, { to: ['x@acme.com'], cc: ['boss@gmail.com'] }, p).kind).toBe('allow')
    expect(decide(send, { to: ['x@acme.com', 'x@evil.com'] }, p).kind).toBe('needs_approval')
    expect(decide(send, { to: ['x@acme.com'], bcc: ['spy@evil.com'] }, p).kind).toBe('needs_approval')
    expect(decide(send, { to: [] }, p).kind).toBe('needs_approval')
  })

  it('domain rules cannot be bypassed by lookalike or suffix domains', () => {
    expect(recipientAllowed('a@acme.com', ['@acme.com'])).toBe(true)
    expect(recipientAllowed('a@evilacme.com', ['@acme.com'])).toBe(false)
    expect(recipientAllowed('a@acme.com.evil.test', ['@acme.com'])).toBe(false)
    expect(recipientAllowed('A@ACME.COM', ['@acme.com'])).toBe(true)
  })

  it('calendar events auto-approve only with internal-only attendees', () => {
    const cal = { name: 'calendar.create_event', risk: 'sensitive' as const }
    const p = parsePolicy({ auto_approve: [{ action: 'calendar.create_event', internal_domains: ['acme.com'] }] })
    expect(decide(cal, { attendees: [] }, p).kind).toBe('allow')
    expect(decide(cal, { attendees: ['a@acme.com'] }, p).kind).toBe('allow')
    expect(decide(cal, { attendees: ['a@acme.com', 'c@client.com'] }, p).kind).toBe('needs_approval')
  })

  it('invalid or hostile stored policy falls back to strictest', () => {
    expect(parsePolicy({ auto_approve: [{ action: 'tasks.delete' }] }).auto_approve).toEqual([])
    expect(parsePolicy({ auto_approve: [{ action: 'payments.send', amount: 1 }] }).auto_approve).toEqual([])
    expect(parsePolicy('nonsense').auto_approve).toEqual([])
  })
})

describe('rate limit', () => {
  it('allows under the limit and reports retry-after when over', () => {
    const now = 100_000
    expect(checkRateLimit([now - 5000, now - 4000], now, { max: 3, windowMs: 60_000 })).toEqual({ ok: true })
    const r = checkRateLimit([now - 50_000, now - 40_000, now - 30_000], now, { max: 3, windowMs: 60_000 })
    expect(r).toEqual({ ok: false, retryAfterSeconds: 10 })
  })
  it('ignores events outside the window', () => {
    expect(checkRateLimit([0, 1, 2, 3], 1_000_000, { max: 2, windowMs: 60_000 })).toEqual({ ok: true })
  })
})

describe('redact', () => {
  it('strips secrets, truncates long text and bounds depth', () => {
    const r = redact({ access_token: 'abc', nested: { Authorization: 'Bearer x', ok: 'fine' }, body: 'x'.repeat(1000) }) as any
    expect(r.access_token).toBe('[redacted]')
    expect(r.nested.Authorization).toBe('[redacted]')
    expect(r.nested.ok).toBe('fine')
    expect(r.body.length).toBeLessThan(400)
  })
})
