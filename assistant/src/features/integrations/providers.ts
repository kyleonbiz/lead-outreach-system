import type { ConnectedIntegration } from '@/lib/types'

export interface ProviderInfo {
  id: ConnectedIntegration['provider']
  name: string
  description: string
  available: boolean   // false = adapter not built yet
  phase: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'google_gmail', name: 'Gmail', description: 'Read, summarize and draft email. Sending always asks for your approval. Permissions requested: read mail and compose/send.', available: true, phase: '' },
  { id: 'google_calendar', name: 'Google Calendar', description: 'View your agenda, check availability and create events. Permissions requested: manage events and see free/busy.', available: true, phase: '' },
  { id: 'microsoft_mail', name: 'Outlook Mail', description: 'Same capabilities as Gmail for Microsoft 365 accounts.', available: false, phase: 'Planned' },
  { id: 'microsoft_calendar', name: 'Outlook Calendar', description: 'Same capabilities as Google Calendar for Microsoft 365 accounts.', available: false, phase: 'Planned' },
]

export const CONNECT_ERRORS: Record<string, string> = {
  access_denied: 'You declined the connection, so nothing was connected.',
  invalid_state: 'That connection link expired or was invalid. Please try again.',
  forbidden: 'Only owners and admins can connect accounts.',
  exchange_failed: 'Google did not complete the connection. Please try again.',
  no_refresh_token: 'Google did not grant ongoing access. Remove this app at myaccount.google.com/permissions, then connect again.',
  missing_scopes: 'Some requested permissions were not granted, so the connection was not saved. Connect again and leave all boxes ticked.',
  not_configured: 'Google connections are not configured on the server yet.',
  google_error: 'Google reported an error. Please try again.',
}
