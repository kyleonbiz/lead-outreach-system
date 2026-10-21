import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationSettings } from './NotificationSettings'
import { FunctionError } from '@/features/assistant/api'

const org = { orgId: 'org-1', isAdmin: true }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'me@acme.com' } }) }))

const savePrefs = vi.fn()
const channelAction = vi.fn()
const state = {
  prefs: { email_workflow_failed: true, email_approval_needed: true, email_task_overdue: false },
  channels: [] as unknown[], deliveries: [] as unknown[],
}
vi.mock('./settingsApi', async (orig) => ({
  ...(await orig<typeof import('./settingsApi')>()),
  usePrefs: () => ({ isLoading: false, isError: false, data: state.prefs }),
  useSavePrefs: () => ({ mutate: savePrefs, isError: false }),
  useChannels: () => ({ isLoading: false, isError: false, data: state.channels }),
  useDeliveries: () => ({ isLoading: false, isError: false, data: state.deliveries }),
  useChannelAction: () => ({ mutateAsync: channelAction, isPending: false }),
}))

const channel = (o = {}) => ({
  id: 'c1', kind: 'slack', name: '#ops', url_hint: 'hooks.slack.com/…/abcd', events: ['workflow_failed', 'approval_needed'],
  enabled: true, last_status: null, last_error: null, last_sent_at: null, ...o,
})

beforeEach(() => {
  savePrefs.mockReset(); channelAction.mockReset().mockResolvedValue({})
  org.isAdmin = true; state.channels = []; state.deliveries = []
})

describe('e-mail preferences', () => {
  it('shows the address e-mails go to and saves a toggle', async () => {
    render(<NotificationSettings />)
    expect(screen.getByText('me@acme.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /Tasks become overdue/ }))
    expect(savePrefs).toHaveBeenCalledWith({ email_workflow_failed: true, email_approval_needed: true, email_task_overdue: true })
  })
  it('plain members see only their own e-mail settings, not channels or delivery logs', () => {
    org.isAdmin = false
    render(<NotificationSettings />)
    expect(screen.getByText('E-mail notifications')).toBeInTheDocument()
    expect(screen.queryByText('Slack & Microsoft Teams')).not.toBeInTheDocument()
    expect(screen.queryByText('Recent deliveries')).not.toBeInTheDocument()
  })
})

describe('channels', () => {
  it('lists channels with a non-secret hint and a visible failure reason', () => {
    state.channels = [channel({ last_status: 'failed', last_error: 'The webhook was rejected (HTTP 404). It may have been deleted or revoked.' })]
    render(<NotificationSettings />)
    expect(screen.getByText(/hooks\.slack\.com\/…\/abcd/)).toBeInTheDocument()
    expect(screen.getByText('Last send failed')).toBeInTheDocument()
    expect(screen.getByText(/deleted or revoked/)).toBeInTheDocument()
  })
  it('sends a test and reports success; reports the real failure when it fails', async () => {
    state.channels = [channel()]
    render(<NotificationSettings />)
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }))
    expect(channelAction).toHaveBeenCalledWith({ action: 'test', channel_id: 'c1' })
    expect(await screen.findByText(/Test message sent to “#ops”/)).toBeInTheDocument()

    channelAction.mockRejectedValueOnce(new FunctionError('The webhook was rejected (HTTP 404).', 502, {}))
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }))
    expect(await screen.findByText('The webhook was rejected (HTTP 404).')).toBeInTheDocument()
    expect(screen.queryByText(/Test message sent/)).not.toBeInTheDocument()
  })
  it('pauses and resumes', async () => {
    state.channels = [channel({ enabled: false })]
    render(<NotificationSettings />)
    expect(screen.getByText('Paused')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(channelAction).toHaveBeenCalledWith({ action: 'update', channel_id: 'c1', enabled: true })
  })
  it('asks for confirmation before removing', async () => {
    state.channels = [channel()]
    render(<NotificationSettings />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove #ops' }))
    expect(channelAction).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove' }))
    expect(channelAction).toHaveBeenCalledWith({ action: 'delete', channel_id: 'c1' })
  })
  it('adds a channel: the URL field is masked and the right request is sent', async () => {
    render(<NotificationSettings />)
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    const dialog = await screen.findByRole('dialog')
    const url = within(dialog).getByLabelText('Webhook URL')
    expect(url).toHaveAttribute('type', 'password')
    await userEvent.type(within(dialog).getByLabelText('Name'), '#ops')
    await userEvent.type(url, 'https://hooks.slack.com/services/T/B/xxxx')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Tasks become overdue' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add channel' }))
    await waitFor(() => expect(channelAction).toHaveBeenCalledWith({
      action: 'create', org_id: 'org-1', kind: 'slack', name: '#ops', webhook_url: 'https://hooks.slack.com/services/T/B/xxxx',
      events: ['workflow_failed', 'approval_needed', 'task_overdue'],
    }))
  })
  it('shows the server\'s reason when a URL is refused and keeps the dialog open', async () => {
    channelAction.mockRejectedValueOnce(new FunctionError('IP addresses and local hosts are not allowed.', 422, {}))
    render(<NotificationSettings />)
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'x')
    await userEvent.type(within(dialog).getByLabelText('Webhook URL'), 'https://127.0.0.1/x')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add channel' }))
    expect(await within(dialog).findByText('IP addresses and local hosts are not allowed.')).toBeInTheDocument()
  })
  it('requires at least one event', async () => {
    render(<NotificationSettings />)
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'x')
    await userEvent.type(within(dialog).getByLabelText('Webhook URL'), 'https://hooks.slack.com/services/T/B/xxxx')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'A workflow fails' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Something needs approval' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add channel' }))
    expect(await within(dialog).findByText(/Choose at least one/)).toBeInTheDocument()
    expect(channelAction).not.toHaveBeenCalled()
  })
})

describe('delivery log', () => {
  it('is honest about e-mails that were skipped and why', () => {
    state.deliveries = [
      { id: 'd1', channel: 'email', status: 'skipped', attempts: 1, last_error: 'E-mail delivery is not configured on this server (missing: RESEND_API_KEY).', created_at: new Date().toISOString(), sent_at: null },
      { id: 'd2', channel: 'slack', status: 'sent', attempts: 1, last_error: null, created_at: new Date().toISOString(), sent_at: new Date().toISOString() },
    ]
    render(<NotificationSettings />)
    expect(screen.getByText(/missing: RESEND_API_KEY/)).toBeInTheDocument()
    expect(screen.getByText('skipped')).toBeInTheDocument()
    expect(screen.getByText('sent')).toBeInTheDocument()
  })
})
