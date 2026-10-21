import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthPage } from './AuthPage'

const signIn = vi.fn(), signUp = vi.fn()
vi.mock('./AuthProvider', () => ({ useAuth: () => ({ signIn, signUp }) }))

beforeEach(() => { signIn.mockReset(); signUp.mockReset() })

it('signs in and surfaces the server error', async () => {
  signIn.mockResolvedValue('Invalid login credentials')
  render(<AuthPage />)
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.co')
  await userEvent.type(screen.getByLabelText('Password'), 'wrongpass1')
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(signIn).toHaveBeenCalledWith('a@b.co', 'wrongpass1')
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials')
})

it('sign-up asks for confirmation instead of pretending the user is logged in', async () => {
  signUp.mockResolvedValue({ needsConfirmation: true })
  render(<AuthPage />)
  await userEvent.click(screen.getByRole('button', { name: 'Create an account' }))
  await userEvent.type(screen.getByLabelText('Your name'), 'Kyle')
  await userEvent.type(screen.getByLabelText('Email'), 'k@b.co')
  await userEvent.type(screen.getByLabelText('Password'), 'longenough1')
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
  expect(signUp).toHaveBeenCalledWith('k@b.co', 'longenough1', 'Kyle')
  expect(await screen.findByText(/confirmation link to k@b.co/)).toBeInTheDocument()
})
