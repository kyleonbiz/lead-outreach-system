import { unzipSync, strFromU8 } from 'fflate'
import { getDocumentProxy, extractText as pdfExtractText } from 'unpdf'
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

// ------------------------------------------------------------------------------------------- PDF
// PDFs are untrusted input. We use pdf.js (via unpdf, which runs in Deno / edge runtimes without a worker or a canvas): the
// bundled build contains no dynamic code evaluation (no eval / new Function; a test asserts this), we load no fonts, run no
// scripts, cap pages and time, and only ever read the text layer:
// a PDF that is just pictures of text (a scan) has no text to read, and we say so instead of returning an empty or invented result.

export const MAX_PDF_PAGES = 300
const PDF_TIMEOUT_MS = 25_000
/** Average readable characters per page below which a PDF is treated as scanned images. */
const MIN_CHARS_PER_PAGE = 25
/** A page with fewer readable characters than this is counted as "no text" (page numbers, stray marks). */
const EMPTY_PAGE_CHARS = 5

const SCANNED =
  'This PDF looks like scanned images: it has no readable text layer. Text recognition (OCR) is not supported yet. ' +
  'Upload a text-based PDF, a .docx, or a text file instead.'

const looksLikePdf = (b: Uint8Array): boolean => {
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 1024)))
  return head.includes('%PDF-')
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  if (!looksLikePdf(bytes)) throw new UnsupportedDocumentError('This file is not a valid PDF')
  // pdf.js takes ownership of the buffer it is given, so hand it a copy
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await withTimeout(getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, disableFontFace: true, verbosity: 0 }), PDF_TIMEOUT_MS)
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'PasswordException') throw new UnsupportedDocumentError('This PDF is password-protected. Remove the password and upload it again.')
    if ((e as Error)?.message === 'timeout') throw new UnsupportedDocumentError('This PDF took too long to read. Try a smaller or simpler file.')
    throw new UnsupportedDocumentError('This PDF is damaged or in a format that cannot be read.')
  }
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new UnsupportedDocumentError(`This PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}. Split it and upload the parts.`)
    }
    let pages: string[]
    try {
      pages = (await withTimeout(pdfExtractText(pdf, { mergePages: false }), PDF_TIMEOUT_MS)).text as unknown as string[]
    } catch (e) {
      if ((e as Error)?.message === 'timeout') throw new UnsupportedDocumentError('This PDF took too long to read. Try a smaller or simpler file.')
      throw new UnsupportedDocumentError('This PDF is damaged or in a format that cannot be read.')
    }
    const readable = pages.map((t) => t.replace(/\s+/g, '').length)
    const total = readable.reduce((a, b) => a + b, 0)
    if (total < MIN_CHARS_PER_PAGE * pages.length) throw new UnsupportedDocumentError(SCANNED)

    const empty = readable.filter((n) => n < EMPTY_PAGE_CHARS).length
    let text = pages.map((t) => t.trim()).filter(Boolean).join('\n\n')
    // never silently drop content: say which part could not be read
    if (empty > 0) {
      text += `\n\n[Note: ${empty} of ${pages.length} page${pages.length === 1 ? '' : 's'} had no readable text (scanned images) and ${empty === 1 ? 'is' : 'are'} not included.]`
    }
    return text
  } finally {
    await pdf.loadingTask.destroy().catch(() => {}) // releases the parser's memory
  }
}

export async function extractText(bytes: Uint8Array, mime: string | null, name: string): Promise<string> {
  if (bytes.length > MAX_BYTES) throw new UnsupportedDocumentError('File is larger than 25 MB')
  let text: string
  if (mime === DOCX_MIME || /\.docx$/i.test(name)) text = docxToText(bytes)
  else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) text = await pdfToText(bytes)
  else if (TEXT_TYPES.test(mime ?? '') || TEXT_EXT.test(name)) {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    text = /html?$/i.test(name) || mime === 'text/html' ? stripHtml(raw) : raw
  } else throw new UnsupportedDocumentError(`Unsupported file type${mime ? ` (${mime})` : ''}. Supported: .txt .md .csv .json .html .docx .pdf`)
  text = text.replace(/\u0000/g, '').trim()
  if (!text) throw new UnsupportedDocumentError('No readable text was found in this file')
  return text.slice(0, MAX_TEXT)
}
