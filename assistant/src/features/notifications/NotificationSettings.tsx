import { useState, type FormEvent } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Hash, Trash2 } from 'lucide-react'
import { Badge, Button, Dialog, EmptyState, Field, Input, Notice, Section, Select, Spinner } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { useOrg } from '@/features/org/OrgProvider'
import { FunctionError } from '@/features/assistant/api'
import {
  EVENT_LABELS, useChannelAction, useChannels, useDeliveries, usePrefs, useSavePrefs, type Channel, type Delivery, type EventType, type Prefs,
} from './settingsApi'

const errText = (e: unknown) => (e instanceof FunctionError ? e.message : (e as Error).message)

export function NotificationSettings() {
  const { isAdmin } = useOrg()
  return (
    <>
      <EmailPrefs />
      {isAdmin && <Channels />}
      {isAdmin && <DeliveryLog />}
    </>
  )
}

function EmailPrefs() {
  const { orgId } = useOrg()
  const { user } = useAuth()
  const prefs = usePrefs(orgId, user!.id)
  const save = useSavePrefs(orgId, user!.id)
  const rows: Array<[keyof Prefs, string, string]> = [
    ['email_workflow_failed', 'A workflow fails', 'So a broken routine does not go unnoticed.'],
    ['email_approval_needed', 'Something is waiting for your approval', 'Sent when the assistant needs a yes before it acts.'],
    ['email_task_overdue', 'Tasks become overdue', 'One short summary, never one e-mail per task.'],
  ]
  return (
    <Section title="E-mail notifications">
      <div className="space-y-3 text-sm">
        <p className="text-muted">Sent only to your sign-in address <strong className="text-ink">{user?.email}</strong>.</p>
        {prefs.isLoading ? <Spinner /> : prefs.isError ? (
          <Notice tone="danger" title="Couldn't load your preferences">{(prefs.error as Error).message}</Notice>
        ) : (
          <ul className="space-y-3">
            {rows.map(([key, label, hint]) => (
              <li key={key}>
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" checked={prefs.data![key]}
                    onChange={(e) => save.mutate({ ...prefs.data!, [key]: e.target.checked })}
                  />
                  <span><span className="font-medium">{label}</span><br /><span className="text-muted">{hint}</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {save.isError && <Notice tone="danger">{(save.error as Error).message}</Notice>}
      </div>
    </Section>
  )
}

function Channels() {
  const { orgId } = useOrg()
  const channels = useChannels(orgId, true)
  const act = useChannelAction(orgId)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  async function run(body: Record<string, unknown>, success: string) {
    setMessage(null)
    try { await act.mutateAsync(body); setMessage({ tone: 'ok', text: success }) } catch (e) { setMessage({ tone: 'danger', text: errText(e) }) }
  }

  return (
    <Section title="Slack & Microsoft Teams" action={<Button onClick={() => setAdding(true)}>Add channel</Button>}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Post alerts to a team channel. Paste an incoming-webhook URL; it is stored encrypted and never shown again.
        </p>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        {channels.isLoading && <Spinner />}
        {channels.isError && <Notice tone="danger" title="Couldn't load channels">{(channels.error as Error).message}</Notice>}
        {channels.data?.length === 0 && <EmptyState title="No channels yet">Add a Slack or Teams channel to get alerts where your team already works.</EmptyState>}
        {channels.data && channels.data.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {channels.data.map((c) => (
              <ChannelRow
                key={c.id} c={c} busy={act.isPending} confirming={confirmDelete === c.id}
                onTest={() => run({ action: 'test', channel_id: c.id }, `Test message sent to “${c.name}”.`)}
                onToggle={() => run({ action: 'update', channel_id: c.id, enabled: !c.enabled }, c.enabled ? 'Channel paused.' : 'Channel resumed.')}
                onAskDelete={() => setConfirmDelete(c.id)} onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() => { setConfirmDelete(null); void run({ action: 'delete', channel_id: c.id }, 'Channel removed.') }}
              />
            ))}
          </ul>
        )}
      </div>
      <AddChannel
        open={adding} onClose={() => setAdding(false)}
        onAdd={async (body) => { await act.mutateAsync({ action: 'create', org_id: orgId, ...body }); setMessage({ tone: 'ok', text: 'Channel added. Send a test message to check it.' }) }}
      />
    </Section>
  )
}

function ChannelRow({
  c, busy, confirming, onTest, onToggle, onAskDelete, onCancelDelete, onDelete,
}: {
  c: Channel; busy: boolean; confirming: boolean; onTest: () => void; onToggle: () => void
  onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void
}) {
  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Hash className="h-4 w-4 text-muted" aria-hidden />
        <span className="font-medium">{c.name}</span>
        <Badge tone="neutral">{c.kind === 'slack' ? 'Slack' : 'Teams'}</Badge>
        {!c.enabled && <Badge tone="warn">Paused</Badge>}
        {c.last_status === 'ok' && <Badge tone="ok">Last send worked</Badge>}
        {c.last_status === 'failed' && <Badge tone="danger">Last send failed</Badge>}
      </div>
      <p className="text-xs text-muted">{c.url_hint} · {c.events.map((e) => EVENT_LABELS[e]).join(', ')}</p>
      {c.last_status === 'failed' && c.last_error && <p className="text-xs text-danger">{c.last_error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onTest} disabled={busy}>Send test</Button>
        <Button onClick={onToggle} disabled={busy}>{c.enabled ? 'Pause' : 'Resume'}</Button>
        {confirming ? (
          <>
            <Button variant="danger" onClick={onDelete}>Confirm remove</Button>
            <Button variant="ghost" onClick={onCancelDelete}>Cancel</Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onAskDelete} disabled={busy} aria-label={`Remove ${c.name}`}><Trash2 className="h-4 w-4" aria-hidden /> Remove</Button>
        )}
      </div>
    </li>
  )
}

function AddChannel({ open, onClose, onAdd }: {
  open: boolean; onClose: () => void
  onAdd: (b: { kind: string; name: string; webhook_url: string; events: EventType[] }) => Promise<void>
}) {
  const [kind, setKind] = useState<'slack' | 'teams'>('slack')
  const [events, setEvents] = useState<EventType[]>(['workflow_failed', 'approval_needed'])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    if (events.length === 0) { setError('Choose at least one thing to be notified about.'); return }
    setBusy(true); setError(null)
    try {
      await onAdd({ kind, name: String(f.get('name') ?? '').trim(), webhook_url: String(f.get('url') ?? '').trim(), events })
      onClose()
    } catch (err) { setError(errText(err)) } finally { setBusy(false) }
  }

  return (
    <Dialog
      open={open} onClose={() => { setError(null); onClose() }} title="Add a channel"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="channel-form" variant="primary" loading={busy}>Add channel</Button></>}
    >
      <form id="channel-form" onSubmit={submit} className="space-y-4">
        <Field label="Where">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as 'slack' | 'teams')}>
              <option value="slack">Slack</option><option value="teams">Microsoft Teams</option>
            </Select>
          )}
        </Field>
        <Field label="Name" hint="Only for you, e.g. “#ops-alerts”.">{(id) => <Input id={id} name="name" required maxLength={80} />}</Field>
        <Field
          label="Webhook URL"
          hint={kind === 'slack'
            ? 'In Slack: add the “Incoming Webhooks” app, pick a channel, and copy the URL (starts with https://hooks.slack.com/services/).'
            : 'In Teams: in the channel, add a Workflow “Post to a channel when a webhook request is received”, and copy its URL.'}
        >
          {(id) => <Input id={id} name="url" type="password" autoComplete="off" required maxLength={1100} spellCheck={false} />}
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Notify me when</legend>
          {(Object.keys(EVENT_LABELS) as EventType[]).map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={events.includes(ev)}
                onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))}
              />
              {EVENT_LABELS[ev]}
            </label>
          ))}
        </fieldset>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  )
}

const statusTone = { sent: 'ok', failed: 'danger', skipped: 'warn', pending: 'neutral', sending: 'neutral' } as const

function DeliveryLog() {
  const { orgId } = useOrg()
  const q = useDeliveries(orgId, true)
  return (
    <Section title="Recent deliveries">
      <div className="space-y-3 text-sm">
        <p className="text-muted">What was sent outside the app, and why anything wasn't.</p>
        {q.isLoading && <Spinner />}
        {q.isError && <Notice tone="danger">{(q.error as Error).message}</Notice>}
        {q.data?.length === 0 && <p className="text-muted">Nothing has been sent yet.</p>}
        {q.data && q.data.length > 0 && (
          <ul className="divide-y divide-line">
            {q.data.map((d: Delivery) => (
              <li key={d.id} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <span>{d.channel === 'email' ? 'E-mail' : d.channel === 'slack' ? 'Slack' : 'Teams'}
                    <span className="text-muted"> · {formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}</span></span>
                  <Badge tone={statusTone[d.status]}>{d.status}</Badge>
                </div>
                {d.last_error && d.status !== 'sent' && <p className="mt-1 text-xs text-muted">{d.last_error}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
