import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { AgendaCardBody, MailCardBody } from './cards'

const invoke = vi.fn()
vi.mock('@/lib/supabase', () => ({ db: () => ({ functions: { invoke } }) }))

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)

const failure = (status: number, body: object) => ({ data: null, error: { message: 'non-2xx', context: new Response(JSON.stringify(body), { status }) } })

beforeEach(() => { invoke.mockReset(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T15:00:00Z')) })
afterEach(() => vi.useRealTimers())

const e = (id: string, h: number, extra = {}) => ({ id, title: `Event ${id}`, start: `2026-10-21T${h}:00:00Z`, end: `2026-10-21T${h}:30:00Z`, allDay: false, attendees: [], ...extra })

describe('AgendaCardBody', () => {
  it('previews the next events (not the finished ones) and links to the rest', async () => {
    invoke.mockResolvedValue({ data: { timezone: 'UTC', events: [e('past', 9), e('a', 16, { location: '88 Birch Lane', attendees: ['x@y.test'] }), e('b', 17), e('c', 18), e('d', 19), e('f', 20)] }, error: null })
    wrap(<AgendaCardBody orgId="o" />)
    expect(await screen.findByText('Event a')).toBeInTheDocument()
    expect(screen.getByText('88 Birch Lane · 1 guest')).toBeInTheDocument()
    expect(screen.queryByText('Event past')).not.toBeInTheDocument()
    expect(screen.queryByText('Event f')).not.toBeInTheDocument() // only 4 previewed
    expect(screen.getByRole('link', { name: 'See all 6 events today' })).toHaveAttribute('href', '/calendar')
  })
  it('says so when nothing is scheduled, or nothing is left', async () => {
    invoke.mockResolvedValue({ data: { timezone: 'UTC', events: [] }, error: null })
    const first = wrap(<AgendaCardBody orgId="o" />)
    expect(await screen.findByText('Nothing is scheduled today.')).toBeInTheDocument()
    first.unmount()
    invoke.mockResolvedValue({ data: { timezone: 'UTC', events: [e('past', 9)] }, error: null })
    wrap(<AgendaCardBody orgId="o" />)
    expect(await screen.findByText('Nothing left on your calendar today.')).toBeInTheDocument()
  })
  it('points to setup when no calendar is connected', async () => {
    invoke.mockImplementation(async () => failure(409, { error: 'Calendar is not connected', code: 'not_connected' }))
    wrap(<AgendaCardBody orgId="o" />)
    expect(await screen.findByRole('link', { name: 'Set it up' })).toHaveAttribute('href', '/integrations')
    expect(screen.getByText(/No calendar is connected/)).toBeInTheDocument()
  })
  it('shows provider errors plainly instead of an empty state', async () => {
    invoke.mockImplementation(async () => failure(502, { error: 'Google returned 500', code: 'upstream' })) // fresh Response per call (bodies are single-use)
    wrap(<AgendaCardBody orgId="o" />)
    // provider errors are retried once (1s backoff) before being shown
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent("Couldn't load your calendar: Google returned 500")
    expect(screen.queryByText(/Nothing is scheduled/)).not.toBeInTheDocument()
  })
})

describe('MailCardBody', () => {
  const m = (id: string, triage: object) => ({ id, threadId: id, from: `Sender ${id} <s${id}@x.test>`, subject: `Subject ${id}`, snippet: '', date: '2026-10-21T14:00:00Z', unread: true, triage: { urgent: false, needsResponse: false, automated: false, reasons: [], ...triage } })
  it('previews urgent and reply-needed mail, hides automated and plain mail', async () => {
    invoke.mockResolvedValue({ data: { account: 'me@x.test', messages: [m('1', { urgent: true }), m('2', { needsResponse: true }), m('3', {}), m('4', { urgent: true, automated: true }), m('5', { needsResponse: true }), m('6', { needsResponse: true }), m('7', { needsResponse: true })] }, error: null })
    wrap(<MailCardBody orgId="o" />)
    expect(await screen.findByText('Subject 1')).toBeInTheDocument()
    expect(screen.getByText(/Sender 1 · about 1 hour ago/)).toBeInTheDocument() // address stripped from the name
    expect(screen.queryByText('Subject 3')).not.toBeInTheDocument()
    expect(screen.queryByText('Subject 4')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '1 more need attention' })).toHaveAttribute('href', '/email')
  })
  it('says when nothing needs attention, and handles not-connected / errors', async () => {
    invoke.mockResolvedValue({ data: { account: 'me@x.test', messages: [m('3', {})] }, error: null })
    const a = wrap(<MailCardBody orgId="o" />)
    expect(await screen.findByText('Nothing urgent or waiting for a reply in me@x.test.')).toBeInTheDocument()
    a.unmount()
    invoke.mockImplementation(async () => failure(409, { error: 'not connected', code: 'not_connected' }))
    const b = wrap(<MailCardBody orgId="o" />)
    expect(await screen.findByText(/No email account is connected/)).toBeInTheDocument()
    b.unmount()
    invoke.mockImplementation(async () => failure(502, { error: 'Gmail quota exceeded', code: 'upstream' }))
    wrap(<MailCardBody orgId="o" />)
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('Gmail quota exceeded')
  })
})
