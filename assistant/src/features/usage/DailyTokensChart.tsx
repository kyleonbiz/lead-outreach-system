import type { UsageResponse } from './api'

const nf = new Intl.NumberFormat('en-US')
const W = 640, H = 200, PAD = { l: 8, r: 8, t: 8, b: 22 }

/** Stacked daily bars (output on top of input). Drawn as inline SVG so it follows the theme; the same data is available as a table. */
export function DailyTokensChart({ daily }: { daily: UsageResponse['daily'] }) {
  const totals = daily.map((d) => d.input_tokens + d.output_tokens)
  const max = Math.max(1, ...totals)
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b
  const slot = innerW / Math.max(1, daily.length)
  const bar = Math.max(2, slot * 0.7)
  const y = (v: number) => (v / max) * innerH
  const label = (i: number) => daily[i].day.slice(5) // MM-DD
  const labelled = new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])
  const sum = totals.reduce((a, b) => a + b, 0)

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
        aria-label={`Daily tokens over ${daily.length} days, ${nf.format(sum)} in total, peak ${nf.format(max === 1 && sum === 0 ? 0 : max)} in a day. A table with the same figures follows.`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="rgb(var(--line))" />
        {daily.map((d, i) => {
          const x = PAD.l + i * slot + (slot - bar) / 2
          const hi = y(d.input_tokens), ho = y(d.output_tokens), base = H - PAD.b
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${nf.format(d.input_tokens)} in, ${nf.format(d.output_tokens)} out`}</title>
              {d.input_tokens > 0 && <rect x={x} y={base - hi} width={bar} height={hi} fill="rgb(var(--muted) / 0.5)" />}
              {d.output_tokens > 0 && <rect x={x} y={base - hi - ho} width={bar} height={ho} fill="rgb(var(--accent))" />}
              {labelled.has(i) && <text x={x + bar / 2} y={H - 6} textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'} fontSize="11" fill="rgb(var(--muted))">{label(i)}</text>}
            </g>
          )
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-4 text-xs text-muted" aria-label="Chart key">
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: 'rgb(var(--muted) / 0.5)' }} />Tokens sent to the AI (input)</li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent" />Tokens written by the AI (output)</li>
      </ul>
      {/* the wrapper (not the table) carries sr-only: a <table> ignores width/overflow and would widen the page */}
      <div className="sr-only">
        <table>
          <caption>Tokens per day (UTC)</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Tool calls</th></tr></thead>
          <tbody>{daily.map((d) => <tr key={d.day}><th scope="row">{d.day}</th><td>{d.input_tokens}</td><td>{d.output_tokens}</td><td>{d.tool_calls}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  )
}
