import type { Definition, Trigger } from './definition.ts'

export interface WorkflowTemplate {
  kind: 'daily_briefing'
  name: string
  description: string
  trigger: Trigger
  definition: Definition
}

/** Weekday-morning briefing: calendar, unread mail, overdue tasks -> one summary shown on the dashboard. */
export const DAILY_BRIEFING: WorkflowTemplate = {
  kind: 'daily_briefing',
  name: 'Daily briefing',
  description: 'Every weekday at 8:00: today\'s calendar, important unread email and overdue tasks, summarized on your dashboard.',
  trigger: { type: 'schedule', cron: '0 8 * * 1-5' },
  definition: {
    steps: [
      { id: 'agenda', type: 'tool', tool: 'calendar.list_events', label: 'Today\'s calendar', input: { time_min: '{{time.today_start}}', time_max: '{{time.today_end}}' }, on_failure: 'continue', retry: { max_attempts: 2, backoff_seconds: 60 } },
      { id: 'mail', type: 'tool', tool: 'email.triage', label: 'Unread email', input: { days: 2, limit: 15 }, on_failure: 'continue', retry: { max_attempts: 2, backoff_seconds: 60 } },
      { id: 'overdue', type: 'tool', tool: 'tasks.list', label: 'Overdue tasks', input: { overdue: true, limit: 20 }, on_failure: 'continue', retry: { max_attempts: 2, backoff_seconds: 60 } },
      { id: 'due_today', type: 'tool', tool: 'tasks.list', label: 'Due today', input: { due_before: '{{time.today_end}}', limit: 20 }, on_failure: 'continue', retry: { max_attempts: 2, backoff_seconds: 60 } },
      {
        id: 'briefing', type: 'summarize', label: 'Write the briefing', from: ['agenda', 'mail', 'overdue', 'due_today'], on_failure: 'stop',
        retry: { max_attempts: 3, backoff_seconds: 120 },
        instruction: 'Prepare a concise daily briefing: (1) today\'s agenda, (2) important unread email — urgent and needs-reply first, (3) overdue and due-today tasks, (4) two or three recommended next actions. State clearly which sections could not be retrieved.',
      },
    ],
  },
}
