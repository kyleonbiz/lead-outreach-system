// Seam for integrations: Gmail/Calendar (Phase 4) are real; documents are added in Phase 5.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDef } from './core/tools/registry.ts'
import type { CalendarProvider, DocumentPort, EmailProvider } from './core/ports.ts'
import { calendarFor, gmailFor } from './adapters/google.ts'
import { SupabaseDocuments } from './adapters/documents.ts'

export function extraTools(): ToolDef[] { return [] }

export function makeProviderPorts(svc: SupabaseClient, orgId: string) {
  return {
    email: (): Promise<EmailProvider> => gmailFor(svc, orgId),
    calendar: (): Promise<CalendarProvider> => calendarFor(svc, orgId),
    emailRules: async (): Promise<unknown> =>
      (await svc.from('organization_settings').select('email_rules').eq('org_id', orgId).maybeSingle()).data?.email_rules ?? {},
    documents: (client: SupabaseClient, userId: string | null = null): DocumentPort => new SupabaseDocuments(client, svc, orgId, userId),
  }
}
