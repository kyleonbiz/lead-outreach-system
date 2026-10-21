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
  { id: 'microsoft_mail', name: 'Outlook Mail', description: 'Read, summarize and draft email for Microsoft 365 and Outlook.com accounts. Sending always asks for your approval. Permissions requested: read and write mail, send mail.', available: true, phase: '' },
  { id: 'microsoft_calendar', name: 'Outlook Calendar', description: 'View your agenda, check availability and create events in Outlook. Permissions requested: read and write calendars.', available: true, phase: '' },
]

const VENDOR: Record<string, { name: string; removeAt: string }> = {
  google: { name: 'Google', removeAt: 'myaccount.google.com/permissions' },
  microsoft: { name: 'Microsoft', removeAt: 'myapps.microsoft.com (work or school) or account.microsoft.com/privacy/app-access (personal)' },
}
export const vendorOf = (provider: string | null): 'google' | 'microsoft' => (provider?.startsWith('microsoft') ? 'microsoft' : 'google')

/** The explanation for a failed connection, worded for the provider that was being connected. */
export function connectError(code: string, provider: string | null): string {
  const v = VENDOR[vendorOf(provider)]
  switch (code) {
    case 'access_denied': return 'You declined the connection, so nothing was connected.'
    case 'invalid_state': return 'That connection link expired or was invalid. Please try again.'
    case 'forbidden': return 'Only owners and admins can connect accounts.'
    case 'exchange_failed': return `${v.name} did not complete the connection. Please try again.`
    case 'no_refresh_token': return `${v.name} did not grant ongoing access. Remove this app at ${v.removeAt}, then connect again.`
    case 'missing_scopes': return 'Some requested permissions were not granted, so the connection was not saved. Connect again and leave all boxes ticked. (A Microsoft 365 admin can also restrict which apps may be used.)'
    case 'not_configured': return `${v.name} connections are not configured on the server yet.`
    case 'google_error': case 'microsoft_error': return `${v.name} reported an error. Please try again.`
    default: return 'Something went wrong. Please try again.'
  }
}
