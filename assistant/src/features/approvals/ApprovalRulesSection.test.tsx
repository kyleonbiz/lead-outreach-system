import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApprovalRulesSection } from './ApprovalRulesSection'

const org: { orgId: string; isAdmin: boolean; settings: unknown; refresh: ReturnType<typeof vi.fn> } = {
  orgId: 'org-1', isAdmin: true, settings: { approval_policy: { auto_approve: [] } }, refresh: vi.fn(),
}
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))
const rpc = vi.fn()
vi.mock('@/lib/supabase', () => ({ db: () => ({ rpc }) }))

beforeEach(() => {
  rpc.mockReset(); rpc.mockResolvedValue({ data: {}, error: null })
  org.refresh = vi.fn().mockResolvedValue(undefined); org.isAdmin = true
  org.settings = { approval_policy: { auto_approve: [] } }
})

async function enableEmail() {
  await userEvent.click(screen.getByRole('checkbox', { name: /Send email without asking/ }))
}

it('starts with nothing automatic and says what can never be automatic', () => {
  render(<ApprovalRulesSection />)
  expect(screen.getByRole('checkbox', { name: /Send email without asking/ })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Save approval rules' })).toBeDisabled()
  for (const t of ['Deleting anything', 'Payments', 'Signing agreements']) expect(screen.getByText(t)).toBeInTheDocument()
})

it.each(['@gmail.com', '*', 'acme', '@com'])('refuses the broad or malformed entry %s before anything is saved', async (entry) => {
  render(<ApprovalRulesSection />)
  await enableEmail()
  await userEvent.type(screen.getByLabelText(/Add to: Send email/), `${entry}{enter}`)
  expect(await screen.findByRole('alert')).toHaveTextContent(entry)
  expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
  expect(rpc).not.toHaveBeenCalled()
})

it('saves narrow rules through the audited RPC in canonical form', async () => {
  render(<ApprovalRulesSection />)
  await enableEmail()
  const input = screen.getByLabelText(/Add to: Send email/)
  await userEvent.type(input, 'Boss@Gmail.com{enter}')
  await userEvent.type(input, '@Acme.com{enter}')
  await userEvent.click(screen.getByRole('checkbox', { name: /Create calendar events without asking/ }))
  await userEvent.type(screen.getByLabelText(/Add to: Create calendar/), 'acme.com{enter}')
  await userEvent.click(screen.getByRole('button', { name: 'Save approval rules' }))
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
  expect(rpc).toHaveBeenCalledWith('set_approval_policy', {
    p_org: 'org-1',
    p_policy: { auto_approve: [
      { action: 'email.send', allowed_recipients: ['boss@gmail.com', '@acme.com'] },
      { action: 'calendar.create_event', internal_domains: ['@acme.com'] },
    ] },
  })
  expect(await screen.findByText(/^Saved\. The change/)).toBeInTheDocument()
  expect(org.refresh).toHaveBeenCalled()
})

it('will not save an enabled rule with no entries', async () => {
  render(<ApprovalRulesSection />)
  await enableEmail()
  await userEvent.click(screen.getByRole('button', { name: 'Save approval rules' }))
  expect(await screen.findByText("These rules can't be saved")).toBeInTheDocument()
  expect(screen.getByText(/add at least one address or domain/)).toBeInTheDocument()
  expect(rpc).not.toHaveBeenCalled()
})

it('shows a server rejection instead of claiming success', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'Only owners and admins can change approval rules' } })
  render(<ApprovalRulesSection />)
  await enableEmail()
  await userEvent.type(screen.getByLabelText(/Add to: Send email/), 'a@acme.com{enter}')
  await userEvent.click(screen.getByRole('button', { name: 'Save approval rules' }))
  expect(await screen.findByText(/Only owners and admins/)).toBeInTheDocument()
  expect(screen.queryByText(/^Saved\. The change/)).not.toBeInTheDocument()
})

it('loads existing rules, lets entries be removed, and saves the smaller policy', async () => {
  org.settings = { approval_policy: { auto_approve: [{ action: 'email.send', allowed_recipients: ['a@acme.com', '@acme.com'] }] } }
  render(<ApprovalRulesSection />)
  const list = screen.getByRole('list', { name: /Send email without asking: allowed/ })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: 'Remove a@acme.com' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save approval rules' }))
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_approval_policy', {
    p_org: 'org-1', p_policy: { auto_approve: [{ action: 'email.send', allowed_recipients: ['@acme.com'] }] },
  }))
})

it('turning a rule off removes it from the saved policy', async () => {
  org.settings = { approval_policy: { auto_approve: [{ action: 'email.send', allowed_recipients: ['a@acme.com'] }] } }
  render(<ApprovalRulesSection />)
  await userEvent.click(screen.getByRole('checkbox', { name: /Send email without asking/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Save approval rules' }))
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_approval_policy', { p_org: 'org-1', p_policy: { auto_approve: [] } }))
})

it('is read-only for non-admins', () => {
  org.isAdmin = false
  org.settings = { approval_policy: { auto_approve: [{ action: 'email.send', allowed_recipients: ['a@acme.com'] }] } }
  render(<ApprovalRulesSection />)
  expect(screen.getByRole('checkbox', { name: /Send email without asking/ })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Save approval rules' })).not.toBeInTheDocument()
  expect(screen.getByText(/Only owners and admins can change these rules/)).toBeInTheDocument()
})

it('warns when stored rules are invalid and therefore ignored', () => {
  org.settings = { approval_policy: { auto_approve: [{ action: 'email.send', allowed_recipients: ['@gmail.com'] }] } }
  render(<ApprovalRulesSection />)
  expect(screen.getByText('Saved rules are being ignored')).toBeInTheDocument()
})
