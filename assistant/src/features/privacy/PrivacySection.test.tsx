import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrivacySection } from './PrivacySection'
import { exportFilename } from './api'
import { FunctionError } from '@/features/assistant/api'

const org = { orgId: 'org-1', orgName: 'Acme & Sons', role: 'owner' as 'owner' | 'admin' | 'member' }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))
const signOut = vi.fn().mockResolvedValue(undefined)
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u-me', email: 'me@acme.com' }, signOut }) }))
vi.mock('@/lib/supabase', () => ({ db: () => ({ auth: { signOut: vi.fn().mockResolvedValue({}) } }) }))
vi.mock('@/features/team/api', async (orig) => ({
  ...(await orig<typeof import('@/features/team/api')>()),
  useMembers: () => ({ data: [
    { user_id: 'u-me', full_name: 'Me Owner', email: 'me@acme.com', role: 'owner', joined_at: '' },
    { user_id: 'u-2', full_name: 'Sam Member', email: 'sam@acme.com', role: 'member', joined_at: '' },
  ] }),
}))

const fetchExport = vi.fn(), saveBlob = vi.fn(), transfer = vi.fn(), del = vi.fn()
const state: { preview: unknown; previewError: Error | null; previewLoading: boolean } = { preview: null, previewError: null, previewLoading: false }
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  fetchExport: (...a: unknown[]) => fetchExport(...a), saveBlob: (...a: unknown[]) => saveBlob(...a),
  useTransferOwnership: () => ({ mutateAsync: transfer, isPending: false }),
  useDeletionPreview: () => ({ data: state.preview, isLoading: state.previewLoading, isError: !!state.previewError, error: state.previewError }),
  useDeleteAccount: () => ({ mutateAsync: del, isPending: false }),
}))

const previewOf = (o: Record<string, unknown> = {}) => ({
  email: 'me@acme.com', recent_sign_in: true, recent_sign_in_minutes: 15, can_delete: true,
  organizations: [{ id: 'org-a', name: 'Acme Team', role: 'member', members: 4, plan: 'leave' }], ...o,
})

beforeEach(() => {
  fetchExport.mockReset().mockResolvedValue(new Blob(['zip'])); saveBlob.mockReset(); transfer.mockReset().mockResolvedValue(undefined)
  del.mockReset().mockResolvedValue({ deleted: true, deleted_organizations: [], disconnected_integrations: [] }); signOut.mockClear()
  org.role = 'owner'; state.preview = previewOf(); state.previewError = null; state.previewLoading = false
})

describe('export', () => {
  it('owners can download everything or just the audit log; the file is saved with a clear name', async () => {
    render(<PrivacySection />)
    await userEvent.click(screen.getByRole('button', { name: /Download all organization data/ }))
    expect(fetchExport).toHaveBeenCalledWith('org-1', 'all')
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1))
    expect(saveBlob.mock.calls[0][1]).toMatch(/^aide-export-acme-sons-\d{4}-\d{2}-\d{2}\.zip$/)
    expect(await screen.findByText(/download has started/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Download the audit log/ }))
    expect(fetchExport).toHaveBeenLastCalledWith('org-1', 'audit')
  })
  it('admins only get the audit log; members get no export at all', () => {
    org.role = 'admin'
    const { unmount } = render(<PrivacySection />)
    expect(screen.queryByRole('button', { name: /all organization data/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /audit log/ })).toBeInTheDocument()
    expect(screen.queryByText('Transfer ownership')).not.toBeInTheDocument()
    unmount()
    org.role = 'member'
    render(<PrivacySection />)
    expect(screen.queryByText('Export your data')).not.toBeInTheDocument()
    expect(screen.getByText('Delete my account')).toBeInTheDocument() // but everyone can delete their own account
  })
  it('shows the server\'s reason (throttling) and saves nothing', async () => {
    fetchExport.mockRejectedValue(new FunctionError('An export was just made. Please wait 120 seconds before exporting again.', 429, { code: 'throttled' }))
    render(<PrivacySection />)
    await userEvent.click(screen.getByRole('button', { name: /Download all organization data/ }))
    expect(await screen.findByText(/Please wait 120 seconds/)).toBeInTheDocument()
    expect(saveBlob).not.toHaveBeenCalled()
    expect(screen.queryByText(/download has started/)).not.toBeInTheDocument()
  })
  it('filenames are safe and dated', () => {
    expect(exportFilename('A/B "weird" ../Name', 'audit', new Date('2026-10-21T00:00:00Z'))).toBe('aide-audit-log-a-b-weird-name-2026-10-21.zip')
    expect(exportFilename('###', 'all', new Date('2026-10-21T00:00:00Z'))).toBe('aide-export-organization-2026-10-21.zip')
  })
})

describe('transfer ownership', () => {
  it('needs a chosen person and an explicit confirmation before anything happens', async () => {
    render(<PrivacySection />)
    expect(screen.getByRole('button', { name: 'Transfer ownership…' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('New owner'), 'u-2')
    await userEvent.click(screen.getByRole('checkbox', { name: /Step down to admin/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Transfer ownership…' }))
    expect(transfer).not.toHaveBeenCalled()
    expect(screen.getByText(/Make Sam Member an owner and step down\?/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Yes, transfer' }))
    expect(transfer).toHaveBeenCalledWith({ newOwner: 'u-2', stepDown: true })
    expect(await screen.findByText(/Sam Member is now an owner and you are an admin/)).toBeInTheDocument()
  })
  it('without stepping down it says ownership is shared; failures are shown, not hidden', async () => {
    render(<PrivacySection />)
    await userEvent.selectOptions(screen.getByLabelText('New owner'), 'u-2')
    await userEvent.click(screen.getByRole('button', { name: 'Transfer ownership…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes, transfer' }))
    expect(await screen.findByText(/you remain an owner too/)).toBeInTheDocument()
    transfer.mockRejectedValueOnce(new Error('Only an owner can transfer ownership'))
    await userEvent.selectOptions(screen.getByLabelText('New owner'), 'u-2')
    await userEvent.click(screen.getByRole('button', { name: 'Transfer ownership…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes, transfer' }))
    expect(await screen.findByText('Only an owner can transfer ownership')).toBeInTheDocument()
  })
  it('the person making the transfer is never offered as the new owner', () => {
    render(<PrivacySection />)
    const options = Array.from((screen.getByLabelText('New owner') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options).toEqual(['Choose a team member…', 'Sam Member (member)'])
  })
})

async function openDelete() {
  render(<PrivacySection />)
  await userEvent.click(screen.getByRole('button', { name: 'Delete my account…' }))
  return screen.findByRole('dialog')
}
const deleteButton = (d: HTMLElement) => within(d).getByRole('button', { name: 'Permanently delete my account' })

describe('delete my account', () => {
  it('stays disabled until the e-mail is typed exactly, then deletes and signs out', async () => {
    const d = await openDelete()
    expect(deleteButton(d)).toBeDisabled()
    await userEvent.type(within(d).getByLabelText(/Type me@acme.com to confirm/), 'me@acme.co')
    expect(deleteButton(d)).toBeDisabled()
    await userEvent.type(within(d).getByLabelText(/Type me@acme.com to confirm/), 'm')
    expect(deleteButton(d)).toBeEnabled()
    await userEvent.click(deleteButton(d))
    expect(del).toHaveBeenCalledWith({ confirm_email: 'me@acme.com', delete_org_ids: [] })
    expect(await screen.findByText('Your account was deleted')).toBeInTheDocument()
  })
  it('explains what will happen to each organization', async () => {
    state.preview = previewOf({ organizations: [
      { id: 'org-a', name: 'Acme Team', role: 'member', members: 4, plan: 'leave' }, { id: 'org-b', name: 'My Solo Shop', role: 'owner', members: 1, plan: 'delete_org' },
    ] })
    const d = await openDelete()
    expect(within(d).getByText(/You will leave/)).toBeInTheDocument()
    expect(within(d).getByText('Acme Team')).toBeInTheDocument()
    expect(within(d).getByText(/will be permanently deleted with you/)).toBeInTheDocument()
    expect(within(d).getByText(/Microsoft you should also remove the app/)).toBeInTheDocument()
  })
  it('organizations that would be deleted must each be acknowledged before the button works, and exactly those are sent', async () => {
    state.preview = previewOf({ organizations: [{ id: 'org-b', name: 'My Solo Shop', role: 'owner', members: 1, plan: 'delete_org' }] })
    const d = await openDelete()
    await userEvent.type(within(d).getByLabelText(/Type me@acme.com/), 'me@acme.com')
    expect(deleteButton(d)).toBeDisabled()
    await userEvent.click(within(d).getByRole('checkbox', { name: /Delete My Solo Shop/ }))
    expect(deleteButton(d)).toBeEnabled()
    await userEvent.click(deleteButton(d))
    expect(del).toHaveBeenCalledWith({ confirm_email: 'me@acme.com', delete_org_ids: ['org-b'] })
  })
  it('a sole owner of an organization with other members is blocked, with a pointer to the transfer', async () => {
    state.preview = previewOf({ can_delete: false, organizations: [{ id: 'org-c', name: 'The Big Team', role: 'owner', members: 7, plan: 'blocked' }] })
    const d = await openDelete()
    expect(within(d).getByText('Transfer ownership first')).toBeInTheDocument()
    expect(within(d).getByText('The Big Team')).toBeInTheDocument()
    await userEvent.type(within(d).getByLabelText(/Type me@acme.com/), 'me@acme.com')
    expect(deleteButton(d)).toBeDisabled() // typing the e-mail cannot override the block
  })
  it('without a recent sign-in it asks to sign in again and cannot delete', async () => {
    state.preview = previewOf({ recent_sign_in: false })
    const d = await openDelete()
    expect(within(d).getByText('Sign in again first')).toBeInTheDocument()
    await userEvent.type(within(d).getByLabelText(/Type me@acme.com/), 'me@acme.com')
    expect(deleteButton(d)).toBeDisabled()
    await userEvent.click(within(d).getByRole('button', { name: 'Sign out, then sign in again' }))
    expect(signOut).toHaveBeenCalled()
  })
  it('shows server refusals and partial failures honestly (and does not claim success)', async () => {
    del.mockRejectedValue(new FunctionError('Deleting your account did not finish. Nothing more was removed; you can try again', 500, { code: 'incomplete' }))
    const d = await openDelete()
    await userEvent.type(within(d).getByLabelText(/Type me@acme.com/), 'me@acme.com')
    await userEvent.click(deleteButton(d))
    expect(await within(d).findByText('Not everything was deleted')).toBeInTheDocument()
    expect(within(d).getByText(/you can try again/)).toBeInTheDocument()
    expect(screen.queryByText('Your account was deleted')).not.toBeInTheDocument()
  })
  it('a failure to load the preview blocks deletion rather than guessing', async () => {
    state.preview = null; state.previewError = new Error('plan: boom')
    const d = await openDelete()
    expect(within(d).getByText(/plan: boom/)).toBeInTheDocument()
    expect(deleteButton(d)).toBeDisabled()
  })
})
