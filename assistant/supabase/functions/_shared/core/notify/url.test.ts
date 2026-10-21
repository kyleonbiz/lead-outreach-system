import { describe, expect, it } from 'vitest'
import { assertPublicHost, isPrivateIp, ResolverUnavailableError, SsrfBlockedError, validateWebhookUrl } from './url.ts'

// assembled at runtime so no secret-shaped literal exists in the source (GitHub push protection)
const SLACK = ['https://hooks.slack.com', 'services', 'T00000000', 'B00000000', 'abcdefghijklmnopqrstuvwx'].join('/')
const TEAMS_LEGACY = 'https://contoso.webhook.office.com/webhookb2/11111111-2222-3333-4444-555555555555@66666666-7777-8888-9999-000000000000/IncomingWebhook/abcdef/xyz'
const TEAMS_FLOW = 'https://prod-12.westus.logic.azure.com:443/workflows/abc123/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRET'
const TEAMS_PP = 'https://default1234.ab.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=S'

describe('validateWebhookUrl: accepts real provider URLs', () => {
  it('Slack', () => {
    const r = validateWebhookUrl('slack', SLACK)
    expect(r).toMatchObject({ ok: true, host: 'hooks.slack.com' })
    if (r.ok) { expect(r.hint).toBe('hooks.slack.com/…/uvwx'); expect(r.hint).not.toContain('T00000000') }
  })
  it.each([TEAMS_LEGACY, TEAMS_FLOW, TEAMS_PP])('Teams %#', (u) => {
    const r = validateWebhookUrl('teams', u)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hint).not.toMatch(/sig|SECRET|\?/) // secrets in the query never reach the display hint
  })
  it('keeps the query (Teams flows carry their key there) and drops the default port', () => {
    const r = validateWebhookUrl('teams', TEAMS_FLOW)
    expect(r.ok && r.url).toBe('https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRET')
  })
})

describe('validateWebhookUrl: refuses SSRF and spoofing attempts', () => {
  it.each([
    ['plain http', 'http://hooks.slack.com/services/T0/B0/xxxx'],
    ['localhost', 'https://localhost/services/T0/B0/xxxx'],
    ['loopback IP', 'https://127.0.0.1/services/T0/B0/xxxx'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['private IP', 'https://10.0.0.5/services/T0/B0/xxxx'],
    ['IPv6 loopback', 'https://[::1]/services/T0/B0/xxxx'],
    ['decimal IP', 'https://2130706433/services/T0/B0/xxxx'],
    ['hex IP', 'https://0x7f000001/services/T0/B0/xxxx'],
    ['credentials trick', 'https://hooks.slack.com@evil.test/services/T0/B0/xxxx'],
    ['userinfo', 'https://user:pw@hooks.slack.com/services/T0/B0/xxxx'],
    ['lookalike suffix', 'https://hooks.slack.com.evil.test/services/T0/B0/xxxx'],
    ['lookalike prefix', 'https://evilhooks.slack.com/services/T0/B0/xxxx'],
    ['other slack host', 'https://slack.com/services/T0/B0/xxxx'],
    ['arbitrary host', 'https://example.com/services/T0/B0/xxxx'],
    ['odd port', 'https://hooks.slack.com:8443/services/T0/B0/xxxx'],
    ['wrong path', 'https://hooks.slack.com/api/chat.postMessage'],
    ['backslash', 'https://hooks.slack.com\\@evil.test/services/T0/B0/xxxx'],
    ['whitespace', 'https://hooks.slack.com/services/T0/B0/xx xx'],
    ['newline', 'https://hooks.slack.com/services/T0/B0/xxxx\nHost: evil'],
    ['fragment', 'https://hooks.slack.com/services/T0/B0/xxxx#x'],
    ['empty', ''],
    ['not a URL', 'not a url'],
    ['javascript', 'javascript:alert(1)'],
  ])('slack: %s', (_n, u) => { expect(validateWebhookUrl('slack', u).ok).toBe(false) })

  it('teams: only Microsoft hosts, and a Slack URL is not a Teams URL (and vice versa)', () => {
    expect(validateWebhookUrl('teams', SLACK).ok).toBe(false)
    expect(validateWebhookUrl('slack', TEAMS_LEGACY).ok).toBe(false)
    expect(validateWebhookUrl('teams', 'https://webhook.office.com.evil.test/webhookb2/x/y/z').ok).toBe(false)
    expect(validateWebhookUrl('teams', 'https://evil.test/logic.azure.com/workflows/abc').ok).toBe(false)
    expect(validateWebhookUrl('teams', 'https://logic.azure.com.evil.test/workflows/abcd').ok).toBe(false)
    expect(validateWebhookUrl('teams', 'https://10.1.1.1/workflows/abcd').ok).toBe(false)
  })
  it('rejects non-strings and oversized input', () => {
    expect(validateWebhookUrl('slack', 42).ok).toBe(false)
    expect(validateWebhookUrl('slack', null).ok).toBe(false)
    expect(validateWebhookUrl('slack', SLACK + 'a'.repeat(1000)).ok).toBe(false)
  })
  it('error reasons never echo the (secret) URL back', () => {
    const r = validateWebhookUrl('slack', 'https://evil.test/services/T0/B0/SECRETTOKEN')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).not.toContain('SECRETTOKEN')
  })
})

describe('isPrivateIp', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '127.255.255.254', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.2.5', '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '::10.0.0.1',
    'garbage', '1.2.3', '999.1.1.1',
  ])('private/unsafe: %s', (ip) => expect(isPrivateIp(ip)).toBe(true))
  it.each(['8.8.8.8', '52.20.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81a::200e', '::ffff:8.8.8.8'])(
    'public: %s', (ip) => expect(isPrivateIp(ip)).toBe(false))
})

describe('assertPublicHost', () => {
  it('passes for public addresses and blocks mixed or private answers (rebinding to internal IPs)', async () => {
    await expect(assertPublicHost('hooks.slack.com', async () => ['52.1.1.1', '2606:4700::1'])).resolves.toBeUndefined()
    await expect(assertPublicHost('x', async () => ['52.1.1.1', '10.0.0.1'])).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertPublicHost('x', async () => ['::ffff:169.254.169.254'])).rejects.toBeInstanceOf(SsrfBlockedError)
  })
  it('skips only the DNS layer when the platform has no DNS API (explicit signal, not a generic error)', async () => {
    await expect(assertPublicHost('x', async () => { throw new ResolverUnavailableError() })).resolves.toBeUndefined()
    await expect(assertPublicHost('x', async () => { throw new TypeError('boom') })).rejects.toBeInstanceOf(SsrfBlockedError)
  })
  it('fails closed when resolution fails or returns nothing', async () => {
    await expect(assertPublicHost('x', async () => [])).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertPublicHost('x', async () => { throw new Error('nx') })).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})
