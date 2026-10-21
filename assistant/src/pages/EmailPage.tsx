import { Link, useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { Badge, Button, EmptyState, Notice, PageHeader, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { isNotConnected, useEmailTriage } from '@/features/integrations/useProviderData'

export default function EmailPage() {
  const { orgId } = useOrg()
  const q = useEmailTriage(orgId)
  const navigate = useNavigate()
  const ask = (prompt: string) => navigate('/assistant', { state: { prompt } })

  return (
    <>
      <PageHeader title="Email" description="Unread mail from the last 7 days, flagged by your urgency rules."
        actions={<Button onClick={() => ask('Summarize my unread emails and tell me which need a reply today.')}>Summarize with assistant</Button>} />
      {q.isLoading && <Spinner label="Reading your inbox" />}
      {isNotConnected(q.error) && (
        <EmptyState title="Gmail isn't connected" action={<Link to="/integrations"><Button variant="primary">Set up Gmail</Button></Link>}>
          Connect your account to see what needs a reply. Nothing is shown until it is connected.
        </EmptyState>
      )}
      {q.isError && !isNotConnected(q.error) && <Notice tone="danger" title="Couldn't load your inbox">{(q.error as Error).message}</Notice>}
      {q.data && q.data.messages.length === 0 && <EmptyState title="Inbox zero">No unread messages in the last 7 days for {q.data.account}.</EmptyState>}
      {q.data && q.data.messages.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {[...q.data.messages].sort((a, b) => Number(b.triage.urgent) - Number(a.triage.urgent) || Number(b.triage.needsResponse) - Number(a.triage.needsResponse)).map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.subject}</p>
                <p className="truncate text-xs text-muted">{m.from} · {m.date ? formatDistanceToNow(new Date(m.date), { addSuffix: true }) : ''}</p>
                <p className="mt-1 line-clamp-2 text-sm text-muted">{m.snippet}</p>
                {m.triage.reasons.length > 0 && <p className="mt-1 text-xs text-muted">Flagged: {m.triage.reasons.join('; ')}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {m.triage.urgent && <Badge tone="danger">Urgent</Badge>}
                {m.triage.needsResponse && <Badge tone="warn">Needs reply</Badge>}
                <Button onClick={() => ask(`Read email thread ${m.threadId} and draft a reply for me to review. Do not send it.`)}>Draft reply</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
