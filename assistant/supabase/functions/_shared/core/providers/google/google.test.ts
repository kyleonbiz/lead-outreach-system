import { describe, expect, it, vi } from 'vitest'
import { b64url, decryptSecret, encryptSecret, signState, unb64url, verifyState } from '../../crypto.ts'
import { buildRfc822, encodeSubject, safeAddress, toRaw } from '../mime.ts'
import { buildAuthUrl, exchangeCode, GOOGLE_SCOPES, hasRequiredScopes, refreshAccessToken, revokeToken } from './oauth.ts'
import { TokenSource, type StoredCredentials } from './tokens.ts'
import { extractBody, GmailProvider, stripHtml } from './gmail.ts'
import { GoogleCalendarProvider } from './calendar.ts'
import { ProviderError } from '../../types.ts'
import { classify, parseRules } from '../emailRules.ts'
import { zonedStartOfDay } from '../../time.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)))
const KEY2 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => 200 - i)))
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

describe('credential encryption (AES-256-GCM)', () => {
  it('round-trips and never contains the plaintext', async () => {
    const ct = await encryptSecret('{"refresh_token":"1//secret"}', KEY, 'integ-1')
    expect(ct.startsWith('v1.')).toBe(true)
    expect(ct).not.toContain('secret')
    expect(await decryptSecret(ct, KEY, 'integ-1')).toBe('{"refresh_token":"1//secret"}')
  })
  it('uses a fresh IV every time', async () => {
    expect(await encryptSecret('x', KEY, 'a')).not.toBe(await encryptSecret('x', KEY, 'a'))
  })
  it('fails with the wrong key, wrong record (AAD), or tampered data', async () => {
    const ct = await encryptSecret('hello', KEY, 'integ-1')
    await expect(decryptSecret(ct, KEY2, 'integ-1')).rejects.toThrow(/Could not decrypt/)
    await expect(decryptSecret(ct, KEY, 'integ-2')).rejects.toThrow(/Could not decrypt/)
    const [v, iv, body] = ct.split('.')
    const flipped = unb64url(body); flipped[0] ^= 1
    await expect(decryptSecret(`${v}.${iv}.${b64url(flipped)}`, KEY, 'integ-1')).rejects.toThrow(/Could not decrypt/)
  })
  it('rejects a malformed or short key with an actionable message', async () => {
    await expect(encryptSecret('x', btoa('short'), 'a')).rejects.toThrow(/32 bytes/)
    await expect(encryptSecret('x', '!!!', 'a')).rejects.toThrow(/base64/)
  })
})

describe('signed OAuth state', () => {
  const payload = { org: 'o', user: 'u', provider: 'google_gmail', nonce: 'n', exp: 2_000_000 }
  it('verifies a valid state', async () => {
    expect(await verifyState(await signState(payload, KEY), KEY, 1_000_000)).toEqual(payload)
  })
  it('rejects expired, tampered, wrong-key and malformed states', async () => {
    const s = await signState(payload, KEY)
    expect(await verifyState(s, KEY, 3_000_000)).toBeNull()
    expect(await verifyState(s, KEY2, 1_000_000)).toBeNull()
    const [body, sig] = s.split('.')
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...payload, org: 'attacker-org' })))
    expect(await verifyState(`${forged}.${sig}`, KEY, 1_000_000)).toBeNull()
    expect(await verifyState(`${body}.`, KEY, 1_000_000)).toBeNull()
    expect(await verifyState('garbage', KEY, 1_000_000)).toBeNull()
  })
})

describe('MIME building', () => {
  it('blocks header injection through subject, addresses and reply headers', () => {
    expect(() => encodeSubject('hi\r\nBcc: spy@evil.test')).toThrow(/line breaks/)
    expect(() => safeAddress('a@b.com\nBcc: x@y.com')).toThrow()
    expect(() => safeAddress('not an address')).toThrow(/Invalid email/)
    expect(() => buildRfc822({ from: 'me@a.com', to: ['x@b.com'], subject: 's', body: 'b', inReplyTo: '<id>\r\nX: y' })).toThrow()
  })
  it('keeps the body out of the header block (base64) and encodes non-ASCII subjects', () => {
    const body = 'hello\r\nBcc: spy@evil.test\r\n\r\ninjected'
    const raw = buildRfc822({ from: 'me@a.com', to: ['x@b.com'], cc: ['c@b.com'], subject: 'Café ☕', body })
    const [headers, payload] = raw.split('\r\n\r\n')
    expect(headers).not.toMatch(/spy@evil/)
    expect(headers).toMatch(/^Subject: =\?UTF-8\?B\?/m)
    expect(headers).toMatch(/^Cc: c@b\.com/m)
    expect(atob(payload.replace(/\r\n/g, ''))).toContain('Bcc: spy@evil.test') // preserved as TEXT, not a header
    expect(unb64url(toRaw(raw)).length).toBe(new TextEncoder().encode(raw).length)
  })
})

describe('Google OAuth helpers (mocked HTTP)', () => {
  const client = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://x.supabase.co/functions/v1/google-oauth-callback' }

  it('builds a least-privilege consent URL that never contains the client secret', () => {
    const u = new URL(buildAuthUrl(client, 'google_gmail', 'STATE'))
    expect(u.searchParams.get('scope')).toBe(GOOGLE_SCOPES.google_gmail.join(' '))
    expect(u.searchParams.get('scope')).not.toMatch(/mail\.google\.com|gmail\.modify/) // no full-mailbox scope
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('state')).toBe('STATE')
    expect(u.toString()).not.toContain('csecret')
  })
  it('exchanges codes and refreshes tokens with form-encoded POSTs', async () => {
    const f = vi.fn().mockResolvedValue(json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' }))
    expect((await exchangeCode(f as any, client, 'code123')).refresh_token).toBe('rt')
    const body = f.mock.calls[0][1].body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code123')
    await refreshAccessToken(f as any, client, 'rt')
    expect((f.mock.calls[1][1].body as URLSearchParams).get('grant_type')).toBe('refresh_token')
  })
  it('maps invalid_grant to an auth ProviderError (reconnect needed)', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: 'invalid_grant' }, 400))
    await expect(refreshAccessToken(f as any, client, 'rt')).rejects.toMatchObject({ kind: 'auth' })
  })
  it('revocation: ok / already-invalid count as revoked, network failure does not', async () => {
    expect(await revokeToken(vi.fn().mockResolvedValue(new Response('', { status: 200 })) as any, 't')).toBe(true)
    expect(await revokeToken(vi.fn().mockResolvedValue(new Response('', { status: 400 })) as any, 't')).toBe(true)
    expect(await revokeToken(vi.fn().mockRejectedValue(new Error('down')) as any, 't')).toBe(false)
    expect(await revokeToken(vi.fn().mockResolvedValue(new Response('', { status: 500 })) as any, 't')).toBe(false)
  })
  it('detects partially granted scopes', () => {
    expect(hasRequiredScopes('google_gmail', GOOGLE_SCOPES.google_gmail.join(' '))).toBe(true)
    expect(hasRequiredScopes('google_gmail', 'openid email https://www.googleapis.com/auth/gmail.readonly')).toBe(false)
  })
})

function tokenSource(over: Partial<{ creds: StoredCredentials; refresh: any; now: number }> = {}) {
  let creds: StoredCredentials = over.creds ?? { access_token: 'old', refresh_token: 'rt', expires_at: 10_000_000, scope: 's' }
  const saved: StoredCredentials[] = []
  const reauth = vi.fn()
  const refresh = over.refresh ?? vi.fn().mockResolvedValue({ access_token: 'new', expires_in: 3600 })
  const ts = new TokenSource({
    load: async () => creds, save: async (c) => { creds = c; saved.push(c) }, markNeedsReauth: reauth, refresh, now: () => over.now ?? 5_000_000,
  })
  return { ts, saved, reauth, refresh }
}

describe('TokenSource', () => {
  it('returns the stored token while it is fresh', async () => {
    const { ts, refresh } = tokenSource()
    expect(await ts.getAccessToken()).toBe('old')
    expect(refresh).not.toHaveBeenCalled()
  })
  it('refreshes an expiring token, persists it and keeps the refresh token', async () => {
    const { ts, saved } = tokenSource({ now: 9_990_000 })
    expect(await ts.getAccessToken()).toBe('new')
    expect(saved[0]).toMatchObject({ access_token: 'new', refresh_token: 'rt', expires_at: 9_990_000 + 3_600_000 })
  })
  it('concurrent callers share ONE refresh', async () => {
    const { ts, refresh } = tokenSource({ now: 9_990_000 })
    await Promise.all([ts.getAccessToken(), ts.getAccessToken(), ts.getAccessToken()])
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('a revoked refresh token flags the integration for reconnection', async () => {
    const { ts, reauth } = tokenSource({ now: 9_990_000, refresh: vi.fn().mockRejectedValue(new ProviderError('invalid_grant', 'auth', 400)) })
    await expect(ts.getAccessToken()).rejects.toMatchObject({ kind: 'auth' })
    expect(reauth).toHaveBeenCalledOnce()
  })
})

const b64 = (s: string) => b64url(new TextEncoder().encode(s))

describe('GmailProvider (mocked HTTP)', () => {
  function gmail(handler: (url: string, init?: RequestInit) => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return handler(url, init) })
    const { ts } = tokenSource()
    return { g: new GmailProvider({ fetch: f as any, tokens: ts }, 'me@acme.com'), calls, f }
  }

  it('search lists ids then fetches metadata; parses unread/headers', async () => {
    const { g, calls } = gmail((url) => url.includes('/messages?')
      ? json({ messages: [{ id: 'm1' }] })
      : json({ id: 'm1', threadId: 't1', snippet: 'Can you confirm?', labelIds: ['INBOX', 'UNREAD'], internalDate: '1792600000000',
          payload: { headers: [{ name: 'From', value: 'Dana <dana@client.com>' }, { name: 'To', value: 'me@acme.com' }, { name: 'Subject', value: 'Invoice' }] } }))
    const r = await g.search('is:unread', 5)
    expect(r[0]).toMatchObject({ id: 'm1', threadId: 't1', from: 'Dana <dana@client.com>', subject: 'Invoice', unread: true })
    expect(calls[0].url).toContain('q=is%3Aunread')
    expect((calls[0].init!.headers as any).authorization).toBe('Bearer old')
  })

  it('getThread decodes text/plain, falls back to stripped HTML, truncates', async () => {
    const { g } = gmail(() => json({ id: 't1', messages: [
      { id: 'a', payload: { headers: [{ name: 'From', value: 'x@y.com' }], parts: [{ mimeType: 'text/plain', body: { data: b64('plain body') } }] } },
      { id: 'b', payload: { headers: [], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi <b>there</b></p><script>x()</script>') } }] } },
    ] }))
    const t = await g.getThread('t1')
    expect(t.messages[0].body).toBe('plain body')
    expect(t.messages[1].body).toBe('Hi there')
    expect(extractBody({ mimeType: 'text/plain', body: { data: b64('x'.repeat(20000)) } }).length).toBe(8000)
    expect(stripHtml('<style>a{}</style>A&amp;B')).toBe('A&B')
  })

  it('createDraft posts a base64url RFC822 message, threading replies; draft is NOT sent', async () => {
    const { g, calls } = gmail((url) => url.includes('/threads/') ? json({ messages: [{ id: 'z', payload: { headers: [{ name: 'Message-ID', value: '<orig@x>' }] } }] }) : json({ id: 'draft1' }))
    const r = await g.createDraft({ to: ['dana@client.com'], subject: 'Re: Invoice', body: 'Thanks!', inReplyToThreadId: 't1' })
    expect(r).toEqual({ draftId: 'draft1' })
    const post = calls.find((c) => c.url.endsWith('/drafts'))!
    expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(false)
    const sent = JSON.parse(post.init!.body as string)
    expect(sent.message.threadId).toBe('t1')
    const mime = new TextDecoder().decode(unb64url(sent.message.raw))
    expect(mime).toMatch(/^From: me@acme\.com/m)
    expect(mime).toMatch(/^In-Reply-To: <orig@x>/m)
  })

  it('send hits messages/send exactly once', async () => {
    const { g, calls } = gmail(() => json({ id: 'sent1' }))
    expect(await g.send({ to: ['a@b.com'], subject: 's', body: 'b' })).toEqual({ messageId: 'sent1' })
    expect(calls.filter((c) => c.url.endsWith('/messages/send'))).toHaveLength(1)
  })

  it('refreshes once on a 401 then succeeds; persistent 403 surfaces as an auth error without leaking the token', async () => {
    let n = 0
    const { g } = gmail(() => (n++ === 0 ? json({ error: { message: 'expired' } }, 401) : json({ messages: [] })))
    expect(await g.search('x', 1)).toEqual([])
    const { g: g2 } = gmail(() => json({ error: { message: 'Insufficient Permission' } }, 403))
    await expect(g2.search('x', 1)).rejects.toMatchObject({ kind: 'auth', status: 403 })
    await expect(g2.search('x', 1)).rejects.not.toThrow(/Bearer|old/)
  })
})

describe('GoogleCalendarProvider (mocked HTTP)', () => {
  const make = (handler: (url: string, init?: RequestInit) => Response) => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return handler(url, init) })
    return { c: new GoogleCalendarProvider({ fetch: f as any, tokens: tokenSource().ts }), calls }
  }
  it('lists and normalizes events (timed + all-day)', async () => {
    const { c, calls } = make(() => json({ items: [
      { id: 'e1', summary: 'Standup', start: { dateTime: '2026-10-21T09:00:00-05:00' }, end: { dateTime: '2026-10-21T09:15:00-05:00' }, attendees: [{ email: 'a@b.com' }] },
      { id: 'e2', start: { date: '2026-10-22' }, end: { date: '2026-10-23' } },
    ] }))
    const ev = await c.listEvents('2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z', 10)
    expect(ev[0]).toMatchObject({ title: 'Standup', allDay: false, attendees: ['a@b.com'] })
    expect(ev[1]).toMatchObject({ title: '(no title)', allDay: true })
    expect(calls[0].url).toContain('singleEvents=true')
  })
  it('free/busy returns busy intervals', async () => {
    const { c } = make(() => json({ calendars: { primary: { busy: [{ start: 'a', end: 'b' }] } } }))
    expect(await c.freeBusy('x', 'y')).toEqual([{ start: 'a', end: 'b' }])
  })
  it('create sends invitations only when there are guests and always carries the time zone', async () => {
    const { c, calls } = make(() => json({ id: 'new', summary: 'Meet', start: { dateTime: 's' }, end: { dateTime: 'e' } }))
    await c.createEvent({ title: 'Meet', start: '2026-10-22T10:00:00-05:00', end: '2026-10-22T11:00:00-05:00', timeZone: 'America/Chicago', attendees: ['g@x.com'] })
    await c.createEvent({ title: 'Solo', start: '2026-10-22T10:00:00-05:00', end: '2026-10-22T11:00:00-05:00', timeZone: 'America/Chicago', attendees: [] })
    expect(calls[0].url).toContain('sendUpdates=all')
    expect(calls[1].url).not.toContain('sendUpdates')
    expect(JSON.parse(calls[0].init!.body as string).start).toEqual({ dateTime: '2026-10-22T10:00:00-05:00', timeZone: 'America/Chicago' })
  })
})

describe('urgent-mail rules', () => {
  const me = 'me@acme.com'
  const m = (o: Partial<{ from: string; subject: string; snippet: string; unread: boolean }>) => ({ from: 'Dana <dana@client.com>', subject: 'Hi', snippet: '', unread: true, ...o })
  it('flags urgency keywords and VIPs with reasons', () => {
    const r = classify(m({ subject: 'URGENT: invoice overdue' }), parseRules({}), me)
    expect(r.urgent).toBe(true)
    expect(r.reasons.join()).toMatch(/urgent/)
    expect(classify(m({ from: 'boss@acme.com' }), parseRules({ vip_senders: ['boss@acme.com'] }), me)).toMatchObject({ urgent: true, needsResponse: true })
    expect(classify(m({ subject: 'budget' }), parseRules({ urgent_keywords: ['budget'] }), me).urgent).toBe(true)
  })
  it('detects messages needing a response, but not automated, own or already-read mail', () => {
    expect(classify(m({ snippet: 'Can you send the quote?' }), parseRules({}), me).needsResponse).toBe(true)
    expect(classify(m({ from: 'noreply@shop.com', snippet: 'Can you rate us?' }), parseRules({}), me).needsResponse).toBe(false)
    expect(classify(m({ from: me, snippet: 'ok?' }), parseRules({}), me).needsResponse).toBe(false)
    expect(classify(m({ snippet: 'ok?', unread: false }), parseRules({}), me).needsResponse).toBe(false)
  })
  it('ignore list wins and bad rules fall back to defaults', () => {
    expect(classify(m({ subject: 'urgent' }), parseRules({ ignore_senders: ['@client.com'] }), me)).toMatchObject({ urgent: false, automated: true })
    expect(parseRules({ urgent_keywords: 'oops' }).urgent_keywords).toEqual([])
  })
})

describe('zonedStartOfDay', () => {
  it('finds local midnight, including across DST changes', () => {
    expect(zonedStartOfDay(new Date('2026-10-21T15:00:00Z'), 'America/Chicago').toISOString()).toBe('2026-10-21T05:00:00.000Z')
    // US DST ends 2026-11-01: that day is 25h long
    const d = zonedStartOfDay(new Date('2026-11-01T12:00:00Z'), 'America/Chicago')
    const next = zonedStartOfDay(new Date('2026-11-01T12:00:00Z'), 'America/Chicago', 1)
    expect(d.toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect((next.getTime() - d.getTime()) / 3_600_000).toBe(25)
    expect(zonedStartOfDay(new Date('2026-10-21T23:30:00Z'), 'Asia/Tokyo').toISOString()).toBe('2026-10-21T15:00:00.000Z')
  })
})
