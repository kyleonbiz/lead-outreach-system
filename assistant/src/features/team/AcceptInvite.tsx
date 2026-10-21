import { useEffect, useRef } from 'react'
import { Button, Notice, Spinner } from '@/components/ui'
import { Logo } from '@/components/Logo'
import { useAuth } from '@/features/auth/AuthProvider'
import { rememberOrg } from '@/features/org/OrgProvider'
import { useAcceptInvitation } from './api'
import { clearPendingInvite } from './pendingInvite'

/** Shown to a signed-in user who arrived with an invitation. Accepts it exactly once, then hands over to the app. */
export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const { user, signOut } = useAuth()
  const accept = useAcceptInvitation()
  const started = useRef(false) // React StrictMode runs effects twice; the invitation must be used only once

  useEffect(() => {
    if (started.current) return
    started.current = true
    accept.mutate(token, {
      onSuccess: (r) => { clearPendingInvite(); rememberOrg(r.org_id); onDone() },
      // a failed token is never retried automatically; it stays until the user leaves this screen
    })
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const wrongAccount = accept.isError && /different e-mail/i.test(accept.error.message)

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-5">
        <Logo />
        <h1 className="text-xl font-semibold tracking-tight">Joining your team</h1>
        {accept.isPending && <Spinner label="Accepting your invitation" />}
        {accept.isError && (
          <>
            <Notice tone="danger" title="We couldn't accept this invitation">{accept.error.message}</Notice>
            <p className="text-sm text-muted">You are signed in as <strong className="text-ink">{user?.email}</strong>.</p>
            <div className="flex flex-wrap gap-2">
              {wrongAccount && <Button variant="primary" onClick={async () => { await signOut() }}>Sign out and use another account</Button>}
              <Button onClick={() => { clearPendingInvite(); onDone() }}>{wrongAccount ? 'Continue without joining' : 'Continue'}</Button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
