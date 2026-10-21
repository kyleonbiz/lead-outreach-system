import { useMutation, useQueryClient } from '@tanstack/react-query'
import { callFunction } from '@/features/assistant/api'

export function useConnect(orgId: string) {
  return useMutation({
    mutationFn: async (provider: string) => {
      const r = await callFunction<{ url: string }>('oauth-start', { org_id: orgId, provider })
      window.location.assign(r.url)
    },
  })
}

export function useDisconnect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (integrationId: string) =>
      callFunction<{ status: string; provider_revoked: boolean; note?: string }>('integration-disconnect', { integration_id: integrationId }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
  })
}
