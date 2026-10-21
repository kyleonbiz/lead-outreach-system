import { ProviderError } from '../types.ts'

// Provider-neutral transactional e-mail. Resend's HTTP API is implemented; another provider only needs `send`.

export interface Mailer {
  readonly name: string
  send(m: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }>
}

export interface MailerEnv {
  NOTIFY_EMAIL_PROVIDER?: string
  RESEND_API_KEY?: string
  NOTIFY_FROM_EMAIL?: string
}

const FROM_RE = /^(?:[^<>\r\n"]{1,80} <[^\s<>@,;]{1,64}@[^\s<>@,;]{1,255}>|[^\s<>@,;]{1,64}@[^\s<>@,;]{1,255})$/

export type MailerSetup = { ok: true; mailer: Mailer } | { ok: false; missing: string[] }

/** Builds the configured mailer, or reports exactly which settings are missing. Never throws. */
export function mailerFromEnv(env: MailerEnv, fetchFn: typeof fetch = fetch): MailerSetup {
  const provider = (env.NOTIFY_EMAIL_PROVIDER ?? 'resend').toLowerCase()
  if (provider !== 'resend') return { ok: false, missing: [`NOTIFY_EMAIL_PROVIDER (unsupported value "${provider}")`] }
  const missing = [['RESEND_API_KEY', env.RESEND_API_KEY], ['NOTIFY_FROM_EMAIL', env.NOTIFY_FROM_EMAIL]]
    .filter(([, v]) => !v).map(([k]) => k as string)
  if (missing.length) return { ok: false, missing }
  if (!FROM_RE.test(env.NOTIFY_FROM_EMAIL!)) return { ok: false, missing: ['NOTIFY_FROM_EMAIL (not a valid sender address)'] }
  return { ok: true, mailer: resendMailer({ apiKey: env.RESEND_API_KEY!, from: env.NOTIFY_FROM_EMAIL! }, fetchFn) }
}

export function resendMailer(cfg: { apiKey: string; from: string }, fetchFn: typeof fetch = fetch): Mailer {
  return {
    name: 'resend',
    async send(m) {
      let res: Response
      try {
        res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json',
            // a retry after a timeout cannot produce a second e-mail
            'Idempotency-Key': m.idempotencyKey,
          },
          body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, text: m.text }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new ProviderError('The e-mail service could not be reached.', 'unavailable')
      }
      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { id?: string }
        return { id: body.id ?? '' }
      }
      const detail = await res.json().catch(() => ({})) as { message?: string }
      const msg = (detail.message ?? '').slice(0, 200)
      if (res.status === 401 || res.status === 403) throw new ProviderError(`The e-mail service rejected our credentials${msg ? `: ${msg}` : ''}`, 'auth', res.status)
      if (res.status === 429) throw new ProviderError('The e-mail service is rate limiting us.', 'rate_limit', res.status)
      if (res.status >= 500) throw new ProviderError(`The e-mail service had a problem (HTTP ${res.status}).`, 'unavailable', res.status)
      throw new ProviderError(`The e-mail service refused the message (HTTP ${res.status})${msg ? `: ${msg}` : ''}`, 'bad_request', res.status)
    },
  }
}
