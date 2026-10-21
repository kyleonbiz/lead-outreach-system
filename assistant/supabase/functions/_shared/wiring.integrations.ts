// Seam for integrations added in later phases (Gmail/Calendar in Phase 4, documents in Phase 5).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDef } from './core/tools/registry.ts'
import type { CalendarProvider, DocumentPort, EmailProvider } from './core/ports.ts'
import { NotConfiguredError } from './core/types.ts'

export function extraTools(): ToolDef[] { return [] }

export function makeProviderPorts(_svc: SupabaseClient, _orgId: string) {
  return {
    email: async (): Promise<EmailProvider> => { throw new NotConfiguredError('Gmail') },
    calendar: async (): Promise<CalendarProvider> => { throw new NotConfiguredError('Google Calendar') },
    documents: (_client: SupabaseClient): DocumentPort => ({
      list: async () => { throw new NotConfiguredError('Documents', 'Documents are not available yet.') },
      createGenerated: async () => { throw new NotConfiguredError('Documents', 'Documents are not available yet.') },
    }),
  }
}
