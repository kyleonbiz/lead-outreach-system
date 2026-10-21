import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Notice, PageHeader, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useIntegrations } from '@/features/activity/api'
import { connectError, PROVIDERS } from '@/features/integrations/providers'
import { useConnect, useDisconnect } from '@/features/integrations/api'
import { FunctionError } from '@/features/assistant/api'

const statusTone = { connected: 'ok', needs_reauth: 'warn', revoked: 'neutral', error: 'danger' } as const
const statusLabel = { connected: 'Connected', needs_reauth: 'Reconnect needed', revoked: 'Disconnected', error: 'Error' } as const

export default function IntegrationsPage() {
  const { orgId, isAdmin } = useOrg()
  const q = useIntegrations(orgId)
  const connect = useConnect(orgId)
  const disconnect = useDisconnect()
  const [params] = useSearchParams()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const connected = params.get('connected')
  const error = params.get('error')
  const connectErr = connect.error as FunctionError | null

  return (
    <>
      <PageHeader title="Integrations" description="Accounts the assistant is allowed to act on. You can disconnect any of them at any time." />
      <div className="mb-4 space-y-3">
        {connected && <Notice tone="ok" title="Connected">Your {PROVIDERS.find((p) => p.id === connected)?.name ?? 'account'} is ready.</Notice>}
        {error && <Notice tone="danger" title="Couldn't connect">{connectError(error, params.get('provider'))}</Notice>}
        {connectErr && (connectErr.body.code === 'not_configured'
          ? <Notice tone="warn" title="Server setup required">Missing: <code className="font-mono">{(connectErr.body.missing as string[]).join(', ')}</code>. See docs/SETUP.md.</Notice>
          : <Notice tone="danger">{connectErr.message}</Notice>)}
        {disconnect.data && (
          <Notice tone={disconnect.data.provider_revoked ? 'ok' : 'warn'} title="Disconnected">
            {disconnect.data.provider_revoked ? 'Access was revoked with the provider and our copy of the credentials was deleted.' : disconnect.data.note}
          </Notice>
        )}
        {disconnect.error && <Notice tone="danger">{(disconnect.error as Error).message}</Notice>}
        {!isAdmin && <Notice>Only owners and admins can connect or disconnect accounts.</Notice>}
      </div>

      {q.isLoading && <Spinner />}
      {q.isError && <Notice tone="danger" title="Couldn't load integrations">{(q.error as Error).message}</Notice>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {PROVIDERS.map((p) => {
          const conn = q.data?.find((c) => c.provider === p.id && c.status !== 'revoked')
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-sm text-muted">{p.description}</p>
                {conn && <p className="mt-1 wrap-break-word text-xs text-muted">{conn.external_account}{conn.last_error ? ` · ${conn.last_error}` : ''}</p>}
              </div>
              {conn
                ? <Badge tone={statusTone[conn.status]}>{statusLabel[conn.status]}</Badge>
                : <Badge>{p.available ? 'Not connected' : `Not available · ${p.phase}`}</Badge>}
              {conn ? (
                confirmId === conn.id ? (
                  <Button variant="danger" loading={disconnect.isPending} disabled={!isAdmin}
                    onClick={() => disconnect.mutate(conn.id, { onSettled: () => setConfirmId(null) })}>Confirm disconnect</Button>
                ) : <Button disabled={!isAdmin} onClick={() => setConfirmId(conn.id)}>{conn.status === 'needs_reauth' ? 'Remove' : 'Disconnect'}</Button>
              ) : null}
              {(!conn || conn.status === 'needs_reauth') && (
                <Button variant="primary" disabled={!p.available || !isAdmin} loading={connect.isPending && connect.variables === p.id}
                  title={p.available ? undefined : `The ${p.name} connector isn't built yet (${p.phase}).`}
                  onClick={() => connect.mutate(p.id)}>{conn ? 'Reconnect' : 'Connect'}</Button>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
