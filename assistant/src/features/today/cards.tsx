import { Link } from 'react-router-dom'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { Badge } from '@/components/ui'
import { useAgenda, useEmailTriage, type AgendaEvent } from '@/features/integrations/useProviderData'
import { ProviderGate } from './ProviderGate'
import { mailNeedingAttention, upcomingEvents } from './logic'

export const eventTime = (e: AgendaEvent) => (e.allDay ? 'All day' : format(parseISO(e.start), 'h:mm a'))
export const guestLabel = (n: number) => (n > 0 ? `${n} guest${n > 1 ? 's' : ''}` : '')

export function AgendaCardBody({ orgId, limit = 4 }: { orgId: string; limit?: number }) {
  const q = useAgenda(orgId, 1)
  return (
    <ProviderGate query={q} what="calendar">
      {(d) => {
        const all = d.events.length
        const next = upcomingEvents(d.events, new Date(), limit)
        if (next.length === 0) {
          return <p className="text-sm text-muted">{all === 0 ? 'Nothing is scheduled today.' : 'Nothing left on your calendar today.'}</p>
        }
        return (
          <>
            <ul className="-my-2 divide-y divide-line">
              {next.map((e) => (
                <li key={e.id} className="flex items-baseline gap-3 py-2">
                  <span className="w-16 shrink-0 text-sm text-muted tabular-nums">{eventTime(e)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.title}</span>
                    {(e.location || e.attendees.length > 0) && (
                      <span className="block truncate text-xs text-muted">{[e.location, guestLabel(e.attendees.length)].filter(Boolean).join(' · ')}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {all > next.length && <p className="mt-3 text-xs text-muted"><Link className="text-accent hover:underline" to="/calendar">See all {all} events today</Link></p>}
          </>
        )
      }}
    </ProviderGate>
  )
}

export function MailCardBody({ orgId, limit = 4 }: { orgId: string; limit?: number }) {
  const q = useEmailTriage(orgId)
  return (
    <ProviderGate query={q} what="email account">
      {(d) => {
        const top = mailNeedingAttention(d.messages, limit)
        const total = mailNeedingAttention(d.messages).length
        if (top.length === 0) return <p className="text-sm text-muted">Nothing urgent or waiting for a reply in {d.account}.</p>
        return (
          <>
            <ul className="-my-2 divide-y divide-line">
              {top.map((m) => (
                <li key={m.id} className="py-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium">{m.subject}</span>
                    <span className="flex shrink-0 gap-1">
                      {m.triage.urgent && <Badge tone="danger">Urgent</Badge>}
                      {m.triage.needsResponse && <Badge tone="warn">Reply</Badge>}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted">
                    {m.from.replace(/\s*<[^>]*>\s*$/, '') || m.from}{m.date ? ` · ${formatDistanceToNow(new Date(m.date), { addSuffix: true })}` : ''}
                  </p>
                </li>
              ))}
            </ul>
            {total > top.length && <p className="mt-3 text-xs text-muted"><Link className="text-accent hover:underline" to="/email">{total - top.length} more need attention</Link></p>}
          </>
        )
      }}
    </ProviderGate>
  )
}
