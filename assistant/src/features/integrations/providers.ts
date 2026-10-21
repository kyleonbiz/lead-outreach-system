import type { ConnectedIntegration } from '@/lib/types'

export interface ProviderInfo {
  id: ConnectedIntegration['provider']
  name: string
  description: string
  available: boolean   // false = adapter not built yet
  phase: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'google_gmail', name: 'Gmail', description: 'Read, summarize and draft email. Sending always asks for approval.', available: false, phase: 'Phase 4' },
  { id: 'google_calendar', name: 'Google Calendar', description: 'View your agenda, check availability and schedule meetings.', available: false, phase: 'Phase 4' },
  { id: 'microsoft_mail', name: 'Outlook Mail', description: 'Same capabilities as Gmail for Microsoft 365 accounts.', available: false, phase: 'Planned' },
  { id: 'microsoft_calendar', name: 'Outlook Calendar', description: 'Same capabilities as Google Calendar for Microsoft 365 accounts.', available: false, phase: 'Planned' },
]
