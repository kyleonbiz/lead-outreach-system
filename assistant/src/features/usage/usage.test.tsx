import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import UsagePage from '@/pages/UsagePage'
import { DailyTokensChart } from './DailyTokensChart'
import type { UsageResponse } from './api'

const org = { orgId: 'org-1', isAdmin: true }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))
const useUsage = vi.fn()
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), useUsage: (...a: unknown[]) => useUsage(...a) }))

const day = (d: string, i = 0, o = 0, t = 0) => ({ day: d, input_tokens: i, output_tokens: o, tool_calls: t })
const usage = (over: Partial<UsageResponse> = {}): UsageResponse => ({
  window_days: 30, from: '2026-09-22T00:00:00Z', generated_at: '2026-10-21T15:30:00Z',
  daily: [day('2026-10-19', 1000, 300, 2), day('2026-10-20'), day('2026-10-21', 4000, 1500, 5)],
  totals: { input_tokens: 5000, output_tokens: 1800, tool_calls: 7 },
  by_model: [{ model: 'model-a', input_tokens: 4000, output_tokens: 1500 }, { model: 'model-b', input_tokens: 1000, output_tokens: 300 }],
  tools: [{ tool: 'tasks.create', calls: 5, failures: 1 }, { tool: 'email.search', calls: 2, failures: 0 }],
  workflow_runs: { succeeded: 3, failed: 1 }, storage: { bytes: 5_242_880, documents: 12 },
  today: { tokens: 120_000, limit: 500_000, percent: 24, remaining: 380_000, resets_at: '2026-10-22T00:00:00Z' }, ...over,
})
const show = (data: UsageResponse | null, extra: Record<string, unknown> = {}) => {
  useUsage.mockReturnValue({ data, isLoading: false, isError: false, error: null, ...extra })
  return render(<MemoryRouter><UsagePage /></MemoryRouter>)
}
beforeEach(() => { useUsage.mockReset(); org.isAdmin = true })

describe("today's budget", () => {
  it('shows use against the limit with correct progressbar semantics', () => {
    show(usage())
    const bar = screen.getByRole('progressbar', { name: "Today's token usage" })
    expect(bar).toHaveAttribute('aria-valuenow', '24')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuetext', "24% of today's limit")
    expect(screen.getByText(/of 500,000 tokens used today \(24%\)/)).toBeInTheDocument()
    expect(screen.getByText(/380,000 tokens remain/)).toBeInTheDocument()
    expect(screen.getByText('Within budget')).toBeInTheDocument()
  })
  it('warns when close, and says plainly when the limit is reached (the bar never overflows)', () => {
    const { unmount } = show(usage({ today: { tokens: 400_000, limit: 500_000, percent: 80, remaining: 100_000, resets_at: '2026-10-22T00:00:00Z' } }))
    expect(screen.getByText('Getting close')).toBeInTheDocument()
    unmount()
    show(usage({ today: { tokens: 650_000, limit: 500_000, percent: 130, remaining: 0, resets_at: '2026-10-22T00:00:00Z' } }))
    expect(screen.getByText('Limit reached')).toBeInTheDocument()
    expect(screen.getByText(/assistant is paused for this organization until midnight UTC/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText(/\(130%\)/)).toBeInTheDocument() // the real figure is still shown
  })
  it('an unlimited server has no bar and no invented percentage', () => {
    show(usage({ today: { tokens: 5000, limit: null, percent: null, remaining: null, resets_at: '2026-10-22T00:00:00Z' } }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('No daily limit')).toBeInTheDocument()
    expect(screen.getByText(/never paused for usage/)).toBeInTheDocument()
  })
})

describe('the numbers', () => {
  it('summarizes tokens, tool calls, workflow runs and storage', () => {
    show(usage())
    const stats = screen.getAllByRole('term').map((t) => [t.textContent, t.nextElementSibling?.textContent])
    expect(stats).toEqual([['Tokens, last 30 days', '6,800'], ['Tool calls', '7'], ['Workflow runs', '4'], ['Stored documents', '5.0 MB']])
    expect(screen.getByText('5,000 in · 1,800 out')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.getByText('12 documents')).toBeInTheDocument()
  })
  it('ranks tools with their failures and lists models', () => {
    show(usage())
    const tools = within(screen.getByRole('table', { name: 'Most used tools' })).getAllByRole('row').map((r) => r.textContent)
    expect(tools[1]).toContain('tasks.create')
    expect(tools[1]).toMatch(/tasks\.create51$/) // 5 calls, 1 failed
    expect(tools[2]).toMatch(/email\.search20$/)
    const models = within(screen.getByRole('table', { name: 'Tokens by model' })).getAllByRole('row').map((r) => r.textContent)
    expect(models[1]).toBe('model-a4,0001,500')
  })
  it('is honest about what is not tracked', () => {
    show(usage())
    expect(screen.getByText(/Cost is not shown because it depends on your AI provider's pricing/)).toBeInTheDocument()
    expect(screen.getByText(/no limit on total storage/)).toBeInTheDocument()
    expect(screen.getByText(/Days are UTC/)).toBeInTheDocument()
  })
  it('an organization with no activity gets an explanation, not empty charts', () => {
    show(usage({ totals: { input_tokens: 0, output_tokens: 0, tool_calls: 0 }, workflow_runs: {}, daily: [], by_model: [], tools: [], today: { tokens: 0, limit: 500_000, percent: 0, remaining: 500_000, resets_at: '2026-10-22T00:00:00Z' } }))
    expect(screen.getByText('No assistant activity in this period')).toBeInTheDocument()
    expect(screen.queryByText('Tokens per day')).not.toBeInTheDocument()
  })
  it('the range selector re-queries with the chosen window', async () => {
    show(usage())
    expect(useUsage).toHaveBeenLastCalledWith('org-1', 30, true)
    await userEvent.selectOptions(screen.getByLabelText('Time range'), '90')
    expect(useUsage).toHaveBeenLastCalledWith('org-1', 90, true)
  })
})

describe('access and failure', () => {
  it('non-admins see an explanation and never trigger the request', () => {
    org.isAdmin = false
    show(null)
    expect(screen.getByText('Owners and admins only')).toBeInTheDocument()
    expect(useUsage).toHaveBeenLastCalledWith('org-1', 30, false) // the query is disabled
    expect(screen.queryByLabelText('Time range')).not.toBeInTheDocument()
  })
  it('shows loading and server errors rather than stale or zero numbers', () => {
    const { unmount } = show(null, { isLoading: true })
    expect(screen.getByRole('status')).toHaveTextContent(/Loading usage/)
    unmount()
    show(null, { isError: true, error: new Error('Only owners and admins can see usage') })
    expect(screen.getByText("Couldn't load usage")).toBeInTheDocument()
    expect(screen.getByText('Only owners and admins can see usage')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

describe('daily chart', () => {
  const data = [day('2026-10-19', 1000, 300), day('2026-10-20'), day('2026-10-21', 4000, 1500)]
  it('has a text alternative and a table with the same figures', () => {
    render(<DailyTokensChart daily={data} />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringMatching(/6,800 in total, peak 5,500 in a day/))
    const table = screen.getByRole('table', { name: 'Tokens per day (UTC)' })
    expect(within(table).getAllByRole('row')).toHaveLength(4) // header + 3 days
    expect(within(table).getByRole('row', { name: /2026-10-21/ })).toHaveTextContent('40001500')
  })
  it('draws a bar only where there is usage, sized relative to the peak', () => {
    const { container } = render(<DailyTokensChart daily={data} />)
    const rects = container.querySelectorAll('svg rect')
    expect(rects).toHaveLength(4) // day 1: in+out, day 2: none, day 3: in+out
    const heights = Array.from(rects).map((r) => Number(r.getAttribute('height')))
    expect(Math.max(...heights)).toBeLessThanOrEqual(170)
    expect(heights.every((h) => h > 0)).toBe(true)
  })
  it('copes with a window that has no usage at all (no NaN, no bars)', () => {
    const { container } = render(<DailyTokensChart daily={[day('2026-10-20'), day('2026-10-21')]} />)
    expect(container.querySelectorAll('svg rect')).toHaveLength(0)
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
  })
})
