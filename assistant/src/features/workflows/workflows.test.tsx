import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import WorkflowsPage from '@/pages/WorkflowsPage'
import { NotificationsBell } from '@/features/notifications/NotificationsBell'

const org = { orgId: 'o', isAdmin: true }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))

const h = vi.hoisted(() => ({
  workflows: [] as any[], runs: [] as any[], notes: [] as any[],
  save: vi.fn(), run: vi.fn(), markRead: vi.fn(),
}))
vi.mock('@/features/workflows/api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  useWorkflows: () => ({ data: h.workflows, isLoading: false, isError: false }),
  useRuns: () => ({ data: h.runs, isLoading: false }),
  useSaveWorkflow: () => ({ mutate: h.save, isPending: false, isError: false, error: null }),
  useRunNow: () => ({ mutate: h.run, isPending: false, isError: false, data: undefined }),
  useToggleWorkflow: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useDeleteWorkflow: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/features/notifications/api', () => ({
  useNotifications: () => ({ data: h.notes }),
  useMarkRead: () => ({ mutate: h.markRead }),
}))

const wf = (o: any = {}) => ({
  id: 'w1', name: 'Daily briefing', description: 'Morning summary', enabled: true, kind: 'daily_briefing', trigger_type: 'schedule',
  trigger_config: { cron: '0 8 * * 1-5' }, current_version: 2,
  definition: { steps: [
    { id: 'agenda', type: 'tool', tool: 'calendar.list_events', label: "Today's calendar", input: {}, on_failure: 'continue', retry: { max_attempts: 2, backoff_seconds: 60 } },
    { id: 'send', type: 'tool', tool: 'email.send', input: {}, on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 }, when: { step: 'agenda', op: 'not_empty' } },
    { id: 'brief', type: 'summarize', instruction: 'x', on_failure: 'stop', retry: { max_attempts: 1, backoff_seconds: 60 } },
  ] }, ...o,
})
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)

beforeEach(() => { org.isAdmin = true; h.workflows = [wf()]; h.runs = []; h.notes = []; h.save.mockReset(); h.run.mockReset(); h.markRead.mockReset() })

describe('Workflows page', () => {
  it('shows the flow: ordered steps with tool names, conditions, retries and failure behaviour', () => {
    wrap(<WorkflowsPage />)
    const steps = within(screen.getAllByRole('list')[1]).getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(steps[0]).toHaveTextContent("Today's calendar")
    expect(steps[0]).toHaveTextContent('calendar.list_events')
    expect(steps[0]).toHaveTextContent('up to 2 attempts')
    expect(steps[0]).toHaveTextContent('continues if it fails')
    expect(steps[1]).toHaveTextContent('only if agenda not empty')
    expect(screen.getByText(/Weekdays at 8:00 AM · version 2/)).toBeInTheDocument()
  })
  it('run history shows real outcomes: the failure reason, per-step status and the briefing text', async () => {
    h.runs = [
      { id: 'r1', workflow_id: 'w1', status: 'failed', trigger_source: 'schedule', attempt: 1, error: 'Step "brief" failed: The AI assistant is not configured', output: null, created_at: '2026-10-21T13:00:00Z', finished_at: null,
        workflow_steps: [{ step_key: 'agenda', step_type: 'tool', status: 'failed', attempt: 2, error: 'Google Calendar is not connected', output: null, started_at: '2026-10-21T13:00:01Z', finished_at: null }] },
      { id: 'r2', workflow_id: 'w1', status: 'succeeded', trigger_source: 'manual', attempt: 1, error: null, output: { text: 'Good morning. Two meetings today.' }, created_at: '2026-10-20T13:00:00Z', finished_at: null, workflow_steps: [] },
    ]
    wrap(<WorkflowsPage />)
    expect(screen.getByText(/The AI assistant is not configured/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: /Failed/ })[0])
    expect(screen.getByText(/Google Calendar is not connected/)).toBeInTheDocument()
    expect(screen.getByText(/attempt 2/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Succeeded/ }))
    expect(screen.getByText('Good morning. Two meetings today.')).toBeInTheDocument()
  })
  it('runs a workflow on demand', async () => {
    wrap(<WorkflowsPage />)
    await userEvent.click(screen.getByRole('button', { name: /Run now/ }))
    expect(h.run).toHaveBeenCalledWith('w1')
  })
  it('non-admins can look but not run, edit or create', () => {
    org.isAdmin = false
    wrap(<WorkflowsPage />)
    expect(screen.getByText(/Only owners and admins can create, edit or run/)).toBeInTheDocument()
    for (const n of [/Run now/, /New workflow/, /Edit/, /Delete/]) expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })
  it('offers the daily briefing template only when none exists', () => {
    h.workflows = []
    wrap(<WorkflowsPage />)
    expect(screen.getByRole('button', { name: 'Set up daily briefing' })).toBeInTheDocument()
    expect(screen.getByText(/switched off until you enable them/)).toBeInTheDocument()
  })
})

describe('Workflow editor', () => {
  async function openEditor() {
    wrap(<WorkflowsPage />)
    await userEvent.click(screen.getByRole('button', { name: 'New workflow' }))
    return screen.getByRole('dialog')
  }
  it('blocks saving with an invalid schedule and says why', async () => {
    const dlg = await openEditor()
    await userEvent.type(within(dlg).getByLabelText('Name'), 'Test')
    await userEvent.selectOptions(within(dlg).getByLabelText('Trigger'), 'schedule')
    const cron = within(dlg).getByLabelText('Cron expression')
    await userEvent.clear(cron); await userEvent.type(cron, '99 * * * *')
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save workflow' }))
    // shown inline next to the field AND in the summary of problems
    expect(await within(dlg).findAllByText(/minute: .*out of range/)).toHaveLength(2)
    expect(h.save).not.toHaveBeenCalled()
  })
  it('blocks invalid step JSON and forward references client-side', async () => {
    const dlg = await openEditor()
    await userEvent.type(within(dlg).getByLabelText('Name'), 'Test')
    const input = within(dlg).getByLabelText('Step 1 input')
    await userEvent.clear(input); await userEvent.type(input, '{{ not json')
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save workflow' }))
    expect(await within(dlg).findByText(/not valid JSON/)).toBeInTheDocument()
    expect(h.save).not.toHaveBeenCalled()
  })
  it('saves a valid definition through the server (not directly to the database)', async () => {
    const dlg = await openEditor()
    await userEvent.type(within(dlg).getByLabelText('Name'), 'Chase overdue')
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save workflow' }))
    expect(h.save).toHaveBeenCalledOnce()
    const arg = h.save.mock.calls[0][0]
    expect(arg).toMatchObject({ name: 'Chase overdue', trigger: { type: 'manual' } })
    expect(arg.definition.steps[0]).toMatchObject({ id: 'step1', type: 'tool', tool: 'tasks.list', on_failure: 'stop', retry: { max_attempts: 1 } })
  })
  it('marks tools that need approval', async () => {
    const dlg = await openEditor()
    expect(within(dlg).getByRole('option', { name: 'email.send (needs approval)' })).toBeInTheDocument()
    expect(within(dlg).getByRole('option', { name: 'tasks.list' })).toBeInTheDocument()
  })
})

describe('Notifications bell', () => {
  const note = (o: any) => ({ id: 'n1', type: 'workflow_failed', title: 'Workflow "Daily briefing" failed', body: 'Step "brief": x', link: '/workflows', read_at: null, created_at: new Date().toISOString(), ...o })
  it('shows the unread count, lists failures, and marks them read', async () => {
    h.notes = [note({}), note({ id: 'n2', read_at: '2026-10-20T00:00:00Z', title: 'Old one' })]
    wrap(<NotificationsBell />)
    const bell = screen.getByRole('button', { name: /Notifications, 1 unread/ })
    await userEvent.click(bell)
    expect(screen.getByText('Workflow "Daily briefing" failed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(h.markRead).toHaveBeenCalledWith(['n1'])
  })
  it('has an empty state', async () => {
    wrap(<NotificationsBell />)
    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument()
  })
})
