import { describe, expect, it } from 'vitest'
import { pickProvider } from './select.ts'

const EMAIL = ['google_gmail', 'microsoft_mail']
const row = (provider: string, status = 'connected', created_at = '2026-10-01T00:00:00Z') => ({ provider, status, created_at })

describe('pickProvider', () => {
  it('returns null when nothing is connected, and ignores revoked and other-kind connections', () => {
    expect(pickProvider([], EMAIL)).toBeNull()
    expect(pickProvider([row('google_gmail', 'revoked')], EMAIL)).toBeNull()
    expect(pickProvider([row('google_calendar')], EMAIL)).toBeNull()
  })
  it('uses the only connection, whichever provider it is', () => {
    expect(pickProvider([row('microsoft_mail')], EMAIL)).toBe('microsoft_mail')
    expect(pickProvider([row('google_gmail')], EMAIL)).toBe('google_gmail')
  })
  it('prefers a working connection over one that needs reconnecting', () => {
    expect(pickProvider([row('google_gmail', 'needs_reauth', '2026-10-20T00:00:00Z'), row('microsoft_mail', 'connected', '2026-09-01T00:00:00Z')], EMAIL)).toBe('microsoft_mail')
  })
  it('between two working connections the most recent wins', () => {
    expect(pickProvider([row('google_gmail', 'connected', '2026-09-01T00:00:00Z'), row('microsoft_mail', 'connected', '2026-10-01T00:00:00Z')], EMAIL)).toBe('microsoft_mail')
    expect(pickProvider([row('microsoft_mail', 'connected', '2026-09-01T00:00:00Z'), row('google_gmail', 'connected', '2026-10-01T00:00:00Z')], EMAIL)).toBe('google_gmail')
  })
  it('a connection that needs reconnecting is still returned (so the user is told to reconnect it) when it is all there is', () => {
    expect(pickProvider([row('microsoft_mail', 'needs_reauth')], EMAIL)).toBe('microsoft_mail')
  })
})
