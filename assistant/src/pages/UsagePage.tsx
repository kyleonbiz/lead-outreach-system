import { useState } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { ArrowLeft } from 'lucide-react'
import { Badge, EmptyState, Notice, PageHeader, Section, Select, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { cn } from '@/lib/utils'
import { DailyTokensChart } from '@/features/usage/DailyTokensChart'
import { useUsage, type UsageResponse } from '@/features/usage/api'

const nf = new Intl.NumberFormat('en-US')
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)

export default function UsagePage() {
  const { orgId, isAdmin } = useOrg()
  const [days, setDays] = useState(30)
  const q = useUsage(orgId, days, isAdmin)

  return (
    <>
      <Link to="/settings" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden /> Settings</Link>
      <PageHeader
        title="Usage" description="What the assistant has used, and how close you are to your daily limit."
        actions={isAdmin ? (
          <Select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
            <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
          </Select>
        ) : undefined}
      />
      {!isAdmin && <Notice tone="warn" title="Owners and admins only">Ask an owner or admin of this organization about usage.</Notice>}
      {isAdmin && q.isLoading && <Spinner label="Loading usage" />}
      {isAdmin && q.isError && <Notice tone="danger" title="Couldn't load usage">{(q.error as Error).message}</Notice>}
      {isAdmin && q.data && <Body u={q.data} />}
    </>
  )
}

function Body({ u }: { u: UsageResponse }) {
  const tokens = u.totals.input_tokens + u.totals.output_tokens
  const runs = Object.values(u.workflow_runs).reduce((a, b) => a + b, 0)
  const failedRuns = u.workflow_runs.failed ?? 0
  const quiet = tokens === 0 && u.totals.tool_calls === 0 && runs === 0

  return (
    <div className="space-y-6">
      <Budget today={u.today} />

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Tokens, last ${u.window_days} days`} value={nf.format(tokens)} hint={`${nf.format(u.totals.input_tokens)} in · ${nf.format(u.totals.output_tokens)} out`} />
        <Stat label="Tool calls" value={nf.format(u.totals.tool_calls)} hint="Actions the assistant took" />
        <Stat label="Workflow runs" value={nf.format(runs)} hint={failedRuns ? `${failedRuns} failed` : runs ? 'None failed' : 'None yet'} />
        <Stat label="Stored documents" value={fmtBytes(u.storage.bytes)} hint={`${nf.format(u.storage.documents)} document${u.storage.documents === 1 ? '' : 's'}`} />
      </dl>

      {quiet ? (
        <EmptyState title="No assistant activity in this period">Tokens, tool calls and workflow runs appear here as the assistant works.</EmptyState>
      ) : (
        <>
          <Section title="Tokens per day"><DailyTokensChart daily={u.daily} /></Section>
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Most used tools">
              {u.tools.length === 0 ? <p className="text-sm text-muted">No tool calls in this period.</p> : (
                <table className="w-full text-sm" aria-label="Most used tools">
                  <thead><tr className="text-left text-xs text-muted"><th scope="col" className="pb-2 font-medium">Tool</th><th scope="col" className="pb-2 text-right font-medium">Calls</th><th scope="col" className="pb-2 text-right font-medium">Failed</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {u.tools.map((t) => (
                      <tr key={t.tool}><td className="py-2 font-mono text-xs">{t.tool}</td><td className="py-2 text-right">{nf.format(t.calls)}</td>
                        <td className={cn('py-2 text-right', t.failures > 0 && 'text-danger')}>{nf.format(t.failures)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
            <Section title="By model">
              {u.by_model.length === 0 ? <p className="text-sm text-muted">No AI usage in this period.</p> : (
                <table className="w-full text-sm" aria-label="Tokens by model">
                  <thead><tr className="text-left text-xs text-muted"><th scope="col" className="pb-2 font-medium">Model</th><th scope="col" className="pb-2 text-right font-medium">In</th><th scope="col" className="pb-2 text-right font-medium">Out</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {u.by_model.map((m) => (
                      <tr key={m.model}><td className="py-2 font-mono text-xs">{m.model}</td><td className="py-2 text-right">{nf.format(m.input_tokens)}</td><td className="py-2 text-right">{nf.format(m.output_tokens)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>
        </>
      )}

      <p className="text-xs text-muted">
        Days are UTC and the daily limit resets at midnight UTC. Cost is not shown because it depends on your AI provider's pricing. There is no limit on total storage
        (each uploaded file can be up to 25 MB). Figures were generated {format(new Date(u.generated_at), 'PPp')}.
      </p>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight">{value}</dd>
      <dd className="mt-1 text-xs text-muted">{hint}</dd>
    </div>
  )
}

function Budget({ today }: { today: UsageResponse['today'] }) {
  const { limit, percent } = today
  const over = limit !== null && today.tokens >= limit
  const tone = percent === null ? 'accent' : percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'accent'
  const fill = { accent: 'bg-accent', warn: 'bg-warn', danger: 'bg-danger' }[tone]
  const resets = format(new Date(today.resets_at), 'p')

  return (
    <Section title="Today's AI budget" action={limit === null ? <Badge>No daily limit</Badge> : over ? <Badge tone="danger">Limit reached</Badge> : percent !== null && percent >= 70 ? <Badge tone="warn">Getting close</Badge> : <Badge tone="ok">Within budget</Badge>}>
      <div className="space-y-3">
        <p className="text-sm">
          <strong className="text-2xl font-semibold tracking-tight">{nf.format(today.tokens)}</strong>
          {limit !== null ? <span className="text-muted"> of {nf.format(limit)} tokens used today ({percent}%)</span> : <span className="text-muted"> tokens used today</span>}
        </p>
        {limit !== null && (
          <div
            role="progressbar" aria-label="Today's token usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(percent ?? 0))}
            aria-valuetext={`${percent}% of today's limit`} className="h-2.5 overflow-hidden rounded-full bg-sunken"
          >
            <div className={cn('h-full rounded-full transition-[width]', fill)} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
          </div>
        )}
        <p className="text-sm text-muted">
          {limit === null ? 'No daily limit is configured on this server, so the assistant is never paused for usage.'
            : over ? `The limit has been reached: the assistant is paused for this organization until midnight UTC (${resets} your time).`
            : `${nf.format(today.remaining ?? 0)} tokens remain. The count resets at midnight UTC (${resets} your time).`}
        </p>
      </div>
    </Section>
  )
}
