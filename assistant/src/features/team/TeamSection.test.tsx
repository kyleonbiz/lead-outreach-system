import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TeamSection } from './TeamSection'

const org = { orgId: 'org-1', role: 'owner' as 'owner' | 'admin' | 'member' }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u-owner' } }) }))

const invite = vi.fn(), revoke = vi.fn(), changeRole = vi.fn(), removeMember = vi.fn()
const state = {
  members: [] as unknown[], invitations: [] as unknown[],
}
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  useMembers: () => ({ isLoading: false, isError: false, data: state.members }),
  useInvitations: () => ({ data: state.invitations }),
  useInvite: () => ({ mutateAsync: invite, isPending: false }),
  useRevokeInvitation: () => ({ mutateAsync: revoke, isPending: false, variables: undefined }),
  useChangeRole: () => ({ mutateAsync: changeRole, isPending: false }),
  useRemoveMember: () => ({ mutateAsync: removeMember, isPending: false }),
}))

const member = (o = {}) => ({ user_id: 'u2', full_name: 'Sam Member', email: 'sam@acme.com', role: 'member', joined_at: '2026-01-01T00:00:00Z', ...o })
const owner = member({ user_id: 'u-owner', full_name: 'Jane Owner', email: 'jane@acme.com', role: 'owner' })

beforeEach(() => {
  invite.mockReset(); revoke.mockReset().mockResolvedValue(undefined); changeRole.mockReset().mockResolvedValue(undefined); removeMember.mockReset().mockResolvedValue(undefined)
  org.role = 'owner'; state.members = [owner, member()]; state.invitations = []
})

describe('as an owner', () => {
  it('lists the team with roles and marks me', () => {
    render(<TeamSection />)
    const list = screen.getByRole('list', { name: 'Team members' })
    expect(within(list).getByText('Jane Owner')).toBeInTheDocument()
    expect(within(list).getByText('You')).toBeInTheDocument()
    expect(within(list).getByText('sam@acme.com')).toBeInTheDocument()
  })
  it('sends an invitation and confirms it was e-mailed', async () => {
    invite.mockResolvedValue({ id: 'i1', emailed: true })
    render(<TeamSection />)
    await userEvent.type(screen.getByLabelText('E-mail address'), 'new@acme.com')
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
    expect(invite).toHaveBeenCalledWith({ email: 'new@acme.com', role: 'admin' })
    expect(await screen.findByText('Invitation e-mailed to new@acme.com.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Invitation link')).not.toBeInTheDocument()
  })
  it('only offers member and admin invitations: owners are added by promotion', () => {
    render(<TeamSection />)
    const opts = within(screen.getByLabelText('Role')).getAllByRole('option').map((o) => o.textContent)
    expect(opts).toEqual(['Member', 'Admin'])
  })
  it('when e-mail could not be sent, says so and shows the link to share (nothing pretended)', async () => {
    invite.mockResolvedValue({ id: 'i1', emailed: false, reason: 'E-mail delivery is not configured on this server (missing: RESEND_API_KEY).', link: 'https://app.example.com/invite/TOKEN' })
    render(<TeamSection />)
    await userEvent.type(screen.getByLabelText('E-mail address'), 'new@acme.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
    expect(await screen.findByText('The e-mail was not sent')).toBeInTheDocument()
    expect(screen.getByText(/missing: RESEND_API_KEY/)).toBeInTheDocument()
    expect(screen.getByLabelText('Invitation link')).toHaveValue('https://app.example.com/invite/TOKEN')
    expect(screen.queryByText(/Invitation e-mailed/)).not.toBeInTheDocument()
  })
  it('shows server refusals (already a member, caps) instead of success', async () => {
    invite.mockRejectedValue(new Error('That person is already a member'))
    render(<TeamSection />)
    await userEvent.type(screen.getByLabelText('E-mail address'), 'sam@acme.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
    expect(await screen.findByText('That person is already a member')).toBeInTheDocument()
    expect(screen.queryByText(/Invitation e-mailed/)).not.toBeInTheDocument()
  })
  it('lists pending invitations and revokes one', async () => {
    state.invitations = [{ id: 'i1', email: 'wait@acme.com', role: 'member', created_at: '2026-10-20T00:00:00Z', expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), accepted_at: null, revoked_at: null }]
    render(<TeamSection />)
    const list = screen.getByRole('list', { name: 'Pending invitations' })
    expect(within(list).getByText('wait@acme.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke invitation for wait@acme.com' }))
    expect(revoke).toHaveBeenCalledWith('i1')
  })
  it('changes a role through the select', async () => {
    render(<TeamSection />)
    await userEvent.selectOptions(screen.getByLabelText('Role for Sam Member'), 'admin')
    expect(changeRole).toHaveBeenCalledWith({ userId: 'u2', role: 'admin' })
  })
  it('asks for confirmation before removing someone', async () => {
    render(<TeamSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Sam Member' }))
    expect(removeMember).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove' }))
    expect(removeMember).toHaveBeenCalledWith('u2')
  })
  it('surfaces the last-owner protection when the only owner tries to leave', async () => {
    removeMember.mockRejectedValue(new Error('An organization must keep at least one owner'))
    render(<TeamSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Leave Jane Owner' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm leave' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('must keep at least one owner')
  })
})

describe('as a non-owner', () => {
  it.each(['admin', 'member'] as const)('%s sees the team but cannot invite, change roles or remove others', (role) => {
    org.role = role
    render(<TeamSection />)
    expect(screen.getByRole('list', { name: 'Team members' })).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Invite someone' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Role for/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(screen.getByText(/Only owners can invite people/)).toBeInTheDocument()
  })
  it('can still leave the organization themselves', async () => {
    org.role = 'member'
    state.members = [owner, member({ user_id: 'u-owner', full_name: 'Me', role: 'member' })]
    render(<TeamSection />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Leave Me' })).toBeInTheDocument())
  })
})
