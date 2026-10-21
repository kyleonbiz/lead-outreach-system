import { unzipSync, strFromU8 } from 'fflate'
import { stripHtml } from '../providers/google/gmail.ts'

export class UnsupportedDocumentError extends Error {}

export const MAX_BYTES = 25 * 1024 * 1024
const MAX_TEXT = 500_000

const TEXT_TYPES = /^(text\/(plain|markdown|csv|html|x-markdown)|application\/(json|xml))$/
const TEXT_EXT = /\.(txt|md|markdown|csv|json|html?|xml|log)$/i
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Plain text from a .docx (OOXML): paragraphs become lines, tabs/breaks preserved. */
export function docxToText(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' }) } catch { throw new UnsupportedDocumentError('This .docx file is corrupt or not a Word document') }
  const xml = files['word/document.xml']
  if (!xml) throw new UnsupportedDocumentError('This file is not a Word document (no word/document.xml)')
  return unescapeXml(
    strFromU8(xml)
      .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim()
}

export function extractText(bytes: Uint8Array, mime: string | null, name: string): string {
  if (bytes.length > MAX_BYTES) throw new UnsupportedDocumentError('File is larger than 25 MB')
  let text: string
  if (mime === DOCX_MIME || /\.docx$/i.test(name)) text = docxToText(bytes)
  else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
    throw new UnsupportedDocumentError('PDF text extraction is not supported yet. Upload a .docx or text version.')
  } else if (TEXT_TYPES.test(mime ?? '') || TEXT_EXT.test(name)) {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    text = /html?$/i.test(name) || mime === 'text/html' ? stripHtml(raw) : raw
  } else throw new UnsupportedDocumentError(`Unsupported file type${mime ? ` (${mime})` : ''}. Supported: .txt .md .csv .json .html .docx`)
  text = text.replace(/\u0000/g, '').trim()
  if (!text) throw new UnsupportedDocumentError('No readable text was found in this file')
  return text.slice(0, MAX_TEXT)
}
