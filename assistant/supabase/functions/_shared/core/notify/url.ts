// Webhook URL validation. A webhook URL is (a) a bearer secret and (b) a place our server will POST to,
// so it must never be able to point at anything but the chat provider it claims to be (SSRF protection).
//
// Defence in depth:
//   1. https only, no credentials, port 443 only
//   2. the hostname must match an exact allow-list for the provider (Slack / Teams)
//   3. IP literals, localhost and single-label hosts are refused outright
//   4. at send time the resolved addresses must be public (assertPublicHost) and redirects are not followed
// Limit: (4) re-resolves DNS separately from fetch(), so it narrows but cannot eliminate DNS-rebinding races.
// The exact-host allow-list in (2) is the primary control.

export type ChannelKind = 'slack' | 'teams'

const LABELS = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTS: Record<ChannelKind, RegExp[]> = {
  slack: [/^hooks\.slack\.com$/, /^hooks\.slack-gov\.com$/],
  teams: [
    new RegExp(`^${LABELS}\\.webhook\\.office\\.com$`),
    /^outlook\.office\.com$/,
    new RegExp(`^(?:${LABELS}\\.)+logic\\.azure\\.com$`),
    new RegExp(`^(?:${LABELS}\\.)+api\\.powerplatform\\.com$`),
  ],
}
const PATH_PREFIX: Record<ChannelKind, string> = { slack: '/services/', teams: '/' }
const MAX_URL = 1000

export type UrlCheck = { ok: true; url: string; host: string; hint: string } | { ok: false; reason: string }

export function validateWebhookUrl(kind: ChannelKind, raw: unknown): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'The webhook URL must be text.' }
  const input = raw.trim()
  if (!input) return { ok: false, reason: 'Paste the webhook URL.' }
  if (input.length > MAX_URL) return { ok: false, reason: 'That URL is too long.' }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(input)) return { ok: false, reason: 'The URL contains characters that are not allowed.' }
  let u: URL
  try { u = new URL(input) } catch { return { ok: false, reason: 'That is not a valid URL.' } }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Webhook URLs must start with https://.' }
  if (u.username || u.password) return { ok: false, reason: 'The URL must not contain a username or password.' }
  if (u.port && u.port !== '443') return { ok: false, reason: 'Only the standard HTTPS port is allowed.' }
  if (u.hash) return { ok: false, reason: 'The URL must not contain a #fragment.' }

  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (isIpLiteral(host) || host === 'localhost' || !host.includes('.')) {
    return { ok: false, reason: 'IP addresses and local hosts are not allowed.' }
  }
  if (!HOSTS[kind].some((re) => re.test(host))) {
    return { ok: false, reason: kind === 'slack'
      ? 'That is not a Slack incoming-webhook URL (it should start with https://hooks.slack.com/services/).'
      : 'That is not a Microsoft Teams webhook URL (expected a *.webhook.office.com, *.logic.azure.com or *.api.powerplatform.com address).' }
  }
  if (!u.pathname.startsWith(PATH_PREFIX[kind]) || u.pathname.length < PATH_PREFIX[kind].length + 4) {
    return { ok: false, reason: 'The URL path does not look like a webhook.' }
  }
  const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
  const url = `https://${host}${u.pathname}${u.search}`
  return { ok: true, url, host, hint: `${host}/…/${last.slice(-4)}` }
}

// ----------------------------------------------------------------------------- IP handling

export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || /^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h)
}

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const p = m.slice(1).map(Number)
  return p.every((n) => n <= 255) ? p : null
}

function parseV6(s: string): number[] | null {
  let h = s.replace(/^\[|\]$/g, '').toLowerCase()
  const zone = h.indexOf('%')
  if (zone >= 0) h = h.slice(0, zone)
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
  if (tail) {
    const v4 = parseV4(tail[1])
    if (!v4) return null
    h = h.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16)
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

function privateV4(p: number[]): boolean {
  const [a, b, c] = p
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
}

/** True for loopback, private, link-local, multicast, reserved, documentation and IPv4-embedding IPv6 ranges. Unparseable = true. */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseV4(ip)
  if (v4) return privateV4(v4)
  const g = parseV6(ip)
  if (!g) return true // anything we cannot parse is treated as unsafe
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  const embedded = (hi: number, lo: number) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255])
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]) // ::ffff:a.b.c.d (mapped)
  if (g.slice(0, 6).every((x) => x === 0)) return embedded(g[6], g[7]) // ::a.b.c.d (compatible)
  if (g[0] === 0x0064 && g[1] === 0xff9b) return embedded(g[6], g[7]) // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]) // 6to4
  return false
}

/** Thrown by a resolver on platforms without DNS APIs. The DNS layer is then skipped (the host allow-list still applies). */
export class ResolverUnavailableError extends Error {
  constructor() { super('DNS lookups are not available on this platform'); this.name = 'ResolverUnavailableError' }
}

export class SsrfBlockedError extends Error {
  constructor(message = 'The webhook host did not resolve to a public address.') { super(message); this.name = 'SsrfBlockedError' }
}

/** Throws unless every address the host resolves to is public. `resolve` returns A and AAAA records. */
export async function assertPublicHost(host: string, resolve: (host: string) => Promise<string[]>): Promise<void> {
  let addrs: string[]
  try { addrs = await resolve(host) } catch (e) {
    if (e instanceof ResolverUnavailableError) return
    throw new SsrfBlockedError('The webhook host could not be resolved.')
  }
  if (!addrs.length) throw new SsrfBlockedError('The webhook host could not be resolved.')
  if (addrs.some(isPrivateIp)) throw new SsrfBlockedError()
}
