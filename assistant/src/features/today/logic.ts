import type { AgendaEvent, TriagedMessage } from '@/features/integrations/useProviderData'

const startMs = (e: AgendaEvent) => Date.parse(e.start)
const endMs = (e: AgendaEvent) => Date.parse(e.end)

/** Events that have not finished yet, in start order (ties: longer first), capped at `limit`. */
export function upcomingEvents(events: AgendaEvent[], now: Date, limit = Infinity): AgendaEvent[] {
  return events
    .filter((e) => Number.isFinite(startMs(e)) && !(endMs(e) <= now.getTime()))
    .sort((a, b) => startMs(a) - startMs(b) || endMs(b) - endMs(a))
    .slice(0, limit)
}

/** Messages worth a look: urgent or awaiting a reply, never automated senders. Urgent first, then newest. */
export function mailNeedingAttention(messages: TriagedMessage[], limit = Infinity): TriagedMessage[] {
  const t = (m: TriagedMessage) => Date.parse(m.date) || 0
  return messages
    .filter((m) => (m.triage.urgent || m.triage.needsResponse) && !m.triage.automated)
    .sort((a, b) =>
      Number(b.triage.urgent) - Number(a.triage.urgent)
      || Number(b.triage.needsResponse) - Number(a.triage.needsResponse)
      || t(b) - t(a))
    .slice(0, limit)
}
