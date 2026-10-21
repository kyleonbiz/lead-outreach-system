import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentsPage from '@/pages/DocumentsPage'
import { safeName, MAX_UPLOAD } from './api'

const org = { orgId: 'o', isAdmin: true }
vi.mock('@/features/org/OrgProvider', () => ({ useOrg: () => org }))

const { state, idle } = vi.hoisted(() => ({
  state: { docs: [], kb: [], search: { data: undefined, isLoading: false, isError: false } } as any,
  idle: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false, reset: () => {}, error: null }),
}))
vi.mock('@/features/documents/api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  useDocuments: () => ({ data: state.docs, isLoading: false, isError: false }),
  useKnowledge: () => ({ data: state.kb, isLoading: false, isError: false }),
  useSearch: () => state.search,
  useUpload: idle, useDeleteDocument: idle, useSaveKnowledge: idle, useDeleteKnowledge: idle,
}))

const doc = (o: any) => ({ id: '1', name: 'a.txt', storage_path: 'p', mime_type: 'text/plain', size_bytes: 2048, category: null, summary: null,
  status: 'ready', error: null, source: 'upload', extracted: {}, created_at: '2026-10-21T00:00:00Z', ...o })

beforeEach(() => { org.isAdmin = true; state.docs = []; state.kb = []; state.search = { data: undefined, isLoading: false, isError: false } })

describe('Documents page', () => {
  it('shows processing state, summary, extracted dates and — for failures — the actual reason', () => {
    state.docs = [
      doc({ id: '1', name: 'contract.docx', summary: 'A services contract.', extracted: { dates: [{ date: 'Dec 15, 2026', description: 'report due' }], action_items: ['Calendar it'] } }),
      doc({ id: '2', name: 'scan.pdf', status: 'failed', error: 'PDF text extraction is not supported yet.' }),
      doc({ id: '3', name: 'new.txt', status: 'processing' }),
      doc({ id: '4', name: 'Late fee letter.md', source: 'generated' }),
    ]
    render(<DocumentsPage />)
    expect(screen.getByText('A services contract.')).toBeInTheDocument()
    expect(screen.getByText(/Dec 15, 2026 \(report due\)/)).toBeInTheDocument()
    expect(screen.getByText('PDF text extraction is not supported yet.')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Processing')).toBeInTheDocument()
    expect(screen.getByText('Created by assistant')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Word' })).toBeInTheDocument() // export only for generated docs
  })
  it('renders search highlights safely: only <b> becomes a highlight, markup in content is never injected', async () => {
    state.docs = [doc({})]
    state.search = { isLoading: false, isError: false, data: [{ source: 'document', id: 'x', title: 'Agreement', rank: 1, snippet: 'late <b>payment</b> fee <img src=x onerror=alert(1)> due' }] }
    const { container } = render(<DocumentsPage />)
    await userEvent.type(screen.getByLabelText(/Search documents/), 'payment{enter}')
    const res = await screen.findByLabelText('Search results')
    expect(within(res).getByText('payment').tagName).toBe('MARK')
    expect(container.querySelector('img')).toBeNull()
    expect(res.textContent).toContain('late payment fee')
  })
  it('explains supported formats (and the PDF limitation) when empty', () => {
    render(<DocumentsPage />)
    expect(screen.getByText(/PDF text extraction is not available yet/)).toBeInTheDocument()
  })
  it('hides delete for non-admins; knowledge base is read-only for them', async () => {
    org.isAdmin = false
    state.docs = [doc({})]; state.kb = [{ id: 'k', kind: 'policy', title: 'Refunds', content: '30 days', is_active: true }]
    render(<DocumentsPage />)
    expect(screen.queryByRole('button', { name: /Delete a\.txt/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Knowledge base' }))
    expect(screen.getByText('Refunds')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument()
    expect(screen.getByText(/Only admins can edit/)).toBeInTheDocument()
  })
})

describe('upload helpers', () => {
  it('sanitizes file names for storage paths and defines the 25 MB limit', () => {
    expect(safeName('../../etc/pass wd?.txt')).not.toMatch(/[?/]/)
    expect(safeName('')).toBe('file')
    expect(MAX_UPLOAD).toBe(25 * 1024 * 1024)
  })
})
