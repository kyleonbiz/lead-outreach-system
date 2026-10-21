// Chooses which connected account serves "email" and "calendar" for an organization.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalendarProvider, EmailProvider } from '../core/ports.ts'
import { NotConfiguredError } from '../core/types.ts'
import { pickProvider } from '../core/providers/select.ts'
import { calendarFor, gmailFor } from './google.ts'
import { outlookCalendarFor, outlookMailFor } from './microsoft.ts'

type Kind = 'email' | 'calendar'
const PROVIDERS: Record<Kind, string[]> = { email: ['google_gmail', 'microsoft_mail'], calendar: ['google_calendar', 'microsoft_calendar'] }
const NAME: Record<Kind, string> = { email: 'an email account (Gmail or Outlook)', calendar: 'a calendar (Google Calendar or Outlook Calendar)' }

async function chosen(svc: SupabaseClient, orgId: string, kind: Kind): Promise<string> {
  const { data } = await svc.from('connected_integrations').select('provider, status, created_at').eq('org_id', orgId).in('provider', PROVIDERS[kind])
  const p = pickProvider((data ?? []) as Array<{ provider: string; status: string; created_at: string }>, PROVIDERS[kind])
  if (!p) throw new NotConfiguredError(NAME[kind], `${NAME[kind]} is not connected. The user needs to set it up in Integrations.`)
  return p
}

export async function emailFor(svc: SupabaseClient, orgId: string): Promise<EmailProvider> {
  return (await chosen(svc, orgId, 'email')) === 'microsoft_mail' ? outlookMailFor(svc, orgId) : gmailFor(svc, orgId)
}

export async function anyCalendarFor(svc: SupabaseClient, orgId: string): Promise<CalendarProvider> {
  return (await chosen(svc, orgId, 'calendar')) === 'microsoft_calendar' ? outlookCalendarFor(svc, orgId) : calendarFor(svc, orgId)
}
