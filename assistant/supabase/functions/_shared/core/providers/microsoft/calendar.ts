import type { CalendarEvent, CalendarProvider, NewCalendarEvent } from '../../ports.ts'
import { tzOffsetMs } from '../../time.ts'
import { assertGraphId, graph, type GraphHttp } from './http.ts'

const UTC = 'outlook.timezone="UTC"'
const SELECT = 'id,subject,bodyPreview,location,attendees,webLink,isAllDay,isCancelled,start,end,showAs'
/** Calendar views are capped; a day or two of events fits comfortably. */
const BUSY = new Set(['busy', 'oof', 'tentative', 'workingelsewhere'])

interface GEvent {
  id: string; subject?: string; bodyPreview?: string; location?: { displayName?: string }; webLink?: string
  attendees?: Array<{ emailAddress?: { address?: string } }>; isAllDay?: boolean; isCancelled?: boolean
  start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; showAs?: string
}

/** Graph returns "2026-10-21T14:00:00.0000000" (no zone designator) in the zone we asked for: UTC. */
const asIso = (d?: { dateTime?: string }): string => {
  const v = d?.dateTime ?? ''
  if (!v) return ''
  return /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v.slice(0, 19)}Z`
}

/** The calendar date, in `tz`, of a UTC instant, as YYYY-MM-DD (used for all-day events). */
function localDate(iso: string, tz: string): string {
  const at = new Date(iso)
  return new Date(at.getTime() + tzOffsetMs(at, tz)).toISOString().slice(0, 10)
}

const utcPoint = (iso: string) => ({ dateTime: new Date(iso).toISOString().slice(0, 19), timeZone: 'UTC' })

export class OutlookCalendarProvider implements CalendarProvider {
  readonly provider = 'microsoft_calendar'
  /** `zone` is the organization's time zone, used only to turn all-day events back into calendar dates. */
  constructor(private http: GraphHttp, private zone = 'UTC') {}

  private normalize(e: GEvent): CalendarEvent {
    const allDay = !!e.isAllDay
    const start = asIso(e.start), end = asIso(e.end)
    return {
      id: e.id, title: e.subject || '(no title)',
      start: allDay && start ? localDate(start, this.zone) : start, end: allDay && end ? localDate(end, this.zone) : end,
      allDay, attendees: (e.attendees ?? []).map((a) => a.emailAddress?.address ?? '').filter(Boolean),
      location: e.location?.displayName || undefined, description: e.bodyPreview?.slice(0, 2000) || undefined, htmlLink: e.webLink,
    }
  }

  private async view(timeMin: string, timeMax: string, top: number): Promise<GEvent[]> {
    const q = new URLSearchParams({
      startDateTime: new Date(timeMin).toISOString(), endDateTime: new Date(timeMax).toISOString(),
      $top: String(top), $orderby: 'start/dateTime', $select: SELECT,
    })
    return (await graph<{ value?: GEvent[] }>(this.http, `/me/calendarView?${q}`, { prefer: UTC })).value ?? []
  }

  async listEvents(timeMin: string, timeMax: string, limit: number) {
    return (await this.view(timeMin, timeMax, limit)).filter((e) => !e.isCancelled).map((e) => this.normalize(e))
  }

  async freeBusy(timeMin: string, timeMax: string) {
    return (await this.view(timeMin, timeMax, 200))
      .filter((e) => !e.isCancelled && BUSY.has((e.showAs ?? 'busy').toLowerCase()))
      .map((e) => ({ start: asIso(e.start), end: asIso(e.end) }))
  }

  /** Events are written as UTC instants: the same moment, shown by Outlook in each person's own zone, with no zone-name translation. */
  private body(e: Partial<NewCalendarEvent>) {
    return {
      ...(e.title !== undefined ? { subject: e.title } : {}),
      ...(e.description !== undefined ? { body: { contentType: 'Text', content: e.description } } : {}),
      ...(e.location !== undefined ? { location: { displayName: e.location } } : {}),
      ...(e.start ? { start: utcPoint(e.start) } : {}),
      ...(e.end ? { end: utcPoint(e.end) } : {}),
      ...(e.attendees ? { attendees: e.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
    }
  }

  // Graph sends the invitations / updates to attendees itself when an event with guests is created or changed.
  async createEvent(e: NewCalendarEvent) {
    return this.normalize(await graph<GEvent>(this.http, '/me/events', { method: 'POST', body: JSON.stringify(this.body(e)), prefer: UTC }))
  }

  async updateEvent(id: string, patch: Partial<NewCalendarEvent>) {
    assertGraphId(id, 'event id')
    return this.normalize(await graph<GEvent>(this.http, `/me/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(this.body(patch)), prefer: UTC }))
  }
}
