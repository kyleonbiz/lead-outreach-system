import { guarded, json, readJson, serviceClient, userClient, verifiedUserId, env } from '../_shared/runtime.ts'
import { handleDocumentProcess } from '../_shared/core/handlers/documentProcess.ts'
import { analyzeDocument } from '../_shared/core/docs/analyze.ts'
import { AnthropicProvider } from '../_shared/core/llm/anthropic.ts'
import { DEFAULT_MODEL } from '../_shared/wiring.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req), svc = serviceClient()
  const userId = await verifiedUserId(client, req)
  const key = env('ANTHROPIC_API_KEY')
  const provider = key ? new AnthropicProvider({ apiKey: key }) : null
  const model = env('ASSISTANT_DEFAULT_MODEL') ?? DEFAULT_MODEL

  return json(await handleDocumentProcess({
    userId,
    async getRole(orgId) {
      const { data } = await client.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', userId!).maybeSingle()
      return (data?.role as 'owner' | 'admin' | 'member' | undefined) ?? null
    },
    async loadDocument(id) {
      const { data } = await client.from('documents').select('id, org_id, name, mime_type, storage_path').eq('id', id).maybeSingle()
      return data
    },
    async download(path) {
      const { data, error } = await svc.storage.from('documents').download(path)
      return error || !data ? null : new Uint8Array(await data.arrayBuffer())
    },
    async markProcessing(id) {
      const { data } = await svc.from('documents').update({ status: 'processing', error: null }).eq('id', id).neq('status', 'processing').select('id')
      return (data?.length ?? 0) === 1
    },
    async saveChunks(orgId, documentId, chunks) {
      await svc.from('document_chunks').delete().eq('document_id', documentId)
      if (chunks.length) {
        const { error } = await svc.from('document_chunks').insert(chunks.map((content, chunk_index) => ({ org_id: orgId, document_id: documentId, chunk_index, content })))
        if (error) throw new Error(`save chunks: ${error.message}`)
      }
    },
    async saveResult(id, r) { await svc.from('documents').update(r).eq('id', id) },
    analyze: provider ? (name, text) => analyzeDocument(provider, model, name, text) : undefined,
  }, await readJson(req)))
}))
