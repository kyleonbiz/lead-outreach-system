import { z } from 'zod'
import type { ToolDef } from './registry.ts'

export const documentsList: ToolDef = {
  name: 'documents.list',
  description: 'List uploaded and generated documents with their summaries and processing status.',
  risk: 'read', untrusted: true,
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  summarize: () => 'List documents',
  execute: (ctx, i) => ctx.ports.documents.list(i.limit),
}

export const documentsGet: ToolDef = {
  name: 'documents.get',
  description: 'Read a document: its summary, extracted dates/obligations/action items, and the start of its text. Use knowledge.search to find passages across all documents.',
  risk: 'read', untrusted: true,
  input: z.object({ id: z.uuid(), max_chars: z.number().int().min(500).max(20000).default(6000) }),
  summarize: (i) => `Read document ${i.id}`,
  execute: (ctx, i) => ctx.ports.documents.get(i.id, i.max_chars),
}

export const documentsGenerate: ToolDef = {
  name: 'documents.generate',
  description: 'Create a new document (letter, report, form, SOP, summary) from the Markdown you write, and save it to the user\'s documents. Does not send or share it with anyone. Use # headings, "- " bullets and **bold**.',
  risk: 'write',
  input: z.object({
    title: z.string().min(1).max(200),
    markdown: z.string().min(1).max(60_000),
    category: z.string().max(80).optional(),
  }),
  summarize: (i) => `Create document "${i.title}" (${i.markdown.length} characters)`,
  async execute(ctx, i) {
    const d = await ctx.ports.documents.createGenerated(i)
    return { created: true, id: d.id, name: d.name, note: 'Saved to Documents; the user can download it as Markdown or Word.' }
  },
}

export const documentTools = [documentsList, documentsGet, documentsGenerate]
