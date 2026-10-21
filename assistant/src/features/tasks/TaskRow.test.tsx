import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskRow } from './TaskRow'
import type { Task } from '@/lib/types'

const base: Task = {
  id: '1', org_id: 'o', title: 'Send invoices', description: null, notes: null, status: 'todo', priority: 'urgent',
  category: 'Finance', due_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), recurrence: 'monthly',
  assignee_id: null, created_via: 'assistant', completed_at: null, created_at: new Date().toISOString(),
}

it('shows urgency, overdue state, recurrence and assistant attribution', () => {
  render(<ul><TaskRow task={base} onToggle={() => {}} onOpen={() => {}} /></ul>)
  expect(screen.getByText('urgent')).toBeInTheDocument()
  expect(screen.getByText(/overdue/)).toBeInTheDocument()
  expect(screen.getByText('monthly')).toBeInTheDocument()
  expect(screen.getByText(/Added by assistant/)).toBeInTheDocument()
})

it('completes via the checkbox and opens the editor via the title', async () => {
  const onToggle = vi.fn(), onOpen = vi.fn()
  render(<ul><TaskRow task={base} onToggle={onToggle} onOpen={onOpen} /></ul>)
  await userEvent.click(screen.getByRole('checkbox', { name: /complete "send invoices"/i }))
  expect(onToggle).toHaveBeenCalledWith(base)
  await userEvent.click(screen.getByText('Send invoices'))
  expect(onOpen).toHaveBeenCalledWith(base)
})

it('does not badge due dates on finished tasks', () => {
  render(<ul><TaskRow task={{ ...base, status: 'done' }} onToggle={() => {}} onOpen={() => {}} /></ul>)
  expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox')).toBeChecked()
})
