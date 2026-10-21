import { describe, expect, it } from 'vitest'
import { dueInfo, greeting, isoToLocalInput, localInputToIso, sortTasks } from './utils'
import type { Task } from './types'

const now = new Date(2026, 9, 21, 10, 0, 0) // Oct 21 2026, local

const task = (o: Partial<Task>): Task => ({
  id: crypto.randomUUID(), org_id: 'o', title: 't', description: null, notes: null, status: 'todo',
  priority: 'medium', category: null, due_at: null, recurrence: null, assignee_id: null,
  created_via: 'user', completed_at: null, created_at: now.toISOString(), ...o,
})

describe('dueInfo', () => {
  it('handles missing and invalid dates', () => {
    expect(dueInfo(null, now).tone).toBe('none')
    expect(dueInfo('not-a-date', now).tone).toBe('none')
  })
  it('flags overdue, today, soon and later', () => {
    expect(dueInfo(new Date(2026, 9, 18, 9).toISOString(), now)).toEqual({ label: '3 days overdue', tone: 'overdue' })
    expect(dueInfo(new Date(2026, 9, 20, 9).toISOString(), now).label).toBe('Yesterday')
    expect(dueInfo(new Date(2026, 9, 21, 17).toISOString(), now).tone).toBe('today')
    expect(dueInfo(new Date(2026, 9, 22, 9).toISOString(), now).label).toBe('Tomorrow')
    expect(dueInfo(new Date(2026, 9, 25, 9).toISOString(), now).tone).toBe('soon')
    expect(dueInfo(new Date(2026, 10, 25, 9).toISOString(), now).tone).toBe('later')
  })
  it('treats a task due earlier today as today, not overdue', () => {
    expect(dueInfo(new Date(2026, 9, 21, 7).toISOString(), now).tone).toBe('today')
  })
})

describe('sortTasks', () => {
  it('puts open tasks first, then earliest due, undated last, then priority', () => {
    const a = task({ title: 'done', status: 'done' })
    const b = task({ title: 'later', due_at: new Date(2026, 9, 30).toISOString() })
    const c = task({ title: 'sooner', due_at: new Date(2026, 9, 22).toISOString() })
    const d = task({ title: 'undated-high', priority: 'high' })
    const e = task({ title: 'undated-low', priority: 'low' })
    expect(sortTasks([a, e, b, d, c]).map((t) => t.title)).toEqual(['sooner', 'later', 'undated-high', 'undated-low', 'done'])
  })
  it('does not mutate its input', () => {
    const input = [task({ title: 'b' }), task({ title: 'a', priority: 'urgent' })]
    const copy = [...input]
    sortTasks(input)
    expect(input).toEqual(copy)
  })
})

describe('greeting', () => {
  it('uses the first name and time of day', () => {
    expect(greeting('Kyle Jones', new Date(2026, 0, 1, 9))).toBe('Good morning, Kyle')
    expect(greeting(null, new Date(2026, 0, 1, 14))).toBe('Good afternoon')
    expect(greeting('  ', new Date(2026, 0, 1, 20))).toBe('Good evening')
  })
})

describe('datetime-local conversion', () => {
  it('round-trips and rejects blanks', () => {
    const iso = localInputToIso('2026-10-21T09:30')
    expect(iso).not.toBeNull()
    expect(isoToLocalInput(iso)).toBe('2026-10-21T09:30')
    expect(localInputToIso('')).toBeNull()
    expect(isoToLocalInput(null)).toBe('')
  })
})
