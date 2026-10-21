import { Badge } from '@/components/ui'
import type { ActionLog } from '@/lib/types'

const map = {
  success: ['ok', 'Succeeded'], failure: ['danger', 'Failed'], pending: ['warn', 'Pending'], denied: ['neutral', 'Denied'],
} as const

export function StatusBadge({ status }: { status: ActionLog['status'] }) {
  const [tone, label] = map[status]
  return <Badge tone={tone}>{label}</Badge>
}
