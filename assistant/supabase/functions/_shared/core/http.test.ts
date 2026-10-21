import { describe, expect, it, vi } from 'vitest'
import { corsHeaders, guard, readJson, toResponse } from './http.ts'

const req = (body: string, headers: Record<string, string> = {}) => new Request('https://x.test/f', { method: 'POST', body, headers })

describe('readJson', () => {
  it('parses valid JSON and returns null for invalid, empty or oversized bodies', async () => {
    expect(await readJson(req('{"a":1}'))).toEqual({ a: 1 })
    expect(await readJson(req('not json'))).toBeNull()
    expect(await readJson(req(''))).toBeNull()
    expect(await readJson(req('{"a":"' + 'x'.repeat(2000) + '"}'), 1000)).toBeNull()
  })
  it('rejects on the declared content-length without reading the body', async () => {
    const r = req('{}', { 'content-length': '5000000' })
    const text = vi.spyOn(r, 'text')
    expect(await readJson(r)).toBeNull()
    expect(text).not.toHaveBeenCalled()
  })
})

describe('toResponse', () => {
  it('serializes JSON with status, no-store caching and CORS for the configured origin', async () => {
    const r = toResponse({ status: 403, body: { error: 'no' } }, 'https://app.example.com')
    expect(r.status).toBe(403)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(await r.json()).toEqual({ error: 'no' })
  })
  it('turns 302 results into real redirects (OAuth callback)', () => {
    const r = toResponse({ status: 302, body: { location: 'https://app.test/integrations?connected=x' } })
    expect(r.status).toBe(302)
    expect(r.headers.get('Location')).toBe('https://app.test/integrations?connected=x')
  })
  it('falls back to * only when no app origin is configured', () => {
    expect(corsHeaders(undefined)['Access-Control-Allow-Origin']).toBe('*')
  })
})

describe('guard', () => {
  it('answers CORS preflight without invoking the handler', async () => {
    const fn = vi.fn()
    const r = await guard(fn, () => 'https://app.test')(new Request('https://x.test', { method: 'OPTIONS' }))
    expect(r.status).toBe(200)
    expect(r.headers.get('Access-Control-Allow-Methods')).toMatch(/POST/)
    expect(fn).not.toHaveBeenCalled()
  })
  it('hides internal error details from clients but logs them', async () => {
    const log = vi.fn()
    const r = await guard(async () => { throw new Error('connection to db at 10.0.0.5 failed: password=hunter2') }, () => undefined, log)(req('{}'))
    expect(r.status).toBe(500)
    const text = await r.text()
    expect(text).toBe('{"error":"Internal error"}')
    expect(text).not.toMatch(/hunter2|10\.0\.0\.5/)
    expect(log).toHaveBeenCalled()
  })
  it('passes successful responses through untouched', async () => {
    const r = await guard(async () => toResponse({ status: 200, body: { ok: true } }), () => undefined)(req('{}'))
    expect(await r.json()).toEqual({ ok: true })
  })
})
