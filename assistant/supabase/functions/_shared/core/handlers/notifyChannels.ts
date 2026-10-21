import { z } from 'zod'
import { fail, isAdmin, ok, type HandlerResult, type Role } from './common.ts'
import { decryptSecret, encryptSecret, CryptoConfigError } from '../crypto.ts'
import { validateWebhookUrl, type ChannelKind } from '../notify/url.ts'
import { postWebhook } from '../notify/webhook.ts'
import { slackPayload, teamsPayload, type Outgoing } from '../notify/format.ts'
import type { ActionLogEntry } from '../types.ts'

export const EVENT_TYPES = ['workflow_failed', 'approval_needed', 'task_overdue', 'workflow_message'] as const
const Events = z.array(z.enum(EVENT_TYPES)).min(1).max(4)
const Name = z.string().trim().min(1).max(80)
export const MAX_CHANNELS_PER_ORG = 10

const Request = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'), org_id: z.uuid(), kind: z.enum(['slack', 'teams']), name: Name,
    webhook_url: z.string().max(1100), events: Events.default(['workflow_failed', 'approval_needed']),
  }),
  z.strictObject({
    action: z.literal('update'), channel_id: z.uuid(), name: Name.optional(), events: Events.optional(),
    enabled: z.boolean().optional(), webhook_url: z.string().max(1100).optional(),
  }),
  z.strictObject({ action: z.literal('delete'), channel_id: z.uuid() }),
  z.strictObject({ action: z.literal('test'), channel_id: z.uuid() }),
])

export interface ChannelRow { id: string; org_id: string; kind: ChannelKind; name: string; enabled: boolean }

export interface ChannelDeps {
  userId: string | null
  getRole(orgId: string): Promise<Role | null>
  encryptionKey?: string
  appUrl: string
  fetch: typeof fetch
  resolve?: (host: string) => Promise<string[]>
  newId(): string
  /** read with the caller's token: Row Level Security hides channels from non-admins and other organizations */
  loadChannel(id: string): Promise<ChannelRow | null>
  countChannels(orgId: string): Promise<number>
  /** inserts the channel and its encrypted URL together; must leave nothing behind if either fails */
  insert(row: { id: string; org_id: string; kind: ChannelKind; name: string; url_hint: string; events: string[]; created_by: string }, encryptedUrl: string): Promise<void>
  update(id: string, orgId: string, patch: { name?: string; events?: string[]; enabled?: boolean; url_hint?: string }, encryptedUrl?: string): Promise<void>
  remove(id: string, orgId: string): Promise<void>
  encryptedUrl(id: string): Promise<string | null>
  recordTest(id: string, orgId: string, ok: boolean, error?: string): Promise<void>
  audit(e: ActionLogEntry): Promise<void>
}

const needsKey = (): HandlerResult =>
  fail(503, 'Notification channels are not configured yet', { code: 'not_configured', missing: ['TOKEN_ENCRYPTION_KEY'] })

const log = (orgId: string, userId: string, action: string, summary: string, input?: unknown): ActionLogEntry => ({
  org_id: orgId, user_id: userId, actor_type: 'user', category: 'audit', tool_name: null, action, status: 'success', summary, input,
})

export async function handleChannels(d: ChannelDeps, raw: unknown): Promise<HandlerResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = Request.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request', { issues: p.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`) })
  const req = p.data
  const userId = d.userId

  if (req.action === 'create') {
    if (!isAdmin(await d.getRole(req.org_id))) return fail(403, 'Only owners and admins can add notification channels')
    if (!d.encryptionKey) return needsKey()
    const url = validateWebhookUrl(req.kind, req.webhook_url)
    if (!url.ok) return fail(422, url.reason, { field: 'webhook_url' })
    if (await d.countChannels(req.org_id) >= MAX_CHANNELS_PER_ORG) return fail(409, `An organization can have at most ${MAX_CHANNELS_PER_ORG} channels`)
    const id = d.newId()
    const events = [...new Set(req.events)]
    await d.insert(
      { id, org_id: req.org_id, kind: req.kind, name: req.name, url_hint: url.hint, events, created_by: userId },
      await encryptSecret(url.url, d.encryptionKey, `notify-channel:${id}`),
    )
    await d.audit(log(req.org_id, userId, 'notification_channel.created', `Added ${req.kind === 'slack' ? 'Slack' : 'Teams'} channel "${req.name}"`, { kind: req.kind, events }))
    return ok({ id, url_hint: url.hint })
  }

  const ch = await d.loadChannel(req.channel_id)
  if (!ch) return fail(404, 'Channel not found')
  if (!isAdmin(await d.getRole(ch.org_id))) return fail(403, 'Only owners and admins can manage notification channels')

  if (req.action === 'delete') {
    await d.remove(ch.id, ch.org_id)
    await d.audit(log(ch.org_id, userId, 'notification_channel.deleted', `Removed channel "${ch.name}"`))
    return ok({ deleted: true })
  }

  if (req.action === 'update') {
    const patch: { name?: string; events?: string[]; enabled?: boolean; url_hint?: string } = {}
    if (req.name !== undefined) patch.name = req.name
    if (req.events !== undefined) patch.events = [...new Set(req.events)]
    if (req.enabled !== undefined) patch.enabled = req.enabled
    let encrypted: string | undefined
    if (req.webhook_url !== undefined) {
      if (!d.encryptionKey) return needsKey()
      const url = validateWebhookUrl(ch.kind, req.webhook_url)
      if (!url.ok) return fail(422, url.reason, { field: 'webhook_url' })
      patch.url_hint = url.hint
      encrypted = await encryptSecret(url.url, d.encryptionKey, `notify-channel:${ch.id}`)
    }
    if (!Object.keys(patch).length) return fail(400, 'Nothing to update')
    await d.update(ch.id, ch.org_id, patch, encrypted)
    await d.audit(log(ch.org_id, userId, 'notification_channel.updated', `Changed channel "${ch.name}"${encrypted ? ' (webhook URL replaced)' : ''}`,
      { changed: Object.keys(patch).filter((k) => k !== 'url_hint').concat(encrypted ? ['webhook_url'] : []) }))
    return ok({ updated: true })
  }

  // test: send a real message and report what actually happened
  if (!d.encryptionKey) return needsKey()
  const stored = await d.encryptedUrl(ch.id)
  if (!stored) return fail(409, 'This channel has no stored webhook URL. Replace the URL and try again.')
  let url: string
  try { url = await decryptSecret(stored, d.encryptionKey, `notify-channel:${ch.id}`) } catch (e) {
    if (e instanceof CryptoConfigError) return needsKey()
    return fail(409, 'The stored webhook URL could not be decrypted. Replace the URL and try again.')
  }
  const msg: Outgoing = {
    type: 'test', title: 'Test message from Aide', body: 'If you can read this, your Aide notifications will arrive here.', link: '/settings', orgName: '',
  }
  const r = await postWebhook(ch.kind, url, ch.kind === 'slack' ? slackPayload(msg, d.appUrl) : teamsPayload(msg, d.appUrl), { fetch: d.fetch, resolve: d.resolve })
  await d.recordTest(ch.id, ch.org_id, r.ok, r.ok ? undefined : r.error)
  await d.audit({ ...log(ch.org_id, userId, 'notification_channel.tested', `Sent a test message to "${ch.name}"`), status: r.ok ? 'success' : 'failure', error: r.ok ? null : r.error })
  return r.ok ? ok({ sent: true }) : fail(502, r.error, { code: 'delivery_failed' })
}
