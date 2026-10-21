import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { Bell } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOrg } from '@/features/org/OrgProvider'
import { useMarkRead, useNotifications } from './api'

export function NotificationsBell() {
  const { orgId } = useOrg()
  const q = useNotifications(orgId)
  const mark = useMarkRead(orgId)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const unread = (q.data ?? []).filter((n) => !n.read_at)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ''}`} aria-expanded={open}
        className="relative rounded p-2 text-muted hover:bg-sunken hover:text-ink">
        <Bell className="h-4 w-4" />
        {unread.length > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-danger-ink">{unread.length}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unread.length > 0 && <button className="text-xs text-accent hover:underline" onClick={() => mark.mutate(unread.map((n) => n.id))}>Mark all read</button>}
          </div>
          <ul className="max-h-80 divide-y divide-line overflow-y-auto">
            {(q.data ?? []).length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nothing yet.</li>}
            {(q.data ?? []).map((n) => (
              <li key={n.id}>
                <button className={cn('w-full px-3 py-2.5 text-left hover:bg-sunken', !n.read_at && 'bg-accent-soft/50')}
                  onClick={() => { if (!n.read_at) mark.mutate([n.id]); if (n.link) navigate(n.link); setOpen(false) }}>
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-muted">{formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
