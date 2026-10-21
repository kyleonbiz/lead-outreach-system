import type { CalendarEvent, CalendarProvider, NewCalendarEvent } from '../../ports.ts'
import { gjson, type GoogleHttp } from './http.ts'

const API = 'https://www.googleapis.com/calendar/v3'

interface GEvent {
  id: string; summary?: string; description?: string; location?: string; htmlLink?: string
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email: string }>
}

const normalize = (e: GEvent): CalendarEvent => ({
  id: e.id, title: e.summary ?? '(no title)',
  start: e.start?.dateTime ?? e.start?.date ?? '', end: e.end?.dateTime ?? e.end?.date ?? '',
  allDay: !e.start?.dateTime, attendees: (e.attendees ?? []).map((a) => a.email),
  location: e.location, description: e.description?.slice(0, 2000), htmlLink: e.htmlLink,
})

const body = (e: Partial<NewCalendarEvent>) => ({
  ...(e.title !== undefined ? { summary: e.title } : {}),
  ...(e.description !== undefined ? { description: e.description } : {}),
  ...(e.location !== undefined ? { location: e.location } : {}),
  ...(e.start ? { start: { dateTime: e.start, timeZone: e.timeZone } } : {}),
  ...(e.end ? { end: { dateTime: e.end, timeZone: e.timeZone } } : {}),
  ...(e.attendees ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
})

export class GoogleCalendarProvider implements CalendarProvider {
  readonly provider = 'google_calendar'
  constructor(private http: GoogleHttp) {}

  async listEvents(timeMin: string, timeMax: string, limit: number) {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(limit) })
    const r = await gjson<{ items?: GEvent[] }>(this.http, `${API}/calendars/primary/events?${q}`)
    return (r.items ?? []).map(normalize)
  }

  async freeBusy(timeMin: string, timeMax: string) {
    const r = await gjson<{ calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } } }>(
      this.http, `${API}/freeBusy`, { method: 'POST', body: JSON.stringify({ timeMin, timeMax, items: [{ id: 'primary' }] }) })
    return r.calendars?.primary?.busy ?? []
  }

  async createEvent(e: NewCalendarEvent) {
    // sendUpdates=all only when there are guests: Google then emails the invitations
    const q = e.attendees.length ? '?sendUpdates=all' : ''
    return normalize(await gjson<GEvent>(this.http, `${API}/calendars/primary/events${q}`, { method: 'POST', body: JSON.stringify(body(e)) }))
  }

  async updateEvent(id: string, patch: Partial<NewCalendarEvent>) {
    const q = patch.attendees?.length ? '?sendUpdates=all' : ''
    return normalize(await gjson<GEvent>(this.http, `${API}/calendars/primary/events/${encodeURIComponent(id)}${q}`, { method: 'PATCH', body: JSON.stringify(body(patch)) }))
  }
}
