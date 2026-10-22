import type { ReactNode } from 'react'
import { cn } from './utils'

/**
 * Small, safe Markdown renderer for assistant replies.
 *
 * Safety model: the output is built from React elements only (no dangerouslySetInnerHTML), so
 * raw HTML in the text is shown literally, never executed. Links are limited to http(s)/mailto,
 * images are never loaded (their alt text is shown), and the input is length-capped so
 * pathological text cannot stall the page.
 */

/** Longest text we parse; anything longer is shown as plain text. */
export const MAX_MARKDOWN_CHARS = 50_000
const MAX_DEPTH = 4
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Returns a safe absolute URL string, or null when the target must not become a link. */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (!url || url.length > 2048) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null } // relative and malformed URLs are rejected
  // URL() strips tabs/newlines from the scheme, so "java\tscript:" is parsed as javascript: and rejected here
  return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch)

/** Index of the ")" that closes a link target starting at `from`, allowing balanced parentheses; -1 if none nearby. */
function closingParen(src: string, from: number): number {
  let depth = 0
  const limit = Math.min(src.length, from + 2048)
  for (let k = from; k < limit; k++) {
    const c = src[k]
    if (c === '(') depth++
    else if (c === ')') { if (depth === 0) return k; depth-- }
    else if (c === '\n') return -1
  }
  return -1
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let buf = ''
  // once a closing marker is known to be missing from here on, later openers cannot match either (keeps scanning linear)
  const noClose = new Set<string>()
  let cachedMid = -2 // position of the next "](" at or after the last search start (-1 = none left)
  const nextMid = (from: number): number => {
    if (cachedMid === -1) return -1
    if (cachedMid >= from) return cachedMid
    cachedMid = src.indexOf('](', from)
    return cachedMid
  }
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }

  const findClose = (marker: string, from: number): number => {
    if (noClose.has(marker)) return -1
    const at = src.indexOf(marker, from)
    if (at === -1) noClose.add(marker)
    return at
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i]

    if (ch === '`') {
      const end = findClose('`', i + 1)
      if (end > i + 1) { flush(); out.push({ t: 'code', v: src.slice(i + 1, end) }); i = end + 1; continue }
    }

    if (depth < MAX_DEPTH && ch === '*' && src[i + 1] === '*') {
      const end = findClose('**', i + 2)
      if (end > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end), depth + 1) }); i = end + 2; continue }
    }

    if (depth < MAX_DEPTH && (ch === '*' || ch === '_') && src[i + 1] !== ch && src[i + 1] !== ' ' && src[i + 1] !== undefined) {
      // underscores inside words (snake_case) are not emphasis
      const ok = ch === '*' || !isWordChar(src[i - 1])
      const end = ok ? findClose(ch, i + 1) : -1
      if (ok && end > i + 1 && src[end - 1] !== ' ' && (ch === '*' || !isWordChar(src[end + 1]))) {
        flush(); out.push({ t: 'em', c: parseInline(src.slice(i + 1, end), depth + 1) }); i = end + 1; continue
      }
    }

    const isImage = ch === '!' && src[i + 1] === '['
    if (ch === '[' || isImage) {
      const open = isImage ? i + 1 : i
      const mid = nextMid(open + 1)
      const close = mid === -1 ? -1 : closingParen(src, mid + 2)
      if (mid !== -1 && close !== -1) {
        const label = src.slice(open + 1, mid)
        const target = src.slice(mid + 2, close).trim().split(/\s+/)[0] ?? ''
        const href = isImage ? null : safeHref(target)
        flush()
        // images are never fetched: show their alt text. Unsafe links degrade to their plain label.
        const children = depth < MAX_DEPTH ? parseInline(label, depth + 1) : [{ t: 'text', v: label } as Inline]
        if (href) out.push({ t: 'link', href, c: children })
        else out.push(...children)
        i = close + 1
        continue
      }
    }

    buf += ch
    i++
  }
  flush()
  return out
}

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'code'; text: string }
  | { t: 'heading'; text: string }

const UL = /^\s{0,3}[-*+]\s+(.*)$/
const OL = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const FENCE = /^\s{0,3}```/

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  const startsBlock = (l: string) => UL.test(l) || OL.test(l) || HEADING.test(l) || QUOTE.test(l) || FENCE.test(l)

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or end of text)
      blocks.push({ t: 'code', text: body.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) { blocks.push({ t: 'heading', text: h[1] }); i++; continue }

    if (UL.test(line) || OL.test(line)) {
      const re = UL.test(line) ? UL : OL
      const items: string[] = []
      while (i < lines.length && re.test(lines[i])) { items.push(re.exec(lines[i])![1]); i++ }
      blocks.push({ t: re === UL ? 'ul' : 'ol', items })
      continue
    }
    if (QUOTE.test(line)) {
      const q: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) { q.push(QUOTE.exec(lines[i])![1]); i++ }
      blocks.push({ t: 'quote', lines: q })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++])
    blocks.push({ t: 'p', lines: para })
  }
  return blocks
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, idx) => {
    switch (n.t) {
      case 'text': return n.v
      case 'strong': return <strong key={idx} className="font-semibold">{renderInline(n.c)}</strong>
      case 'em': return <em key={idx}>{renderInline(n.c)}</em>
      case 'code': return <code key={idx} className="rounded bg-ink/10 px-1 py-0.5 font-mono text-[0.9em]">{n.v}</code>
      case 'link':
        return (
          <a key={idx} href={n.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-words">
            {renderInline(n.c)}
          </a>
        )
    }
  })
}

function renderLines(lines: string[]): ReactNode[] {
  return lines.flatMap((l, i) => (i === 0 ? renderInline(parseInline(l)) : [<br key={`br${i}`} />, ...renderInline(parseInline(l))]))
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  if (text.length > MAX_MARKDOWN_CHARS) {
    return <div className={cn('whitespace-pre-wrap wrap-break-word', className)}>{text}</div>
  }
  return (
    <div className={cn('space-y-2 wrap-break-word', className)}>
      {parseBlocks(text).map((b, idx) => {
        switch (b.t) {
          case 'p': return <p key={idx}>{renderLines(b.lines)}</p>
          case 'heading': return <p key={idx} className="font-semibold">{renderInline(parseInline(b.text))}</p>
          case 'ul': return <ul key={idx} className="list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{renderInline(parseInline(it))}</li>)}</ul>
          case 'ol': return <ol key={idx} className="list-decimal space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{renderInline(parseInline(it))}</li>)}</ol>
          case 'quote': return <blockquote key={idx} className="border-l-2 border-line pl-3 text-muted">{renderLines(b.lines)}</blockquote>
          case 'code': return <pre key={idx} className="overflow-x-auto rounded bg-ink/10 p-2.5 font-mono text-xs">{b.text}</pre>
        }
      })}
    </div>
  )
}
