export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-accent-ink" aria-hidden>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M5 18 12 5l7 13h-3.4L12 11.2 8.4 18z" /></svg>
      </span>
      {!compact && <span>Aide</span>}
    </span>
  )
}
