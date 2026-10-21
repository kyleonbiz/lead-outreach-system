import { describe, expect, it, vi } from 'vitest'
import { handleInvite, inviteLink, newInviteToken, sha256Hex, type InviteDeps } from './invitations.ts'
import { ProviderError } from '../types.ts'
import type { Role } from './common.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const APP = 'https://app.example.com'
const body = (o: Record<string, unknown> = {}) => ({ org_id: ORG, email: 'new.hire@acme.com', role: 'member', ...o })

function world(role: Role | null = 'owner', over: Partial<InviteDeps> = {}) {
  const created: Array<Parameters<InviteDeps['create']>[0]> = []
  const sent: Array<{ to: string; subject: string; text: string; idempotencyKey: string }> = []
  const audits: Array<Record<string, unknown>> = []
  const d: InviteDeps = {
    userId: 'owner-1', getRole: async () => role, appUrl: APP,
    mailer: { name: 'fake', send: async (m) => { sent.push(m); return { id: 'e1' } } },
    newToken: newInviteToken, sha256Hex,
    orgName: async () => 'Acme Plumbing', inviterName: async () => 'Jane Owner',
    create: async (a) => { created.push(a); return { ok: true, id: 'inv-1' } },
    audit: async (e) => { audits.push(e as unknown as Record<string, unknown>) },
    ...over,
  }
  return { d, created, sent, audits }
}
const tokenIn = (s: string) => /\/invite\/([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? ''

describe('invitation tokens', () => {
  it('are 256-bit random, URL-safe and never repeat', () => {
    const t = Array.from({ length: 500 }, newInviteToken)
    expect(new Set(t).size).toBe(500)
    expect(t.every((x) => /^[A-Za-z0-9_-]{43}$/.test(x))).toBe(true)
  })
  it('hash to 64 lowercase hex characters (the format the database requires)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') // SHA-256("abc")
    expect(await sha256Hex(newInviteToken())).toMatch(/^[0-9a-f]{64}$/)
  })
  it('the link is built from the app origin only', () => {
    expect(inviteLink('https://app.example.com/some/path?x=1', 'T')).toBe('https://app.example.com/invite/T')
    expect(inviteLink('javascript:alert(1)', 'T')).toBeNull()
    expect(inviteLink('not a url', 'T')).toBeNull()
  })
})

describe('creating an invitation', () => {
  it('stores ONLY the hash; the plaintext token exists only inside the e-mailed link', async () => {
    const w = world()
    const r = await handleInvite(w.d, body())
    expect(r).toMatchObject({ status: 200, body: { id: 'inv-1', emailed: true } })
    expect(w.sent).toHaveLength(1)
    const token = tokenIn(w.sent[0].text)
    expect(token).toHaveLength(43)
    expect(w.created[0].tokenHash).toBe(await sha256Hex(token))
    expect(JSON.stringify(w.created)).not.toContain(token) // the DB call never sees it
    expect(JSON.stringify(r.body)).not.toContain(token) // nor does the response when the e-mail went out
    expect(JSON.stringify(w.audits)).not.toContain(token)
  })
  it('sends to the invited address with the right content and a stable idempotency key', async () => {
    const w = world()
    await handleInvite(w.d, body({ email: '  New.Hire@ACME.com ', role: 'admin' }))
    expect(w.created[0]).toMatchObject({ actor: 'owner-1', org: ORG, email: 'new.hire@acme.com', role: 'admin', days: 7 })
    expect(w.sent[0].to).toBe('new.hire@acme.com')
    expect(w.sent[0].subject).toBe('Jane Owner invited you to Acme Plumbing on Aide')
    expect(w.sent[0].text).toContain('as an admin')
    expect(w.sent[0].text).toContain(`${APP}/invite/`)
    expect(w.sent[0].text).toContain('works once, only for new.hire@acme.com')
    expect(w.sent[0].idempotencyKey).toBe('aide-invite-inv-1')
    expect(w.audits[0]).toMatchObject({ action: 'invitation.emailed', status: 'success' })
  })
  it('each invitation gets a fresh token', async () => {
    const w = world()
    await handleInvite(w.d, body()); await handleInvite(w.d, body())
    expect(tokenIn(w.sent[0].text)).not.toBe(tokenIn(w.sent[1].text))
    expect(w.created[0].tokenHash).not.toBe(w.created[1].tokenHash)
  })
  it('only OWNERS can invite: admins, members and outsiders get 403 before anything is created', async () => {
    for (const role of ['admin', 'member', null] as const) {
      const w = world(role)
      expect((await handleInvite(w.d, body())).status).toBe(403)
      expect(w.created).toHaveLength(0)
      expect(w.sent).toHaveLength(0)
    }
    expect((await handleInvite(world('owner', { userId: null }).d, body())).status).toBe(401)
  })
  it('refuses the owner role, bad addresses, several addresses and extra fields (400)', async () => {
    const d = world().d
    for (const bad of [{ role: 'owner' }, { role: 'root' }, { email: 'nope' }, { email: 'a@b.com, c@d.com' }, { email: '' }, { org_id: 'x' }, { extra: 1 }]) {
      expect((await handleInvite(d, body(bad))).status).toBe(400)
    }
    expect((await handleInvite(d, null)).status).toBe(400)
  })
  it.each([
    ['42501', 403], ['23505', 409], ['53400', 429], ['22023', 422], ['23514', 422],
  ])('maps database refusal %s to HTTP %i without sending anything', async (code, status) => {
    const w = world('owner', { create: async () => ({ ok: false, code, message: 'refused: reason' }) })
    expect((await handleInvite(w.d, body())).status).toBe(status)
    expect(w.sent).toHaveLength(0)
  })
  it('surfaces the cap message to the owner and treats unknown database errors as 500s (thrown)', async () => {
    const cap = world('owner', { create: async () => ({ ok: false, code: '53400', message: 'Too many pending invitations; revoke some first' }) })
    expect((await handleInvite(cap.d, body())).body.error).toBe('Too many pending invitations; revoke some first')
    const weird = world('owner', { create: async () => ({ ok: false, code: 'XX000', message: 'internal detail' }) })
    await expect(handleInvite(weird.d, body())).rejects.toThrow() // the guard turns it into a generic 500
  })
})

describe('when the e-mail cannot be sent, the invitation is not lost and nothing is faked', () => {
  it('no mailer configured: returns the link ONCE with the reason, and audits the failure', async () => {
    const w = world('owner', { mailer: null, mailerMissing: ['RESEND_API_KEY'] })
    const r = await handleInvite(w.d, body())
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: 'inv-1', emailed: false })
    expect(String(r.body.reason)).toContain('RESEND_API_KEY')
    expect(String(r.body.link)).toMatch(new RegExp(`^${APP}/invite/[A-Za-z0-9_-]{43}$`))
    expect(w.created[0].tokenHash).toBe(await sha256Hex(tokenIn(String(r.body.link))))
    expect(w.audits[0]).toMatchObject({ action: 'invitation.email_failed', status: 'failure' })
    expect(JSON.stringify(w.audits)).not.toContain(tokenIn(String(r.body.link)))
  })
  it('provider failure: reports it and hands over the link', async () => {
    const w = world('owner', { mailer: { name: 'f', send: async () => { throw new ProviderError('The e-mail service is rate limiting us.', 'rate_limit') } } })
    const r = await handleInvite(w.d, body())
    expect(r.body).toMatchObject({ emailed: false, reason: 'The e-mail service is rate limiting us.' })
    expect(r.body.link).toBeTruthy()
  })
  it('an unexpected mailer error does not leak its details', async () => {
    const w = world('owner', { mailer: { name: 'f', send: async () => { throw new Error('socket hang up at 10.0.0.5:443 key=SECRET') } } })
    const r = await handleInvite(w.d, body())
    expect(JSON.stringify(r.body)).not.toContain('SECRET')
    expect(r.body.emailed).toBe(false)
  })
  it('an unusable APP_URL still creates the invitation but cannot produce a link', async () => {
    const w = world('owner', { appUrl: 'nonsense' })
    const r = await handleInvite(w.d, body())
    expect(r.body).toMatchObject({ emailed: false })
    expect(r.body.link).toBeUndefined()
    expect(w.sent).toHaveLength(0)
  })
})

describe('untrusted names in the e-mail', () => {
  it('cannot inject headers or extra lines into the subject', async () => {
    const w = world('owner', { orgName: async () => 'Evil\r\nBcc: spy@evil.test', inviterName: async () => 'Mallory\nSubject: hacked' })
    await handleInvite(w.d, body())
    expect(w.sent[0].subject).not.toMatch(/[\r\n]/)
  })
  it('falls back to neutral wording when names are missing', async () => {
    const w = world('owner', { orgName: async () => '', inviterName: async () => null })
    await handleInvite(w.d, body())
    expect(w.sent[0].subject).toBe('Someone invited you to their team on Aide')
  })
})

describe('mock call hygiene', () => {
  it('does not call the mailer when creation fails', async () => {
    const send = vi.fn()
    await handleInvite(world('owner', { mailer: { name: 'f', send }, create: async () => ({ ok: false, code: '23505', message: 'x' }) }).d, body())
    expect(send).not.toHaveBeenCalled()
  })
})
