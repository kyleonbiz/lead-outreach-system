import { ComingSoon } from './ComingSoon'
export default function EmailPage() {
  return (
    <ComingSoon
      title="Email" phase="Phase 4"
      description="Summaries, priorities, drafts and follow-ups."
      needs={['a connected Gmail account (OAuth)']}
    />
  )
}
