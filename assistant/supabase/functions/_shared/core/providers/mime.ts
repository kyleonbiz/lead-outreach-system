import { b64url } from '../crypto.ts'
import type { OutgoingEmail } from '../ports.ts'

/** Header values must never contain CR/LF: that is how header-injection (extra Bcc, spoofed headers) happens. */
export function safeHeader(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('Invalid header value (line breaks are not allowed)')
  return v
}

const ADDR = /^[^\s<>,;"()]+@[^\s<>,;"()]+\.[^\s<>,;"()]+$/
export function safeAddress(a: string): string {
  const v = safeHeader(a.trim())
  if (!ADDR.test(v)) throw new Error(`Invalid email address: ${v.slice(0, 80)}`)
  return v
}

/** RFC 2047 encoded-word for non-ASCII subjects. */
export function encodeSubject(s: string): string {
  safeHeader(s)
  // deno-lint-ignore no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s
  const bytes = new TextEncoder().encode(s)
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`
}

export function buildRfc822(m: OutgoingEmail & { from: string; inReplyTo?: string; references?: string }): string {
  const lines = [
    `From: ${safeAddress(m.from)}`,
    `To: ${m.to.map(safeAddress).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(safeAddress).join(', ')}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.map(safeAddress).join(', ')}`] : []),
    `Subject: ${encodeSubject(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${safeHeader(m.inReplyTo)}`, `References: ${safeHeader(m.references ?? m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    // body as base64 in 76-col lines: no body content can ever be interpreted as a header
    (btoa(String.fromCharCode(...new TextEncoder().encode(m.body))).match(/.{1,76}/g) ?? []).join('\r\n'),
  ]
  return lines.join('\r\n')
}

export const toRaw = (rfc822: string): string => b64url(new TextEncoder().encode(rfc822))
