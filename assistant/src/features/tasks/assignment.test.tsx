import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskDialog } from './TaskDialog'
import { TaskRow } from './TaskRow'
import type { Task } from '@/lib/types'

const create = vi.fn(), update = vi.fn()
vi.mock('./api', () => ({
  useCreateTask: () => ({ mutateAsync: create, isPending: false }),
  useUpdateTask: () => ({ mutateAsync: update, isPending: false }),
  useDeleteTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/features/team/api', async (orig) => ({
  ...(await orig<typeof import('@/features/team/api')>()),
  useMembers: () => ({ data: [
    { user_id: 'u1', full_name: 'Jane Owner', email: null, role: 'owner', joined_at: '' },
    { user_id: 'u2', full_name: null, email: 'sam@acme.com', role: 'member', joined_at: '' },
    { user_id: 'u3', full_name: null, email: null, role: 'member', joined_at: '' },
  ] }),
}))

const task = (o: Partial<Task> = {}): Task => ({
  id: 't1', org_id: 'o', title: 'File taxes', description: null, notes: null, status: 'todo', priority: 'medium', category: null,
  due_at: null, recurrence: null, assignee_id: null, created_via: 'user', completed_at: null, created_at: new Date().toISOString(), ...o,
})

beforeEach(() => { create.mockReset().mockResolvedValue(undefined); update.mockReset().mockResolvedValue(undefined) })

describe('assigning a task', () => {
  it('offers every team member by name (falling back to the e-mail prefix, then a neutral label)', () => {
    render(<TaskDialog orgId="o" task={null} open onClose={() => {}} />)
    const labels = Array.from((screen.getByLabelText('Assigned to') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(labels).toEqual(['Unassigned', 'Jane Owner', 'sam', 'Team member'])
  })
  it('creates a task assigned to someone', async () => {
    render(<TaskDialog orgId="o" task={null} open onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText('Title'), 'Call the bank')
    await userEvent.selectOptions(screen.getByLabelText('Assigned to'), 'u2')
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call the bank', assignee_id: 'u2' })))
  })
  it('creates unassigned tasks with a null assignee', async () => {
    render(<TaskDialog orgId="o" task={null} open onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText('Title'), 'Solo task')
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ assignee_id: null })))
  })
  it('edits an assignment and can clear it', async () => {
    render(<TaskDialog orgId="o" task={task({ assignee_id: 'u1' })} open onClose={() => {}} />)
    expect(screen.getByLabelText('Assigned to')).toHaveValue('u1')
    await userEvent.selectOptions(screen.getByLabelText('Assigned to'), '')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', assignee_id: null })))
  })
})

describe('task row', () => {
  it('shows who a task is assigned to', () => {
    render(<ul><TaskRow task={task({ assignee_id: 'u1' })} assigneeName="Jane Owner" onToggle={() => {}} onOpen={() => {}} /></ul>)
    expect(screen.getByText('Jane Owner')).toBeInTheDocument()
  })
  it('shows nothing for unassigned tasks and a neutral label when the name is unknown', () => {
    const { rerender } = render(<ul><TaskRow task={task()} onToggle={() => {}} onOpen={() => {}} /></ul>)
    expect(screen.queryByText('Assigned')).not.toBeInTheDocument()
    rerender(<ul><TaskRow task={task({ assignee_id: 'gone' })} onToggle={() => {}} onOpen={() => {}} /></ul>)
    expect(screen.getByText('Assigned')).toBeInTheDocument()
  })
})
