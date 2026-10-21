import { Badge, EmptyState, PageHeader } from '@/components/ui'

/** Honest placeholder: states what is missing instead of pretending the feature works. */
export function ComingSoon({
  title, description, phase, needs,
}: { title: string; description: string; phase: string; needs: string[] }) {
  return (
    <>
      <PageHeader title={title} description={description} actions={<Badge tone="warn">Not built yet · {phase}</Badge>} />
      <EmptyState title={`${title} isn't available yet`}>
        Nothing here is simulated. This section is built in {phase}. It will need: {needs.join('; ')}.
      </EmptyState>
    </>
  )
}
