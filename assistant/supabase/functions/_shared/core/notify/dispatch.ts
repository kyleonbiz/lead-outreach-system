import { ProviderError } from '../types.ts'
import { emailMessage, slackPayload, teamsPayload, type Outgoing } from './format.ts'
import type { Mailer } from './mailer.ts'
import { postWebhook } from './webhook.ts'

export interface Claimed {
  id: string
  orgId: string
  channel: 'email' | 'slack' | 'teams'
  channelId: string | null
  attempts: number
  recipientEmail: string | null
  notification: Outgoing
}

export type Outcome = 'sent' | 'failed' | 'retry' | 'skipped'

export interface DispatchDeps {
  claim(limit: number): Promise<Claimed[]>
  complete(id: string, outcome: Outcome, error?: string, retryInSeconds?: number): Promise<void>
  /** decrypts the stored webhook URL; null if the channel or its secret is gone */
  webhookUrl(channelId: string, orgId: string): Promise<string | null>
  mailer: Mailer | null
  /** why the mailer is missing, shown to admins (never silently dropped) */
  mailerMissing?: string[]
  fetch: typeof fetch
  resolve?: (host: string) => Promise<string[]>
  appUrl: string
}

export interface DispatchSummary { claimed: number; sent: number; failed: number; retried: number; skipped: number }

/** 1 min, 5 min, 30 min, 2 h, then 2 h. */
export const backoffSeconds = (attempts: number): number => [60, 300, 1800, 7200][Math.max(0, attempts - 1)] ?? 7200

async function deliver(d: DispatchDeps, c: Claimed): Promise<{ outcome: Outcome; error?: string; retryIn?: number }> {
  if (c.channel === 'email') {
    if (!d.mailer) {
      const why = d.mailerMissing?.length ? ` (missing: ${d.mailerMissing.join(', ')})` : ''
      return { outcome: 'skipped', error: `E-mail delivery is not configured on this server${why}.` }
    }
    if (!c.recipientEmail) return { outcome: 'skipped', error: "The recipient's e-mail address is not confirmed." }
    const m = emailMessage(c.notification, d.appUrl)
    try {
      await d.mailer.send({ to: c.recipientEmail, subject: m.subject, text: m.text, idempotencyKey: `aide-delivery-${c.id}` })
      return { outcome: 'sent' }
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : 'unknown'
      const permanent = kind === 'auth' || kind === 'bad_request'
      return { outcome: permanent ? 'failed' : 'retry', error: (e as Error).message.slice(0, 300), retryIn: backoffSeconds(c.attempts) }
    }
  }

  if (!c.channelId) return { outcome: 'failed', error: 'The delivery has no destination channel.' }
  const url = await d.webhookUrl(c.channelId, c.orgId)
  if (!url) return { outcome: 'failed', error: 'The channel or its stored webhook URL no longer exists.' }
  const payload = c.channel === 'slack' ? slackPayload(c.notification, d.appUrl) : teamsPayload(c.notification, d.appUrl)
  const r = await postWebhook(c.channel, url, payload, { fetch: d.fetch, resolve: d.resolve })
  if (r.ok) return { outcome: 'sent' }
  return { outcome: r.retry ? 'retry' : 'failed', error: r.error, retryIn: r.retryAfterSeconds ?? backoffSeconds(c.attempts) }
}

/** Claims due deliveries, sends them with bounded concurrency and reports every outcome. One bad delivery never blocks the rest. */
export async function dispatchDeliveries(d: DispatchDeps, limit = 20, concurrency = 4): Promise<DispatchSummary> {
  const items = await d.claim(limit)
  const s: DispatchSummary = { claimed: items.length, sent: 0, failed: 0, retried: 0, skipped: 0 }
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(async (c) => {
      let r: { outcome: Outcome; error?: string; retryIn?: number }
      try { r = await deliver(d, c) } catch (e) {
        r = { outcome: 'retry', error: `Unexpected error: ${(e as Error).message}`.slice(0, 300), retryIn: backoffSeconds(c.attempts) }
      }
      try { await d.complete(c.id, r.outcome, r.error, r.retryIn) } catch { /* the lease expires and the delivery is retried */ }
      if (r.outcome === 'sent') s.sent++
      else if (r.outcome === 'retry') s.retried++
      else if (r.outcome === 'skipped') s.skipped++
      else s.failed++
    }))
  }
  return s
}
