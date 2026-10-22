import { describe, expect, it } from 'vitest'
import { mailNeedingAttention, upcomingEvents } from './logic'
import type { AgendaEvent, TriagedMessage } from '@/features/integrations/useProviderData'

const now = new Date('2026-10-21T15:00:00Z')
const ev = (id: string, start: string, end: string, o: Partial<AgendaEvent> = {}): AgendaEvent =>
  ({ id, title: id, start, end, allDay: false, attendees: [], ...o })

describe('upcomingEvents', () => {
  it('drops finished events, sorts by start and caps the list', () => {
    const events = [
      ev('late', '2026-10-21T20:00:00Z', '2026-10-21T21:00:00Z'),
      ev('done', '2026-10-21T13:00:00Z', '2026-10-21T14:00:00Z'),
      ev('now', '2026-10-21T14:30:00Z', '2026-10-21T15:30:00Z'),
      ev('soon', '2026-10-21T16:00:00Z', '2026-10-21T16:30:00Z'),
    ]
    expect(upcomingEvents(events, now).map((e) => e.id)).toEqual(['now', 'soon', 'late'])
    expect(upcomingEvents(events, now, 2).map((e) => e.id)).toEqual(['now', 'soon'])
  })
  it('keeps an event that ends exactly after now and drops one that ends exactly now', () => {
    expect(upcomingEvents([ev('a', '2026-10-21T14:00:00Z', '2026-10-21T15:00:00Z')], now)).toEqual([])
    expect(upcomingEvents([ev('b', '2026-10-21T14:00:00Z', '2026-10-21T15:00:01Z')], now)).toHaveLength(1)
  })
  it('keeps all-day events that are still running and ignores unparseable ones', () => {
    const allDay = ev('trip', '2026-10-21', '2026-10-22', { allDay: true })
    expect(upcomingEvents([allDay, ev('bad', 'nope', 'nope')], now).map((e) => e.id)).toEqual(['trip'])
  })
  it('does not mutate its input', () => {
    const input = [ev('b', '2026-10-21T18:00:00Z', '2026-10-21T19:00:00Z'), ev('a', '2026-10-21T16:00:00Z', '2026-10-21T17:00:00Z')]
    upcomingEvents(input, now)
    expect(input.map((e) => e.id)).toEqual(['b', 'a'])
  })
})

const mail = (id: string, date: string, t: Partial<TriagedMessage['triage']>): TriagedMessage => ({
  id, threadId: id, from: 'x@y.test', subject: id, snippet: '', date, unread: true,
  triage: { urgent: false, needsResponse: false, automated: false, reasons: [], ...t },
})

describe('mailNeedingAttention', () => {
  it('shows urgent first, then needs-reply, newest first, and hides plain and automated mail', () => {
    const msgs = [
      mail('reply-old', '2026-10-20T10:00:00Z', { needsResponse: true }),
      mail('plain', '2026-10-21T10:00:00Z', {}),
      mail('urgent-old', '2026-10-19T10:00:00Z', { urgent: true }),
      mail('both', '2026-10-21T09:00:00Z', { urgent: true, needsResponse: true }),
      mail('reply-new', '2026-10-21T08:00:00Z', { needsResponse: true }),
      mail('robot', '2026-10-21T11:00:00Z', { urgent: true, automated: true }),
    ]
    expect(mailNeedingAttention(msgs).map((m) => m.id)).toEqual(['both', 'urgent-old', 'reply-new', 'reply-old'])
    expect(mailNeedingAttention(msgs, 2).map((m) => m.id)).toEqual(['both', 'urgent-old'])
  })
})
