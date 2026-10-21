import { describeTrigger } from './describe'

it('describes triggers in plain language', () => {
  expect(describeTrigger({ trigger_type: 'manual', trigger_config: {} })).toBe('Manual only')
  expect(describeTrigger({ trigger_type: 'schedule', trigger_config: { cron: '0 8 * * 1-5' } })).toBe('Weekdays at 8:00 AM')
  expect(describeTrigger({ trigger_type: 'schedule', trigger_config: { cron: '15 6 * * 2' } })).toBe('Schedule: 15 6 * * 2')
  expect(describeTrigger({ trigger_type: 'event', trigger_config: { event: 'task.overdue' } })).toBe('When a task becomes overdue')
})
