import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button, EmptyState, Notice, PageHeader, Spinner } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useAuth } from '@/features/auth/AuthProvider'
import { memberName, useMembers } from '@/features/team/api'
import { useCompleteTask, useTasks, useUpdateTask } from '@/features/tasks/api'
import { TaskDialog } from '@/features/tasks/TaskDialog'
import { TaskRow } from '@/features/tasks/TaskRow'
import type { Task } from '@/lib/types'
import { cn, isOpen } from '@/lib/utils'

type Filter = 'open' | 'mine' | 'overdue' | 'done' | 'all'

export default function TasksPage() {
  const { orgId } = useOrg()
  const tasks = useTasks(orgId)
  const { user } = useAuth()
  const members = useMembers(orgId)
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.user_id, memberName(m)])), [members.data])
  const complete = useCompleteTask(orgId)
  const update = useUpdateTask(orgId)
  const [filter, setFilter] = useState<Filter>('open')
  const [editing, setEditing] = useState<Task | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const visible = useMemo(() => {
    const all = tasks.data ?? []
    const now = Date.now()
    switch (filter) {
      case 'open': return all.filter(isOpen)
      case 'mine': return all.filter((t) => isOpen(t) && t.assignee_id === user?.id)
      case 'overdue': return all.filter((t) => isOpen(t) && t.due_at && Date.parse(t.due_at) < now)
      case 'done': return all.filter((t) => t.status === 'done')
      default: return all
    }
  }, [tasks.data, filter, user?.id])

  const open = (t: Task | null) => { setEditing(t); setDialogOpen(true) }

  async function toggle(t: Task) {
    setActionError(null)
    try {
      if (t.status === 'done') await update.mutateAsync({ id: t.id, status: 'todo' })
      else await complete.mutateAsync(t.id)
    } catch (e) { setActionError((e as Error).message) }
  }

  const tabs: [Filter, string][] = [['open', 'Open'], ['mine', 'Assigned to me'], ['overdue', 'Overdue'], ['done', 'Done'], ['all', 'All']]

  return (
    <>
      <PageHeader
        title="Tasks" description="Everything on your plate. The assistant works from this same list."
        actions={<Button variant="primary" onClick={() => open(null)}><Plus className="h-4 w-4" /> New task</Button>}
      />

      <div role="tablist" aria-label="Filter tasks" className="mb-4 flex gap-1 border-b border-line">
        {tabs.map(([k, label]) => (
          <button
            key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              filter === k ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink')}
          >{label}</button>
        ))}
      </div>

      {actionError && <div className="mb-3"><Notice tone="danger">{actionError}</Notice></div>}
      {tasks.isLoading && <Spinner label="Loading tasks" />}
      {tasks.isError && <Notice tone="danger" title="Couldn't load tasks">{(tasks.error as Error).message}</Notice>}
      {tasks.data && visible.length === 0 && (
        <EmptyState
          title={filter === 'open' ? 'Nothing open right now' : 'No tasks here'}
          action={filter === 'open' ? <Button onClick={() => open(null)}>Add a task</Button> : undefined}
        >
          {filter === 'open' ? 'Add a task, or ask the assistant to once it is connected.' : undefined}
        </EmptyState>
      )}
      {visible.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {visible.map((t) => (
            <TaskRow key={t.id} task={t} onToggle={toggle} onOpen={open} busy={complete.isPending || update.isPending} assigneeName={t.assignee_id ? names.get(t.assignee_id) : undefined} />
          ))}
        </ul>
      )}

      <TaskDialog orgId={orgId} task={editing} open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  )
}
