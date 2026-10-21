import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import { callFunction } from '@/features/assistant/api'
import { markdownToDocx } from '@core/docs/docx'

export interface DocRow {
  id: string; name: string; storage_path: string; mime_type: string | null; size_bytes: number | null; category: string | null
  summary: string | null; status: 'uploaded' | 'processing' | 'ready' | 'failed'; error: string | null; source: 'upload' | 'generated'
  extracted: { dates?: Array<{ date: string; description: string }>; obligations?: Array<{ party: string; obligation: string }>; action_items?: string[] }
  created_at: string
}
export interface KbRow { id: string; kind: string; title: string; content: string; is_active: boolean }
export interface SearchHit { source: 'knowledge' | 'document'; id: string; title: string; snippet: string; rank: number }

export const MAX_UPLOAD = 25 * 1024 * 1024
export const safeName = (n: string) => n.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'

export function useDocuments(orgId: string) {
  return useQuery({
    queryKey: ['documents', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('documents')
        .select('id, name, storage_path, mime_type, size_bytes, category, summary, status, error, source, extracted, created_at')
        .eq('org_id', orgId).order('created_at', { ascending: false }).limit(200)
      if (error) throw error
      return (data ?? []) as DocRow[]
    },
    // poll while anything is still being processed
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'uploaded' || d.status === 'processing') ? 3000 : false),
  })
}

export function useUpload(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_UPLOAD) throw new Error('Files must be 25 MB or smaller')
      if (file.size === 0) throw new Error('That file is empty')
      const id = crypto.randomUUID()
      const path = `${orgId}/${id}/${safeName(file.name)}`
      const up = await db().storage.from('documents').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
      if (up.error) throw new Error(`Upload failed: ${up.error.message}`)
      const ins = await db().from('documents').insert({ id, org_id: orgId, name: file.name.slice(0, 300), storage_path: path, mime_type: file.type || null, size_bytes: file.size })
      if (ins.error) {
        await db().storage.from('documents').remove([path]) // don't leave an orphan file behind
        throw new Error(`Could not save the document: ${ins.error.message}`)
      }
      await qc.invalidateQueries({ queryKey: ['documents'] })
      // processing runs server-side; its outcome (ready/failed + reason) is shown on the row
      callFunction('document-process', { document_id: id }).catch(() => {}).finally(() => qc.invalidateQueries({ queryKey: ['documents'] }))
    },
  })
}

export function useDeleteDocument(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (d: DocRow) => {
      const del = await db().from('documents').delete().eq('id', d.id).eq('org_id', orgId)
      if (del.error) throw new Error(del.error.message)
      await db().storage.from('documents').remove([d.storage_path]) // best effort; the row is already gone
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

export function useSearch(orgId: string, query: string) {
  return useQuery({
    queryKey: ['doc-search', orgId, query], enabled: query.trim().length >= 2,
    queryFn: async () => {
      const { data, error } = await db().rpc('search_knowledge', { p_org: orgId, p_query: query.trim(), p_limit: 10 })
      if (error) throw error
      return (data ?? []) as SearchHit[]
    },
  })
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadDocument(d: DocRow) {
  const { data, error } = await db().storage.from('documents').download(d.storage_path)
  if (error || !data) throw new Error(error?.message ?? 'File not found')
  saveBlob(data, d.name)
}

/** Generated Markdown documents can be exported as Word, built in the browser from the stored Markdown. */
export async function exportDocx(d: DocRow) {
  const { data, error } = await db().storage.from('documents').download(d.storage_path)
  if (error || !data) throw new Error(error?.message ?? 'File not found')
  const bytes = markdownToDocx(await data.text())
  saveBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), d.name.replace(/\.md$/i, '') + '.docx')
}

export function useKnowledge(orgId: string) {
  return useQuery({
    queryKey: ['knowledge', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('knowledge_base_sources').select('id, kind, title, content, is_active').eq('org_id', orgId).order('kind').order('title')
      if (error) throw error
      return (data ?? []) as KbRow[]
    },
  })
}

export function useSaveKnowledge(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; kind: string; title: string; content: string }) => {
      const r = v.id
        ? await db().from('knowledge_base_sources').update({ kind: v.kind, title: v.title, content: v.content }).eq('id', v.id)
        : await db().from('knowledge_base_sources').insert({ org_id: orgId, kind: v.kind, title: v.title, content: v.content })
      if (r.error) throw new Error(r.error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge'] }),
  })
}

export function useDeleteKnowledge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => { const r = await db().from('knowledge_base_sources').delete().eq('id', id); if (r.error) throw new Error(r.error.message) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge'] }),
  })
}
