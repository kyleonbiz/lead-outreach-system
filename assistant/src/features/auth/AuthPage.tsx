import { useState, type FormEvent } from 'react'
import { Button, Field, Input, Notice } from '@/components/ui'
import { Logo } from '@/components/Logo'
import { useAuth } from './AuthProvider'

export function AuthPage({ invited = false }: { invited?: boolean }) {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const email = String(f.get('email') ?? '').trim()
    const password = String(f.get('password') ?? '')
    setBusy(true); setError(null); setInfo(null)
    if (mode === 'signin') {
      setError(await signIn(email, password))
    } else {
      const r = await signUp(email, password, String(f.get('name') ?? '').trim())
      if (r.error) setError(r.error)
      else if (r.needsConfirmation) setInfo(`We sent a confirmation link to ${email}. Open it to finish creating your account.`)
    }
    setBusy(false)
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3">
          <Logo />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {mode === 'signin' ? 'Sign in to Aide' : 'Create your account'}
            </h1>
            <p className="text-sm text-muted mt-1">Delegate the work. Keep control.</p>
          </div>
        </div>

        {invited && (
          <Notice tone="info" title="You've been invited to join a team">
            Sign in, or create an account, using the e-mail address the invitation was sent to.
          </Notice>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          {mode === 'signup' && (
            <Field label="Your name">{(id) => <Input id={id} name="name" autoComplete="name" required maxLength={200} />}</Field>
          )}
          <Field label="Email">
            {(id) => <Input id={id} name="email" type="email" autoComplete="email" required />}
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
            {(id) => (
              <Input
                id={id} name="password" type="password" required minLength={8}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              />
            )}
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
          {info && <Notice tone="ok">{info}</Notice>}
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="text-sm text-muted">
          {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            className="font-medium text-accent hover:underline"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null) }}
          >
            {mode === 'signin' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  )
}
