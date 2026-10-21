import { z } from 'zod'
import type { ToolDef } from './registry.ts'

const iso = z.iso.datetime({ offset: true })
const tz = z.string().min(1).max(60).refine((v) => {
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false }
}, 'must be a valid IANA time zone such as America/Chicago')

export const calendarListEvents: ToolDef = {
  name: 'calendar.list_events',
  description: 'List calendar events between two ISO 8601 timestamps (with offset). Use for agendas and "what is on my calendar".',
  risk: 'read', untrusted: true,
  input: z.object({ time_min: iso, time_max: iso, limit: z.number().int().min(1).max(50).default(25) }),
  summarize: (i) => `List calendar events ${i.time_min} → ${i.time_max}`,
  async execute(ctx, i) { return (await ctx.ports.calendar()).listEvents(i.time_min, i.time_max, i.limit) },
}

export const calendarFreeBusy: ToolDef = {
  name: 'calendar.free_busy',
  description: 'Return the busy intervals on the user\'s calendar in a window, to find open slots for scheduling.',
  risk: 'read',
  input: z.object({ time_min: iso, time_max: iso }),
  summarize: (i) => `Check availability ${i.time_min} → ${i.time_max}`,
  async execute(ctx, i) { return { busy: await (await ctx.ports.calendar()).freeBusy(i.time_min, i.time_max) } },
}

const newEvent = z.object({
  title: z.string().min(1).max(300),
  start: iso, end: iso,
  time_zone: tz.describe('IANA time zone for the event. Ask the user if unsure; do not guess.'),
  attendees: z.array(z.email()).max(50).describe('Guest emails. Use [] only if the user confirmed there are no guests.'),
  description: z.string().max(5000).optional(), location: z.string().max(300).optional(),
}).refine((e) => Date.parse(e.end) > Date.parse(e.start), { message: 'end must be after start', path: ['end'] })

export const calendarCreateEvent: ToolDef = {
  name: 'calendar.create_event',
  description: 'Create a calendar event. Requires an explicit time zone and an explicit attendee list. Guests receive invitations, so this requires the user\'s approval unless pre-authorized for internal-only events.',
  risk: 'sensitive',
  input: newEvent,
  summarize: (i) => `Create event "${i.title}" ${i.start} → ${i.end} (${i.time_zone})${i.attendees.length ? `, inviting ${i.attendees.join(', ')}` : ', no guests'}`,
  async execute(ctx, i) {
    const e = await (await ctx.ports.calendar()).createEvent({
      title: i.title, start: i.start, end: i.end, timeZone: i.time_zone, attendees: i.attendees, description: i.description, location: i.location,
    })
    return { created: true, event: e }
  },
}

export const calendarUpdateEvent: ToolDef = {
  name: 'calendar.update_event',
  description: 'Change an existing event. Guests are notified of changes, so this always requires the user\'s approval.',
  risk: 'sensitive',
  input: z.object({
    id: z.string().min(1).max(200), title: z.string().min(1).max(300).optional(), start: iso.optional(), end: iso.optional(),
    time_zone: tz.optional(), description: z.string().max(5000).optional(), location: z.string().max(300).optional(),
    attendees: z.array(z.email()).max(50).optional(),
  }).refine((e) => !(e.start || e.end) || !!e.time_zone, { message: 'time_zone is required when changing times', path: ['time_zone'] }),
  summarize: (i) => `Update calendar event ${i.id}${i.title ? ` → "${i.title}"` : ''}${i.start ? ` start ${i.start}` : ''}${i.end ? ` end ${i.end}` : ''}`,
  async execute(ctx, { id, time_zone, ...rest }) {
    const e = await (await ctx.ports.calendar()).updateEvent(id, { ...rest, timeZone: time_zone })
    return { updated: true, event: e }
  },
}

export const calendarTools = [calendarListEvents, calendarFreeBusy, calendarCreateEvent, calendarUpdateEvent]
