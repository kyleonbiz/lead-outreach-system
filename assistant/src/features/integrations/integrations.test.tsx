import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import IntegrationsPage from '@/pages/IntegrationsPage'
import EmailPage from '@/pages/EmailPage'
import { FunctionError } from '@/features/assistant/api'

const orgState = { orgId: 'org-1', isAdmin: true }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => orgState }))
const integrations = vi.fn()
vi.mock('@/features/activity/api', () => ({ useIntegrations: () => integrations() }))
const invoke = vi.fn()
vi.mock('@/lib/supabase', () => ({ db: () => ({ functions: { invoke } }) }))

const wrap = (ui: React.ReactNode, url = '/') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
  </QueryClientProvider>)

beforeEach(() => { integrations.mockReturnValue({ data: [], isLoading: false, isError: false }); orgState.isAdmin = true; invoke.mockReset() })

describe('Integrations page', () => {
  it('explains OAuth failures in plain language instead of a silent redirect', () => {
    wrap(<IntegrationsPage />, '/integrations?error=missing_scopes')
    expect(screen.getByText(/Some requested permissions were not granted/)).toBeInTheDocument()
  })
  it('lets admins connect Gmail, Google Calendar, Outlook Mail and Outlook Calendar', () => {
    wrap(<IntegrationsPage />)
    expect(screen.getAllByRole('button', { name: 'Connect' }).filter((b) => !(b as HTMLButtonElement).disabled)).toHaveLength(4)
    expect(screen.getByText('Outlook Mail')).toBeInTheDocument()
    expect(screen.queryByText(/Not available/)).not.toBeInTheDocument()
  })
  it('disables connect/disconnect for non-admins and says why', () => {
    orgState.isAdmin = false
    integrations.mockReturnValue({ data: [{ id: 'i1', provider: 'google_gmail', status: 'connected', external_account: 'me@acme.com', last_error: null }], isLoading: false, isError: false })
    wrap(<IntegrationsPage />)
    expect(screen.getByText(/Only owners and admins can connect or disconnect/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
  })
  it('flags an account that needs reconnecting', () => {
    integrations.mockReturnValue({ data: [{ id: 'i1', provider: 'google_gmail', status: 'needs_reauth', external_account: 'me@acme.com', last_error: 'Google rejected the saved credentials.' }], isLoading: false, isError: false })
    wrap(<IntegrationsPage />)
    expect(screen.getByText('Reconnect needed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
  })
})

describe('Email page', () => {
  it('shows a setup state — and no fake mail — when no email account is connected', async () => {
    invoke.mockResolvedValue({ data: null, error: { message: 'x', context: new Response(JSON.stringify({ error: 'Gmail is not connected', code: 'not_connected' }), { status: 409 }) } })
    wrap(<EmailPage />)
    expect(await screen.findByText('No email account is connected')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })
  it('lists urgent mail first with the reasons it was flagged', async () => {
    invoke.mockResolvedValue({ data: { account: 'me@acme.com', messages: [
      { id: '1', threadId: 't1', from: 'a@b.com', subject: 'Lunch?', snippet: 'x', date: new Date().toISOString(), unread: true, triage: { urgent: false, needsResponse: false, automated: false, reasons: [] } },
      { id: '2', threadId: 't2', from: 'c@d.com', subject: 'Invoice overdue', snippet: 'pay', date: new Date().toISOString(), unread: true, triage: { urgent: true, needsResponse: true, automated: false, reasons: ['contains "overdue"'] } },
    ] }, error: null })
    wrap(<EmailPage />)
    const items = await screen.findAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Invoice overdue')
    expect(items[0]).toHaveTextContent('Urgent')
    expect(items[0]).toHaveTextContent('contains "overdue"')
  })
  it('surfaces provider failures as errors', async () => {
    invoke.mockResolvedValue({ data: null, error: new FunctionError('boom', 502, {}) })
    wrap(<EmailPage />)
    expect(await screen.findByText(/Couldn't load your inbox/, {}, { timeout: 4000 })).toBeInTheDocument() // one retry (~1s backoff) first
  })
})

describe('connect errors are worded for the provider being connected', () => {
  it('Microsoft failures never point people at Google settings (and vice versa)', async () => {
    const { connectError } = await import('./providers')
    expect(connectError('no_refresh_token', 'microsoft_mail')).toMatch(/myapps\.microsoft\.com/)
    expect(connectError('no_refresh_token', 'microsoft_mail')).not.toMatch(/google/i)
    expect(connectError('no_refresh_token', 'google_gmail')).toMatch(/myaccount\.google\.com/)
    expect(connectError('microsoft_error', 'microsoft_calendar')).toBe('Microsoft reported an error. Please try again.')
    expect(connectError('not_configured', 'microsoft_mail')).toBe('Microsoft connections are not configured on the server yet.')
    expect(connectError('missing_scopes', 'microsoft_mail')).toMatch(/admin can also restrict/)
    expect(connectError('something_new', null)).toBe('Something went wrong. Please try again.')
  })
  it('shows a Microsoft-specific message when returning from a failed Microsoft connection', () => {
    wrap(<IntegrationsPage />, '/integrations?error=exchange_failed&provider=microsoft_mail')
    expect(screen.getByText('Microsoft did not complete the connection. Please try again.')).toBeInTheDocument()
  })
})
