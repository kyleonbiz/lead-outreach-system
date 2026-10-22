import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AssistantPage from './AssistantPage'

const messages = [
  { id: 'm1', role: 'user', content: 'What needs my attention? **not bold**', tool_calls: null, metadata: {}, created_at: '2026-10-21T10:00:00Z' },
  { id: 'm2', role: 'assistant', content: "Here's today:\n\n**Urgent email (3)**\n- Hartwell — quote expires\n- Dana — confirm visit\n\n[Open email](https://mail.example.com) and [bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>", tool_calls: [{ type: 'tool_use', name: 'email__triage' }], metadata: {}, created_at: '2026-10-21T10:00:01Z' },
]

vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => ({ orgId: 'org-1' }) }))
vi.mock('@/features/assistant/api', async (orig) => ({
  ...(await orig<typeof import('@/features/assistant/api')>()),
  useConversations: () => ({ data: [{ id: 'c1', title: 'Morning check-in', updated_at: '2026-10-21T10:00:00Z' }] }),
  useMessages: (id: string | null) => ({ data: id ? messages : undefined, isLoading: false }),
  usePendingApprovalList: () => ({ data: [] }),
  useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
}))

it('renders assistant replies as Markdown, keeps the user\'s text literal and neutralizes hostile content', async () => {
  const { container } = render(<MemoryRouter><AssistantPage /></MemoryRouter>)
  await userEvent.click(screen.getByRole('button', { name: 'Morning check-in' }))
  expect(await screen.findByText('Urgent email (3)')).toBeInTheDocument()
  expect(container.querySelectorAll('ul.list-disc li')).toHaveLength(2)
  expect(screen.getByText('Urgent email (3)').tagName).toBe('STRONG')
  expect(screen.getByRole('link', { name: 'Open email' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument()
  expect(container.querySelector('img, script')).toBeNull()
  expect(screen.getByText(/What needs my attention\? \*\*not bold\*\*/)).toBeInTheDocument() // user text is not formatted
  expect(screen.getByText(/Used email\.triage/)).toBeInTheDocument()
})
