import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { UseQueryResult } from '@tanstack/react-query'
import { Spinner } from '@/components/ui'
import { isNotConnected } from '@/features/integrations/useProviderData'

/** Honest states for data that comes from a connected account: loading, not connected, failed, or the data itself. */
export function ProviderGate<T>({ query, what, children }: { query: UseQueryResult<T, unknown>; what: string; children: (data: T) => ReactNode }) {
  if (query.isLoading) return <Spinner />
  if (isNotConnected(query.error)) {
    return (
      <p className="text-sm text-muted">
        No {what} is connected. <Link className="text-accent underline underline-offset-2" to="/integrations">Set it up</Link> to see it here.
      </p>
    )
  }
  if (query.isError) return <p role="alert" className="text-sm text-danger">Couldn't load your {what}: {(query.error as Error).message}</p>
  if (!query.data) return null
  return <>{children(query.data)}</>
}
