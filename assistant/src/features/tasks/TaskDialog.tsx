import { useState, type FormEvent } from 'react'
import { Button, Dialog, Field, Input, Notice, Select, Textarea } from '@/components/ui'
import type { Recurrence, Task, TaskPriority, TaskStatus } from '@/lib/types'
import { isoToLocalInput, localInputToIso } from '@/lib/utils'
import { memberName, useMembers } from '@/features/team/api'
import { useCreateTask, useDeleteTask, useUpdateTask } from './api'

export function TaskDialog({ orgId, task, open, onClose }: { orgId: string; task: Task | null; open: boolean; onClose: () => void }) {
  const create = useCreateTask(orgId)
  const update = useUpdateTask(orgId)
  const remove = useDeleteTask(orgId)
  const members = useMembers(orgId)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const busy = create.isPending || update.isPending || remove.isPending

  function close() { setError(null); setConfirmDelete(false); onClose() }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const text = (k: string) => String(f.get(k) ?? '').trim()
    const input = {
      title: text('title'),
      description: text('description') || null,
      notes: text('notes') || null,
      category: text('category') || null,
      priority: text('priority') as TaskPriority,
      status: text('status') as TaskStatus,
      recurrence: (text('recurrence') || null) as Recurrence | null,
      due_at: localInputToIso(text('due_at')),
      assignee_id: text('assignee_id') || null,
    }
    try {
      if (task) await update.mutateAsync({ id: task.id, ...input })
      else await create.mutateAsync(input)
      close()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function onDelete() {
    if (!task) return
    try { await remove.mutateAsync(task.id); close() } catch (err) { setError((err as Error).message) }
  }

  return (
    <Dialog
      open={open} onClose={close} title={task ? 'Edit task' : 'New task'}
      footer={
        <>
          {task && (
            confirmDelete
              ? <Button variant="danger" onClick={onDelete} loading={remove.isPending} className="mr-auto">Confirm delete</Button>
              : <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy} className="mr-auto text-danger">Delete</Button>
          )}
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" form="task-form" variant="primary" loading={create.isPending || update.isPending}>
            {task ? 'Save changes' : 'Create task'}
          </Button>
        </>
      }
    >
      {/* key resets uncontrolled fields whenever a different task is opened */}
      <form id="task-form" key={task?.id ?? 'new'} onSubmit={onSubmit} className="space-y-4">
        <Field label="Title">{(id) => <Input id={id} name="title" required maxLength={300} defaultValue={task?.title} autoFocus />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} name="description" maxLength={20000} defaultValue={task?.description ?? ''} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due">{(id) => <Input id={id} name="due_at" type="datetime-local" defaultValue={isoToLocalInput(task?.due_at ?? null)} />}</Field>
          <Field label="Priority">
            {(id) => (
              <Select id={id} name="priority" defaultValue={task?.priority ?? 'medium'}>
                <option value="low">Low</option><option value="medium">Medium</option>
                <option value="high">High</option><option value="urgent">Urgent</option>
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} name="status" defaultValue={task?.status ?? 'todo'}>
                <option value="todo">To do</option><option value="in_progress">In progress</option>
                <option value="blocked">Blocked</option><option value="done">Done</option><option value="cancelled">Cancelled</option>
              </Select>
            )}
          </Field>
          <Field label="Assigned to">
            {(id) => (
              <Select id={id} name="assignee_id" defaultValue={task?.assignee_id ?? ''}>
                <option value="">Unassigned</option>
                {(members.data ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Category">{(id) => <Input id={id} name="category" maxLength={80} defaultValue={task?.category ?? ''} placeholder="e.g. Finance" />}</Field>
          <Field label="Repeats" hint="A new task is created each time you complete this one.">
            {(id) => (
              <Select id={id} name="recurrence" defaultValue={task?.recurrence ?? ''}>
                <option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" maxLength={20000} defaultValue={task?.notes ?? ''} />}</Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  )
}
