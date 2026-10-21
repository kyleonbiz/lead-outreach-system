import { strToU8, zipSync } from 'fflate'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const run = (text: string, o: { bold?: boolean; size?: number } = {}) =>
  `<w:r><w:rPr>${o.bold ? '<w:b/>' : ''}${o.size ? `<w:sz w:val="${o.size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`

const para = (inner: string) => `<w:p>${inner}</w:p>`

/** Inline **bold** support inside a line. */
function inline(line: string, base: { bold?: boolean; size?: number } = {}): string {
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map((seg) => (seg.startsWith('**') && seg.endsWith('**') ? run(seg.slice(2, -2), { ...base, bold: true }) : run(seg, base))).join('')
}

/** Minimal, valid .docx from light Markdown: #/##/### headings, "- " bullets, paragraphs, **bold**. */
export function markdownToDocx(markdown: string): Uint8Array {
  const body = markdown.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) return para(inline(h[2], { bold: true, size: [36, 30, 26][h[1].length - 1] }))
    const b = line.match(/^\s*[-*]\s+(.*)$/)
    if (b) return para(`<w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr>${run('• ')}${inline(b[1])}`)
    return line.trim() ? para(inline(line)) : para('')
  }).join('')

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}
