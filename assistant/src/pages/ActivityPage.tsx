import { useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { Bot, User, Workflow, Cog } from 'lucide-react'
import { Button, EmptyState, Notice, PageHeader, Select, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useActivity } from '@/features/activity/api'
import { StatusBadge } from '@/features/activity/StatusBadge'
import type { ActionLog } from '@/lib/types'

const actorIcon = { user: User, assistant: Bot, workflow: Workflow, system: Cog }

export default function ActivityPage() {
  const { orgId } = useOrg()
  const [status, setStatus] = useState<ActionLog['status'] | 'all'>('all')
  const q = useActivity(orgId, status)
  const rows = q.data?.pages.flat() ?? []

  return (
    <>
      <PageHeader
        title="Activity" description="A record of everything the assistant did: when, with which tool, and whether it worked."
        actions={
          <Select aria-label="Filter by result" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-40">
            <option value="all">All results</option><option value="success">Succeeded</option>
            <option value="failure">Failed</option><option value="pending">Pending</option><option value="denied">Denied</option>
          </Select>
        }
      />
      {q.isLoading && <Spinner label="Loading activity" />}
      {q.isError && <Notice tone="danger" title="Couldn't load activity">{(q.error as Error).message}</Notice>}
      {q.data && rows.length === 0 && (
        <EmptyState title="No activity yet">Actions taken by you, the assistant and your workflows will be listed here.</EmptyState>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {rows.map((r) => {
            const Icon = actorIcon[r.actor_type]
            return (
              <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label={r.actor_type} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{r.summary ?? r.action}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    <code className="font-mono">{r.tool_name ?? r.action}</code>
                    {r.duration_ms != null && <> · {r.duration_ms} ms</>}
                    {' · '}
                    <time dateTime={r.created_at} title={format(new Date(r.created_at), 'PPpp')}>
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </time>
                  </p>
                  {r.error && <p className="mt-1 text-xs text-danger">{r.error}</p>}
                </div>
                <StatusBadge status={r.status} />
              </li>
            )
          })}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="mt-4 text-center">
          <Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load older activity</Button>
        </div>
      )}
    </>
  )
}
