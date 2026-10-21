import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import { callFunction, FunctionError } from '@/features/assistant/api'

export type ExportScope = 'all' | 'audit'

/** Calls the export function and returns the zip. Failures carry the server's explanation (e.g. "wait 120 seconds"). */
export async function fetchExport(orgId: string, scope: ExportScope): Promise<Blob> {
  const { data, error } = await db().functions.invoke('export-org-data', { body: { org_id: orgId, scope } })
  if (!error) {
    if (!(data instanceof Blob)) throw new FunctionError('The export did not return a file.', 0, {})
    return data
  }
  const res = (error as { context?: Response }).context
  if (res && typeof res.json === 'function') {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new FunctionError(String(body.error ?? error.message), res.status, body)
  }
  throw new FunctionError(error.message, 0, {})
}

/** Hands the file to the browser as a normal download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const exportFilename = (orgName: string, scope: ExportScope, now = new Date()) =>
  `aide-${scope === 'all' ? 'export' : 'audit-log'}-${orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'organization'}-${now.toISOString().slice(0, 10)}.zip`

export interface PlannedOrg { id: string; name: string; role: string; members: number; plan: 'leave' | 'delete_org' | 'blocked' }
export interface DeletionPreview { email: string | null; recent_sign_in: boolean; recent_sign_in_minutes: number; organizations: PlannedOrg[]; can_delete: boolean }

export function useDeletionPreview(enabled: boolean) {
  return useQuery({
    queryKey: ['deletion-preview'], enabled, gcTime: 0, staleTime: 0,
    queryFn: () => callFunction<DeletionPreview>('delete-account', { action: 'preview' }),
  })
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: (v: { confirm_email: string; delete_org_ids: string[] }) =>
      callFunction<{ deleted: boolean; deleted_organizations: string[]; disconnected_integrations: Array<{ provider: string; account: string; revoked: boolean }> }>('delete-account', { action: 'delete', ...v }),
  })
}

export function useTransferOwnership(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { newOwner: string; stepDown: boolean }) => {
      const { error } = await db().rpc('transfer_ownership', { p_org: orgId, p_new_owner: v.newOwner, p_step_down: v.stepDown })
      if (error) throw new Error(error.message)
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); qc.invalidateQueries({ queryKey: ['memberships'] }) },
  })
}
