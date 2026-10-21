import { ShieldCheck } from 'lucide-react'
import { Button, Notice } from '@/components/ui'
import { useOrg } from '@/features/org/OrgProvider'
import { useDecide, type PendingApproval } from './api'

export function ApprovalCard({ a }: { a: PendingApproval }) {
  const { orgId } = useOrg()
  const decide = useDecide(orgId)
  const result = decide.data
  return (
    <div className="rounded-lg border border-warn/40 bg-warn-soft p-3.5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Approval needed</p>
          <p className="mt-0.5 wrap-break-word text-sm">{a.summary}</p>
          <p className="mt-0.5 text-xs text-muted"><code className="font-mono">{a.action_type}</code></p>
        </div>
      </div>
      {decide.error && <div className="mt-3"><Notice tone="danger">{(decide.error as Error).message}</Notice></div>}
      {result && result.status !== 'rejected' && result.status !== 'executed' && (
        <div className="mt-3"><Notice tone="danger" title={`Not completed: ${result.status}`}>{result.error}</Notice></div>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" loading={decide.isPending && decide.variables?.decision === 'approved'}
          disabled={decide.isPending} onClick={() => decide.mutate({ approvalId: a.id, decision: 'approved' })}>Approve</Button>
        <Button disabled={decide.isPending} onClick={() => decide.mutate({ approvalId: a.id, decision: 'rejected' })}>Decline</Button>
      </div>
    </div>
  )
}
