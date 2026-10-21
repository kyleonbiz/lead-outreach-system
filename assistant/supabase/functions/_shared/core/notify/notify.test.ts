import { describe, expect, it, vi } from 'vitest'
import { appLink, clean, emailMessage, slackPayload, teamsPayload, type Outgoing } from './format.ts'
import { mailerFromEnv, resendMailer } from './mailer.ts'
import { postWebhook } from './webhook.ts'
import { backoffSeconds, dispatchDeliveries, type Claimed, type DispatchDeps } from './dispatch.ts'
import { ProviderError } from '../types.ts'

const APP = 'https://app.example.com'
const SLACK = ['https://hooks.slack.com', 'services', 'T0000', 'B0000', 'abcdefghijkl'].join('/') // runtime-built: no secret-shaped literal
const n = (o: Partial<Outgoing> = {}): Outgoing => ({ type: 'workflow_failed', title: 'Workflow "Daily" failed', body: 'Step 2: boom', link: '/workflows', orgName: 'Acme', ...o })
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('format: untrusted text is neutralised', () => {
  it('Slack: no mentions, no forged links, no raw markup', () => {
    const p = slackPayload(n({ title: '<!channel> urgent', body: 'Click <https://evil.test|here> & <@U123> *now*' }), APP)
    const json = JSON.stringify(p)
    expect(json).not.toContain('<!channel>')
    expect(json).not.toContain('<https://evil.test|here>')
    expect(json).not.toContain('<@U123>')
    expect(json).toContain('&lt;!channel&gt; urgent')
    expect(json).toContain('&amp;')
    // the only <...> in the message is our own link
    expect([...json.matchAll(/<[^>]*>/g)].map((m) => m[0])).toEqual([`<${APP}/workflows|Open Aide>`])
  })
  it('Teams: breaks markdown links and strips HTML', () => {
    const body = JSON.stringify(teamsPayload(n({ body: 'see [click](https://evil.test) <img src=x onerror=1>' }), APP))
    expect(body).not.toContain('](')
    expect(body).not.toContain('<img')
    expect(body).toContain('application/vnd.microsoft.card.adaptive')
    expect(body).toContain(`${APP}/workflows`)
  })
  it('e-mail is plain text, subject has no line breaks, only internal links', () => {
    const m = emailMessage(n({ title: 'Bcc: attacker@evil.test\r\nSubject: hi', link: 'https://evil.test/phish' }), APP)
    expect(m.subject).not.toMatch(/[\r\n]/)
    expect(m.text).not.toContain('evil.test/phish')
    expect(m.text).toContain(`${APP}/settings`)
    expect(m.subject.startsWith('[Aide] ')).toBe(true)
  })
  it.each(['//evil.test', 'https://evil.test', 'javascript:alert(1)', '/a\\b', '/x y', '', null])('appLink refuses %s', (l) => {
    expect(appLink(l as string | null, APP)).toBeNull()
  })
  it('appLink accepts app paths and refuses a non-http app URL', () => {
    expect(appLink('/tasks?x=1', APP)).toBe(`${APP}/tasks?x=1`)
    expect(appLink('/tasks', 'ftp://x')).toBeNull()
  })
  it('clean strips control and bidi characters, collapses blank lines and truncates', () => {
    expect(clean('a\u0000b‮c\n\n\n\nd', 100)).toBe('abc\n\nd')
    expect(clean('x'.repeat(50), 10)).toHaveLength(10)
    expect(clean(null, 10)).toBe('')
  })
})

describe('Resend mailer', () => {
  it('posts the right request with an idempotency key and returns the id', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { id: 'em_1' }))
    const out = await resendMailer({ apiKey: 'k', from: 'Aide <a@x.com>' }, f).send({ to: 'u@acme.com', subject: 'S', text: 'T', idempotencyKey: 'k1' })
    expect(out).toEqual({ id: 'em_1' })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(init.headers['Idempotency-Key']).toBe('k1')
    expect(JSON.parse(init.body)).toEqual({ from: 'Aide <a@x.com>', to: ['u@acme.com'], subject: 'S', text: 'T' })
  })
  it.each([[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'unavailable'], [503, 'unavailable'], [422, 'bad_request']])('HTTP %s is a %s error', async (status, kind) => {
    const f = vi.fn().mockResolvedValue(res(status, { message: 'nope' }))
    await expect(resendMailer({ apiKey: 'k', from: 'a@x.com' }, f).send({ to: 'u@a.com', subject: 's', text: 't', idempotencyKey: 'i' }))
      .rejects.toMatchObject({ kind })
  })
  it('network failure is retryable and never leaks the API key', async () => {
    const f = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED with key=SECRETKEY'))
    const e = await resendMailer({ apiKey: 'SECRETKEY', from: 'a@x.com' }, f).send({ to: 'u@a.com', subject: 's', text: 't', idempotencyKey: 'i' }).catch((x) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.kind).toBe('unavailable')
    expect(e.message).not.toContain('SECRETKEY')
  })
  it('mailerFromEnv reports exactly what is missing and validates the sender', () => {
    expect(mailerFromEnv({})).toEqual({ ok: false, missing: ['RESEND_API_KEY', 'NOTIFY_FROM_EMAIL'] })
    expect(mailerFromEnv({ RESEND_API_KEY: 'k' })).toEqual({ ok: false, missing: ['NOTIFY_FROM_EMAIL'] })
    expect(mailerFromEnv({ RESEND_API_KEY: 'k', NOTIFY_FROM_EMAIL: 'a@x.com\nBcc: evil@x.com' }).ok).toBe(false)
    expect(mailerFromEnv({ RESEND_API_KEY: 'k', NOTIFY_FROM_EMAIL: 'x', NOTIFY_EMAIL_PROVIDER: 'sendgrid' }).ok).toBe(false)
    expect(mailerFromEnv({ RESEND_API_KEY: 'k', NOTIFY_FROM_EMAIL: 'Aide <noreply@acme.com>' }).ok).toBe(true)
  })
})

describe('postWebhook', () => {
  const ok = (r: Response) => ({ fetch: vi.fn().mockResolvedValue(r) as unknown as typeof fetch })
  it('sends JSON to the validated URL, never following redirects', async () => {
    const d = ok(res(200, 'ok'))
    expect(await postWebhook('slack', SLACK, { text: 'hi' }, d)).toEqual({ ok: true })
    const [url, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(SLACK)
    expect(init.redirect).toBe('manual')
    expect(init.method).toBe('POST')
  })
  it.each([[301], [302], [307]])('a %s redirect is a permanent failure', async (s) => {
    expect(await postWebhook('slack', SLACK, {}, ok(res(s, {}, { location: 'http://169.254.169.254/' })))).toMatchObject({ ok: false, retry: false })
  })
  it.each([[400, false], [401, false], [403, false], [404, false], [410, false], [429, true], [500, true], [502, true]])('HTTP %s retry=%s', async (s, retry) => {
    expect(await postWebhook('slack', SLACK, {}, ok(res(s)))).toMatchObject({ ok: false, retry })
  })
  it('explains a revoked webhook and honours Retry-After (bounded)', async () => {
    expect(await postWebhook('slack', SLACK, {}, ok(res(404)))).toMatchObject({ error: expect.stringContaining('revoked') })
    expect(await postWebhook('slack', SLACK, {}, ok(res(429, {}, { 'retry-after': '120' })))).toMatchObject({ retryAfterSeconds: 120 })
    expect(await postWebhook('slack', SLACK, {}, ok(res(429, {}, { 'retry-after': '999999' })))).toMatchObject({ retryAfterSeconds: 3600 })
  })
  it('a network error is retryable and the secret URL is scrubbed from the message', async () => {
    const f = vi.fn().mockRejectedValue(new Error(`fetch failed: ${SLACK}`)) as unknown as typeof fetch
    const r = await postWebhook('slack', SLACK, {}, { fetch: f })
    expect(r).toMatchObject({ ok: false, retry: true })
    expect(JSON.stringify(r)).not.toContain('abcdefghijkl')
  })
  it('refuses a tampered stored URL without making any request', async () => {
    const d = ok(res(200))
    const r = await postWebhook('slack', 'https://169.254.169.254/services/T/B/xxxx', {}, d)
    expect(r).toMatchObject({ ok: false, retry: false })
    expect(d.fetch).not.toHaveBeenCalled()
  })
  it('blocks a host that resolves to a private address, without sending (and does not retry)', async () => {
    const d = { ...ok(res(200)), resolve: async () => ['10.0.0.8'] }
    expect(await postWebhook('slack', SLACK, {}, d)).toMatchObject({ ok: false, retry: false })
    expect(d.fetch).not.toHaveBeenCalled()
  })
  it('a DNS failure is retryable (transient), but still sends nothing', async () => {
    const d = { ...ok(res(200)), resolve: async () => { throw new Error('nx') } }
    expect(await postWebhook('slack', SLACK, {}, d)).toMatchObject({ ok: false, retry: true })
    expect(d.fetch).not.toHaveBeenCalled()
  })
})

const claimed = (o: Partial<Claimed> = {}): Claimed => ({
  id: 'd1', orgId: 'o1', channel: 'email', channelId: null, attempts: 1, recipientEmail: 'u@acme.com', notification: n(), ...o,
})

function deps(items: Claimed[], over: Partial<DispatchDeps> = {}) {
  const complete = vi.fn().mockResolvedValue(undefined)
  const send = vi.fn().mockResolvedValue({ id: 'e1' })
  const d: DispatchDeps = {
    claim: async () => items, complete, webhookUrl: async () => SLACK,
    mailer: { name: 'fake', send }, fetch: vi.fn().mockResolvedValue(res(200)) as unknown as typeof fetch, appUrl: APP, ...over,
  }
  return { d, complete, send }
}

describe('dispatchDeliveries', () => {
  it('sends e-mail to the confirmed address with a stable idempotency key', async () => {
    const { d, complete, send } = deps([claimed()])
    expect(await dispatchDeliveries(d)).toEqual({ claimed: 1, sent: 1, failed: 0, retried: 0, skipped: 0 })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'u@acme.com', idempotencyKey: 'aide-delivery-d1' }))
    expect(complete).toHaveBeenCalledWith('d1', 'sent', undefined, undefined)
  })
  it('is honest when e-mail is not configured: skipped with the missing settings, nothing pretended', async () => {
    const { d, complete } = deps([claimed()], { mailer: null, mailerMissing: ['RESEND_API_KEY'] })
    expect((await dispatchDeliveries(d)).skipped).toBe(1)
    expect(complete).toHaveBeenCalledWith('d1', 'skipped', expect.stringContaining('RESEND_API_KEY'), undefined)
  })
  it('never e-mails an unconfirmed address', async () => {
    const { d, send, complete } = deps([claimed({ recipientEmail: null })])
    await dispatchDeliveries(d)
    expect(send).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledWith('d1', 'skipped', expect.stringContaining('not confirmed'), undefined)
  })
  it('retries transient e-mail errors with back-off and fails permanent ones', async () => {
    const t = deps([claimed({ attempts: 2 })], { mailer: { name: 'f', send: vi.fn().mockRejectedValue(new ProviderError('down', 'unavailable')) } })
    expect((await dispatchDeliveries(t.d)).retried).toBe(1)
    expect(t.complete).toHaveBeenCalledWith('d1', 'retry', 'down', 300)
    const p = deps([claimed()], { mailer: { name: 'f', send: vi.fn().mockRejectedValue(new ProviderError('bad key', 'auth')) } })
    expect((await dispatchDeliveries(p.d)).failed).toBe(1)
  })
  it('delivers to Slack and Teams with the right payload shape', async () => {
    const f = vi.fn().mockResolvedValue(res(200)) as unknown as typeof fetch
    const { d, complete } = deps([claimed({ id: 's', channel: 'slack', channelId: 'c1' }), claimed({ id: 't', channel: 'teams', channelId: 'c2' })], {
      fetch: f, webhookUrl: async (id) => (id === 'c1' ? SLACK : 'https://contoso.webhook.office.com/webhookb2/aaaa/bbbb/cccc'),
    })
    expect((await dispatchDeliveries(d)).sent).toBe(2)
    const bodies = (f as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[1].body))
    expect(bodies.some((b) => 'blocks' in b)).toBe(true)
    expect(bodies.some((b) => b.type === 'message')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
  })
  it('fails a webhook delivery whose secret is gone and a rejected webhook; retries a 503', async () => {
    const gone = deps([claimed({ channel: 'slack', channelId: 'c1' })], { webhookUrl: async () => null })
    expect((await dispatchDeliveries(gone.d)).failed).toBe(1)
    const rejected = deps([claimed({ channel: 'slack', channelId: 'c1' })], { fetch: vi.fn().mockResolvedValue(res(404)) as unknown as typeof fetch })
    expect((await dispatchDeliveries(rejected.d)).failed).toBe(1)
    const down = deps([claimed({ channel: 'slack', channelId: 'c1', attempts: 1 })], { fetch: vi.fn().mockResolvedValue(res(503)) as unknown as typeof fetch })
    await dispatchDeliveries(down.d)
    expect(down.complete).toHaveBeenCalledWith('d1', 'retry', expect.any(String), 60)
  })
  it('one failing delivery never blocks the others, and an exception becomes a retry', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('kaboom')).mockResolvedValue({ id: 'ok' })
    const { d, complete } = deps([claimed({ id: 'a' }), claimed({ id: 'b' }), claimed({ id: 'c' })], { mailer: { name: 'f', send } })
    const s = await dispatchDeliveries(d, 20, 1)
    expect(s).toMatchObject({ claimed: 3, sent: 2, retried: 1 })
    expect(complete).toHaveBeenCalledWith('a', 'retry', expect.stringContaining('kaboom'), 60)
  })
  it('a failure to report an outcome does not throw (the lease will expire and retry)', async () => {
    const { d } = deps([claimed()], { complete: vi.fn().mockRejectedValue(new Error('db down')) })
    await expect(dispatchDeliveries(d)).resolves.toMatchObject({ claimed: 1 })
  })
  it('does nothing when nothing is due', async () => {
    expect(await dispatchDeliveries(deps([]).d)).toEqual({ claimed: 0, sent: 0, failed: 0, retried: 0, skipped: 0 })
  })
  it('back-off grows and is capped', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffSeconds)).toEqual([60, 300, 1800, 7200, 7200, 7200])
  })
})
