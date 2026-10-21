import { useQuery } from '@tanstack/react-query'
import { callFunction, FunctionError } from '@/features/assistant/api'

export interface Triage { urgent: boolean; needsResponse: boolean; automated: boolean; reasons: string[] }
export interface TriagedMessage {
  id: string; threadId: string; from: string; subject: string; snippet: string; date: string; unread: boolean; triage: Triage
}
export interface AgendaEvent { id: string; title: string; start: string; end: string; allDay: boolean; attendees: string[]; location?: string }

const retryable = (n: number, e: unknown) => !(e instanceof FunctionError && [409, 503].includes(e.status)) && n < 1

export function useEmailTriage(orgId: string) {
  return useQuery({
    queryKey: ['email-triage', orgId], retry: retryable,
    queryFn: () => callFunction<{ account: string; messages: TriagedMessage[] }>('provider-data', { action: 'email.triage', org_id: orgId, days: 7, limit: 25 }),
  })
}

export function useAgenda(orgId: string, days: number) {
  return useQuery({
    queryKey: ['agenda', orgId, days], retry: retryable,
    queryFn: () => callFunction<{ timezone: string; events: AgendaEvent[] }>('provider-data', { action: 'calendar.agenda', org_id: orgId, days }),
  })
}

/** 'not_connected' (409) is a normal setup state, not an error. */
export const isNotConnected = (e: unknown) => e instanceof FunctionError && e.status === 409
