// Turns a notification into a message for each channel. Notification text can contain untrusted content
// (e.g. a workflow step error quoting an e-mail subject), so everything is neutralised for the target format:
// Slack mrkdwn control characters are escaped (no <!channel>, no forged <links|labels>), Teams markdown links
// and HTML are broken, e-mail is plain text with CR/LF stripped from the subject. Links are internal paths only.

export interface Outgoing {
  type: string
  title: string
  body: string | null
  link: string | null
  orgName: string
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g

/** Removes control/bidi characters, collapses blank-line floods and truncates. */
export function clean(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** Only same-app paths are ever linked ("/tasks", not "//evil.test" or "https://…"). Returns null otherwise. */
export function appLink(link: string | null, appUrl: string): string | null {
  if (!link || !/^\/(?!\/)[A-Za-z0-9\-._~/?=&%#]*$/.test(link)) return null
  let base: URL
  try { base = new URL(appUrl) } catch { return null }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null
  return `${base.origin}${link}`
}

const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const teamsEscape = (s: string) => s.replace(/\[/g, '(').replace(/\]/g, ')').replace(/[<>]/g, '')

export function slackPayload(n: Outgoing, appUrl: string): Record<string, unknown> {
  const title = slackEscape(clean(n.title, 150))
  const body = slackEscape(clean(n.body, 1500))
  const url = appLink(n.link, appUrl)
  const text = `*${title}*${body ? `\n${body}` : ''}`
  return {
    text: `${title} (${slackEscape(clean(n.orgName, 80))})`, // fallback for push notifications; Slack parses this field too, so it is escaped
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${slackEscape(clean(n.orgName, 80))} · ${url ? `<${url}|Open Aide>` : 'Aide'}` }] },
    ],
  }
}

export function teamsPayload(n: Outgoing, appUrl: string): Record<string, unknown> {
  const url = appLink(n.link, appUrl)
  const body: Array<Record<string, unknown>> = [
    { type: 'TextBlock', text: teamsEscape(clean(n.title, 150)), weight: 'Bolder', size: 'Medium', wrap: true },
  ]
  const text = clean(n.body, 1500)
  if (text) body.push({ type: 'TextBlock', text: teamsEscape(text), wrap: true })
  body.push({ type: 'TextBlock', text: teamsEscape(clean(n.orgName, 80)), isSubtle: true, spacing: 'Small', wrap: true })
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body,
        ...(url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open Aide', url }] } : {}),
      },
    }],
  }
}

export function emailMessage(n: Outgoing, appUrl: string): { subject: string; text: string } {
  const url = appLink(n.link, appUrl)
  const settings = appLink('/settings', appUrl)
  const subject = clean(n.title, 120).replace(/\s*\n\s*/g, ' ')
  const lines = [clean(n.title, 150), '', clean(n.body, 3000)]
  if (url) lines.push('', `Open in Aide: ${url}`)
  lines.push('', '—', `Sent by Aide for ${clean(n.orgName, 80)}.`)
  if (settings) lines.push(`Choose which e-mails you get: ${settings}`)
  return { subject: `[Aide] ${subject}`, text: lines.join('\n').replace(/\n{3,}/g, '\n\n') }
}
