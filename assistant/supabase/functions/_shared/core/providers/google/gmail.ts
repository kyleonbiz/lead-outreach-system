import type { EmailMessageSummary, EmailProvider, EmailThread, OutgoingEmail } from '../../ports.ts'
import { unb64url } from '../../crypto.ts'
import { buildRfc822, toRaw } from '../mime.ts'
import { gjson, type GoogleHttp } from './http.ts'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_BODY = 8000

interface GHeader { name: string; value: string }
interface GPart { mimeType?: string; body?: { data?: string }; parts?: GPart[]; headers?: GHeader[] }
interface GMessage { id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: GPart & { headers?: GHeader[] } }

const header = (m: GMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
const addrList = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
}

/** Prefers text/plain, falls back to stripped text/html. */
export function extractBody(p: GPart | undefined): string {
  if (!p) return ''
  const find = (part: GPart, type: string): string | null => {
    if (part.mimeType === type && part.body?.data) return new TextDecoder().decode(unb64url(part.body.data))
    for (const c of part.parts ?? []) { const r = find(c, type); if (r) return r }
    return null
  }
  const plain = find(p, 'text/plain')
  if (plain) return plain.trim().slice(0, MAX_BODY)
  const html = find(p, 'text/html')
  return html ? stripHtml(html).slice(0, MAX_BODY) : ''
}

export class GmailProvider implements EmailProvider {
  readonly provider = 'google_gmail'
  constructor(private http: GoogleHttp, private email: string) {}

  accountEmail() { return this.email }

  async search(query: string, limit: number): Promise<EmailMessageSummary[]> {
    const list = await gjson<{ messages?: Array<{ id: string }> }>(this.http, `${API}/messages?${new URLSearchParams({ q: query, maxResults: String(limit) })}`)
    const ids = (list.messages ?? []).map((m) => m.id)
    const metas = await Promise.all(ids.map((id) => gjson<GMessage>(this.http,
      `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)))
    return metas.map((m) => ({
      id: m.id, threadId: m.threadId, from: header(m, 'From'), to: addrList(header(m, 'To')), subject: header(m, 'Subject') || '(no subject)',
      snippet: m.snippet ?? '', date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'Date'),
      unread: (m.labelIds ?? []).includes('UNREAD'), labels: m.labelIds ?? [],
    }))
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const t = await gjson<{ id: string; messages?: GMessage[] }>(this.http, `${API}/threads/${encodeURIComponent(threadId)}?format=full`)
    return {
      id: t.id,
      messages: (t.messages ?? []).slice(-10).map((m) => ({
        id: m.id, from: header(m, 'From'), to: addrList(header(m, 'To')), cc: addrList(header(m, 'Cc')),
        subject: header(m, 'Subject'), date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'Date'),
        body: extractBody(m.payload),
      })),
    }
  }

  private async raw(m: OutgoingEmail): Promise<{ raw: string; threadId?: string }> {
    let inReplyTo: string | undefined
    if (m.inReplyToThreadId) {
      const t = await gjson<{ messages?: GMessage[] }>(this.http,
        `${API}/threads/${encodeURIComponent(m.inReplyToThreadId)}?format=metadata&metadataHeaders=Message-ID`)
      inReplyTo = header(t.messages?.at(-1) ?? ({} as GMessage), 'Message-ID') || undefined
    }
    return { raw: toRaw(buildRfc822({ ...m, from: this.email, inReplyTo })), threadId: m.inReplyToThreadId }
  }

  async createDraft(m: OutgoingEmail) {
    const { raw, threadId } = await this.raw(m)
    const d = await gjson<{ id: string }>(this.http, `${API}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw, threadId } }) })
    return { draftId: d.id }
  }

  async send(m: OutgoingEmail) {
    const { raw, threadId } = await this.raw(m)
    const r = await gjson<{ id: string }>(this.http, `${API}/messages/send`, { method: 'POST', body: JSON.stringify({ raw, threadId }) })
    return { messageId: r.id }
  }
}
