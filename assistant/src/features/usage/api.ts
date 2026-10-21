import { useQuery } from '@tanstack/react-query'
import { callFunction } from '@/features/assistant/api'

export interface UsageResponse {
  window_days: number
  from: string
  generated_at: string
  daily: Array<{ day: string; input_tokens: number; output_tokens: number; tool_calls: number }>
  totals: { input_tokens: number; output_tokens: number; tool_calls: number }
  by_model: Array<{ model: string; input_tokens: number; output_tokens: number }>
  tools: Array<{ tool: string; calls: number; failures: number }>
  workflow_runs: Record<string, number>
  storage: { bytes: number; documents: number }
  today: { tokens: number; limit: number | null; percent: number | null; remaining: number | null; resets_at: string }
}

export function useUsage(orgId: string, days: number, enabled: boolean) {
  return useQuery({
    queryKey: ['usage', orgId, days], enabled, staleTime: 30_000,
    queryFn: () => callFunction<UsageResponse>('usage-summary', { org_id: orgId, days }),
  })
}
