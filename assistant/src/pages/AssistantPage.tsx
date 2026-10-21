import { ComingSoon } from './ComingSoon'
export default function AssistantPage() {
  return (
    <ComingSoon
      title="Assistant" phase="Phase 3"
      description="Give instructions in plain language; the assistant plans, asks for approval, then acts."
      needs={['an Anthropic API key configured on the server', 'the tool execution layer and approval flow']}
    />
  )
}
