/** Splits text into overlapping, paragraph-aware chunks for full-text search. */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? 1200
  const overlap = Math.min(opts.overlap ?? 150, Math.floor(size / 3))
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]

  // pieces are capped so that overlap + separator + piece never exceeds `size`
  const piece = size - overlap - 2
  const paras = clean.split(/\n\n/).flatMap((p) => (p.length <= piece ? [p] : p.match(new RegExp(`[\\s\\S]{1,${piece}}(?=\\s|$)|[\\s\\S]+`, 'g')) ?? [p]))
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur)
      cur = overlap ? `${cur.slice(-overlap).replace(/^\S*\s/, '')}\n\n${p}` : p
    } else cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur.trim()) chunks.push(cur)
  return chunks.map((c) => c.slice(0, 8000))
}
