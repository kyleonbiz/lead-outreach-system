import { z } from 'zod'
import { fail, ok, type HandlerResult, type Role } from './common.ts'
import { chunkText } from '../docs/chunk.ts'
import { extractText, UnsupportedDocumentError } from '../docs/extract.ts'
import type { Analysis } from '../docs/analyze.ts'

export interface DocRow { id: string; org_id: string; name: string; mime_type: string | null; storage_path: string }

export interface DocumentProcessDeps {
  userId: string | null
  getRole(orgId: string): Promise<Role | null>
  /** read with the user's token: documents of other orgs are invisible */
  loadDocument(id: string): Promise<DocRow | null>
  download(path: string): Promise<Uint8Array | null>
  /** atomic: moves the row to 'processing' unless it already is; false = someone else is processing it */
  markProcessing(id: string): Promise<boolean>
  saveChunks(orgId: string, documentId: string, chunks: string[]): Promise<void>
  saveResult(id: string, r: { status: 'ready' | 'failed'; error?: string | null; summary?: string | null; extracted?: unknown; text_chars?: number }): Promise<void>
  /** undefined when no AI provider is configured: processing still succeeds, without a summary */
  analyze?: (name: string, text: string) => Promise<Analysis>
}

export async function handleDocumentProcess(d: DocumentProcessDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = z.object({ document_id: z.uuid() }).safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request')
  const doc = await d.loadDocument(p.data.document_id)
  if (!doc) return fail(404, 'Document not found')
  if (!(await d.getRole(doc.org_id))) return fail(403, 'You are not a member of this organization')
  if (!(await d.markProcessing(doc.id))) return fail(409, 'This document is already being processed')

  try {
    const bytes = await d.download(doc.storage_path)
    if (!bytes) throw new UnsupportedDocumentError('The uploaded file could not be found in storage')
    const text = await extractText(bytes, doc.mime_type, doc.name)
    await d.saveChunks(doc.org_id, doc.id, chunkText(text))

    let analysis: Analysis | null = null
    let note: string | null = null
    if (d.analyze) {
      try { analysis = await d.analyze(doc.name, text) } catch (e) { note = `Summary unavailable: ${e instanceof Error ? e.message : 'analysis failed'}` }
    } else note = 'Summary skipped: the AI assistant is not configured.'

    await d.saveResult(doc.id, {
      status: 'ready', error: note, summary: analysis?.summary ?? null, text_chars: text.length,
      extracted: analysis ? { dates: analysis.dates, obligations: analysis.obligations, action_items: analysis.action_items } : {},
    })
    return ok({ status: 'ready', searchable: true, analyzed: !!analysis, ...(note ? { note } : {}) })
  } catch (e) {
    const message = e instanceof UnsupportedDocumentError ? e.message : 'Processing failed unexpectedly'
    if (!(e instanceof UnsupportedDocumentError)) console.error('document-process', e)
    await d.saveResult(doc.id, { status: 'failed', error: message })
    return ok({ status: 'failed', error: message })
  }
}
