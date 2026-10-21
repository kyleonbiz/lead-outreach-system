import { Bot, Repeat, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui'
import { cn, dueInfo, isOpen } from '@/lib/utils'
import type { Task } from '@/lib/types'

const priorityTone = { urgent: 'danger', high: 'warn', medium: 'neutral', low: 'neutral' } as const
const dueTone = { overdue: 'danger', today: 'warn', soon: 'accent', later: 'neutral', none: 'neutral' } as const

export function TaskRow({
  task, onToggle, onOpen, busy,
}: { task: Task; onToggle: (t: Task) => void; onOpen: (t: Task) => void; busy?: boolean }) {
  const open = isOpen(task)
  const due = dueInfo(task.due_at)
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <input
        type="checkbox" checked={task.status === 'done'} disabled={busy || task.status === 'cancelled'}
        onChange={() => onToggle(task)}
        aria-label={task.status === 'done' ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
        className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
      />
      <button onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <span className={cn('block truncate text-sm font-medium', !open && 'text-muted line-through')}>{task.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {task.category && <span>{task.category}</span>}
          {task.recurrence && <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" aria-hidden />{task.recurrence}</span>}
          {task.created_via === 'assistant' && <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" aria-hidden />Added by assistant</span>}
          {task.created_via === 'workflow' && <span className="inline-flex items-center gap-1"><Workflow className="h-3 w-3" aria-hidden />Workflow</span>}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {open && task.priority !== 'medium' && task.priority !== 'low' && <Badge tone={priorityTone[task.priority]}>{task.priority}</Badge>}
        {open && task.due_at && <Badge tone={dueTone[due.tone]}>{due.label}</Badge>}
        {task.status === 'blocked' && <Badge tone="warn">blocked</Badge>}
        {task.status === 'in_progress' && <Badge tone="accent">in progress</Badge>}
      </div>
    </li>
  )
}
