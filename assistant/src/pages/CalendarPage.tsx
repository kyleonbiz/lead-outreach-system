import { ComingSoon } from './ComingSoon'
export default function CalendarPage() {
  return (
    <ComingSoon
      title="Calendar" phase="Phase 4"
      description="Your agenda, availability and scheduling."
      needs={['a connected Google Calendar account (OAuth)']}
    />
  )
}
