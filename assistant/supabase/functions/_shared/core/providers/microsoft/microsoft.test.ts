import { describe, expect, it, vi } from 'vitest'
import {
  buildAuthUrl, exchangeCode, fetchAccountEmail, hasRequiredScopes, isValidTenant, MICROSOFT_SCOPES, refreshAccessToken, type MicrosoftClient,
} from './oauth.ts'
import { assertGraphId, graph, type GraphHttp } from './http.ts'
import { OutlookMailProvider, parseMailQuery, planMailRequest } from './mail.ts'
import { OutlookCalendarProvider } from './calendar.ts'
import { TokenSource, type StoredCredentials } from '../google/tokens.ts'
import { ProviderError } from '../../types.ts'

const client: MicrosoftClient = { clientId: 'client-id-for-tests', clientSecret: 'client-secret-for-tests', redirectUri: 'https://x.supabase.co/functions/v1/microsoft-oauth-callback', tenant: 'common' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const empty = (status: number) => new Response(null, { status })

// a token source that never refreshes: HTTP behaviour is what is under test here
const http = (f: typeof fetch): GraphHttp => ({ fetch: f, tokens: { getAccessToken: async () => 'access-token-for-tests' } as unknown as TokenSource })
const call = (f: ReturnType<typeof vi.fn>, n = 0) => ({ url: new URL(String(f.mock.calls[n][0])), init: f.mock.calls[n][1] as RequestInit & { headers: Record<string, string> } })
const NOW = new Date('2026-10-21T12:00:00Z')

describe('Microsoft OAuth', () => {
  it('builds an authorize URL with minimal scopes, account picker and signed state', () => {
    const u = new URL(buildAuthUrl(client, 'microsoft_mail', 'STATE'))
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: client.clientId, response_type: 'code', redirect_uri: client.redirectUri, response_mode: 'query', state: 'STATE', prompt: 'select_account',
    })
    const scopes = u.searchParams.get('scope')!.split(' ')
    expect(scopes).toEqual(expect.arrayContaining(['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send']))
    expect(scopes.some((s) => s.startsWith('Calendars'))).toBe(false) // capabilities are not bundled
    expect(scopes).not.toContain('Mail.Read') // ReadWrite already covers it
  })
  it('requests only calendar permissions for the calendar connection', () => {
    const scopes = new URL(buildAuthUrl(client, 'microsoft_calendar', 's')).searchParams.get('scope')!.split(' ')
    expect(scopes).toContain('Calendars.ReadWrite')
    expect(scopes.some((s) => s.startsWith('Mail'))).toBe(false)
  })
  it('accepts real tenant forms and refuses anything that could alter the URL', () => {
    for (const t of ['common', 'organizations', 'consumers', '72f988bf-86f1-41af-91ab-2d7cd011db47', 'contoso.onmicrosoft.com']) expect(isValidTenant(t)).toBe(true)
    for (const t of ['', 'evil.test/..', 'a b', 'x?y=1', 'common/../x', 'a@b', '//evil.test', 'localhost']) expect(isValidTenant(t)).toBe(false)
    expect(() => buildAuthUrl({ ...client, tenant: 'evil.test/..%2F' }, 'microsoft_mail', 's')).toThrow(/tenant/)
  })

  it('exchanges a code with the right form fields', async () => {
    const f = vi.fn().mockResolvedValue(json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'Mail.ReadWrite' }))
    const t = await exchangeCode(f, client, 'CODE')
    expect(t.refresh_token).toBe('r')
    const { url, init } = call(f)
    expect(url.href).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    const body = new URLSearchParams(String(init.body))
    expect(Object.fromEntries(body)).toMatchObject({ code: 'CODE', grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: client.redirectUri })
  })
  it('refreshes with the requested scopes', async () => {
    const f = vi.fn().mockResolvedValue(json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600, scope: 'x' }))
    await refreshAccessToken(f, client, 'old', 'microsoft_calendar')
    const body = new URLSearchParams(String(call(f).init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old')
    expect(body.get('scope')).toContain('Calendars.ReadWrite')
  })
  it.each([
    ['invalid_grant', 400, 'auth'], ['interaction_required', 400, 'auth'], ['consent_required', 400, 'auth'],
    ['invalid_client', 401, 'bad_request'], ['temporarily_unavailable', 503, 'unavailable'], ['throttled', 429, 'rate_limit'],
  ])('token error %s (HTTP %i) is classified as %s', async (error, status, kind) => {
    const f = vi.fn().mockResolvedValue(json({ error, error_description: 'AADSTS70000: details for jane@contoso.com trace 123' }, status))
    const e = (await exchangeCode(f, client, 'c').catch((x) => x)) as ProviderError
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.kind).toBe(kind)
    expect(e.message).toContain('AADSTS70000') // the support code
    expect(e.message).not.toContain('jane@contoso.com') // not the account details around it
  })

  it('reads the mailbox address (mail first, sign-in name as a fallback), lower-cased', async () => {
    expect(await fetchAccountEmail(vi.fn().mockResolvedValue(json({ mail: 'Jane@Contoso.com', userPrincipalName: 'jane_contoso.com#EXT#@t.onmicrosoft.com' })), 'tok')).toBe('jane@contoso.com')
    expect(await fetchAccountEmail(vi.fn().mockResolvedValue(json({ mail: null, userPrincipalName: 'Sam@Outlook.com' })), 'tok')).toBe('sam@outlook.com')
  })
  it('refuses accounts without an address and surfaces API failures', async () => {
    await expect(fetchAccountEmail(vi.fn().mockResolvedValue(json({ mail: null, userPrincipalName: 'no-at-sign' })), 'tok')).rejects.toThrow(/did not return an email/)
    await expect(fetchAccountEmail(vi.fn().mockResolvedValue(json({}, 403)), 'tok')).rejects.toThrow(/403/)
  })

  it('checks that every needed permission was granted, however Microsoft spells them', () => {
    expect(hasRequiredScopes('microsoft_mail', 'openid email profile User.Read Mail.ReadWrite Mail.Send')).toBe(true)
    expect(hasRequiredScopes('microsoft_mail', 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read')).toBe(true)
    expect(hasRequiredScopes('microsoft_mail', 'user.read mail.readwrite mail.send')).toBe(true)
    expect(hasRequiredScopes('microsoft_mail', 'User.Read Mail.ReadWrite')).toBe(false) // Mail.Send was unticked or blocked by an admin
    expect(hasRequiredScopes('microsoft_mail', 'User.Read Calendars.ReadWrite')).toBe(false) // the wrong capability
    expect(hasRequiredScopes('microsoft_calendar', 'User.Read Calendars.ReadWrite')).toBe(true)
    expect(hasRequiredScopes('microsoft_calendar', '')).toBe(false)
    expect(MICROSOFT_SCOPES.microsoft_mail).not.toContain('Mail.Read')
  })

  it('the shared TokenSource stores Microsoft\'s rotated refresh token and asks for a reconnect when it is rejected', async () => {
    let creds: StoredCredentials = { access_token: 'old', refresh_token: 'refresh-1', expires_at: 0, scope: 's' }
    const reauth = vi.fn()
    const ts = new TokenSource({
      load: async () => creds, save: async (c) => { creds = c }, markNeedsReauth: reauth, now: () => 1_000_000,
      refresh: async (rt) => refreshAccessToken(vi.fn().mockResolvedValue(json({ access_token: 'new', refresh_token: 'refresh-2', expires_in: 3600, scope: 's' })), client, rt, 'microsoft_mail'),
    }, 60_000, 'Microsoft')
    expect(await ts.getAccessToken()).toBe('new')
    expect(creds.refresh_token).toBe('refresh-2') // rotated, so the next refresh uses the new one

    const bad = new TokenSource({
      load: async () => creds, save: async () => {}, markNeedsReauth: reauth, now: () => 99_999_999_999,
      refresh: async (rt) => refreshAccessToken(vi.fn().mockResolvedValue(json({ error: 'invalid_grant', error_description: 'AADSTS700082: expired' }, 400)), client, rt, 'microsoft_mail'),
    }, 60_000, 'Microsoft')
    await expect(bad.getAccessToken()).rejects.toBeInstanceOf(ProviderError)
    expect(reauth).toHaveBeenCalledWith('Microsoft rejected the saved credentials. Please reconnect this account.')
  })
})

describe('Graph HTTP client', () => {
  it('sends the bearer token and Prefer header, returns {} for 202/204', async () => {
    const f = vi.fn().mockResolvedValue(empty(202))
    expect(await graph(http(f as unknown as typeof fetch), '/me/messages/abc12345/send', { method: 'POST', prefer: 'x="y"' })).toEqual({})
    const { url, init } = call(f)
    expect(url.href).toBe('https://graph.microsoft.com/v1.0/me/messages/abc12345/send')
    expect(init.headers).toMatchObject({ authorization: 'Bearer access-token-for-tests', Prefer: 'x="y"' })
  })
  it('refreshes once on 401 and retries; a second 401 is an auth error', async () => {
    const getAccessToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValue('fresh')
    const f = vi.fn().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ value: [] }))
    const h = { fetch: f as unknown as typeof fetch, tokens: { getAccessToken } as unknown as TokenSource }
    expect(await graph(h, '/me/messages')).toEqual({ value: [] })
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true)
    const f2 = vi.fn().mockResolvedValue(json({}, 401))
    await expect(graph({ ...h, fetch: f2 as unknown as typeof fetch }, '/me')).rejects.toMatchObject({ kind: 'auth' })
    expect(f2).toHaveBeenCalledTimes(2)
  })
  it.each([[403, 'auth'], [404, 'bad_request'], [429, 'rate_limit'], [500, 'unavailable'], [503, 'unavailable'], [400, 'bad_request']])('HTTP %i is a %s error', async (status, kind) => {
    const f = vi.fn().mockResolvedValue(json({ error: { message: 'nope '.repeat(100) } }, status))
    const e = (await graph(http(f as unknown as typeof fetch), '/me').catch((x) => x)) as ProviderError
    expect(e.kind).toBe(kind)
    expect(e.message.length).toBeLessThan(260)
  })
  it('refuses to call anything that is not Microsoft Graph (no token for other hosts)', async () => {
    const f = vi.fn()
    await expect(graph(http(f as unknown as typeof fetch), 'https://evil.test/v1.0/me')).rejects.toThrow(/non-Graph/)
    await expect(graph(http(f as unknown as typeof fetch), 'https://graph.microsoft.com.evil.test/v1.0/me')).rejects.toThrow(/non-Graph/)
    expect(f).not.toHaveBeenCalled()
  })
  it('validates ids before they reach a path or an OData filter', () => {
    expect(assertGraphId('AAMkAGI2THVSAAA=', 'id')).toBe('AAMkAGI2THVSAAA=')
    for (const bad of ["x' or 1 eq 1 or id eq '", '../me', 'a/../../b/c', 'a.b.c.d.e.f', 'a+b+c+d+e+f', 'a b c d e f g h', 'id\nHost: x', 'short', 'a'.repeat(600), '']) expect(() => assertGraphId(bad, 'id')).toThrow(ProviderError)
  })
})

describe('mail search language', () => {
  it('parses the supported subset', () => {
    const q = parseMailQuery('in:inbox is:unread newer_than:3d from:acme.com subject:"quarterly report" invoice "net 30"', NOW)
    expect(q).toMatchObject({ folder: 'inbox', unread: true, from: ['acme.com'], subject: ['quarterly report'], text: ['invoice', 'net 30'] })
    expect(q.since?.toISOString()).toBe('2026-10-18T12:00:00.000Z')
  })
  it.each([['7d', 7], ['2m', 60], ['1y', 365]])('newer_than:%s means %i days', (v, days) => {
    expect(parseMailQuery(`newer_than:${v}`, NOW).since?.getTime()).toBe(NOW.getTime() - days * 86_400_000)
  })
  it('understands absolute dates, folders and read state', () => {
    const q = parseMailQuery('after:2026/10/01 before:2026-10-15 in:sent is:read hello', NOW)
    expect(q.since?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(q.until?.toISOString()).toBe('2026-10-15T00:00:00.000Z')
    expect(q).toMatchObject({ folder: 'sentitems', unread: false })
    expect(parseMailQuery('in:anywhere invoice', NOW).folder).toBeUndefined()
  })
  it('implicit AND is fine; everything we cannot honour is refused with an explanation (never ignored)', () => {
    expect(parseMailQuery('invoice AND acme', NOW).text).toEqual(['invoice', 'acme'])
    for (const q of ['has:attachment', 'label:work', 'category:primary', '-spam', 'a OR b', '(a b)', 'is:starred', 'in:spam', 'larger:5M', 'filename:pdf', 'http://x.test', 'from:', 'newer_than:soon', 'after:yesterday', '']) {
      expect(() => parseMailQuery(q, NOW), q).toThrow(ProviderError)
    }
    expect(() => parseMailQuery('has:attachment', NOW)).toThrow(/Supported: from:/)
  })
})

describe('mail request planning', () => {
  it('filter-only searches sort by date, and the sort property comes first in the filter (a Graph requirement)', () => {
    const p = planMailRequest(parseMailQuery('in:inbox is:unread newer_than:3d', NOW), 10)
    expect(p.path).toBe('/me/mailFolders/inbox/messages')
    expect(p.params.$filter).toBe('receivedDateTime ge 2026-10-18T12:00:00Z and isRead eq false')
    expect(p.params.$orderby).toBe('receivedDateTime desc')
    expect(p.params.$top).toBe('10')
    expect(p.params.$search).toBeUndefined() // $search and $filter cannot be combined
  })
  it('an unbounded filter still starts with the sort property', () => {
    expect(planMailRequest(parseMailQuery('is:unread', NOW), 5).params.$filter).toMatch(/^receivedDateTime ge 1970-01-01T00:00:00Z and isRead eq false$/)
  })
  it('text searches use $search only, over-fetch, and apply read-state/date client-side', () => {
    const p = planMailRequest(parseMailQuery('from:acme.com invoice is:unread newer_than:7d', NOW), 10)
    expect(p.params.$search).toBe('"from:\\"acme.com\\" AND \\"invoice\\""')
    expect(p.params.$filter).toBeUndefined()
    expect(p.params.$orderby).toBeUndefined()
    expect(p.params.$top).toBe('40')
    expect(p.clientFilter?.({ id: '1', isRead: false, receivedDateTime: '2026-10-20T00:00:00Z' })).toBe(true)
    expect(p.clientFilter?.({ id: '2', isRead: true, receivedDateTime: '2026-10-20T00:00:00Z' })).toBe(false)
    expect(p.clientFilter?.({ id: '3', isRead: false, receivedDateTime: '2026-09-01T00:00:00Z' })).toBe(false)
  })
  it('search terms cannot break out of their quotes or inject operators', () => {
    // the language has no escape character, so hostile text can only arrive inside bare words or quoted phrases
    const p = planMailRequest(parseMailQuery('a"b c\\d subject:"x y" e"f"g', NOW), 5)
    const kql = JSON.parse(p.params.$search) as string
    expect(kql).toBe('subject:"x y" AND "a b" AND "c d" AND "e f g"') // quotes and backslashes are turned into spaces, not escaped
    expect(kql.match(/"/g)!.length % 2).toBe(0) // quotes always balanced
    expect(kql).not.toMatch(/\\/) // no backslashes survive
    expect(kql.split(' AND ').every((part) => /^(subject:|from:|to:)?"[^"]*"$/.test(part))).toBe(true) // every term is one quoted value
    expect(kql).not.toMatch(/\b(OR|NOT)\b/)
  })
  it('an operator smuggled into a quoted value stays inside that value', () => {
    const q = parseMailQuery('"from:evil OR to:boss"', NOW)
    expect(q.text).toEqual(['from:evil OR to:boss'])
    expect(q.from).toEqual([])
    expect(JSON.parse(planMailRequest(q, 5).params.$search)).toBe('"from:evil OR to:boss"')
  })
  it('caps over-fetching at 100', () => {
    expect(planMailRequest(parseMailQuery('x is:unread', NOW), 25).params.$top).toBe('100')
    expect(planMailRequest(parseMailQuery('x', NOW), 25).params.$top).toBe('25')
  })
})

describe('OutlookMailProvider', () => {
  const msg = (o: Record<string, unknown> = {}) => ({
    id: 'AAMkAD-1', conversationId: 'AAQkAD-conv', subject: 'Invoice overdue', from: { emailAddress: { name: 'Dana "The Boss" <x>', address: 'dana@acme.com' } },
    toRecipients: [{ emailAddress: { address: 'me@contoso.com' } }], receivedDateTime: '2026-10-21T10:00:00Z', bodyPreview: 'Please pay', isRead: false, categories: ['Red'], ...o,
  })

  it('searches and maps messages into the shared summary shape', async () => {
    const f = vi.fn().mockResolvedValue(json({ value: [msg(), msg({ id: 'AAMkAD-2', isRead: true, subject: '', from: undefined, categories: [] })] }))
    const mail = new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com', () => NOW)
    const out = await mail.search('in:inbox is:unread', 10)
    expect(out[0]).toEqual({
      id: 'AAMkAD-1', threadId: 'AAQkAD-conv', from: 'Dana The Boss x <dana@acme.com>', to: ['me@contoso.com'], subject: 'Invoice overdue',
      snippet: 'Please pay', date: '2026-10-21T10:00:00Z', unread: true, labels: ['UNREAD', 'Red'],
    })
    expect(out[1]).toMatchObject({ subject: '(no subject)', from: '', unread: false, labels: [] })
    expect(call(f).url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages')
    expect(mail.accountEmail()).toBe('me@contoso.com')
    expect(mail.provider).toBe('microsoft_mail')
  })
  it('text search filters client-side and never returns more than the limit', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => msg({ id: `AAMkAD-${i}`, isRead: i % 2 === 0 })) // odd indexes are unread
    const f = vi.fn().mockResolvedValue(json({ value: rows }))
    const out = await new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com', () => NOW).search('invoice is:unread', 2)
    expect(out).toHaveLength(2)
    expect(out.every((m) => m.unread)).toBe(true) // read messages were filtered out, and the result is capped at the limit
    expect(out.map((m) => m.id)).toEqual(['AAMkAD-1', 'AAMkAD-3']) // the first two UNREAD rows, in order
  })
  it('an unsupported query fails before any request is made', async () => {
    const f = vi.fn()
    await expect(new OutlookMailProvider(http(f as unknown as typeof fetch), 'a@b.co').search('has:attachment', 5)).rejects.toThrow(/does not support/)
    expect(f).not.toHaveBeenCalled()
  })

  it('reads a conversation oldest-first, as plain text, quoting the id safely', async () => {
    const f = vi.fn().mockResolvedValue(json({ value: [
      msg({ id: 'AAMkAD-b', receivedDateTime: '2026-10-21T11:00:00Z', body: { contentType: 'text', content: 'second' } }),
      msg({ id: 'AAMkAD-a', receivedDateTime: '2026-10-21T10:00:00Z', body: { contentType: 'html', content: '<p>first <b>one</b></p><script>x()</script>' } }),
    ] }))
    const t = await new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com').getThread('AAQkAD-conv=')
    expect(t.messages.map((m) => m.body)).toEqual(['first one', 'second'])
    const { url, init } = call(f)
    expect(url.searchParams.get('$filter')).toBe("conversationId eq 'AAQkAD-conv='")
    expect(init.headers.Prefer).toBe('outlook.body-content-type="text"')
  })
  it('refuses a thread id that is not an id', async () => {
    const f = vi.fn()
    await expect(new OutlookMailProvider(http(f as unknown as typeof fetch), 'a@b.co').getThread("x' or 1 eq 1 or id eq '")).rejects.toThrow(/valid thread id/)
    expect(f).not.toHaveBeenCalled()
  })

  it('creates a draft without sending anything', async () => {
    const f = vi.fn().mockResolvedValue(json({ id: 'DRAFT-0001' }, 201))
    const r = await new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com').createDraft({ to: ['a@acme.com'], cc: ['b@acme.com'], subject: 'Hello', body: 'Hi there' })
    expect(r).toEqual({ draftId: 'DRAFT-0001' })
    expect(f).toHaveBeenCalledTimes(1)
    const { url, init } = call(f)
    expect(url.pathname).toBe('/v1.0/me/messages')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      subject: 'Hello', body: { contentType: 'Text', content: 'Hi there' },
      toRecipients: [{ emailAddress: { address: 'a@acme.com' } }], ccRecipients: [{ emailAddress: { address: 'b@acme.com' } }], bccRecipients: [],
    })
  })
  it('a reply draft is created inside the conversation: createReply then PATCH', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ value: [msg({ id: 'AAMkAD-last', receivedDateTime: '2026-10-21T11:00:00Z' }), msg({ id: 'AAMkAD-first', receivedDateTime: '2026-10-21T09:00:00Z' })] }))
      .mockResolvedValueOnce(json({ id: 'REPLY-0001' }, 201)).mockResolvedValueOnce(json({ id: 'REPLY-0001' }))
    const r = await new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com').createDraft({ to: ['dana@acme.com'], subject: 'Re: Invoice', body: 'Paid.', inReplyToThreadId: 'AAQkAD-conv' })
    expect(r.draftId).toBe('REPLY-0001')
    expect(call(f, 1).url.pathname).toBe('/v1.0/me/messages/AAMkAD-last/createReply')
    expect(call(f, 2).init.method).toBe('PATCH')
    expect(call(f, 2).url.pathname).toBe('/v1.0/me/messages/REPLY-0001')
  })
  it('does not leave a half-made reply behind when the update fails', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ value: [msg()] })).mockResolvedValueOnce(json({ id: 'REPLY-0002' }, 201))
      .mockResolvedValueOnce(json({ error: { message: 'bad' } }, 400)).mockResolvedValueOnce(empty(204))
    await expect(new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com').createDraft({ to: ['a@acme.com'], subject: 's', body: 'b', inReplyToThreadId: 'AAQkAD-conv' })).rejects.toBeInstanceOf(ProviderError)
    expect(call(f, 3).init.method).toBe('DELETE')
    expect(call(f, 3).url.pathname).toBe('/v1.0/me/messages/REPLY-0002')
  })
  it('a reply to an unknown thread is an error, not a new email', async () => {
    const f = vi.fn().mockResolvedValue(json({ value: [] }))
    await expect(new OutlookMailProvider(http(f as unknown as typeof fetch), 'a@b.co').createDraft({ to: ['a@acme.com'], subject: 's', body: 'b', inReplyToThreadId: 'AAQkAD-conv' })).rejects.toThrow(/not found/)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('refuses malformed or injected recipients before making any request', async () => {
    const f = vi.fn()
    const mail = new OutlookMailProvider(http(f as unknown as typeof fetch), 'a@b.co')
    for (const to of ['a@b.com, c@d.com', 'a@b.com\nBcc: x@y.com', 'not-an-address', '"x" <a@b.com>']) {
      await expect(mail.send({ to: [to], subject: 's', body: 'b' })).rejects.toThrow(/valid email address/)
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('sends by creating the draft and then sending that draft (so there is an id to return)', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ id: 'DRAFT-0003' }, 201)).mockResolvedValueOnce(empty(202))
    const r = await new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com').send({ to: ['a@acme.com'], subject: 'Hi', body: 'Body' })
    expect(r).toEqual({ messageId: 'DRAFT-0003' })
    expect(call(f, 1).url.pathname).toBe('/v1.0/me/messages/DRAFT-0003/send')
  })
  it('if sending fails the error is reported (the draft remains in Drafts, nothing is claimed as sent)', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ id: 'DRAFT-0004' }, 201)).mockResolvedValueOnce(json({ error: { message: 'quota' } }, 429))
    await expect(new OutlookMailProvider(http(f as unknown as typeof fetch), 'me@contoso.com').send({ to: ['a@acme.com'], subject: 'Hi', body: 'B' })).rejects.toMatchObject({ kind: 'rate_limit' })
  })
})

describe('OutlookCalendarProvider', () => {
  const ev = (o: Record<string, unknown> = {}) => ({
    id: 'AAMkEV-0001', subject: 'Standup', bodyPreview: 'daily', location: { displayName: 'Room 4' }, webLink: 'https://outlook.office.com/x', isAllDay: false,
    start: { dateTime: '2026-10-21T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-21T14:30:00.0000000', timeZone: 'UTC' },
    attendees: [{ emailAddress: { address: 'a@acme.com' } }], showAs: 'busy', isCancelled: false, ...o,
  })

  it('lists events as UTC instants, asking Graph for UTC, and skips cancelled ones', async () => {
    const f = vi.fn().mockResolvedValue(json({ value: [ev(), ev({ id: 'AAMkEV-0002', isCancelled: true })] }))
    const out = await new OutlookCalendarProvider(http(f as unknown as typeof fetch)).listEvents('2026-10-21T00:00:00-05:00', '2026-10-22T00:00:00-05:00', 25)
    expect(out).toEqual([{
      id: 'AAMkEV-0001', title: 'Standup', start: '2026-10-21T14:00:00Z', end: '2026-10-21T14:30:00Z', allDay: false, attendees: ['a@acme.com'],
      location: 'Room 4', description: 'daily', htmlLink: 'https://outlook.office.com/x',
    }])
    const { url, init } = call(f)
    expect(url.pathname).toBe('/v1.0/me/calendarView')
    expect(url.searchParams.get('startDateTime')).toBe('2026-10-21T05:00:00.000Z')
    expect(url.searchParams.get('$top')).toBe('25')
    expect(init.headers.Prefer).toBe('outlook.timezone="UTC"')
  })
  it('turns all-day events back into calendar dates in the organization time zone', async () => {
    const chicago = ev({ isAllDay: true, start: { dateTime: '2026-10-21T05:00:00.0000000' }, end: { dateTime: '2026-10-22T05:00:00.0000000' } })
    const tokyo = ev({ isAllDay: true, start: { dateTime: '2026-10-20T15:00:00.0000000' }, end: { dateTime: '2026-10-21T15:00:00.0000000' } })
    const a = await new OutlookCalendarProvider(http(vi.fn().mockResolvedValue(json({ value: [chicago] })) as unknown as typeof fetch), 'America/Chicago').listEvents('2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z', 5)
    const b = await new OutlookCalendarProvider(http(vi.fn().mockResolvedValue(json({ value: [tokyo] })) as unknown as typeof fetch), 'Asia/Tokyo').listEvents('2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z', 5)
    expect([a[0].allDay, a[0].start, a[0].end]).toEqual([true, '2026-10-21', '2026-10-22'])
    expect([b[0].start, b[0].end]).toEqual(['2026-10-21', '2026-10-22'])
  })
  it('free/busy reports busy, tentative and away time but not free time or cancelled events', async () => {
    const f = vi.fn().mockResolvedValue(json({ value: [
      ev({ showAs: 'busy' }), ev({ showAs: 'tentative' }), ev({ showAs: 'oof' }), ev({ showAs: 'free' }), ev({ showAs: 'busy', isCancelled: true }),
    ] }))
    const busy = await new OutlookCalendarProvider(http(f as unknown as typeof fetch)).freeBusy('2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z')
    expect(busy).toHaveLength(3)
    expect(busy[0]).toEqual({ start: '2026-10-21T14:00:00Z', end: '2026-10-21T14:30:00Z' })
  })
  it('creates events as UTC instants with required attendees (Graph sends the invitations)', async () => {
    const f = vi.fn().mockResolvedValue(json(ev({ id: 'AAMkEV-NEW1' }), 201))
    const e = await new OutlookCalendarProvider(http(f as unknown as typeof fetch)).createEvent({
      title: 'Kickoff', start: '2026-10-21T10:00:00-05:00', end: '2026-10-21T11:00:00-05:00', timeZone: 'America/Chicago',
      attendees: ['a@acme.com', 'b@acme.com'], description: 'Agenda', location: 'HQ',
    })
    expect(e.id).toBe('AAMkEV-NEW1')
    const { url, init } = call(f)
    expect(url.pathname).toBe('/v1.0/me/events')
    expect(JSON.parse(String(init.body))).toEqual({
      subject: 'Kickoff', body: { contentType: 'Text', content: 'Agenda' }, location: { displayName: 'HQ' },
      start: { dateTime: '2026-10-21T15:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-21T16:00:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'a@acme.com' }, type: 'required' }, { emailAddress: { address: 'b@acme.com' }, type: 'required' }],
    })
  })
  it('updates only the fields that changed', async () => {
    const f = vi.fn().mockResolvedValue(json(ev()))
    await new OutlookCalendarProvider(http(f as unknown as typeof fetch)).updateEvent('AAMkEV-0001', { title: 'Renamed' })
    const { url, init } = call(f)
    expect(url.pathname).toBe('/v1.0/me/events/AAMkEV-0001')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ subject: 'Renamed' })
  })
  it('refuses event ids that are not ids (no path traversal into other Graph resources)', async () => {
    const f = vi.fn()
    const cal = new OutlookCalendarProvider(http(f as unknown as typeof fetch))
    for (const id of ['../me/messages', 'a/../../b/c/d/e', 'x y z w q r s t', '']) await expect(cal.updateEvent(id, { title: 'x' })).rejects.toThrow(/valid event id/)
    expect(f).not.toHaveBeenCalled()
  })
  it('surfaces Graph failures instead of pretending the event was created', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: { message: 'Mailbox not enabled' } }, 403))
    await expect(new OutlookCalendarProvider(http(f as unknown as typeof fetch)).createEvent({
      title: 't', start: '2026-10-21T10:00:00Z', end: '2026-10-21T11:00:00Z', timeZone: 'UTC', attendees: [],
    })).rejects.toMatchObject({ kind: 'auth' })
  })
})
