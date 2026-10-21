import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AcceptInvite } from './AcceptInvite'

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1234'
const signOut = vi.fn().mockResolvedValue(undefined)
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'me@acme.com' }, signOut }) }))
const rememberOrg = vi.fn()
vi.mock('@/features/org/OrgProvider', () => ({ rememberOrg: (id: string) => rememberOrg(id) }))

const accept = vi.fn()
vi.mock('./api', async (orig) => {
  const React = await import('react')
  return {
    ...(await orig<typeof import('./api')>()),
    // a real stateful stand-in for the mutation: pending -> success | error
    useAcceptInvitation: () => {
      const [s, set] = React.useState<{ st: 'idle' | 'pending' | 'error' | 'ok'; err: Error | null }>({ st: 'idle', err: null })
      return {
        isPending: s.st === 'pending', isError: s.st === 'error', error: s.err,
        mutate: (token: string, cb?: { onSuccess?: (r: { org_id: string; role: string }) => void }) => {
          set({ st: 'pending', err: null })
          Promise.resolve(accept(token)).then(
            (r) => { set({ st: 'ok', err: null }); cb?.onSuccess?.(r) },
            (e: Error) => set({ st: 'error', err: e }),
          )
        },
      }
    },
  }
})

beforeEach(() => { accept.mockReset(); rememberOrg.mockReset(); signOut.mockClear(); localStorage.setItem('pendingInvite', TOKEN) })

it('accepts exactly once even under React StrictMode, then forgets the token and opens the new team', async () => {
  accept.mockResolvedValue({ org_id: 'org-9', role: 'member' })
  const done = vi.fn()
  render(<StrictMode><AcceptInvite token={TOKEN} onDone={done} /></StrictMode>)
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  expect(accept).toHaveBeenCalledTimes(1)
  expect(accept).toHaveBeenCalledWith(TOKEN)
  expect(rememberOrg).toHaveBeenCalledWith('org-9')
  expect(localStorage.getItem('pendingInvite')).toBeNull()
})

it('shows the real reason on failure, never retries, and lets the user move on (clearing the token)', async () => {
  accept.mockRejectedValue(new Error('This invitation is invalid, has expired, or was already used'))
  const done = vi.fn()
  render(<AcceptInvite token={TOKEN} onDone={done} />)
  expect(await screen.findByText(/invalid, has expired, or was already used/)).toBeInTheDocument()
  expect(screen.getByText('me@acme.com')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Sign out/ })).not.toBeInTheDocument()
  expect(done).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(done).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem('pendingInvite')).toBeNull()
  expect(accept).toHaveBeenCalledTimes(1)
  expect(rememberOrg).not.toHaveBeenCalled()
})

it('when the signed-in address does not match, offers to switch accounts', async () => {
  accept.mockRejectedValue(new Error('This invitation was sent to a different e-mail address. Sign in with the address it was sent to.'))
  render(<AcceptInvite token={TOKEN} onDone={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Sign out and use another account' }))
  expect(signOut).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Continue without joining' })).toBeInTheDocument()
})

it('shows progress while the invitation is being accepted', async () => {
  accept.mockReturnValue(new Promise(() => {})) // never settles
  render(<AcceptInvite token={TOKEN} onDone={() => {}} />)
  expect(await screen.findByRole('status')).toHaveTextContent(/Accepting your invitation/)
})
