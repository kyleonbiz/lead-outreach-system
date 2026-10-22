import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ArrowRight, Send } from 'lucide-react'
import { Badge, Button, Section, Spinner, Textarea } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useTasks } from '@/features/tasks/api'
import { useIntegrations, useRecentActivity, useWorkflowSummary } from '@/features/activity/api'
import { usePendingApprovalList } from '@/features/assistant/api'
import { useLatestBriefing } from '@/features/workflows/api'
import { StatusBadge } from '@/features/activity/StatusBadge'
import { ApprovalCard } from '@/features/assistant/ApprovalCard'
import { PROVIDERS } from '@/features/integrations/providers'
import { AgendaCardBody, MailCardBody } from '@/features/today/cards'
import { dueInfo, greeting, isOpen } from '@/lib/utils'
import { Markdown } from '@/lib/markdown'

const More = ({ to, children }: { to: string; children: string }) => (
  <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
    {children} <ArrowRight className="h-3 w-3" aria-hidden />
  </Link>
)

const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted">{children}</p>

export default function OverviewPage() {
  const { orgId, profile } = useOrg()
  const navigate = useNavigate()
  const [cmd, setCmd] = useState('')
  const tasks = useTasks(orgId)
  const activity = useRecentActivity(orgId)
  const approvals = usePendingApprovalList(orgId)
  const integrations = useIntegrations(orgId)
  const workflows = useWorkflowSummary(orgId)
  const briefing = useLatestBriefing(orgId)

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

      <form
        className="rounded-lg border border-line bg-surface p-4"
        onSubmit={(e) => { e.preventDefault(); const p = cmd.trim(); if (p) navigate('/assistant', { state: { prompt: p } }) }}
      >
        <label htmlFor="cmd" className="sr-only">Ask your assistant</label>
        <Textarea id="cmd" rows={2} value={cmd} onChange={(e) => setCmd(e.target.value)} className="resize-none"
          placeholder="Summarize my unread emails, schedule a meeting, find overdue tasks…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">Sensitive actions always wait for your approval.</p>
          <Button type="submit" variant="primary" disabled={!cmd.trim()}><Send className="h-4 w-4" /> Ask</Button>
        </div>
      </form>

      <Section title="Daily briefing" action={<More to="/workflows">Workflows</More>}>
        {briefing.isLoading ? <Spinner /> : !briefing.data?.exists ? (
          <Muted>Not set up. <Link className="text-accent underline underline-offset-2" to="/workflows">Turn on the daily briefing</Link> to get your agenda, important email and overdue tasks each weekday morning.</Muted>
        ) : !briefing.data.run ? (
          <Muted>{briefing.data.enabled ? 'No briefing has run yet. The first one arrives at the next scheduled time.' : 'The daily briefing is switched off.'}</Muted>
        ) : briefing.data.run.status === 'succeeded' && briefing.data.run.output?.text ? (
          <div>
            <Markdown className="text-sm" text={briefing.data.run.output.text} />
            <p className="mt-2 text-xs text-muted">Generated {format(new Date(briefing.data.run.finished_at ?? briefing.data.run.created_at), 'EEE MMM d, h:mm a')}</p>
          </div>
        ) : briefing.data.run.status === 'failed' ? (
          <Muted>The last briefing failed: {briefing.data.run.error}</Muted>
        ) : <Muted>The latest briefing is {briefing.data.run.status.replace('_', ' ')}.</Muted>}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Today's agenda" action={<More to="/calendar">Calendar</More>}>
          <AgendaCardBody orgId={orgId} />
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
          <MailCardBody orgId={orgId} />
        </Section>

        <Section title="Pending approvals">
          {approvals.isLoading ? <Spinner /> : (approvals.data ?? []).length === 0 ? <Muted>Nothing is waiting for your approval.</Muted> : (
            <div className="space-y-3">
              {approvals.data!.map((a) => <ApprovalCard key={a.id} a={a} />)}
            </div>
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
