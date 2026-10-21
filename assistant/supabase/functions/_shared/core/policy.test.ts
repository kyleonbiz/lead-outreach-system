import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovalPolicy, BROAD_DOMAINS, decide, entryProblem, parsePolicy, recipientAllowed, validatePolicyInput } from './policy.ts'
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

describe('narrow rules: broad or unsafe pre-authorizations are rejected', () => {
  const email = (...allowed_recipients: string[]) => ({ auto_approve: [{ action: 'email.send', allowed_recipients }] })
  const cal = (...internal_domains: string[]) => ({ auto_approve: [{ action: 'calendar.create_event', internal_domains }] })

  it.each([
    ['whole free-mail domain', '@gmail.com'],
    ['another free-mail domain', '@outlook.com'],
    ['public suffix', '@co.uk'],
    ['bare TLD', '@com'],
    ['wildcard', '*'],
    ['wildcard domain', '@*.com'],
    ['domain without @ in an email rule', 'acme.com'],
    ['not an address', 'hello'],
    ['display-name injection', 'Boss <boss@acme.com>'],
    ['multiple addresses in one entry', 'a@acme.com,b@evil.com'],
    ['whitespace tricks', 'a@acme.com b@evil.com'],
    ['empty', ''],
  ])('email.send refuses %s', (_why, entry) => {
    expect(validatePolicyInput(email(entry)).ok).toBe(false)
    expect(parsePolicy(email(entry)).auto_approve).toEqual([])
  })

  it('still allows an exact address at a free-mail provider and a real company domain', () => {
    const r = validatePolicyInput(email('Boss@Gmail.com', '@Acme.com'))
    expect(r).toEqual({ ok: true, policy: { auto_approve: [{ action: 'email.send', allowed_recipients: ['boss@gmail.com', '@acme.com'] }] } })
  })

  it('calendar rules refuse broad domains and normalise bare domains', () => {
    expect(validatePolicyInput(cal('gmail.com')).ok).toBe(false)
    expect(validatePolicyInput(cal('@com')).ok).toBe(false)
    expect(validatePolicyInput(cal('acme.com', '@acme.com'))).toEqual({
      ok: true, policy: { auto_approve: [{ action: 'calendar.create_event', internal_domains: ['@acme.com'] }] },
    })
  })

  it('refuses actions that must never be pre-authorized, extra fields, duplicates and oversize lists', () => {
    for (const action of ['tasks.delete', 'payments.send', 'documents.delete', 'settings.update', 'contract.sign']) {
      expect(validatePolicyInput({ auto_approve: [{ action }] }).ok).toBe(false)
    }
    expect(validatePolicyInput({ auto_approve: [{ action: 'email.send', allowed_recipients: ['a@acme.com'], any_recipient: true }] }).ok).toBe(false)
    expect(ApprovalPolicy.safeParse({ auto_approve: [], extra: 1 }).success).toBe(false) // unknown fields are refused, not kept
    expect(validatePolicyInput({ auto_approve: [
      { action: 'email.send', allowed_recipients: ['a@acme.com'] }, { action: 'email.send', allowed_recipients: ['b@acme.com'] },
    ] }).ok).toBe(false)
    expect(validatePolicyInput(email(...Array.from({ length: 51 }, (_, i) => `u${i}@acme.com`))).ok).toBe(false)
    expect(validatePolicyInput(email()).ok).toBe(false) // an empty recipient list would match nothing useful
  })

  it('reports every problem at once, with the offending entry', () => {
    const r = validatePolicyInput(email('@gmail.com', 'nonsense'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toHaveLength(2)
      expect(r.errors.join(' ')).toContain('"@gmail.com"')
      expect(r.errors.join(' ')).toContain('"nonsense"')
    }
  })

  it('an empty policy is valid (everything needs approval)', () => {
    expect(validatePolicyInput({ auto_approve: [] })).toEqual({ ok: true, policy: { auto_approve: [] } })
    expect(validatePolicyInput(null)).toEqual({ ok: true, policy: { auto_approve: [] } })
  })

  it('entryProblem classifies directly', () => {
    expect(entryProblem('a@acme.com', 'recipient')).toBeNull()
    expect(entryProblem('@acme.com', 'recipient')).toBeNull()
    expect(entryProblem('acme.com', 'domain')).toBeNull()
    expect(entryProblem('@yahoo.com', 'recipient')).toMatch(/everyone/)
    expect(BROAD_DOMAINS.length).toBeGreaterThan(20)
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

describe('TypeScript and SQL narrowness rules stay identical', () => {
  it('BROAD_DOMAINS matches the list in migration 0008', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/0008_approval_rules.sql'), 'utf8')
    const block = /v_broad text\[\] := array\[([\s\S]*?)\];/.exec(sql)?.[1] ?? ''
    const sqlList = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(sqlList.length).toBeGreaterThan(20)
    expect(sqlList).toEqual([...BROAD_DOMAINS].sort())
  })
})
