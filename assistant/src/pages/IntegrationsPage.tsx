import { Badge, Button, Notice, PageHeader, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useIntegrations } from '@/features/activity/api'
import { PROVIDERS } from '@/features/integrations/providers'

const statusTone = { connected: 'ok', needs_reauth: 'warn', revoked: 'neutral', error: 'danger' } as const
const statusLabel = { connected: 'Connected', needs_reauth: 'Reconnect needed', revoked: 'Disconnected', error: 'Error' } as const

export default function IntegrationsPage() {
  const { orgId } = useOrg()
  const q = useIntegrations(orgId)
  return (
    <>
      <PageHeader title="Integrations" description="Accounts the assistant is allowed to act on. You can disconnect any of them at any time." />
      {q.isLoading && <Spinner />}
      {q.isError && <Notice tone="danger" title="Couldn't load integrations">{(q.error as Error).message}</Notice>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {PROVIDERS.map((p) => {
          const conn = q.data?.find((c) => c.provider === p.id)
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-sm text-muted">{p.description}</p>
                {conn && <p className="mt-1 text-xs text-muted">{conn.external_account}{conn.last_error ? ` · ${conn.last_error}` : ''}</p>}
              </div>
              {conn
                ? <Badge tone={statusTone[conn.status]}>{statusLabel[conn.status]}</Badge>
                : <Badge>{p.available ? 'Not connected' : `Setup required · ${p.phase}`}</Badge>}
              <Button disabled title={p.available ? undefined : `The ${p.name} connector isn't built yet (${p.phase}).`}>
                {conn ? 'Disconnect' : 'Connect'}
              </Button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
