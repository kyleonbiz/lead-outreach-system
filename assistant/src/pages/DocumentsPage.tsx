import { useRef, useState } from 'react'
import { format } from 'date-fns'
import { Download, FileText, Search, Trash2, Upload } from 'lucide-react'
import { Badge, Button, Dialog, EmptyState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useOrg } from '@/features/org/OrgProvider'
import {
  downloadDocument, exportDocx, useDeleteDocument, useDeleteKnowledge, useDocuments, useKnowledge, useSaveKnowledge, useSearch, useUpload,
  type DocRow, type KbRow,
} from '@/features/documents/api'

const KINDS: Array<[string, string]> = [
  ['company', 'Company description'], ['service', 'Services & products'], ['hours', 'Operating hours'], ['policy', 'Policy'],
  ['faq', 'FAQ'], ['guideline', 'Response guideline'], ['contact', 'Important contact'], ['sop', 'Standard procedure'],
]
const statusTone = { uploaded: 'neutral', processing: 'warn', ready: 'ok', failed: 'danger' } as const
const statusLabel = { uploaded: 'Queued', processing: 'Processing', ready: 'Ready', failed: 'Failed' } as const
const fmtSize = (n: number | null) => (n == null ? '' : n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export default function DocumentsPage() {
  const [tab, setTab] = useState<'files' | 'knowledge'>('files')
  return (
    <>
      <PageHeader title="Documents" description="Upload files, search across them, and keep the business knowledge your assistant should use." />
      <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
        {([['files', 'Files'], ['knowledge', 'Knowledge base']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>
      {tab === 'files' ? <Files /> : <Knowledge />}
    </>
  )
}

function Files() {
  const { orgId, isAdmin } = useOrg()
  const docs = useDocuments(orgId)
  const upload = useUpload(orgId)
  const del = useDeleteDocument(orgId)
  const input = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const search = useSearch(orgId, term)
  const [confirm, setConfirm] = useState<string | null>(null)

  const wrap = (fn: () => Promise<void>) => fn().catch((e: Error) => setErr(e.message))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(q) }} role="search">
          <label htmlFor="doc-search" className="sr-only">Search documents and knowledge</label>
          <Input id="doc-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your documents and knowledge base…" />
          <Button type="submit" aria-label="Search"><Search className="h-4 w-4" /></Button>
        </form>
        <input ref={input} type="file" hidden accept=".txt,.md,.csv,.json,.html,.docx,.pdf" onChange={(e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (f) { setErr(null); upload.mutate(f, { onError: (er) => setErr(er.message) }) }
        }} />
        <Button variant="primary" loading={upload.isPending} onClick={() => input.current?.click()}><Upload className="h-4 w-4" /> Upload</Button>
      </div>
      {err && <Notice tone="danger">{err}</Notice>}

      {term.trim().length >= 2 && (
        <section aria-label="Search results" className="rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold">Results for “{term}”</h2>
          {search.isLoading && <div className="px-4"><Spinner /></div>}
          {search.isError && <div className="p-4"><Notice tone="danger">{(search.error as Error).message}</Notice></div>}
          {search.data?.length === 0 && <p className="px-4 py-4 text-sm text-muted">No matches.</p>}
          <ul className="divide-y divide-line">
            {search.data?.map((h) => (
              <li key={`${h.source}-${h.id}`} className="px-4 py-3">
                <p className="text-sm font-medium">{h.title} <Badge className="ml-1">{h.source === 'knowledge' ? 'Knowledge' : 'Document'}</Badge></p>
                {/* ts_headline wraps matches in <b>; everything else is escaped by React, so render as text with bold segments */}
                <p className="mt-1 text-sm text-muted">{h.snippet.split(/(<b>.*?<\/b>)/g).map((seg, i) =>
                  seg.startsWith('<b>') ? <mark key={i} className="rounded bg-accent-soft px-0.5 text-ink">{seg.slice(3, -4)}</mark> : <span key={i}>{seg.replace(/<[^>]*>/g, '')}</span>)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {docs.isLoading && <Spinner label="Loading documents" />}
      {docs.isError && <Notice tone="danger" title="Couldn't load documents">{(docs.error as Error).message}</Notice>}
      {docs.data?.length === 0 && (
        <EmptyState title="No documents yet" action={<Button onClick={() => input.current?.click()}>Upload a file</Button>}>
          Supported: .txt, .md, .csv, .json, .html and .docx (up to 25 MB). PDF text extraction is not available yet. Ask the assistant to draft letters or reports and they appear here too.
        </EmptyState>
      )}
      {!!docs.data?.length && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {docs.data.map((d) => <DocItem key={d.id} d={d} canDelete={isAdmin} confirming={confirm === d.id}
            onConfirm={() => setConfirm(d.id)} onCancel={() => setConfirm(null)}
            onDelete={() => wrap(async () => { await del.mutateAsync(d); setConfirm(null) })}
            onDownload={() => wrap(() => downloadDocument(d))} onExport={() => wrap(() => exportDocx(d))} />)}
        </ul>
      )}
    </div>
  )
}

function DocItem({ d, canDelete, confirming, onConfirm, onCancel, onDelete, onDownload, onExport }: {
  d: DocRow; canDelete: boolean; confirming: boolean; onConfirm: () => void; onCancel: () => void
  onDelete: () => void; onDownload: () => void; onExport: () => void
}) {
  const x = d.extracted ?? {}
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1 basis-56">
          <p className="break-words text-sm font-medium">{d.name} {d.source === 'generated' && <Badge tone="accent" className="ml-1">Created by assistant</Badge>}</p>
          <p className="text-xs text-muted">{format(new Date(d.created_at), 'MMM d, yyyy')}{d.size_bytes ? ` · ${fmtSize(d.size_bytes)}` : ''}</p>
          {d.summary && <p className="mt-1.5 text-sm">{d.summary}</p>}
          {!!x.dates?.length && <p className="mt-1 text-xs text-muted"><strong className="font-medium text-ink">Key dates:</strong> {x.dates.map((t) => `${t.date} (${t.description})`).join('; ')}</p>}
          {!!x.action_items?.length && <p className="mt-1 text-xs text-muted"><strong className="font-medium text-ink">Action items:</strong> {x.action_items.join('; ')}</p>}
          {d.error && <p className={cn('mt-1 text-xs', d.status === 'failed' ? 'text-danger' : 'text-muted')}>{d.error}</p>}
        </div>
        <div className="ml-7 flex items-center gap-2 sm:ml-0">
          <Badge tone={statusTone[d.status]}>{statusLabel[d.status]}</Badge>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={onDownload} aria-label={`Download ${d.name}`}><Download className="h-4 w-4" /></Button>
            {d.source === 'generated' && <Button variant="ghost" onClick={onExport}>Word</Button>}
            {canDelete && (confirming
              ? <><Button variant="danger" onClick={onDelete}>Delete</Button><Button onClick={onCancel}>Keep</Button></>
              : <Button variant="ghost" onClick={onConfirm} aria-label={`Delete ${d.name}`}><Trash2 className="h-4 w-4" /></Button>)}
          </div>
        </div>
      </div>
    </li>
  )
}

function Knowledge() {
  const { orgId, isAdmin } = useOrg()
  const kb = useKnowledge(orgId)
  const save = useSaveKnowledge(orgId)
  const del = useDeleteKnowledge()
  const [editing, setEditing] = useState<KbRow | 'new' | null>(null)
  const row = editing && editing !== 'new' ? editing : null

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Facts and rules your assistant should follow when answering or drafting for your business.{!isAdmin && ' Only admins can edit.'}</p>
        {isAdmin && <Button variant="primary" onClick={() => setEditing('new')}>Add entry</Button>}
      </div>
      {kb.isLoading && <Spinner />}
      {kb.isError && <Notice tone="danger">{(kb.error as Error).message}</Notice>}
      {kb.data?.length === 0 && <EmptyState title="Nothing here yet">Add your hours, services, policies and standard answers so drafts sound like you.</EmptyState>}
      {!!kb.data?.length && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {kb.data.map((k) => (
            <li key={k.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{k.title} <Badge className="ml-1">{KINDS.find(([v]) => v === k.kind)?.[1] ?? k.kind}</Badge></p>
                <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted">{k.content}</p>
              </div>
              {isAdmin && <div className="flex gap-1"><Button variant="ghost" onClick={() => setEditing(k)}>Edit</Button>
                <Button variant="ghost" aria-label={`Delete ${k.title}`} onClick={() => { if (confirm(`Delete “${k.title}”?`)) del.mutate(k.id) }}><Trash2 className="h-4 w-4" /></Button></div>}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onClose={() => { setEditing(null); save.reset() }} title={row ? 'Edit entry' : 'Add entry'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="kb-form" variant="primary" loading={save.isPending}>Save</Button></>}>
        <form id="kb-form" key={row?.id ?? 'new'} className="space-y-4" onSubmit={(e) => {
          e.preventDefault(); const f = new FormData(e.currentTarget)
          save.mutate({ id: row?.id, kind: String(f.get('kind')), title: String(f.get('title')).trim(), content: String(f.get('content')) }, { onSuccess: () => setEditing(null) })
        }}>
          <Field label="Type">{(id) => <Select id={id} name="kind" defaultValue={row?.kind ?? 'policy'}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
          <Field label="Title">{(id) => <Input id={id} name="title" required maxLength={200} defaultValue={row?.title} />}</Field>
          <Field label="Content">{(id) => <Textarea id={id} name="content" rows={8} maxLength={100000} defaultValue={row?.content} />}</Field>
          {save.error && <Notice tone="danger">{(save.error as Error).message}</Notice>}
        </form>
      </Dialog>
    </>
  )
}
