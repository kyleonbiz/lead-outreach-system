import { Link } from 'react-router-dom'
import { format, formatDistanceToNow } from 'date-fns'
import { ArrowRight, Send } from 'lucide-react'
import { Badge, Button, Section, Spinner, Textarea } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useTasks } from '@/features/tasks/api'
import { useIntegrations, useRecentActivity, usePendingApprovals, useWorkflowSummary } from '@/features/activity/api'
import { StatusBadge } from '@/features/activity/StatusBadge'
import { PROVIDERS } from '@/features/integrations/providers'
import { dueInfo, greeting, isOpen } from '@/lib/utils'

const More = ({ to, children }: { to: string; children: string }) => (
  <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
    {children} <ArrowRight className="h-3 w-3" aria-hidden />
  </Link>
)

const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted">{children}</p>

export default function OverviewPage() {
  const { orgId, profile } = useOrg()
  const tasks = useTasks(orgId)
  const activity = useRecentActivity(orgId)
  const approvals = usePendingApprovals(orgId)
  const integrations = useIntegrations(orgId)
  const workflows = useWorkflowSummary(orgId)

  const gmail = integrations.data?.find((i) => i.provider === 'google_gmail' && i.status === 'connected')
  const calendar = integrations.data?.find((i) => i.provider === 'google_calendar' && i.status === 'connected')
  const dueSoon = (tasks.data ?? []).filter((t) => {
    if (!isOpen(t) || !t.due_at) return false
    return Date.parse(t.due_at) < Date.now() + 3 * 86_400_000
  }).slice(0, 6)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting(profile?.full_name)}</h1>
        <p className="mt-1 text-sm text-muted">{format(new Date(), 'EEEE, MMMM d')}</p>
      </div>

      {/* Assistant command box: deliberately disabled until the orchestration layer exists. */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <label htmlFor="cmd" className="sr-only">Ask your assistant</label>
        <Textarea id="cmd" disabled rows={2} className="resize-none" placeholder="Summarize my unread emails, schedule a meeting, find overdue tasks…" />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">The assistant isn't connected yet — it arrives in Phase 3, once an AI key is configured.</p>
          <Button variant="primary" disabled><Send className="h-4 w-4" /> Send</Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Today's agenda" action={<More to="/calendar">Calendar</More>}>
          {calendar ? <Muted>Calendar sync arrives in Phase 4.</Muted>
            : <Muted>Google Calendar isn't connected. <Link className="text-accent hover:underline" to="/integrations">Set it up</Link> to see your day here.</Muted>}
        </Section>

        <Section title="Tasks due soon" action={<More to="/tasks">All tasks</More>}>
          {tasks.isLoading ? <Spinner /> : dueSoon.length === 0 ? <Muted>Nothing due in the next three days.</Muted> : (
            <ul className="-my-2 divide-y divide-line">
              {dueSoon.map((t) => {
                const d = dueInfo(t.due_at)
                return (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-sm">{t.title}</span>
                    <Badge tone={d.tone === 'overdue' ? 'danger' : d.tone === 'today' ? 'warn' : 'neutral'}>{d.label}</Badge>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section title="Important communications" action={<More to="/email">Email</More>}>
          {gmail ? <Muted>Email triage arrives in Phase 4.</Muted>
            : <Muted>Gmail isn't connected. <Link className="text-accent hover:underline" to="/integrations">Set it up</Link> to see what needs a reply.</Muted>}
        </Section>

        <Section title="Pending approvals">
          {approvals.isLoading ? <Spinner /> : (approvals.data ?? []).length === 0 ? <Muted>Nothing is waiting for your approval.</Muted> : (
            <ul className="-my-2 divide-y divide-line">
              {approvals.data!.map((a) => (
                <li key={a.id} className="py-2">
                  <p className="text-sm">{a.summary}</p>
                  <p className="text-xs text-muted">{a.action_type} · {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent assistant actions" action={<More to="/activity">Activity</More>}>
          {activity.isLoading ? <Spinner /> : (activity.data ?? []).length === 0 ? <Muted>No actions yet.</Muted> : (
            <ul className="-my-2 divide-y divide-line">
              {activity.data!.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-sm">{a.summary ?? a.action}</span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Workflows" action={<More to="/workflows">Workflows</More>}>
          {workflows.isLoading ? <Spinner /> : workflows.data!.total === 0
            ? <Muted>No workflows yet. Workflow automation arrives in Phase 6.</Muted>
            : <Muted>{workflows.data!.enabled} of {workflows.data!.total} enabled.</Muted>}
        </Section>
      </div>

      <Section title="Integrations" action={<More to="/integrations">Manage</More>}>
        <ul className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => {
            const c = integrations.data?.find((i) => i.provider === p.id)
            return (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                {p.name}
                <Badge tone={c?.status === 'connected' ? 'ok' : c ? 'warn' : 'neutral'}>
                  {c ? (c.status === 'connected' ? 'Connected' : 'Needs attention') : 'Setup required'}
                </Badge>
              </li>
            )
          })}
        </ul>
      </Section>
    </div>
  )
}
