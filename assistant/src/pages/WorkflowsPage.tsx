import { ComingSoon } from './ComingSoon'
export default function WorkflowsPage() {
  return (
    <ComingSoon
      title="Workflows" phase="Phase 6"
      description="Repeatable multi-step routines with schedules, approvals and retries."
      needs={['the background job runner', 'the assistant tool layer (Phase 3)']}
    />
  )
}
