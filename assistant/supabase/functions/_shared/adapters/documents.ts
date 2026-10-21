import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkText } from '../core/docs/chunk.ts'
import type { DocumentDetail, DocumentPort, DocumentRecord } from '../core/ports.ts'

const COLS = 'id, name, category, summary, status, created_at'

export class SupabaseDocuments implements DocumentPort {
  /** `client` reads (RLS for chat); `svc` writes generated files + chunks (server-owned). */
  constructor(private client: SupabaseClient, private svc: SupabaseClient, private orgId: string, private userId: string | null) {}

  async list(limit: number): Promise<DocumentRecord[]> {
    const { data, error } = await this.client.from('documents').select(COLS).eq('org_id', this.orgId).order('created_at', { ascending: false }).limit(limit)
    if (error) throw new Error(`list documents: ${error.message}`)
    return (data ?? []) as DocumentRecord[]
  }

  async get(id: string, maxChars: number): Promise<DocumentDetail> {
    const { data, error } = await this.client.from('documents').select(`${COLS}, extracted`).eq('id', id).eq('org_id', this.orgId).maybeSingle()
    if (error) throw new Error(`get document: ${error.message}`)
    if (!data) throw new Error(`Document ${id} not found`)
    const chunks = await this.client.from('document_chunks').select('content').eq('document_id', id).eq('org_id', this.orgId).order('chunk_index').limit(40)
    const text = (chunks.data ?? []).map((c) => c.content as string).join('\n\n').slice(0, maxChars)
    return { ...(data as unknown as DocumentRecord), extracted: (data as { extracted?: unknown }).extracted ?? {}, text }
  }

  async createGenerated(input: { title: string; markdown: string; category?: string }): Promise<DocumentRecord> {
    const id = crypto.randomUUID()
    const safe = input.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'document'
    const path = `${this.orgId}/${id}/${safe}.md`
    const bytes = new TextEncoder().encode(input.markdown)
    const up = await this.svc.storage.from('documents').upload(path, bytes, { contentType: 'text/markdown', upsert: false })
    if (up.error) throw new Error(`save file: ${up.error.message}`)

    const { data, error } = await this.svc.from('documents').insert({
      id, org_id: this.orgId, uploaded_by: this.userId, name: `${safe}.md`, storage_path: path, mime_type: 'text/markdown',
      size_bytes: bytes.length, category: input.category ?? null, status: 'ready', source: 'generated', text_chars: input.markdown.length,
    }).select(COLS).single()
    if (error) {
      await this.svc.storage.from('documents').remove([path]) // don't orphan the file
      throw new Error(`save document: ${error.message}`)
    }
    const rows = chunkText(input.markdown).map((content, chunk_index) => ({ org_id: this.orgId, document_id: id, chunk_index, content }))
    if (rows.length) {
      const c = await this.svc.from('document_chunks').insert(rows)
      if (c.error) throw new Error(`index document: ${c.error.message}`)
    }
    return data as DocumentRecord
  }
}
