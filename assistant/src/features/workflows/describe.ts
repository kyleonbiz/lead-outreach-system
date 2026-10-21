import type { WorkflowRow } from './api'

const PRESETS: Record<string, string> = {
  '0 8 * * 1-5': 'Weekdays at 8:00 AM', '0 9 * * *': 'Every day at 9:00 AM', '0 9 * * 1': 'Every Monday at 9:00 AM',
  '0 17 * * 5': 'Fridays at 5:00 PM', '0 * * * *': 'Every hour',
}
export const CRON_PRESETS = Object.entries(PRESETS).map(([cron, label]) => ({ cron, label }))

export function describeTrigger(w: Pick<WorkflowRow, 'trigger_type' | 'trigger_config'>): string {
  if (w.trigger_type === 'schedule') { const c = w.trigger_config.cron ?? ''; return PRESETS[c] ?? `Schedule: ${c}` }
  if (w.trigger_type === 'event') return w.trigger_config.event === 'task.overdue' ? 'When a task becomes overdue' : w.trigger_config.event === 'document.ready' ? 'When a document finishes processing' : 'On an event'
  return 'Manual only'
}
