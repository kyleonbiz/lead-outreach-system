import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { callFunction, FunctionError } from './api'
import { ApprovalCard } from './ApprovalCard'

const invoke = vi.fn()
vi.mock('@/lib/supabase', () => ({ db: () => ({ functions: { invoke } }) }))
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => ({ orgId: 'org-1' }) }))

beforeEach(() => invoke.mockReset())

describe('callFunction', () => {
  it('surfaces the server\'s structured error body (not_configured)', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify({ error: 'The assistant is not configured yet', code: 'not_configured', missing: ['ANTHROPIC_API_KEY'] }), { status: 503 }) },
    })
    const err = (await callFunction('assistant-chat', {}).catch((e) => e)) as FunctionError
    expect(err).toBeInstanceOf(FunctionError)
    expect(err.status).toBe(503)
    expect(err.body).toMatchObject({ code: 'not_configured', missing: ['ANTHROPIC_API_KEY'] })
    expect(err.message).toBe('The assistant is not configured yet')
  })
  it('returns data on success', async () => {
    invoke.mockResolvedValue({ data: { reply: 'hi' }, error: null })
    expect(await callFunction('assistant-chat', {})).toEqual({ reply: 'hi' })
  })
})

describe('ApprovalCard', () => {
  const a = { id: 'ap-1', summary: 'Permanently delete task "Old"', action_type: 'tasks.delete', created_at: new Date().toISOString(), conversation_id: null }
  const wrap = () => render(<QueryClientProvider client={new QueryClient()}><ApprovalCard a={a} /></QueryClientProvider>)

  it('sends the decision to the server and nothing else', async () => {
    invoke.mockResolvedValue({ data: { status: 'executed' }, error: null })
    wrap()
    expect(screen.getByText(/Permanently delete task "Old"/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('assistant-approve', { body: { approval_id: 'ap-1', decision: 'approved' } }))
  })
  it('shows a failed execution instead of pretending success', async () => {
    invoke.mockResolvedValue({ data: { status: 'failed', error: 'Gmail is not connected' }, error: null })
    wrap()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Gmail is not connected')).toBeInTheDocument()
    expect(screen.getByText(/Not completed: failed/)).toBeInTheDocument()
  })
})
