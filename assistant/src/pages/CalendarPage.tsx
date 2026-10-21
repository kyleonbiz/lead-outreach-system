import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { Button, EmptyState, Notice, PageHeader, Select, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { isNotConnected, useAgenda } from '@/features/integrations/useProviderData'

export default function CalendarPage() {
  const { orgId } = useOrg()
  const [days, setDays] = useState(1)
  const q = useAgenda(orgId, days)
  const navigate = useNavigate()

  return (
    <>
      <PageHeader title="Calendar" description="Your agenda. Ask the assistant to find a time or schedule a meeting — it will confirm details and ask before inviting anyone."
        actions={
          <>
            <Select aria-label="Range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
              <option value={1}>Today</option><option value={7}>Next 7 days</option><option value={14}>Next 14 days</option>
            </Select>
            <Button onClick={() => navigate('/assistant', { state: { prompt: 'Find three 30-minute slots this week that are free on my calendar.' } })}>Find a time</Button>
          </>
        } />
      {q.isLoading && <Spinner label="Loading agenda" />}
      {isNotConnected(q.error) && (
        <EmptyState title="No calendar is connected" action={<Link to="/integrations"><Button variant="primary">Set up Calendar</Button></Link>}>
          Connect Google Calendar or Outlook Calendar to see your agenda. Nothing is shown until it is connected.
        </EmptyState>
      )}
      {q.isError && !isNotConnected(q.error) && <Notice tone="danger" title="Couldn't load your calendar">{(q.error as Error).message}</Notice>}
      {q.data && q.data.events.length === 0 && <EmptyState title="Nothing scheduled">No events in this range.</EmptyState>}
      {q.data && q.data.events.length > 0 && (
        <>
          <p className="mb-2 text-xs text-muted">Times shown in {q.data.timezone}</p>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {q.data.events.map((e) => (
              <li key={e.id} className="flex items-start gap-4 px-4 py-3">
                <div className="w-28 shrink-0 text-sm text-muted">
                  {e.allDay ? 'All day' : `${format(parseISO(e.start), 'EEE h:mm a')}`}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{e.title}</p>
                  {(e.location || e.attendees.length > 0) && (
                    <p className="truncate text-xs text-muted">{[e.location, e.attendees.length ? `${e.attendees.length} guest${e.attendees.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
