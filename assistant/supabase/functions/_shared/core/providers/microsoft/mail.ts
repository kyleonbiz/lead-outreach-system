import type { EmailMessageSummary, EmailProvider, EmailThread, OutgoingEmail } from '../../ports.ts'
import { ProviderError } from '../../types.ts'
import { stripHtml } from '../google/gmail.ts'
import { assertGraphId, graph, type GraphHttp } from './http.ts'

const MAX_BODY = 8000
const SELECT = 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,categories'
const WELL_KNOWN = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', trash: 'deleteditems' } as const
type Folder = (typeof WELL_KNOWN)[keyof typeof WELL_KNOWN]

// --------------------------------------------------------------------------------------------- query translation
// The assistant and the Email page speak one small search language (the common subset of Gmail's and Outlook's):
//   from:  to:  subject:  is:unread|read  in:inbox|sent|drafts|trash|anywhere  newer_than:Nd|Nm|Ny  older_than:  after:YYYY/MM/DD  before:
//   plain words and "quoted phrases"
// Anything else is refused with an explanation, never silently ignored (that would return wrong results).

export interface MailQuery {
  folder?: Folder
  unread?: boolean
  since?: Date
  until?: Date
  from: string[]; to: string[]; subject: string[]; text: string[]
}

const SUPPORTED = 'from:, to:, subject:, is:unread, is:read, in:inbox|sent|drafts|trash|anywhere, newer_than:, older_than:, after:, before:, plain words and "quoted phrases"'
const unsupported = (what: string) =>
  new ProviderError(`Outlook search does not support ${what}. Supported: ${SUPPORTED}.`, 'bad_request')
const DAY = 86_400_000

function relative(value: string, now: Date, what: string): Date {
  const m = /^(\d{1,4})([dmy])$/i.exec(value)
  if (!m) throw new ProviderError(`${what}: expected a number followed by d, m or y (for example 7d)`, 'bad_request')
  const days = Number(m[1]) * { d: 1, m: 30, y: 365 }[m[2].toLowerCase() as 'd' | 'm' | 'y']
  return new Date(now.getTime() - days * DAY)
}

function absolute(value: string, what: string): Date {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value)
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
  if (!d || Number.isNaN(d.getTime())) throw new ProviderError(`${what}: expected a date like 2026/10/21`, 'bad_request')
  return d
}

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

export function parseMailQuery(q: string, now: Date = new Date()): MailQuery {
  const out: MailQuery = { from: [], to: [], subject: [], text: [] }
  if (/[(){}]/.test(q)) throw unsupported('grouping with parentheses or braces')
  const re = /(-)?(?:([A-Za-z_]+):)?(?:"([^"]*)"|(\S+))/g
  for (let m = re.exec(q); m; m = re.exec(q)) {
    const [, neg, op, quoted, bare] = m
    const value = (quoted ?? bare ?? '').trim()
    if (neg) throw unsupported('excluding terms with "-"')
    if (!op) {
      if (/^[A-Za-z_]+:$/.test(value)) throw new ProviderError(`"${value}" needs a value`, 'bad_request') // an operator with nothing after it
      if (/^(OR|NOT)$/.test(value)) throw unsupported(`"${value}"`)
      if (value === 'AND') continue // implicit in both languages
      if (value) out.text.push(clean(value))
      continue
    }
    const key = op.toLowerCase()
    if (!value) throw new ProviderError(`"${key}:" needs a value`, 'bad_request')
    switch (key) {
      case 'from': out.from.push(clean(value)); break
      case 'to': out.to.push(clean(value)); break
      case 'subject': out.subject.push(clean(value)); break
      case 'is': {
        const v = value.toLowerCase()
        if (v !== 'unread' && v !== 'read') throw unsupported(`"is:${value}"`)
        out.unread = v === 'unread'
        break
      }
      case 'in': {
        const v = value.toLowerCase()
        if (v === 'anywhere') out.folder = undefined
        else if (v in WELL_KNOWN) out.folder = WELL_KNOWN[v as keyof typeof WELL_KNOWN]
        else throw unsupported(`"in:${value}"`)
        break
      }
      case 'newer_than': out.since = relative(value, now, 'newer_than'); break
      case 'older_than': out.until = relative(value, now, 'older_than'); break
      case 'after': out.since = absolute(value, 'after'); break
      case 'before': out.until = absolute(value, 'before'); break
      default: throw unsupported(`"${key}:"`)
    }
  }
  const empty = !out.from.length && !out.to.length && !out.subject.length && !out.text.length
  if (empty && out.unread === undefined && !out.folder && !out.since && !out.until) throw new ProviderError('The search is empty', 'bad_request')
  return out
}

export interface MailRequest { path: string; params: Record<string, string>; clientFilter?: (m: GMsg) => boolean; fetchCount: number }

/** Graph cannot combine $search with $filter/$orderby, so text searches filter by read-state/date after fetching. */
export function planMailRequest(q: MailQuery, limit: number): MailRequest {
  const path = q.folder ? `/me/mailFolders/${q.folder}/messages` : '/me/messages'
  const textual = q.from.length + q.to.length + q.subject.length + q.text.length > 0
  if (textual) {
    const kql = [
      ...q.from.map((v) => `from:"${v}"`), ...q.to.map((v) => `to:"${v}"`),
      ...q.subject.map((v) => `subject:"${v}"`), ...q.text.map((v) => `"${v}"`),
    ].join(' AND ')
    const needsClient = q.unread !== undefined || !!q.since || !!q.until
    const fetchCount = needsClient ? Math.min(100, limit * 4) : limit
    return {
      path, fetchCount,
      params: { $search: `"${kql.replace(/"/g, '\\"')}"`, $top: String(fetchCount), $select: SELECT },
      clientFilter: needsClient ? (m) => {
        const t = Date.parse(m.receivedDateTime ?? '')
        return (q.unread === undefined || (m.isRead === false) === q.unread)
          && (!q.since || t >= q.since.getTime()) && (!q.until || t < q.until.getTime())
      } : undefined,
    }
  }
  // $orderby properties must appear first in $filter, otherwise Graph rejects the query as too complex
  const filter = [`receivedDateTime ge ${(q.since ?? new Date(0)).toISOString().replace(/\.\d{3}Z$/, 'Z')}`]
  if (q.until) filter.push(`receivedDateTime lt ${q.until.toISOString().replace(/\.\d{3}Z$/, 'Z')}`)
  if (q.unread !== undefined) filter.push(`isRead eq ${q.unread ? 'false' : 'true'}`)
  return { path, fetchCount: limit, params: { $filter: filter.join(' and '), $orderby: 'receivedDateTime desc', $top: String(limit), $select: SELECT } }
}

// --------------------------------------------------------------------------------------------------- provider
interface GAddress { emailAddress?: { name?: string; address?: string } }
interface GMsg {
  id: string; conversationId?: string; subject?: string; from?: GAddress; toRecipients?: GAddress[]; ccRecipients?: GAddress[]
  receivedDateTime?: string; bodyPreview?: string; isRead?: boolean; categories?: string[]; body?: { contentType?: string; content?: string }
}

const asAddress = (a?: GAddress): string => {
  const addr = a?.emailAddress?.address ?? ''
  const name = (a?.emailAddress?.name ?? '').replace(/["\r\n<>]/g, '').trim()
  return name && addr ? `${name} <${addr}>` : addr
}
const addrs = (l?: GAddress[]) => (l ?? []).map(asAddress).filter(Boolean)

const EMAIL_RE = /^[^\s@,;<>()"]{1,64}@[^\s@,;<>()"]{1,255}$/
const recipients = (l: string[] | undefined) => (l ?? []).map((address) => {
  if (!EMAIL_RE.test(address)) throw new ProviderError(`"${address.slice(0, 60)}" is not a valid email address`, 'bad_request')
  return { emailAddress: { address } }
})

const textOf = (b: GMsg['body']): string => {
  const c = b?.content ?? ''
  return (b?.contentType?.toLowerCase() === 'html' ? stripHtml(c) : c).trim().slice(0, MAX_BODY)
}

export class OutlookMailProvider implements EmailProvider {
  readonly provider = 'microsoft_mail'
  constructor(private http: GraphHttp, private email: string, private now: () => Date = () => new Date()) {}

  accountEmail() { return this.email }

  async search(query: string, limit: number): Promise<EmailMessageSummary[]> {
    const plan = planMailRequest(parseMailQuery(query, this.now()), limit)
    const r = await graph<{ value?: GMsg[] }>(this.http, `${plan.path}?${new URLSearchParams(plan.params)}`)
    const rows = (r.value ?? []).filter(plan.clientFilter ?? (() => true)).slice(0, limit)
    return rows.map((m) => ({
      id: m.id, threadId: m.conversationId ?? m.id, from: asAddress(m.from), to: addrs(m.toRecipients), subject: m.subject || '(no subject)',
      snippet: m.bodyPreview ?? '', date: m.receivedDateTime ?? '', unread: m.isRead === false,
      labels: [...(m.isRead === false ? ['UNREAD'] : []), ...(m.categories ?? [])],
    }))
  }

  private async conversation(threadId: string, select: string): Promise<GMsg[]> {
    assertGraphId(threadId, 'thread id')
    const q = new URLSearchParams({ $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`, $select: select, $top: '50' })
    const r = await graph<{ value?: GMsg[] }>(this.http, `/me/messages?${q}`, { prefer: 'outlook.body-content-type="text"' })
    return (r.value ?? []).sort((a, b) => Date.parse(a.receivedDateTime ?? '') - Date.parse(b.receivedDateTime ?? ''))
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const msgs = await this.conversation(threadId, 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body')
    return {
      id: threadId,
      messages: msgs.slice(-10).map((m) => ({
        id: m.id, from: asAddress(m.from), to: addrs(m.toRecipients), cc: addrs(m.ccRecipients),
        subject: m.subject ?? '', date: m.receivedDateTime ?? '', body: textOf(m.body),
      })),
    }
  }

  /** Creates the draft (a new message, or a reply in the existing conversation) and returns its id. Nothing is sent. */
  private async draft(m: OutgoingEmail): Promise<string> {
    const message = {
      subject: m.subject, body: { contentType: 'Text', content: m.body },
      toRecipients: recipients(m.to), ccRecipients: recipients(m.cc), bccRecipients: recipients(m.bcc),
    }
    if (!m.inReplyToThreadId) return (await graph<{ id: string }>(this.http, '/me/messages', { method: 'POST', body: JSON.stringify(message) })).id

    const last = (await this.conversation(m.inReplyToThreadId, 'id,receivedDateTime')).at(-1)
    if (!last) throw new ProviderError('That email thread was not found', 'bad_request')
    const reply = await graph<{ id: string }>(this.http, `/me/messages/${encodeURIComponent(last.id)}/createReply`, { method: 'POST', body: JSON.stringify({}) })
    try {
      await graph(this.http, `/me/messages/${encodeURIComponent(reply.id)}`, { method: 'PATCH', body: JSON.stringify(message) })
    } catch (e) {
      await graph(this.http, `/me/messages/${encodeURIComponent(reply.id)}`, { method: 'DELETE' }).catch(() => {}) // do not leave a half-made draft
      throw e
    }
    return reply.id
  }

  async createDraft(m: OutgoingEmail) { return { draftId: await this.draft(m) } }

  /** Draft first, then send it, so there is a message id to return. If sending fails the draft stays in Drafts. */
  async send(m: OutgoingEmail) {
    const id = await this.draft(m)
    await graph(this.http, `/me/messages/${encodeURIComponent(id)}/send`, { method: 'POST' })
    return { messageId: id }
  }
}
