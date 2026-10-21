import { useState, type FormEvent } from 'react'
import { db } from '@/lib/supabase'
import { Button, Field, Input, Notice } from '@/components/ui'
import { Logo } from '@/components/Logo'
import { useAuth } from '@/features/auth/AuthProvider'
import { useQueryClient } from '@tanstack/react-query'

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

export function Onboarding() {
  const { signOut } = useAuth()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim()
    setBusy(true); setError(null)
    const { error } = await db().rpc('create_organization', { p_name: name, p_timezone: browserTz() })
    if (error) { setError(error.message); setBusy(false); return }
    await qc.invalidateQueries({ queryKey: ['memberships'] })
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Logo />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Set up your business</h1>
          <p className="text-sm text-muted mt-1">
            Your tasks, documents and connected accounts live in a private workspace that only your team can access.
          </p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Business name">
            {(id) => <Input id={id} name="name" required maxLength={120} placeholder="Acme Plumbing" autoFocus />}
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button type="submit" variant="primary" loading={busy} className="w-full">Create workspace</Button>
        </form>
        <button onClick={signOut} className="text-sm text-muted hover:text-ink">Sign out</button>
      </div>
    </main>
  )
}
