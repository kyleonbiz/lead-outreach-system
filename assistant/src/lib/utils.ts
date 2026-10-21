import clsx, { type ClassValue } from 'clsx'
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'
import type { Task } from './types'

export const cn = (...v: ClassValue[]) => clsx(v)

export type DueTone = 'none' | 'overdue' | 'today' | 'soon' | 'later'

/** Classifies a due date relative to `now` using calendar days in the viewer's local time. */
export function dueInfo(dueAt: string | null, now: Date = new Date()): { label: string; tone: DueTone } {
  if (!dueAt) return { label: 'No date', tone: 'none' }
  const d = parseISO(dueAt)
  if (!isValid(d)) return { label: 'No date', tone: 'none' }
  const days = differenceInCalendarDays(d, now)
  if (days < 0) {
    return { label: days === -1 ? 'Yesterday' : `${-days} days overdue`, tone: 'overdue' }
  }
  if (days === 0) return { label: `Today ${format(d, 'p')}`, tone: 'today' }
  if (days === 1) return { label: 'Tomorrow', tone: 'soon' }
  if (days <= 7) return { label: format(d, 'EEE, MMM d'), tone: 'soon' }
  return { label: format(d, 'MMM d, yyyy'), tone: 'later' }
}

export function isOpen(t: Pick<Task, 'status'>) {
  return t.status !== 'done' && t.status !== 'cancelled'
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/** Open tasks first; then by due date (undated last); then by priority. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1
    const ad = a.due_at ? Date.parse(a.due_at) : Infinity
    const bd = b.due_at ? Date.parse(b.due_at) : Infinity
    if (ad !== bd) return ad - bd
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  })
}

export function greeting(name: string | null | undefined, now: Date = new Date()): string {
  const h = now.getHours()
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

/** Converts a `datetime-local` input value (viewer's local time) to an ISO string, or null. */
export function localInputToIso(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return isValid(d) ? d.toISOString() : null
}

export function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = parseISO(iso)
  return isValid(d) ? format(d, "yyyy-MM-dd'T'HH:mm") : ''
}
